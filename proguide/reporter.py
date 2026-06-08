from __future__ import annotations

from importlib import resources
from pathlib import Path

from jinja2 import Template

from proguide.models import RunSummary


def write_html_report(summary: RunSummary, run_dir: Path) -> Path:
    template_text = resources.files("proguide.templates").joinpath("report.html.j2").read_text(encoding="utf-8")
    report = Template(template_text).render(summary=summary)
    report_path = run_dir / "report.html"
    report_path.write_text(report, encoding="utf-8")
    return report_path
