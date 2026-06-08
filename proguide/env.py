from __future__ import annotations

import os
from pathlib import Path


def load_project_env(root: Path) -> list[str]:
    return load_env_file(root.resolve() / ".env")


def load_runtime_env(project_root: Path) -> list[str]:
    loaded: list[str] = []
    for env_path in _env_candidates(project_root):
        loaded.extend(load_env_file(env_path))
    return loaded


def load_env_file(env_path: Path) -> list[str]:
    if not env_path.exists():
        return []
    loaded: list[str] = []
    for raw_line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = _clean_value(value.strip())
        if not key or key in os.environ:
            continue
        os.environ[key] = value
        loaded.append(key)
    return loaded


def _env_candidates(project_root: Path) -> list[Path]:
    candidates = [
        project_root.resolve() / ".env",
        Path.cwd().resolve() / ".env",
        Path(__file__).resolve().parents[1] / ".env",
    ]
    unique: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved not in seen:
            seen.add(resolved)
            unique.append(resolved)
    return unique


def _clean_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value
