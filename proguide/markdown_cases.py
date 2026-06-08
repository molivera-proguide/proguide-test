from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from proguide.models import AutomationState, NormalizedCaseStep, NormalizedMarkdownCase
from proguide.utils import safe_id


FIELD_ALIASES = {
    "titulo": "title",
    "title": "title",
    "descripcion": "description",
    "description": "description",
    "prioridad": "priority",
    "priority": "priority",
    "precondicion": "preconditions",
    "precondiciones": "preconditions",
    "precondition": "preconditions",
    "preconditions": "preconditions",
    "datos": "data_used",
    "datos utilizados": "data_used",
    "data": "data_used",
    "test data": "data_used",
    "pasos": "original_steps",
    "acciones": "original_steps",
    "steps": "original_steps",
    "resultado esperado": "expected_results",
    "resultados esperados": "expected_results",
    "esperado": "expected_results",
    "esperados": "expected_results",
    "expected": "expected_results",
    "expected result": "expected_results",
    "expected results": "expected_results",
    "tags": "tags",
    "etiquetas": "tags",
    "qa": "qa_owner",
    "responsable": "qa_owner",
    "resp": "qa_owner",
    "qa responsable": "qa_owner",
    "desarrollo": "dev_owner",
    "desa": "dev_owner",
    "dev": "dev_owner",
    "ticket": "ticket",
    "requerimiento": "ticket",
    "ruta": "route",
    "route": "route",
    "url": "route",
}

GENERIC_EXPECTED_RE = re.compile(
    r"\b(correcto|correctamente|funciona|ok|exitoso|exitosamente|segun corresponda|adecuado)\b",
    re.I,
)
NOT_AUTOMATABLE_RE = re.compile(
    r"\b(captcha|2fa|otp|token fisico|sms|llamada|telefono|fuera del navegador|manual|base de datos|"
    r"db|api externa|correo fisico|impresion)\b",
    re.I,
)
REVIEW_STEP_RE = re.compile(
    r"\b(validar que corresponda|segun criterio|revisar visualmente|comprobar manualmente|"
    r"buscar el expediente|ubicar el expediente|datos de ambiente|consultar con)\b",
    re.I,
)
BULLET_CHARS = "\u2022\u25e6\u2043\u2219\u00b7\u2014\u2013\ufffd"
NAVIGATION_RE = re.compile(r"\b(ir|abrir|navegar|visitar|acceder|entrar|dirigirse|volver)\b", re.I)


@dataclass
class _CaseBlock:
    heading: str
    lines: list[str] = field(default_factory=list)


def load_markdown_cases(path: Path) -> list[NormalizedMarkdownCase]:
    return parse_markdown_cases(read_markdown_text(path), source_name=path.name)


def read_markdown_text(path: Path) -> str:
    data = path.read_bytes()
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return _repair_decoded_markdown(data.decode("utf-16"))
    if data.startswith(b"\xef\xbb\xbf"):
        return _repair_decoded_markdown(data.decode("utf-8-sig"))
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            text = data.decode(encoding)
        except UnicodeDecodeError:
            continue
        return _repair_decoded_markdown(text)
    return _repair_decoded_markdown(data.decode("utf-8", errors="replace"))


def parse_markdown_cases(markdown: str, *, source_name: str = "source.md") -> list[NormalizedMarkdownCase]:
    blocks = _split_case_blocks(markdown)
    cases: list[NormalizedMarkdownCase] = []
    for index, block in enumerate(blocks, start=1):
        case = _parse_block(block, index)
        if case:
            cases.append(case)

    if not cases and markdown.strip():
        fallback = _parse_block(_CaseBlock(source_name, markdown.splitlines()), 1)
        if fallback:
            cases.append(fallback)

    return cases


