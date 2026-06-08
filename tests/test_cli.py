from __future__ import annotations

from pathlib import Path
import importlib.util
import json

from typer.testing import CliRunner

import proguide.env
import proguide.cli
from proguide.cli import app


def test_test_command_reports_missing_prd(tmp_path: Path) -> None:
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "test",
            "--root",
            str(tmp_path),
            "--prd",
            str(tmp_path / "proguide_tests" / "prd" / "prd.yaml"),
        ],
    )

    assert result.exit_code == 1
    assert "No encontre el PRD" in result.output
    assert "proguide init" in result.output


def test_test_command_reports_missing_start_command(tmp_path: Path) -> None:
    prd_path = tmp_path / "proguide_tests" / "prd" / "prd.yaml"
    prd_path.parent.mkdir(parents=True)
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
    runner = CliRunner()

    result = runner.invoke(app, ["test", "--root", str(tmp_path), "--prd", str(prd_path), "--no-agent"])

    assert result.exit_code == 1
    assert "No encontre un comando para levantar el frontend" in result.output
    assert "Raiz analizada:" in result.output
    assert "configura app.start_command" in result.output


def test_test_command_reports_missing_playwright(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "package.json").write_text(
        json.dumps({"scripts": {"dev": "vite"}, "devDependencies": {"vite": "^5.0.0"}}),
        encoding="utf-8",
    )
    prd_path = tmp_path / "proguide_tests" / "prd" / "prd.yaml"
    prd_path.parent.mkdir(parents=True)
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
    original_find_spec = importlib.util.find_spec

    def fake_find_spec(name: str, *args, **kwargs):
        if name == "playwright":
            return None
        return original_find_spec(name, *args, **kwargs)

    monkeypatch.setattr(importlib.util, "find_spec", fake_find_spec)
    runner = CliRunner()

    result = runner.invoke(app, ["test", "--root", str(tmp_path), "--prd", str(prd_path), "--no-agent"])

    assert result.exit_code == 1
    assert "Falta Playwright" in result.output
    assert "playwright install chromium" in result.output


def test_agent_check_reports_missing_anthropic_key_by_default(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("PROGUIDE_LLM_API_KEY", raising=False)
    monkeypatch.delenv("API_KEY", raising=False)
    monkeypatch.setattr(proguide.env, "_env_candidates", lambda project_root: [Path(project_root).resolve() / ".env"])
    monkeypatch.setattr(proguide.cli, "load_runtime_env", proguide.env.load_runtime_env)
    runner = CliRunner()

    result = runner.invoke(app, ["agent-check", "--root", str(tmp_path)])

    assert result.exit_code == 1
    assert "Falta ANTHROPIC_API_KEY" in result.output


def test_agent_check_loads_anthropic_api_key_alias_from_project_env(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("PROGUIDE_LLM_API_KEY", raising=False)
    monkeypatch.delenv("API_KEY", raising=False)
    (tmp_path / ".env").write_text("API_KEY=sk-test\n", encoding="utf-8")
    runner = CliRunner()

    result = runner.invoke(app, ["agent-check", "--root", str(tmp_path)])

    assert result.exit_code == 0
    assert "Agente listo" in result.output
    assert ".env cargado" in result.output
    assert "sk-test" not in result.output


def test_case_template_writes_markdown_template(tmp_path: Path) -> None:
    output = tmp_path / "cases.md"
    runner = CliRunner()

    result = runner.invoke(app, ["case-template", "--output", str(output)])

    assert result.exit_code == 0
    assert output.exists()
    assert "## Caso 1: Login valido" in output.read_text(encoding="utf-8")


def test_case_interpret_creates_editable_run(tmp_path: Path) -> None:
    source = tmp_path / "cases.md"
    source.write_text(
        """
## Caso 1: Smoke

### Pasos
- Ir a /

### Resultado esperado
- La pagina muestra Home
""",
        encoding="utf-8",
    )
    runner = CliRunner()

    result = runner.invoke(
        app,
        [
            "case-interpret",
            "--root",
            str(tmp_path),
            "--source",
            str(source),
            "--base-url",
            "http://example.test",
        ],
    )

    assert result.exit_code == 0
    assert "Run:" in result.output
    assert "Cases: 1" in result.output
    assert list((tmp_path / "proguide_tests" / "runs").glob("*/normalized_cases.json"))
