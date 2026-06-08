from __future__ import annotations

import pytest

from proguide.agents.planner_agent import _coerce_plan_payload, _schema
from proguide.models import TestCase as ProGuideTestCase, TestPlan as ProGuideTestPlan


def fallback_plan() -> ProGuideTestPlan:
    return ProGuideTestPlan(
        app_name="Demo",
        source_prd="proguide_tests/prd/prd.yaml",
        cases=[
            ProGuideTestCase(
                id="smoke_home",
                feature_id="smoke",
                scenario_id="home",
                title="Homepage loads",
                description="Smoke",
                route="/",
                priority="medium",
                steps=["go to /"],
                expected=["page shows Demo"],
                data={},
            )
        ],
    )


def test_coerce_plan_payload_adds_missing_top_level_fields() -> None:
    payload = {
        "cases": [
            {
                "id": "auth_valid_login",
                "feature_id": "auth",
                "scenario_id": "valid_login",
                "title": "Valid login",
                "description": "Checks login",
                "route": "/login",
                "priority": "high",
                "steps": ["go to /login"],
                "expected": ["page shows Autenticado"],
                "data": {},
            }
        ]
    }

    coerced = _coerce_plan_payload(payload, fallback_plan())

    assert coerced["app_name"] == "Demo"
    assert coerced["source_prd"] == "proguide_tests/prd/prd.yaml"
    assert len(coerced["cases"]) == 1


def test_coerce_plan_payload_rejects_returned_schema() -> None:
    with pytest.raises(RuntimeError, match="schema de ejemplo"):
        _coerce_plan_payload({"schema": _schema(12), "constraints": {"max_cases": 12}}, fallback_plan())
