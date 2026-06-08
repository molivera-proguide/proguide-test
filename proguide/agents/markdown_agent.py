from __future__ import annotations

import json
from typing import Any

from pydantic import ValidationError

from proguide.agents.planner_agent import _build_chat_model, _content_to_text, _extract_json, _require_llm_ready
from proguide.markdown_cases import parse_markdown_cases
from proguide.models import NormalizedMarkdownCase, ToolConfig


SYSTEM_PROMPT = """You are a senior QA analyst converting Markdown test cases into structured cases.
Return only valid JSON. No markdown.

Rules:
- Do not execute tests.
- Do not invent credentials, environment data, or business records.
- Preserve the original wording in original_markdown/original_steps.
- Use Spanish UI state values:
  - automation_state: listo, necesita_revision, no_automatizable_aun
- Mark ambiguous cases as necesita_revision with a concrete state_reason.
- Mark captcha, 2FA, manual-only, external calls, or missing data as no_automatizable_aun.
- Keep password/secret/token values masked as ******.
- Use priority values baja, media, alta, critica.
"""


def interpret_markdown_with_llm(markdown: str, *, source_name: str, config: ToolConfig) -> list[NormalizedMarkdownCase]:
    _require_llm_ready(config)
    baseline = parse_markdown_cases(markdown, source_name=source_name)
    payload = {
        "required_output_shape": _schema(),
        "source_name": source_name,
        "markdown": markdown[: config.llm.max_context_chars],
        "deterministic_baseline": [case.model_dump(mode="json") for case in baseline],
    }
    llm = _build_chat_model(config)
    response = llm.invoke(
        [
            ("system", SYSTEM_PROMPT),
            ("human", json.dumps(payload, ensure_ascii=False)),
        ]
    )
    data = _extract_json(_content_to_text(response.content))
    cases_data = _coerce_cases_payload(data)
    try:
        cases = [NormalizedMarkdownCase.model_validate(item) for item in cases_data]
    except ValidationError as exc:
        raise RuntimeError(f"El agente devolvio casos Markdown con formato invalido: {exc}") from exc
    return cases[: config.llm.max_cases] or baseline


def _schema() -> dict[str, Any]:
    return {
        "cases": [
            {
                "id": "caso_1_login_valido",
                "number": 1,
                "title": "Login valido",
                "description": "string",
                "priority": "baja|media|alta|critica",
                "tags": ["string"],
                "preconditions": ["string"],
                "data_used": ["Password: ******"],
                "original_steps": ["string"],
                "executable_steps": [
                    {
                        "number": 1,
                        "original_text": "Ir a /login",
                        "normalized_action": "go to /login",
                        "confidence": 0.9,
                        "needs_review": False,
                        "review_reason": "",
                    }
                ],
                "expected_results": ["page shows Dashboard"],
                "confidence": 0.9,
                "automation_state": "listo|necesita_revision|no_automatizable_aun",
                "state_reason": "string",
                "original_markdown": "string",
                "route": "/",
                "qa_owner": "string or null",
                "dev_owner": "string or null",
                "ticket": "string or null",
                "excluded": False,
                "parallelizable": True,
            }
        ]
    }


def _coerce_cases_payload(data: dict[str, Any]) -> list[dict[str, Any]]:
    if isinstance(data.get("cases"), list):
        return data["cases"]
    if isinstance(data.get("normalized_cases"), list):
        return data["normalized_cases"]
    if isinstance(data.get("test_cases"), list):
        return data["test_cases"]
    raise RuntimeError("El agente no devolvio una lista de casos en la clave cases.")
