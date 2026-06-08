from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

from proguide.models import RunEvent
from proguide.utils import safe_id


EVENTS_JSONL = "events.jsonl"


class ProGuideStepRecorder:
    def __init__(self, run_dir: Path, node_name: str) -> None:
        self.run_dir = run_dir
        self.case_id = safe_id(node_name)
        self.title = node_name
        self.entries: list[dict[str, Any]] = []
        self.path = self._build_path()
        self.case_started_emitted = False

    def set_case(self, case_id: str, title: str) -> None:
        self.case_id = safe_id(case_id)
        self.title = title
        self.path = self._build_path()
        self.case_started_emitted = False
        self._flush()
        self._emit_case_started()

    def log(self, step: str, status: str = "passed", message: str = "") -> None:
        self._emit_case_started()
        self.entries.append(
            {
                "time": datetime.now(timezone.utc).isoformat(),
                "step": step,
                "status": status,
                "message": message,
            }
        )
        self._flush()
        self._emit_step_event(step, status, message)

    def _build_path(self) -> Path:
        return self.run_dir / "step_logs" / f"{self.case_id}.json"

    def _flush(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"id": self.case_id, "title": self.title, "steps": self.entries}
        self.path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def _emit_case_started(self) -> None:
        if self.case_started_emitted:
            return
        _append_event(
            self.run_dir,
            type="case_started",
            status="running",
            message=self.title,
            case_id=self.case_id,
        )
        self.case_started_emitted = True

    def _emit_step_event(self, step: str, status: str, message: str) -> None:
        event_type = {
            "started": "step_started",
            "passed": "step_finished",
            "failed": "step_failed",
        }.get(status, "step_logged")
        event_status = "failed" if status == "failed" else "running"
        _append_event(
            self.run_dir,
            type=event_type,
            status=event_status,
            message=message or step,
            case_id=self.case_id,
            step_id=str(len(self.entries)),
            payload={"step": step, "step_status": status},
        )


def _append_event(
    run_dir: Path,
    *,
    type: str,
    status: str = "",
    message: str = "",
    case_id: str | None = None,
    step_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    event = RunEvent(
        run_id=run_dir.name,
        type=type,
        status=status,
        message=message,
        case_id=safe_id(case_id) if case_id else None,
        step_id=step_id,
        payload=payload or {},
    )
    path = run_dir / EVENTS_JSONL
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(event.model_dump_json() + "\n")


def _message_from_report(report: Any) -> str:
    if report is None or not getattr(report, "longrepr", None):
        return ""
    return str(report.longrepr).strip()[:700]


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "proguide_case(case_id): maps a pytest case to a ProGuide test case id")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo[Any]):
    outcome = yield
    report = outcome.get_result()
    setattr(item, f"rep_{report.when}", report)


@pytest.fixture(scope="session")
def proguide_base_url() -> str:
    return os.environ.get("PROGUIDE_BASE_URL", "http://localhost:3000").rstrip("/")


@pytest.fixture(scope="session")
def proguide_run_dir() -> Path:
    run_dir = Path(os.environ.get("PROGUIDE_RUN_DIR", ".proguide-run")).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir


@pytest.fixture
def proguide_steps(request: pytest.FixtureRequest, proguide_run_dir: Path) -> ProGuideStepRecorder:
    marker = request.node.get_closest_marker("proguide_case")
    case_id = marker.args[0] if marker and marker.args else request.node.name
    recorder = ProGuideStepRecorder(proguide_run_dir, str(case_id))
    return recorder


@pytest.fixture(scope="session")
def browser(proguide_run_dir: Path):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError("Playwright is required. Install with: python -m pip install -e \".[runner]\"") from exc

    browser_name = os.environ.get("PROGUIDE_BROWSER", "chromium")
    headless = os.environ.get("PROGUIDE_HEADLESS", "1") != "0"
    with sync_playwright() as playwright:
        browser_type = getattr(playwright, browser_name)
        browser_instance = browser_type.launch(headless=headless)
        yield browser_instance
        browser_instance.close()


@pytest.fixture
def page(request: pytest.FixtureRequest, browser: Any, proguide_run_dir: Path):
    marker = request.node.get_closest_marker("proguide_case")
    case_id = safe_id(str(marker.args[0] if marker and marker.args else request.node.name))
    video_enabled = os.environ.get("PROGUIDE_VIDEO", "on") == "on"
    trace_mode = os.environ.get("PROGUIDE_TRACES", "retain_on_failure")
    screenshot_mode = os.environ.get("PROGUIDE_SCREENSHOTS", "on_failure")

    context_kwargs: dict[str, Any] = {"viewport": {"width": 1366, "height": 768}}
    if video_enabled:
        video_dir = proguide_run_dir / "videos" / case_id
        video_dir.mkdir(parents=True, exist_ok=True)
        context_kwargs["record_video_dir"] = str(video_dir)
        context_kwargs["record_video_size"] = {"width": 1366, "height": 768}

    context = browser.new_context(**context_kwargs)
    if trace_mode in {"on", "retain_on_failure"}:
        context.tracing.start(screenshots=True, snapshots=True, sources=True)

    page_instance = context.new_page()
    yield page_instance

    report = getattr(request.node, "rep_call", None)
    failed = bool(getattr(report, "failed", False))
    if failed:
        case_status = "failed"
        case_message = _message_from_report(report) or "El caso fallo durante la ejecucion."
    elif bool(getattr(report, "skipped", False)):
        case_status = "inconclusive"
        case_message = _message_from_report(report) or "El caso fue omitido."
    elif report is None:
        case_status = "inconclusive"
        case_message = "No se obtuvo resultado del test."
    else:
        case_status = "passed"
        case_message = ""

    _append_event(
        proguide_run_dir,
        type="case_finished",
        status=case_status,
        message=case_message,
        case_id=case_id,
    )

    screenshot_path = proguide_run_dir / "screenshots" / f"{case_id}.png"
    if screenshot_mode == "on" or (screenshot_mode == "on_failure" and failed):
        screenshot_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            page_instance.screenshot(path=str(screenshot_path), full_page=True)
        except Exception:
            pass

    if trace_mode == "on" or (trace_mode == "retain_on_failure" and failed):
        trace_path = proguide_run_dir / "traces" / f"{case_id}.zip"
        trace_path.parent.mkdir(parents=True, exist_ok=True)
        context.tracing.stop(path=str(trace_path))
    elif trace_mode in {"retain_on_failure", "off"}:
        try:
            context.tracing.stop()
        except Exception:
            pass

    context.close()
