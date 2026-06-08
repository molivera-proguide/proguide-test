from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

from proguide.models import TestCase, TestPlan
from proguide.utils import safe_id


def generate_tests(plan: TestPlan, output_dir: Path) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    conftest_path = output_dir / "conftest.py"
    conftest_path.write_text('pytest_plugins = ["proguide.pytest_plugin"]\n', encoding="utf-8")
    written.append(conftest_path)

    by_feature: dict[str, list[TestCase]] = defaultdict(list)
    for case in plan.cases:
        by_feature[safe_id(case.feature_id)].append(case)

    for feature_id, cases in by_feature.items():
        path = output_dir / f"test_{feature_id}.py"
        path.write_text(_render_test_module(cases), encoding="utf-8")
        written.append(path)

    return written


def _render_test_module(cases: list[TestCase]) -> str:
    cases_json = json.dumps([case.model_dump(mode="json") for case in cases], indent=2)
    lines = [
        "from __future__ import annotations",
        "",
        "import json",
        "import os",
        "",
        "import pytest",
        "",
        "from proguide.playwright_steps import assert_expected, run_step",
        "",
        f"CASES = json.loads({cases_json!r})",
        "",
        "",
        "def _case(case_id: str) -> dict:",
        "    for item in CASES:",
        "        if item['id'] == case_id:",
        "            return item",
        "    raise KeyError(case_id)",
        "",
        "",
        "def _runtime_user(user: dict) -> dict:",
        "    merged = dict(user or {})",
        "    runtime_values = {",
        "        'email': os.environ.get('PROGUIDE_USER_EMAIL'),",
        "        'username': os.environ.get('PROGUIDE_USER_USERNAME'),",
        "        'password': os.environ.get('PROGUIDE_USER_PASSWORD'),",
        "    }",
        "    for key, value in runtime_values.items():",
        "        if value:",
        "            merged[key] = value",
        "    return merged",
        "",
    ]

    used_names: set[str] = set()
    for case in cases:
        function_name = f"test_{safe_id(case.id)}"
        while function_name in used_names:
            function_name = f"{function_name}_case"
        used_names.add(function_name)
        lines.extend(
            [
                "",
                f"@pytest.mark.proguide_case({case.id!r})",
                f"def {function_name}(page, proguide_base_url, proguide_steps):",
                f"    case = _case({case.id!r})",
                "    proguide_steps.set_case(case['id'], case['title'])",
                "    user = _runtime_user(case.get('data', {}).get('user', {}))",
                "    for step in case['steps']:",
                "        run_step(page, step, user, proguide_base_url, case.get('route', '/'), proguide_steps)",
                "    for expected in case['expected']:",
                "        assert_expected(page, expected, proguide_base_url, proguide_steps, user)",
            ]
        )

    return "\n".join(lines) + "\n"
