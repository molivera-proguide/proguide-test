from __future__ import annotations

import json
import os
import re
from typing import Any

from pydantic import ValidationError

from proguide.models import PRDDocument, TestPlan, ToolConfig
from proguide.planner import build_test_plan
from proguide.project_context import collect_project_context


SYSTEM_PROMPT = """You are a senior frontend QA planner.
Generate a compact JSON test plan for Playwright tests from the PRD and project source context.

Rules:
- Return only valid JSON. No markdown.
- Return a single test plan object with top-level keys: schema_version, generated_at, app_name, source_prd, cases.
- Do not return the input schema, do not wrap the answer in a "schema" key, and do not include explanations.
- Create realistic frontend cases from visible routes, labels, buttons, validation messages, and local storage behavior found in context.
- Prefer 6 to max_cases cases when enough behavior is visible.
- Keep tests executable by this constrained runner.
- Supported step phrases:
  - "go to <route>"
  - "enter valid email"
  - "enter valid password"
  - "enter invalid email"
  - "enter invalid password"
  - "submit form"
  - "click button <visible button text>"
- Supported expected phrases:
  - "url contains <path>"
  - "page shows <visible text>"
  - "page does not show <visible text>"
- Do not invent backend APIs or data that is not implied by the PRD/context.
- If the PRD says one success signal but the source shows a different concrete signal, prefer the source and visible UI text.
"""


def build_agentic_test_plan(prd: PRDDocument, source_prd: str, config: ToolConfig, root) -> TestPlan:
    _require_llm_ready(config)
    fallback = build_test_plan(prd, source_prd)
    payload = {
        "required_output_shape": _schema(config.llm.max_cases),
        "prd": prd.model_dump(mode="json"),
        "deterministic_baseline": fallback.model_dump(mode="json"),
        "project_context": collect_project_context(root, config.llm.max_context_chars),
    }
    llm = _build_chat_model(config)
    response = llm.invoke(
        [
            ("system", SYSTEM_PROMPT),
            ("human", json.dumps(payload, ensure_ascii=False)),
        ]
    )
    raw = _content_to_text(response.content)
    data = _extract_json(raw)
    try:
        plan = TestPlan.model_validate(_coerce_plan_payload(data, fallback))
    except ValidationError as exc:
        raise RuntimeError(f"El agente devolvio un plan con formato invalido: {exc}") from exc
    return _normalize_agent_plan(plan, fallback, config.llm.max_cases)


def _require_llm_ready(config: ToolConfig) -> None:
    if not config.llm.enabled or config.llm.provider == "disabled":
        raise RuntimeError("El agente LLM esta deshabilitado en proguide_tests/config.yaml.")
    if config.llm.provider == "openai":
        if not os.environ.get("OPENAI_API_KEY"):
            raise RuntimeError("Falta OPENAI_API_KEY en el entorno.")
        try:
            import langchain_openai  # noqa: F401
        except ImportError as exc:
            raise RuntimeError("Falta langchain-openai. Instala con: python -m pip install -e \".[llm]\"") from exc
    elif config.llm.provider == "anthropic":
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise RuntimeError("Falta ANTHROPIC_API_KEY en el entorno.")
        try:
            import langchain_anthropic  # noqa: F401
        except ImportError as exc:
            raise RuntimeError("Falta langchain-anthropic. Instala con: python -m pip install -e \".[llm]\"") from exc
    else:
        raise RuntimeError(f"Proveedor LLM no soportado: {config.llm.provider}")


def _build_chat_model(config: ToolConfig):
    if config.llm.provider == "openai":
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(model=config.llm.model, temperature=config.llm.temperature)
    if config.llm.provider == "anthropic":
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(model=config.llm.model, temperature=config.llm.temperature)
    raise RuntimeError(f"Proveedor LLM no soportado: {config.llm.provider}")


def _schema(max_cases: int) -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "generated_at": "ISO timestamp string",
        "app_name": "string",
        "source_prd": "string",
        "cases": [
            {
                "id": "snake_case_unique_id",
                "feature_id": "feature id from PRD",
                "scenario_id": "snake_case_scenario_id",
                "title": "short title",
                "description": "what this verifies",
                "route": "/route",
                "priority": "low|medium|high|critical",
                "steps": ["go to /login", "enter valid email", "enter valid password", "submit form"],
                "expected": ["page shows Autenticado"],
                "data": {"user": {"email": "test@example.com", "password": "password123"}},
            }
        ],
        "constraints": {"max_cases": max_cases},
    }


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or ""))
            else:
                parts.append(str(item))
        return "\n".join(parts)
    return str(content)


def _extract_json(raw: str) -> dict[str, Any]:
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?", "", cleaned).strip()
        cleaned = re.sub(r"```$", "", cleaned).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, re.S)
        if not match:
            raise
        return json.loads(match.group(0))


def _coerce_plan_payload(data: dict[str, Any], fallback: TestPlan) -> dict[str, Any]:
    if "cases" in data:
        data.setdefault("schema_version", "1.0")
        data.setdefault("app_name", fallback.app_name)
        data.setdefault("source_prd", fallback.source_prd)
        return data

    if isinstance(data.get("test_plan"), dict):
        return _coerce_plan_payload(data["test_plan"], fallback)

    if isinstance(data.get("plan"), dict):
        return _coerce_plan_payload(data["plan"], fallback)

    if isinstance(data.get("cases"), list):
        return {
            "schema_version": "1.0",
            "app_name": fallback.app_name,
            "source_prd": fallback.source_prd,
            "cases": data["cases"],
        }

    if "schema" in data and "constraints" in data:
        raise RuntimeError("El agente devolvio el schema de ejemplo en vez del plan. Reintenta o usa `--no-agent`.")

    raise RuntimeError("El agente no devolvio casos de prueba. Reintenta o usa `--no-agent`.")


def _normalize_agent_plan(plan: TestPlan, fallback: TestPlan, max_cases: int) -> TestPlan:
    if not plan.cases:
        return fallback
    baseline_users = {case.id: case.data.get("user") for case in fallback.cases}
    default_user = next((user for user in baseline_users.values() if user), None)
    seen: set[str] = set()
    normalized_cases = []
    for case in plan.cases[:max_cases]:
        if case.id in seen:
            continue
        seen.add(case.id)
        if default_user and not case.data.get("user"):
            case.data["user"] = default_user
        normalized_cases.append(case)
    plan.cases = normalized_cases or fallback.cases
    plan.schema_version = "1.0"
    plan.source_prd = fallback.source_prd
    plan.app_name = fallback.app_name
    return plan