def cases_to_test_plan(
    cases: list[NormalizedMarkdownCase],
    *,
    source_md: str,
    app_name: str = "ProGuide Markdown Cases",
    include_review_cases: bool = False,
):
    from proguide.models import TestCase, TestPlan

    planned_cases: list[TestCase] = []
    for case in cases:
        if case.excluded:
            continue
        if not include_review_cases and case.automation_state != AutomationState.ready:
            continue
        steps = [step.normalized_action or step.original_text for step in case.executable_steps]
        expected = case.expected_results or ["page is visible"]
        case_data = dict(case.data or {})
        if case.data_used:
            case_data = _merge_case_data(case_data, _data_from_lines(case.data_used))
        planned_cases.append(
            TestCase(
                id=case.id,
                feature_id="markdown_cases",
                scenario_id=case.id,
                title=case.title,
                description=case.description or case.title,
                route=case.route or "/",
                priority=_priority_for_plan(case.priority),
                steps=steps or ["go to /"],
                expected=expected,
                data={
                    **case_data,
                    "preconditions": case.preconditions,
                    "data_used": _mask_secret_lines(case.data_used),
                    "qa_owner": case.qa_owner,
                    "dev_owner": case.dev_owner,
                    "ticket": case.ticket,
                },
            )
        )
    return TestPlan(app_name=app_name, source_prd=source_md, cases=planned_cases)


def recommended_markdown_template() -> str:
    return """# Casos de prueba

## Caso 1: Login valido

Prioridad: alta
Ticket: ARQ-000
QA responsable: Nombre QA
Desarrollo: Nombre Dev

### Precondiciones
- El usuario existe y esta activo.

### Datos utilizados
- Usuario: qa@example.com
- Password: ******

### Pasos
1. Ir a /login
2. Completar usuario valido
3. Completar password valido
4. Hacer clic en Ingresar

### Resultado esperado
- La URL contiene /home
- La pagina muestra Dashboard
"""


def mask_secret_text(text: str) -> str:
    return "\n".join(_mask_secret_line(line) for line in text.splitlines())


def _repair_decoded_markdown(text: str) -> str:
    return re.sub(r"(?m)^(\s*)\ufffd(?=\s+)", r"\1-", text)


def _split_case_blocks(markdown: str) -> list[_CaseBlock]:
    blocks: list[_CaseBlock] = []
    current: _CaseBlock | None = None
    preface: list[str] = []

    for line in markdown.splitlines():
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if heading and _is_case_heading(heading.group(1), heading.group(2)):
            if current:
                blocks.append(current)
            current = _CaseBlock(_clean_heading(heading.group(2)))
            continue
        if current:
            current.lines.append(line)
        else:
            preface.append(line)

    if current:
        blocks.append(current)

    if blocks:
        return blocks

    # Fallback: split by level 2/3 headings that actually contain case fields.
    # This avoids treating document sections such as "## 1. Autenticacion" as cases.
    current = None
    fallback_blocks: list[_CaseBlock] = []
    for line in markdown.splitlines():
        heading = re.match(r"^(#{2,3})\s+(.+?)\s*$", line)
        if heading and not _is_field_label(_norm(heading.group(2))):
            if current:
                fallback_blocks.append(current)
            current = _CaseBlock(_clean_heading(heading.group(2)))
            continue
        if current:
            current.lines.append(line)

    if current:
        fallback_blocks.append(current)
    content_blocks = [block for block in fallback_blocks if _has_case_content(block)]
    return content_blocks or [_CaseBlock("Caso 1", markdown.splitlines())]


def _is_case_heading(prefix: str, text: str) -> bool:
    normalized = _norm(text)
    if re.match(r"^(?:caso|case|test|tc)(?:\s|#|:|\.|\-|_|\d|$)", normalized):
        return True
    if re.search(r"\btc[\s._-]*\d+\b", normalized):
        return True
    return False


def _has_case_content(block: _CaseBlock) -> bool:
    current_field: str | None = None
    has_steps = False
    has_expected = False
    for raw_line in block.lines:
        line = raw_line.strip()
        if not line or _is_separator_line(line):
            continue
        if line.startswith("#"):
            current_field = _field_from_heading(line) or current_field
            if current_field == "original_steps":
                has_steps = True
            if current_field == "expected_results":
                has_expected = True
            continue
        stripped = _strip_list_marker(_strip_markdown_emphasis(line))
        label, _ = _extract_label(stripped)
        if label:
            current_field = label
            if label == "original_steps":
                has_steps = True
            if label == "expected_results":
                has_expected = True
            continue
        if current_field == "original_steps" or _looks_like_step(line):
            has_steps = True
        if current_field == "expected_results":
            has_expected = True
    return has_steps and has_expected


