from __future__ import annotations

import json
from pathlib import Path

from proguide.project_context import collect_project_context


def test_collect_project_context_includes_package_and_src(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(
        json.dumps({"scripts": {"dev": "vite"}, "dependencies": {"react": "^19.0.0"}}),
        encoding="utf-8",
    )
    src = tmp_path / "src"
    src.mkdir()
    (src / "App.jsx").write_text("export default function App() { return <button>Login valido</button> }", encoding="utf-8")
    node_modules = tmp_path / "node_modules"
    node_modules.mkdir()
    (node_modules / "ignored.js").write_text("ignored", encoding="utf-8")

    context = collect_project_context(tmp_path)

    assert "FILE: package.json" in context
    assert "FILE: src/App.jsx" in context
    assert "Login valido" in context
    assert "ignored" not in context
