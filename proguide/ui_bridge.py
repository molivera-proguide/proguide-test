from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from proguide.case_runs import (
    execute_prepared_run,
    list_run_records,
    load_run_bundle,
    prepare_markdown_run,
    save_cases_for_run,
)
from proguide.env import load_runtime_env
from proguide.models import CredentialSet


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="JSON bridge for the local ProGuide UI.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare")
    prepare.add_argument("--root", required=True)
    prepare.add_argument("--source", required=True)
    prepare.add_argument("--base-url", default="")
    prepare.add_argument("--metadata-json", default="{}")
    prepare.add_argument("--agent", action="store_true")

    save = subparsers.add_parser("save-cases")
    save.add_argument("--root", required=True)
    save.add_argument("--run-id", required=True)

    execute = subparsers.add_parser("execute")
    execute.add_argument("--root", required=True)
    execute.add_argument("--run-id", required=True)
    execute.add_argument("--base-url", default="")
    execute.add_argument("--no-pdf", action="store_true")

    history = subparsers.add_parser("history")
    history.add_argument("--root", required=True)

    run = subparsers.add_parser("run")
    run.add_argument("--root", required=True)
    run.add_argument("--run-id", required=True)

    args = parser.parse_args(argv)
    try:
        payload = _dispatch(args)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1
    print(json.dumps(payload))
    return 0


def _dispatch(args: argparse.Namespace) -> dict[str, Any]:
    root = Path(args.root).resolve()
    load_runtime_env(root)
    if args.command == "prepare":
        metadata = json.loads(args.metadata_json)
        run, cases = prepare_markdown_run(
            root=root,
            source_md=Path(args.source).resolve(),
            base_url=args.base_url,
            metadata=metadata,
            use_agent=bool(args.agent),
        )
        return {"run": run.model_dump(mode="json"), "cases": [case.model_dump(mode="json") for case in cases]}

    if args.command == "save-cases":
        data = json.loads(sys.stdin.read() or "{}")
        cases_payload = data.get("cases", data if isinstance(data, list) else [])
        cases = save_cases_for_run(root=root, run_id=args.run_id, cases_payload=cases_payload)
        return {"cases": [case.model_dump(mode="json") for case in cases]}

    if args.command == "execute":
        credentials = CredentialSet(
            email=os.environ.get("PROGUIDE_UI_EMAIL") or None,
            username=os.environ.get("PROGUIDE_UI_USERNAME") or None,
            password=os.environ.get("PROGUIDE_UI_PASSWORD") or None,
        )
        summary = execute_prepared_run(
            root=root,
            run_id=args.run_id,
            base_url=args.base_url or None,
            credentials=credentials,
            create_pdf=not args.no_pdf,
        )
        return {"summary": summary.model_dump(mode="json")}

    if args.command == "history":
        records = list_run_records(root)
        return {"runs": [record.model_dump(mode="json") for record in records]}

    if args.command == "run":
        return load_run_bundle(root, args.run_id)

    raise RuntimeError(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