def _parse_block(block: _CaseBlock, number: int) -> NormalizedMarkdownCase | None:
    fields: dict[str, Any] = {
        "title": _title_from_heading(block.heading, number),
        "description": "",
        "priority": "media",
        "preconditions": [],
        "data_used": [],
        "original_steps": [],
        "expected_results": [],
        "tags": [],
        "route": "/",
    }
    current_field: str | None = None
    original_lines = [f"## {block.heading}", *block.lines]

    for raw_line in block.lines:
        line = raw_line.strip()
        if not line:
            continue
        if _is_separator_line(line):
            continue
        if line.startswith("#"):
            label = _field_from_heading(line)
            if label:
                current_field = label
            continue

        stripped = _strip_list_marker(_strip_markdown_emphasis(line))
        label, value = _extract_label(stripped)
        if label:
            current_field = label
            if value:
                _append_field(fields, label, value)
            continue
        if current_field:
            _append_field(fields, current_field, stripped)
        elif _looks_like_step(stripped):
            fields["original_steps"].append(stripped)
        elif stripped:
            fields["description"] = _join_text(fields.get("description", ""), stripped)

    fields["priority"] = _normalize_priority(str(fields.get("priority") or "media"))
    fields["tags"] = _split_tags(fields.get("tags", []))
    fields["preconditions"] = _clean_list(fields.get("preconditions", []))
    fields["data_used"] = _clean_list(fields.get("data_used", []))
    fields["original_steps"] = _clean_list(fields.get("original_steps", []))
    fields["expected_results"] = _clean_list(fields.get("expected_results", []))

    title = str(fields.get("title") or f"Caso {number}").strip()
    case_id = safe_id(f"caso_{number}_{title}")
    steps = _build_steps(fields["original_steps"])
    state, reason, confidence = _assess_automation(fields["original_steps"], fields["expected_results"])

    return NormalizedMarkdownCase(
        id=case_id,
        number=number,
        title=title,
        description=str(fields.get("description") or "").strip(),
        priority=fields["priority"],
        tags=fields["tags"],
        preconditions=fields["preconditions"],
        data_used=_mask_secret_lines(fields["data_used"]),
        data=_data_from_lines(fields["data_used"]),
        original_steps=fields["original_steps"],
        executable_steps=steps,
        expected_results=fields["expected_results"],
        confidence=confidence,
        automation_state=state,
        state_reason=reason,
        original_markdown=mask_secret_text("\n".join(original_lines).strip()),
        route=str(fields.get("route") or "/").strip() or "/",
        qa_owner=_none_if_empty(fields.get("qa_owner")),
        dev_owner=_none_if_empty(fields.get("dev_owner")),
        ticket=_none_if_empty(fields.get("ticket")),
    )


def _build_steps(original_steps: list[str]) -> list[NormalizedCaseStep]:
    return [
        NormalizedCaseStep(
            number=index,
            original_text=step,
            normalized_action=_normalize_step(step),
            confidence=_step_confidence(step),
            needs_review=bool(REVIEW_STEP_RE.search(step)),
            review_reason="Paso ambiguo o dependiente de datos de ambiente." if REVIEW_STEP_RE.search(step) else "",
        )
        for index, step in enumerate(original_steps, start=1)
    ]


def _normalize_step(step: str) -> str:
    normalized = _norm(step)
    explicit = _explicit_step(step)
    if explicit:
        return explicit
    route = _extract_route(step)
    click_target = _extract_click_target(step)
    if click_target:
        return f"click button {click_target}"
    if route:
        return f"go to {route}"
    if re.search(r"\b(email|e-mail|correo|usuario|user)\b", normalized) and re.search(r"\b(completar|ingresar|escribir|cargar|enter)\b", normalized):
        if re.search(r"\b(invalido|invalid|malformado|incorrecto)\b", normalized):
            return "enter invalid email"
        return "enter valid email"
    if re.search(r"\b(password|pass|clave|contrasena)\b", normalized) and re.search(r"\b(completar|ingresar|escribir|cargar|enter)\b", normalized):
        if re.search(r"\b(invalido|invalid|corta|corto|incorrecto)\b", normalized):
            return "enter invalid password"
        return "enter valid password"
    if re.search(r"\b(enviar|submit|login|iniciar sesion|continuar)\b", normalized):
        return "submit form"
    if NAVIGATION_RE.search(normalized):
        return "go to /"
    if re.search(r"\b(recargar|refresh)\b", normalized):
        return "refresh page"
    return step


