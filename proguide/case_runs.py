from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from proguide.agents.markdown_agent import interpret_markdown_with_llm
from proguide.evidence import write_evidence_report
from proguide.generator import generate_tests
from proguide.markdown_cases import cases_to_test_plan, mask_secret_text, parse_markdown_cases, read_markdown_text
from proguide.models import (
    AutomationState,
    CredentialSet,
    NormalizedMarkdownCase,
    RunEvent,
    RunMode,
    RunRecord,
    RunStatus,
    RunSummary,
    TestStatus,
    ToolConfig,
)
from proguide.paths import build_paths, ensure_layout
from proguide.planner import load_test_plan, save_test_plan
from proguide.prd import load_config
from proguide.runner import make_run_id, run_pytest
from proguide.utils import as_relative


RUN_JSON = "run.json"
SOURCE_MD = "source.md"
NORMALIZED_CASES_JSON = "normalized_cases.json"
TEST_PLAN_JSON = "test_plan.json"
EVENTS_JSONL = "events.jsonl"
RESULTS_JSON = "results.json"


def prepare_markdown_run(
    *,
    root: Path,
    source_md: Path,
    base_url: str,
    metadata: dict[str, Any] | None = None,
    use_agent: bool = False,
) -> tuple[RunRecord, list[NormalizedMarkdownCase]]:
    paths = build_paths(root)
    ensure_layout(paths)
    run_dir = _new_run_dir(paths.runs_dir)
    metadata = metadata or {}
    run = RunRecord(
        id=run_dir.name,
        status=RunStatus.interpreting,
        mode=RunMode.url,
        base_url=base_url.rstrip("/"),
        source_filename=source_md.name,
        app_name=metadata.get("app_name") or metadata.get("title"),
        ticket=metadata.get("ticket"),
        module=metadata.get("module"),
        title=metadata.get("title"),
        qa_owner=metadata.get("qa_owner"),
        dev_owner=metadata.get("dev_owner"),
        data_dir=str(run_dir),
    )

    run_dir.mkdir(parents=True, exist_ok=True)
    _save_run(run_dir, run)
    _append_event(run_dir, RunEvent(run_id=run.id, type="run_created", status=run.status.value, message="Run creado."))
    markdown = read_markdown_text(source_md)
    (run_dir / SOURCE_MD).write_text(mask_secret_text(markdown), encoding="utf-8")
    _append_event(run_dir, RunEvent(run_id=run.id, type="file_received", message=f"Archivo recibido: {source_md.name}"))

    config = load_config(paths.config_path)
    cases = _interpret_cases(markdown, source_name=source_md.name, config=config, use_agent=use_agent)
    for case in cases:
        if run.qa_owner and not case.qa_owner:
            case.qa_owner = run.qa_owner
        if run.dev_owner and not case.dev_owner:
            case.dev_owner = run.dev_owner
        if run.ticket and not case.ticket:
            case.ticket = run.ticket
    _save_cases(run_dir, cases)

    plan = cases_to_test_plan(cases, source_md=SOURCE_MD, app_name=run.app_name or "ProGuide Markdown Cases")
    save_test_plan(run_dir / TEST_PLAN_JSON, plan)

    run.status = RunStatus.ready
    run.total_cases = len(cases)
    _save_run(run_dir, run)
    _append_event(
        run_dir,
        RunEvent(
            run_id=run.id,
            type="cases_interpreted",
            status=run.status.value,
            message=f"{len(cases)} caso(s) interpretado(s).",
            payload={"ready": sum(1 for case in cases if case.automation_state == AutomationState.ready)},
        ),
    )
    return run, cases


