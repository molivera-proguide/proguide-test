from __future__ import annotations

from pathlib import Path

from proguide.generator import generate_tests
from proguide.planner import build_test_plan
from proguide.prd import load_prd


def test_builds_plan_from_prd(tmp_path: Path) -> None:
    prd_path = tmp_path / "prd.yaml"
    prd_path.write_text(
        """
app:
  name: Demo
users:
  default:
    email: test@example.com
    password: password123
features:
  - id: auth_login
    name: Login
    route: /login
    priority: high
    goal: User can log in.
    scenarios:
      - id: valid_login
        title: Valid user logs in
        steps:
          - go to login page
          - enter valid email
          - enter valid password
          - submit form
        expected:
          - user is redirected to home
""",
        encoding="utf-8",
    )

    plan = build_test_plan(load_prd(prd_path), "prd.yaml")

    assert len(plan.cases) == 1
    assert plan.cases[0].id == "auth_login_valid_login"
    assert plan.cases[0].data["user"]["email"] == "test@example.com"


def test_generates_pytest_files(tmp_path: Path) -> None:
    prd_path = tmp_path / "prd.yaml"
    prd_path.write_text(
        """
app:
  name: Demo
features:
  - id: smoke
    name: Smoke
    route: /
    scenarios:
      - id: homepage
        title: Homepage loads
        steps:
          - go to home page
        expected:
          - page is visible
""",
        encoding="utf-8",
    )
    plan = build_test_plan(load_prd(prd_path), "prd.yaml")

    written = generate_tests(plan, tmp_path / "generated")

    assert (tmp_path / "generated" / "conftest.py").exists()
    assert any(path.name == "test_smoke.py" for path in written)
    generated = (tmp_path / "generated" / "test_smoke.py").read_text(encoding="utf-8")
    assert "pytest.mark.proguide_case" in generated
    assert "PROGUIDE_USER_PASSWORD" in generated
    assert "assert_expected(page, expected, proguide_base_url, proguide_steps, user)" in generated
