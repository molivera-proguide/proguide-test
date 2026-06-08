from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from proguide.models import FrontendFramework


@dataclass(frozen=True)
class DetectedProject:
    root: Path
    framework: FrontendFramework
    package_manager: str
    start_command: str
    base_url: str
    reason: str


def _read_package_json(root: Path) -> dict[str, Any]:
    package_path = root / "package.json"
    if not package_path.exists():
        return {}
    with package_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _detect_package_manager(root: Path) -> str:
    if (root / "pnpm-lock.yaml").exists():
        return "pnpm"
    if (root / "yarn.lock").exists():
        return "yarn"
    if (root / "bun.lockb").exists() or (root / "bun.lock").exists():
        return "bun"
    return "npm"


def _script_command(package_manager: str, script: str) -> str:
    if package_manager == "npm":
        if script == "start":
            return "npm start"
        return f"npm run {script}"
    if package_manager == "pnpm":
        return f"pnpm {script}"
    if package_manager == "yarn":
        return f"yarn {script}"
    if package_manager == "bun":
        return f"bun run {script}"
    return f"npm run {script}"


def _has_dependency(package_json: dict[str, Any], name: str) -> bool:
    dependencies = package_json.get("dependencies", {}) or {}
    dev_dependencies = package_json.get("devDependencies", {}) or {}
    return name in dependencies or name in dev_dependencies


def detect_project(root: Path | str = ".") -> DetectedProject:
    root_path = Path(root).resolve()
    package_json = _read_package_json(root_path)
    package_manager = _detect_package_manager(root_path)

    if not package_json:
        return DetectedProject(
            root=root_path,
            framework=FrontendFramework.unknown,
            package_manager=package_manager,
            start_command="",
            base_url="http://localhost:3000",
            reason="No package.json found.",
        )

    scripts = package_json.get("scripts", {}) or {}
    dev_script = str(scripts.get("dev", ""))
    start_script = str(scripts.get("start", ""))
    serve_script = str(scripts.get("serve", ""))

    if _has_dependency(package_json, "next") or "next" in dev_script:
        command = _script_command(package_manager, "dev") if "dev" in scripts else _script_command(package_manager, "start")
        return DetectedProject(root_path, FrontendFramework.next, package_manager, command, "http://localhost:3000", "Detected Next.js.")

    if _has_dependency(package_json, "vite") or "vite" in dev_script:
        command = _script_command(package_manager, "dev") if "dev" in scripts else _script_command(package_manager, "start")
        return DetectedProject(root_path, FrontendFramework.vite, package_manager, command, "http://localhost:5173", "Detected Vite.")

    if _has_dependency(package_json, "@angular/core") or "ng serve" in start_script or "ng serve" in dev_script:
        if "start" in scripts:
            command = _script_command(package_manager, "start")
        elif "dev" in scripts:
            command = _script_command(package_manager, "dev")
        else:
            command = "npx ng serve"
        return DetectedProject(root_path, FrontendFramework.angular, package_manager, command, "http://localhost:4200", "Detected Angular.")

    if _has_dependency(package_json, "@vue/cli-service") or "vue-cli-service serve" in serve_script:
        command = _script_command(package_manager, "serve") if "serve" in scripts else _script_command(package_manager, "start")
        return DetectedProject(root_path, FrontendFramework.vue, package_manager, command, "http://localhost:8080", "Detected Vue CLI.")

    if _has_dependency(package_json, "react-scripts") or "react-scripts start" in start_script:
        command = _script_command(package_manager, "start")
        return DetectedProject(root_path, FrontendFramework.react_cra, package_manager, command, "http://localhost:3000", "Detected Create React App.")

    if "dev" in scripts:
        return DetectedProject(root_path, FrontendFramework.generic, package_manager, _script_command(package_manager, "dev"), "http://localhost:3000", "Using generic dev script.")

    if "start" in scripts:
        return DetectedProject(root_path, FrontendFramework.generic, package_manager, _script_command(package_manager, "start"), "http://localhost:3000", "Using generic start script.")

    return DetectedProject(
        root=root_path,
        framework=FrontendFramework.unknown,
        package_manager=package_manager,
        start_command="",
        base_url="http://localhost:3000",
        reason="No supported script found.",
    )