def execute_prepared_run(
    *,
    root: Path,
    run_id: str,
    base_url: str | None = None,
    credentials: CredentialSet | None = None,
    create_pdf: bool = True,
) -> RunSummary:
    paths = build_paths(root)
    run_dir = paths.runs_dir / run_id
    run = load_run_record(run_dir)
    cases = load_normalized_cases(run_dir)
    config = load_config(paths.config_path)
    if config.runner.screenshots == "on_failure":
        config.runner.screenshots = "on"
    actual_base_url = (base_url or run.base_url).rstrip("/")
    if not actual_base_url:
        raise RuntimeError("base_url es obligatorio para ejecutar casos Markdown en modo URL.")

    run.status = RunStatus.generating
    run.base_url = actual_base_url
    run.started_at = datetime.now(timezone.utc).isoformat()
    _save_run(run_dir, run)
    _append_event(run_dir, RunEvent(run_id=run.id, type="plan_generated", status=run.status.value, message="Generando plan ejecutable."))

    plan = cases_to_test_plan(cases, source_md=SOURCE_MD, app_name=run.app_name or "ProGuide Markdown Cases")
    if not plan.cases:
        run.status = RunStatus.blocked
        run.finished_at = datetime.now(timezone.utc).isoformat()
        run.blocked = len(cases)
        _save_run(run_dir, run)
        _append_event(
            run_dir,
            RunEvent(
                run_id=run.id,
                type="error_global",
                status=run.status.value,
                message="No hay casos listos para ejecutar. Revisa normalized_cases.json.",
            ),
        )
        raise RuntimeError("No hay casos listos para ejecutar.")
    save_test_plan(run_dir / TEST_PLAN_JSON, plan)
    generated_dir = run_dir / "generated"
    generate_tests(plan, generated_dir)
    _append_event(run_dir, RunEvent(run_id=run.id, type="tests_generated", status=RunStatus.running.value, message="Tests generados."))

    run.status = RunStatus.running
    _save_run(run_dir, run)
    _append_event(run_dir, RunEvent(run_id=run.id, type="run_started", status=run.status.value, message="Ejecucion iniciada."))
    try:
        summary = run_pytest(
            tests_dir=generated_dir,
            run_dir=run_dir,
            plan=plan,
            base_url=actual_base_url,
            config=config,
            project_root=paths.root,
            credentials=credentials,
        )
    except Exception as exc:
        run.status = RunStatus.error
        run.finished_at = datetime.now(timezone.utc).isoformat()
        _save_run(run_dir, run)
        _append_event(run_dir, RunEvent(run_id=run.id, type="error_global", status=run.status.value, message=str(exc)))
        raise

    _save_summary(run_dir, summary)
    run.finished_at = summary.finished_at
    run.passed = summary.passed
    run.failed = summary.failed
    run.inconclusive = summary.inconclusive
    run.blocked = sum(1 for case in cases if case.automation_state != AutomationState.ready and not case.excluded)
    run.status = _status_from_summary(summary, run.blocked)

    html_path, pdf_path = write_evidence_report(
        summary=summary,
        run_record=run,
        cases=cases,
        run_dir=run_dir,
        create_pdf=create_pdf,
    )
    run.html_path = as_relative(html_path, run_dir)
    if pdf_path:
        run.pdf_path = as_relative(pdf_path, run_dir)
        _append_event(run_dir, RunEvent(run_id=run.id, type="pdf_generated", status=run.status.value, message="PDF de evidencia generado."))
    else:
        _append_event(run_dir, RunEvent(run_id=run.id, type="pdf_skipped", status=run.status.value, message="Se genero evidencia HTML; PDF no disponible."))
    _save_run(run_dir, run)
    _append_event(run_dir, RunEvent(run_id=run.id, type="run_finished", status=run.status.value, message="Run finalizado."))
    return summary


def save_cases_for_run(*, root: Path, run_id: str, cases_payload: list[dict[str, Any]]) -> list[NormalizedMarkdownCase]:
    paths = build_paths(root)
    run_dir = paths.runs_dir / run_id
    cases = [NormalizedMarkdownCase.model_validate(item) for item in cases_payload]
    _save_cases(run_dir, cases)
    plan = cases_to_test_plan(cases, source_md=SOURCE_MD, app_name=load_run_record(run_dir).app_name or "ProGuide Markdown Cases")
    save_test_plan(run_dir / TEST_PLAN_JSON, plan)
    _append_event(run_dir, RunEvent(run_id=run_id, type="cases_saved", status=RunStatus.ready.value, message="Cambios de preview guardados."))
    return cases


