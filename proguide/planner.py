from __future__ import annotations

import json
from pathlib import Path

from proguide.models import PRDDocument, Scenario, TestCase, TestPlan
from proguide.utils import safe_id


def build_test_plan(prd: PRDDocument, source_prd: str) -> TestPlan:
    cases: list[TestCase] = []
    default_user = prd.users.get("default")
    user_data = default_user.model_dump(mode="json", exclude_none=True) if default_user else {}

    for feature in prd.features:
        scenarios = feature.scenarios or [
            Scenario(
                id="smoke",
                title=f"{feature.name} smoke test",
                steps=[f"go to {feature.route or '/'}"],
                expected=feature.success_signals or [feature.goal or f"{feature.name} is reachable"],
            )
        ]
        for scenario in scenarios:
            case_id = safe_id(f"{feature.id}_{scenario.id}")
            expected = scenario.expected or feature.success_signals or [feature.goal or f"{feature.name} behaves as expected"]
            cases.append(
                TestCase(
                    id=case_id,
                    feature_id=feature.id,
                    scenario_id=scenario.id,
                    title=scenario.title,
                    description=feature.goal or scenario.title,
                    route=feature.route or "/",
                    priority=feature.priority,
                    steps=scenario.steps or [f"go to {feature.route or '/'}"],
                    expected=expected,
                    data={"user": user_data},
                )
            )

    return TestPlan(app_name=prd.app.name, source_prd=source_prd, cases=cases)


def save_test_plan(path: Path, plan: TestPlan) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(plan.model_dump_json(indent=2), encoding="utf-8")


def load_test_plan(path: Path) -> TestPlan:
    return TestPlan.model_validate(json.loads(path.read_text(encoding="utf-8")))
