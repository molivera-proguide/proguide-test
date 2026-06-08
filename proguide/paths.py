from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


DEFAULT_PROGUIDE_DIR = "proguide_tests"


@dataclass(frozen=True)
class ProjectPaths:
    root: Path
    proguide_dir: Path
    prd_dir: Path
    plans_dir: Path
    generated_dir: Path
    runs_dir: Path
    config_path: Path
    default_prd_path: Path
    default_plan_path: Path


def build_paths(root: Path | str = ".", proguide_dir: str = DEFAULT_PROGUIDE_DIR) -> ProjectPaths:
    root_path = Path(root).resolve()
    base = root_path / proguide_dir
    return ProjectPaths(
        root=root_path,
        proguide_dir=base,
        prd_dir=base / "prd",
        plans_dir=base / "plans",
        generated_dir=base / "generated",
        runs_dir=base / "runs",
        config_path=base / "config.yaml",
        default_prd_path=base / "prd" / "prd.yaml",
        default_plan_path=base / "plans" / "test_plan.json",
    )


def ensure_layout(paths: ProjectPaths) -> None:
    for directory in (
        paths.proguide_dir,
        paths.prd_dir,
        paths.plans_dir,
        paths.generated_dir,
        paths.runs_dir,
    ):
        directory.mkdir(parents=True, exist_ok=True)
