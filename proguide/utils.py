from __future__ import annotations

import re
from pathlib import Path


def safe_id(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_]+", "_", value.strip().lower())
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return cleaned or "item"


def as_relative(path: Path, base: Path) -> str:
    try:
        return path.resolve().relative_to(base.resolve()).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def url_join(base_url: str, route: str) -> str:
    base = base_url.rstrip("/")
    if not route:
        return base
    if route.startswith("http://") or route.startswith("https://"):
        return route
    return f"{base}/{route.lstrip('/')}"
