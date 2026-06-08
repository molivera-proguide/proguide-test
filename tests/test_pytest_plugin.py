from __future__ import annotations

import json
from pathlib import Path

from proguide.pytest_plugin import ProGuideStepRecorder
from proguide.utils import safe_id


def test_step_recorder_emits_case_and_step_events(tmp_path: Path) -> None:
    recorder = ProGuideStepRecorder(tmp_path, "fallback case")

    recorder.set_case("Caso 1 Login", "Mostrar login cuando no hay sesion")
    recorder.log("Ir a /login", "started")
    recorder.log("Ir a /login", "passed")

    events = [
        json.loads(line)
        for line in (tmp_path / "events.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]

    assert [event["type"] for event in events] == ["case_started", "step_started", "step_finished"]
    assert {event["case_id"] for event in events} == {safe_id("Caso 1 Login")}
    assert events[0]["status"] == "running"
    assert events[1]["payload"] == {"step": "Ir a /login", "step_status": "started"}
    assert events[2]["payload"] == {"step": "Ir a /login", "step_status": "passed"}
