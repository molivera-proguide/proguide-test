from __future__ import annotations

from proguide.markdown_cases import cases_to_test_plan, mask_secret_text, parse_markdown_cases, read_markdown_text
from proguide.models import AutomationState


def test_parses_semistructured_markdown_case() -> None:
    markdown = """
# Casos de prueba

## Caso 1: Login valido
Prioridad: alta

### Precondiciones
- Usuario activo

### Datos utilizados
- Usuario: qa@example.com
- Password: secreto

### Pasos
1. Ir a /login
2. Completar usuario valido
3. Completar password valido
4. Hacer clic en Ingresar

### Resultado esperado
- La URL contiene /home
- La pagina muestra Dashboard
"""

    cases = parse_markdown_cases(markdown)

    assert len(cases) == 1
    assert cases[0].id == "caso_1_login_valido"
    assert cases[0].priority == "alta"
    assert cases[0].automation_state == AutomationState.ready
    assert cases[0].data_used == ["Usuario: qa@example.com", "Password: ******"]
    assert [step.normalized_action for step in cases[0].executable_steps] == [
        "go to /login",
        "enter valid email",
        "enter valid password",
        "click button Ingresar",
    ]
    assert "secreto" not in cases[0].original_markdown


def test_marks_generic_expected_result_for_review() -> None:
    markdown = """
## Caso 1: Flujo generico

### Pasos
- Ir a /home

### Resultado esperado
- Funciona correctamente
"""

    cases = parse_markdown_cases(markdown)

    assert cases[0].automation_state == AutomationState.needs_review
    assert "generico" in cases[0].state_reason


def test_builds_test_plan_from_ready_cases_only() -> None:
    markdown = """
## Caso 1: Listo

### Pasos
- Ir a /home

### Resultado esperado
- La pagina muestra Dashboard

## Caso 2: Revisar

### Pasos
- Ir a /home

### Resultado esperado
- Funciona correctamente
"""
    cases = parse_markdown_cases(markdown)

    plan = cases_to_test_plan(cases, source_md="source.md")

    assert [case.id for case in plan.cases] == ["caso_1_listo"]
    assert plan.cases[0].expected == ["La pagina muestra Dashboard"]


def test_masks_secret_lines_without_masking_password_steps() -> None:
    text = "Password: secreto\nCompletar password valido"

    assert mask_secret_text(text) == "Password: ******\nCompletar password valido"


def test_reads_windows_1252_markdown_without_replacement_characters(tmp_path) -> None:
    source = tmp_path / "cases.md"
    source.write_bytes(
        b"## \x95 Mostrar login cuando no hay sesi\xf3n\r\n\r\n"
        b"### Pasos\r\n"
        b"- Ir a /login\r\n\r\n"
        b"### Resultado esperado\r\n"
        b"- La pagina muestra Login\r\n"
    )

    markdown = read_markdown_text(source)
    cases = parse_markdown_cases(markdown)

    assert "\ufffd" not in markdown
    assert cases[0].title == "Mostrar login cuando no hay sesi\u00f3n"
