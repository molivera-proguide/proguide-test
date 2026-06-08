from __future__ import annotations

import json
from pathlib import Path

from proguide.detector import detect_project


def write_package(root: Path, payload: dict) -> None:
    (root / "package.json").write_text(json.dumps(payload), encoding="utf-8")


def test_detects_vite(tmp_path: Path) -> None:
    write_package(
        tmp_path,
        {
            "scripts": {"dev": "vite --host 0.0.0.0"},
            "devDependencies": {"vite": "^5.0.0"},
        },
    )

    detected = detect_project(tmp_path)

    assert detected.framework.value == "vite"
    assert detected.start_command == "npm run dev"
    assert detected.base_url == "http://localhost:5173"


def test_detects_next(tmp_path: Path) -> None:
    write_package(
        tmp_path,
        {
            "scripts": {"dev": "next dev"},
            "dependencies": {"next": "^14.0.0"},
        },
    )

    detected = detect_project(tmp_path)

    assert detected.framework.value == "next"
    assert detected.start_command == "npm run dev"
    assert detected.base_url == "http://localhost:3000"


def test_uses_pnpm_command(tmp_path: Path) -> None:
    (tmp_path / "pnpm-lock.yaml").write_text("", encoding="utf-8")
    write_package(tmp_path, {"scripts": {"dev": "vite"}, "devDependencies": {"vite": "^5.0.0"}})

    detected = detect_project(tmp_path)

    assert detected.package_manager == "pnpm"
    assert detected.start_command == "pnpm dev"
