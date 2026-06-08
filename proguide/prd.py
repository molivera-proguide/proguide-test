from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

from proguide.models import PRDDocument, ToolConfig


def load_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise ValueError(f"Expected a YAML mapping in {path}")
    return data


def write_yaml(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(data, handle, sort_keys=False)


def load_prd(path: Path) -> PRDDocument:
    return PRDDocument.model_validate(load_yaml(path))


def load_config(path: Path) -> ToolConfig:
    if not path.exists():
        return ToolConfig()
    return ToolConfig.model_validate(load_yaml(path))


def save_config(path: Path, config: ToolConfig) -> None:
    write_yaml(path, config.model_dump(mode="json"))


def save_normalized_prd(path: Path, prd: PRDDocument) -> None:
    normalized = {
        "schema_version": "1.0",
        "app": prd.app.model_dump(mode="json"),
        "users": {key: value.model_dump(mode="json", exclude_none=True) for key, value in prd.users.items()},
        "features": [feature.model_dump(mode="json") for feature in prd.features],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(normalized, indent=2), encoding="utf-8")
