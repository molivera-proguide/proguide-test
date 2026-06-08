from __future__ import annotations

import os
from pathlib import Path

from proguide.env import load_env_file, load_project_env, load_runtime_env


def test_load_project_env_sets_missing_values(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    (tmp_path / ".env").write_text(
        """
# local secrets
OPENAI_API_KEY="sk-test"
IGNORED_LINE
""",
        encoding="utf-8",
    )

    loaded = load_project_env(tmp_path)

    assert loaded == ["OPENAI_API_KEY"]
    assert os.environ["OPENAI_API_KEY"] == "sk-test"


def test_load_project_env_does_not_override_existing_values(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "already-set")
    (tmp_path / ".env").write_text("OPENAI_API_KEY=from-file", encoding="utf-8")

    loaded = load_project_env(tmp_path)

    assert loaded == []
    assert os.environ["OPENAI_API_KEY"] == "already-set"


def test_load_env_file_reads_specific_file(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    env_path = tmp_path / "custom.env"
    env_path.write_text("ANTHROPIC_API_KEY='anthropic-test'\n", encoding="utf-8")

    loaded = load_env_file(env_path)

    assert loaded == ["ANTHROPIC_API_KEY"]
    assert os.environ["ANTHROPIC_API_KEY"] == "anthropic-test"


def test_load_runtime_env_includes_current_working_directory(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    workdir = tmp_path / "tool"
    project = tmp_path / "frontend"
    workdir.mkdir()
    project.mkdir()
    (workdir / ".env").write_text("OPENAI_API_KEY=from-tool-dir\n", encoding="utf-8")
    monkeypatch.chdir(workdir)

    loaded = load_runtime_env(project)

    assert loaded == ["OPENAI_API_KEY"]
    assert os.environ["OPENAI_API_KEY"] == "from-tool-dir"


def test_load_runtime_env_prefers_explicit_proguide_env_file(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("PROGUIDE_LLM_API_KEY", raising=False)
    project = tmp_path / "frontend"
    project.mkdir()
    explicit = tmp_path / "proguide.env"
    explicit.write_text("PROGUIDE_LLM_API_KEY=from-explicit-file\n", encoding="utf-8")
    (project / ".env").write_text("PROGUIDE_LLM_API_KEY=from-project\n", encoding="utf-8")
    monkeypatch.setenv("PROGUIDE_ENV_FILE", str(explicit))

    loaded = load_runtime_env(project)

    assert loaded == ["PROGUIDE_LLM_API_KEY"]
    assert os.environ["PROGUIDE_LLM_API_KEY"] == "from-explicit-file"
