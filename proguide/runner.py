from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree

from proguide.models import CredentialSet, RunSummary, TestPlan, TestResult, TestStatus, ToolConfig
from proguide.utils import as_relative, safe_id


def make_run_id() -> str:
    return datetime.now().strftime("%Y-%m-%d_%H-%M-%S")


def run_pytest(
    *,
    tests_dir: Path,
    run_dir: Path,
    plan: TestPlan,
    base_url: str,
    config: ToolConfig,
    project_root: Path,
    credentials: CredentialSet | None = None,
) -> RunSummary:
    run_dir.mkdir(parents=True, exist_ok=True)
    started_at = datetime.now(timezone.utc).isoformat()
    junit_path = run_dir / "junit.xml"
    pytest_log_path = run_dir / "pytest.log"

    command = [sys.executable, "-m", "pytest", str(tests_dir), "--junitxml", str(junit_path)]
    workers = config.runner.parallel_workers
    if workers != "1" and importlib.util.find_spec("xdist") is not None:
        command.extend(["-n", "auto" if workers == "auto" else workers])

    env = os.environ.copy()
    env["PROGUIDE_BASE_URL"] = base_url.rstrip("/")
    env["PROGUIDE_RUN_DIR"] = str(run_dir)
    env["PROGUIDE_BROWSER"] = config.runner.browser
    env["PROGUIDE_VIDEO"] = config.runner.video
    env["PROGUIDE_SCREENSHOTS"] = config.runner.screenshots
    env["PROGUIDE_TRACES"] = config.runner.traces
    if credentials:
        if credentials.email:
            env["PROGUIDE_USER_EMAIL"] = credentials.email
        if credentials.username:
            env["PROGUIDE_USER_USERNAME"] = credentials.username
        if credentials.password:
            env["PROGUIDE_USER_PASSWORD"] = credentials.password
    env["PYTHONPATH"] = os.pathsep.join([str(project_root), env.get("PYTHONPATH", "")]).strip(os.pathsep)

    with pytest_log_path.open("w", encoding="utf-8") as log_file:
        log_file.write("$ " + " ".join(command) + "\n")
        completed = subprocess.run(
            command,
            cwd=project_root,
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
        )

    results = _parse_results(plan, junit_path, run_dir, project_root)
    if completed.returncode != 0 and not junit_path.exists():
        results = [
            TestResult(
                id=case.id,
                title=case.title,
                status=TestStatus.inconclusive,
                message=f"pytest exited with code {completed.returncode}. See {as_relative(pytest_log_path, project_root)}.",
                steps=case.steps,
                expected=case.expected,
            )
            for case in plan.cases
        ]

    summary = RunSummary(
        run_id=run_dir.name,
        base_url=base_url,
        started_at=started_at,
        finished_at=datetime.now(timezone.utc).isoformat(),
        results=results,
    )
    (run_dir / "summary.json").write_text(summary.model_dump_json(indent=2), encoding="utf-8")
    return summary


def _parse_results(plan: TestPlan, junit_path: Path, run_dir: Path, project_root: Path) -> list[TestResult]:
    case_by_safe_id = {safe_id(case.id): case for case in plan.cases}
    parsed: dict[str, TestResult] = {}

    if junit_path.exists():
        tree = ElementTree.parse(junit_path)
        for node in tree.findall(".//testcase"):
            name = node.attrib.get("name", "")
            safe_case_id = safe_id(name.removeprefix("test_"))
            case = case_by_safe_id.get(safe_case_id)
            if case is None:
                continue
            status = TestStatus.passed
            message = ""
            if node.find("failure") is not None:
                status = TestStatus.failed
                message = node.find("failure").attrib.get("message", "")
            elif node.find("error") is not None:
                status = TestStatus.inconclusive
                message = node.find("error").attrib.get("message", "")
            elif node.find("skipped") is not None:
                status = TestStatus.inconclusive
                message = node.find("skipped").attrib.get("message", "Skipped")

            parsed[case.id] = TestResult(
                id=case.id,
                title=case.title,
                status=status,
                duration_seconds=float(node.attrib.get("time", "0") or 0),
                message=message,
                steps=_load_steps(run_dir, case.id) or case.steps,
                expected=case.expected,
                videos=_collect_artifacts(run_dir / "videos" / safe_id(case.id), run_dir, {".webm"}),
                screenshots=_collect_artifacts(run_dir / "screenshots", run_dir, {".png"}, safe_id(case.id)),
                traces=_collect_artifacts(run_dir / "traces", run_dir, {".zip"}, safe_id(case.id)),
            )

    results: list[TestResult] = []
    for case in plan.cases:
        results.append(
            parsed.get(
                case.id,
                TestResult(
                    id=case.id,
                    title=case.title,
                    status=TestStatus.inconclusive,
                    message="No pytest result was found for this case.",
                    steps=case.steps,
                    expected=case.expected,
                    videos=_collect_artifacts(run_dir / "videos" / safe_id(case.id), run_dir, {".webm"}),
                    screenshots=_collect_artifacts(run_dir / "screenshots", run_dir, {".png"}, safe_id(case.id)),
                    traces=_collect_artifacts(run_dir / "traces", run_dir, {".zip"}, safe_id(case.id)),
                ),
            )
        )
    return results


def _load_steps(run_dir: Path, case_id: str) -> list[str]:
    path = run_dir / "step_logs" / f"{safe_id(case_id)}.json"
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    return [f"{entry['status']}: {entry['step']}" for entry in payload.get("steps", [])]


def _collect_artifacts(directory: Path, relative_to: Path, suffixes: set[str], stem: str | None = None) -> list[str]:
    if not directory.exists():
        return []
    files = []
    for path in directory.rglob("*"):
        if path.is_file() and path.suffix.lower() in suffixes:
            if stem is None or safe_id(path.stem).startswith(stem) or stem in safe_id(str(path)):
                files.append(as_relative(path, relative_to))
    return sorted(files)
