from __future__ import annotations

import json
from pathlib import Path


TEXT_SUFFIXES = {
    ".css",
    ".html",
    ".js",
    ".jsx",
    ".json",
    ".md",
    ".mjs",
    ".ts",
    ".tsx",
    ".vue",
}

EXCLUDED_PARTS = {
    ".git",
    ".next",
    ".nuxt",
    ".pytest_cache",
    ".venv",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "proguide_tests",
}

PRIORITY_DIRS = ("src", "app", "pages", "components", "router", "routes")


def collect_project_context(root: Path, max_chars: int = 50000) -> str:
    root = root.resolve()
    sections: list[str] = []
    package_json = root / "package.json"
    if package_json.exists():
        try:
            payload = json.loads(package_json.read_text(encoding="utf-8"))
            slim = {
                "name": payload.get("name"),
                "scripts": payload.get("scripts", {}),
                "dependencies": payload.get("dependencies", {}),
                "devDependencies": payload.get("devDependencies", {}),
            }
            sections.append("FILE: package.json\n" + json.dumps(slim, indent=2))
        except Exception:
            sections.append("FILE: package.json\n" + package_json.read_text(encoding="utf-8", errors="ignore")[:4000])

    for path in _candidate_files(root):
        if sum(len(section) for section in sections) >= max_chars:
            break
        relative = path.relative_to(root).as_posix()
        content = path.read_text(encoding="utf-8", errors="ignore")
        remaining = max_chars - sum(len(section) for section in sections)
        if remaining <= 0:
            break
        sections.append(f"FILE: {relative}\n{content[: min(len(content), remaining, 8000)]}")

    return "\n\n---\n\n".join(sections)


def _candidate_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for priority_dir in PRIORITY_DIRS:
        directory = root / priority_dir
        if directory.exists():
            files.extend(_walk_text_files(directory, root))
    files.extend(_walk_text_files(root, root, shallow=True))
    seen: set[Path] = set()
    unique: list[Path] = []
    for path in files:
        resolved = path.resolve()
        if resolved not in seen:
            seen.add(resolved)
            unique.append(path)
    return sorted(unique, key=lambda item: (len(item.parts), item.as_posix()))


def _walk_text_files(directory: Path, root: Path, shallow: bool = False) -> list[Path]:
    if shallow:
        candidates = [path for path in directory.iterdir() if path.is_file()]
    else:
        candidates = [path for path in directory.rglob("*") if path.is_file()]
    return [
        path
        for path in candidates
        if path.suffix.lower() in TEXT_SUFFIXES
        and not any(part in EXCLUDED_PARTS for part in path.relative_to(root).parts)
        and path.stat().st_size <= 120000
    ]