def _assess_automation(steps: list[str], expected: list[str]) -> tuple[AutomationState, str, float]:
    joined_steps = "\n".join(steps)
    joined_expected = "\n".join(expected)
    if not steps:
        return AutomationState.not_automatable, "El caso no tiene pasos ejecutables.", 0.2
    if NOT_AUTOMATABLE_RE.search(joined_steps):
        return AutomationState.not_automatable, "El caso requiere acciones fuera del navegador o controles no automatizables.", 0.35
    if not expected:
        return AutomationState.needs_review, "Falta resultado esperado verificable.", 0.55
    if GENERIC_EXPECTED_RE.search(joined_expected) and not _has_concrete_expected(expected):
        return AutomationState.needs_review, "El resultado esperado es generico; conviene hacerlo verificable.", 0.6
    if REVIEW_STEP_RE.search(joined_steps):
        return AutomationState.needs_review, "Hay pasos ambiguos o dependientes de datos de ambiente.", 0.65
    return AutomationState.ready, "Caso listo para automatizar con el resolvedor actual.", 0.9


def _has_concrete_expected(expected: list[str]) -> bool:
    return any(
        re.search(r"\b(url|muestra|shows|visible|contains|contiene|mensaje|texto|dashboard|home|error)\b", item, re.I)
        for item in expected
    )


def _step_confidence(step: str) -> float:
    if _explicit_step(step):
        return 0.95
    if NOT_AUTOMATABLE_RE.search(step):
        return 0.2
    if REVIEW_STEP_RE.search(step):
        return 0.45
    if _normalize_step(step) != step:
        return 0.85
    return 0.7


def _extract_label(line: str) -> tuple[str | None, str]:
    match = re.match(r"^([^:]{2,40}):\s*(.*)$", line)
    if not match:
        return None, ""
    key = _norm(match.group(1))
    field = FIELD_ALIASES.get(key)
    if not field:
        return None, ""
    return field, match.group(2).strip()


def _field_from_heading(line: str) -> str | None:
    label = re.sub(r"^#+\s*", "", line).strip()
    return FIELD_ALIASES.get(_norm(label))


def _append_field(fields: dict[str, Any], label: str, value: str) -> None:
    value = _strip_list_marker(value).strip()
    if not value:
        return
    if label in {"preconditions", "data_used", "original_steps", "expected_results", "tags"}:
        fields.setdefault(label, []).append(value)
    elif label in {"qa_owner", "dev_owner", "ticket", "route", "priority", "title"}:
        fields[label] = value
    elif label == "description":
        fields[label] = _join_text(str(fields.get(label) or ""), value)


def _looks_like_step(line: str) -> bool:
    return bool(re.match(r"^(?:\d+[\).\s-]+|paso\s+\d+[:.\s-]+)", _norm(line)))


def _strip_list_marker(line: str) -> str:
    return re.sub(
        rf"^\s*(?:[-*+{re.escape(BULLET_CHARS)}]\s+|\d+[\).\s-]+|paso\s+\d+[:.\s-]+)",
        "",
        line,
        flags=re.I,
    ).strip()


def _strip_markdown_emphasis(line: str) -> str:
    return line.replace("**", "").replace("__", "").strip()


def _is_separator_line(line: str) -> bool:
    return bool(re.match(r"^[-*_]{3,}$", line.strip()))


def _title_from_heading(heading: str, number: int) -> str:
    title = re.sub(r"^\s*(?:caso|case|test|tc)(?:\s|#|:|\.|\-|_)*\d*[\s:.\-_]*", "", heading, flags=re.I).strip()
    title = _strip_list_marker(title)
    return title or f"Caso {number}"


def _clean_heading(heading: str) -> str:
    return _strip_list_marker(heading.strip().strip("#").strip())


def _is_field_label(text: str) -> bool:
    return text in FIELD_ALIASES


def _norm(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value)
    asciiish = "".join(char for char in decomposed if not unicodedata.combining(char))
    asciiish = asciiish.lower().strip()
    asciiish = re.sub(r"[*_`]+", "", asciiish)
    asciiish = re.sub(r"\s+", " ", asciiish)
    return asciiish


def _normalize_priority(value: str) -> str:
    normalized = _norm(value)
    if normalized in {"critica", "critical", "bloqueante"}:
        return "critica"
    if normalized in {"alta", "high"}:
        return "alta"
    if normalized in {"baja", "low"}:
        return "baja"
    return "media"


