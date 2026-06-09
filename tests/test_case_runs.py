from __future__ import annotations

import json
from pathlib import Path

from proguide.case_runs import (
    EVENTS_JSONL,
    NORMALIZED_CASES_JSON,
    RUN_JSON,
    SOURCE_MD,
    TEST_PLAN_JSON,
    prepare_markdown_run,
)


def test_prepare_markdown_run_writes_contract_files(tmp_path: Path) -> None:
    source = tmp_path / "cases.md"
    source.write_text(
        """
## Caso 1: Login valido

### Datos utilizados
- Password: secreto

### Pasos
1. Ir a /login
2. Completar usuario valido
3. Completar password valido
4. Hacer clic en Ingresar

### Resultado esperado
- La URL contiene /home
""",
        encoding="utf-8",
    )

    run, cases = prepare_markdown_run(
        root=tmp_path,
        source_md=source,
        base_url="http://localhost:3000",
        metadata={"ticket": "ARQ-1", "qa_owner": "QA"},
        use_agent=False,
    )

    run_dir = Path(run.data_dir)
    assert len(cases) == 1
    assert cases[0].route == "/login"
    assert (run_dir / RUN_JSON).exists()
    assert (run_dir / SOURCE_MD).exists()
    assert (run_dir / NORMALIZED_CASES_JSON).exists()
    assert (run_dir / TEST_PLAN_JSON).exists()
    assert (run_dir / EVENTS_JSONL).exists()
    assert "secreto" not in (run_dir / SOURCE_MD).read_text(encoding="utf-8")
    assert "secreto" not in (run_dir / NORMALIZED_CASES_JSON).read_text(encoding="utf-8")

    run_payload = json.loads((run_dir / RUN_JSON).read_text(encoding="utf-8"))
    assert run_payload["status"] == "ready"
    assert run_payload["ticket"] == "ARQ-1"
    assert run_payload["total_cases"] == 1

    plan_payload = json.loads((run_dir / TEST_PLAN_JSON).read_text(encoding="utf-8"))
    assert plan_payload["cases"][0]["route"] == "/login"
    assert plan_payload["cases"][0]["steps"] == [
        "go to /login",
        "enter valid email",
        "enter valid password",
        "click button Ingresar",
    ]


def test_prepare_markdown_run_records_interpretation_events(tmp_path: Path) -> None:
    source = tmp_path / "cases.md"
    source.write_text(
        """
## Caso 1: Smoke

### Pasos
- Ir a /

### Resultado esperado
- La pagina muestra Home
""",
        encoding="utf-8",
    )

    run, _cases = prepare_markdown_run(root=tmp_path, source_md=source, base_url="http://example.test")

    events = [
        json.loads(line)["type"]
        for line in (Path(run.data_dir) / EVENTS_JSONL).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert events == ["run_created", "file_received", "cases_interpreted"]