def list_run_records(root: Path) -> list[RunRecord]:
    paths = build_paths(root)
    if not paths.runs_dir.exists():
        return []
    records: list[RunRecord] = []
    for path in paths.runs_dir.glob(f"*/{RUN_JSON}"):
        try:
            records.append(load_run_record(path.parent))
        except Exception:
            continue
    return sorted(records, key=lambda run: run.created_at, reverse=True)


def load_run_bundle(root: Path, run_id: str) -> dict[str, Any]:
    paths = build_paths(root)
    run_dir = paths.runs_dir / run_id
    run = load_run_record(run_dir)
    cases = load_normalized_cases(run_dir) if (run_dir / NORMALIZED_CASES_JSON).exists() else []
    summary = load_summary(run_dir)
    events = load_events(run_dir)
    return {
        "run": run.model_dump(mode="json"),
        "cases": [case.model_dump(mode="json") for case in cases],
        "summary": summary.model_dump(mode="json") if summary else None,
        "events": [event.model_dump(mode="json") for event in events],
    }


def load_run_record(run_dir: Path) -> RunRecord:
    return RunRecord.model_validate(json.loads((run_dir / RUN_JSON).read_text(encoding="utf-8")))


def load_normalized_cases(run_dir: Path) -> list[NormalizedMarkdownCase]:
    data = json.loads((run_dir / NORMALIZED_CASES_JSON).read_text(encoding="utf-8"))
    return [NormalizedMarkdownCase.model_validate(item) for item in data]


def load_summary(run_dir: Path) -> RunSummary | None:
    path = run_dir / RESULTS_JSON
    if not path.exists():
        path = run_dir / "summary.json"
    if not path.exists():
        return None
    return RunSummary.model_validate(json.loads(path.read_text(encoding="utf-8")))


def load_events(run_dir: Path) -> list[RunEvent]:
    path = run_dir / EVENTS_JSONL
    if not path.exists():
        return []
    events: list[RunEvent] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            events.append(RunEvent.model_validate(json.loads(line)))
    return events


def _interpret_cases(markdown: str, *, source_name: str, config: ToolConfig, use_agent: bool) -> list[NormalizedMarkdownCase]:
    if use_agent:
        return interpret_markdown_with_llm(markdown, source_name=source_name, config=config)
    return parse_markdown_cases(markdown, source_name=source_name)


def _save_run(run_dir: Path, run: RunRecord) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / RUN_JSON).write_text(run.model_dump_json(indent=2), encoding="utf-8")


def _save_cases(run_dir: Path, cases: list[NormalizedMarkdownCase]) -> None:
    (run_dir / NORMALIZED_CASES_JSON).write_text(
        json.dumps([case.model_dump(mode="json") for case in cases], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def _save_summary(run_dir: Path, summary: RunSummary) -> None:
    (run_dir / RESULTS_JSON).write_text(summary.model_dump_json(indent=2), encoding="utf-8")


def _append_event(run_dir: Path, event: RunEvent) -> None:
    path = run_dir / EVENTS_JSONL
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(event.model_dump_json() + "\n")


def _new_run_dir(runs_dir: Path) -> Path:
    base_id = make_run_id()
    candidate = runs_dir / base_id
    suffix = 2
    while candidate.exists():
        candidate = runs_dir / f"{base_id}_{suffix}"
        suffix += 1
    return candidate


def _status_from_summary(summary: RunSummary, blocked: int) -> RunStatus:
    if summary.failed:
        return RunStatus.failed
    if summary.inconclusive:
        return RunStatus.inconclusive
    if blocked and not summary.results:
        return RunStatus.blocked
    if summary.passed and not summary.failed and not summary.inconclusive:
        return RunStatus.passed
    return RunStatus.finished