def _priority_for_plan(value: str) -> str:
    return {"baja": "low", "media": "medium", "alta": "high", "critica": "critical"}.get(_normalize_priority(value), "medium")


def _split_tags(value: Any) -> list[str]:
    if isinstance(value, str):
        raw_values = [value]
    else:
        raw_values = list(value or [])
    tags: list[str] = []
    for item in raw_values:
        tags.extend(part.strip() for part in re.split(r"[,;]", str(item)) if part.strip())
    return tags


def _clean_list(values: Any) -> list[str]:
    if isinstance(values, str):
        values = [values]
    return [_strip_list_marker(str(value)).strip() for value in values or [] if str(value).strip()]


def _join_text(existing: str, value: str) -> str:
    return f"{existing}\n{value}".strip() if existing else value.strip()


def _extract_route(step: str) -> str | None:
    normalized = _norm(step)
    has_route_context = (
        NAVIGATION_RE.search(normalized)
        or (re.search(r"\bingresar\b", normalized) and re.search(r"(https?://|/[A-Za-z0-9_\-/?#=&.]+)", step))
        or re.search(r"\b(ruta|route|url)\b", normalized)
        or re.match(r"^\s*(?:https?://|/[A-Za-z0-9_\-/?#=&.]+)", step)
    )
    if not has_route_context:
        return None
    match = re.search(r"(https?://\S+|/[A-Za-z0-9_\-/?#=&.]+)", step)
    if match:
        return match.group(1).rstrip(".,;")
    match = re.search(r"\b(?:ruta|route|url)\s+([A-Za-z0-9_\-/?#=&.]+)", step, re.I)
    if match:
        value = match.group(1).strip().rstrip(".,;")
        return value if value.startswith("/") else f"/{value}"
    return None


def _explicit_step(step: str) -> str | None:
    text = step.strip()
    if re.match(r"^(?:fill|click|expect)\s+\[.+?\]", text, re.I):
        return text
    if re.match(r"^expect\s+text\s+[\"'].+?[\"']", text, re.I):
        return text
    return None


def _merge_case_data(base: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = {**merged[key], **value}
        else:
            merged.setdefault(key, value)
    return merged


def _data_from_lines(lines: list[str]) -> dict[str, Any]:
    user: dict[str, str] = {}
    data: dict[str, Any] = {}
    for line in lines:
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        normalized = _norm(key)
        clean_value = value.strip()
        if not clean_value:
            continue
        if re.search(r"\b(password|pass|clave|contrasena|secret|token|api[_ -]?key)\b", normalized):
            continue
        if normalized in {"email", "correo"} or re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", clean_value):
            user["email"] = clean_value
        elif normalized in {"usuario", "user", "username"}:
            user["username"] = clean_value
        else:
            data[re.sub(r"[^a-z0-9]+", "_", normalized).strip("_")] = clean_value
    if user:
        data["user"] = user
    return data


def _extract_click_target(step: str) -> str | None:
    patterns = [
        r"(?:hacer\s+)?clic\s+(?:en\s+)?(?:el\s+boton\s+|boton\s+)?[\"']?([^\"']+?)[\"']?$",
        r"(?:click|press|presionar|seleccionar)\s+(?:button\s+|boton\s+)?[\"']?([^\"']+?)[\"']?$",
    ]
    for pattern in patterns:
        match = re.search(pattern, step, re.I)
        if match:
            target = match.group(1).strip().strip(".,;")
            if target and _norm(target) not in {"formulario", "boton", "button"}:
                return target
    return None


def _mask_secret_lines(values: list[str]) -> list[str]:
    return [_mask_secret_line(value) for value in values]


def _mask_secret_line(value: str) -> str:
    normalized = _norm(value)
    if not re.search(r"\b(password|pass|clave|contrasena|secret|token)\b", normalized):
        return value
    if re.search(r"\b(valido|valid|campo|input|completar|ingresar|escribir|placeholder)\b", normalized):
        return value
    if ":" in value:
        key = value.split(":", 1)[0].strip()
        prefix = value[: value.find(":") + 1]
        spacing = " " if not prefix.endswith(" ") else ""
        return f"{prefix}{spacing}******" if key else "******"
    match = re.match(r"^(\s*[-*+]?\s*(?:password|pass|clave|contrasena|secret|token)\b).*$", value, re.I)
    if match:
        return f"{match.group(1)}: ******"
    return value


def _none_if_empty(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None
