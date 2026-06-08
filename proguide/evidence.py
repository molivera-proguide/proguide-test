from __future__ import annotations

from importlib import resources
from pathlib import Path

from jinja2 import Template

from proguide.models import NormalizedMarkdownCase, RunRecord, RunSummary


def write_evidence_report(
    *,
    summary: RunSummary,
    run_record: RunRecord,
    cases: list[NormalizedMarkdownCase],
    run_dir: Path,
    create_pdf: bool = True,
) -> tuple[Path, Path | None]:
    template_text = resources.files("proguide.templates").joinpath("evidence.html.j2").read_text(encoding="utf-8")
    html = Template(template_text).render(summary=summary, run=run_record, cases=cases)
    html_path = run_dir / "evidence.html"
    html_path.write_text(html, encoding="utf-8")

    pdf_path: Path | None = None
    if create_pdf:
        try:
            pdf_path = _html_to_pdf(html_path, run_dir / "evidence.pdf")
        except Exception:
            pdf_path = None
    return html_path, pdf_path


def _html_to_pdf(html_path: Path, pdf_path: Path) -> Path:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(html_path.resolve().as_uri(), wait_until="networkidle")
        page.pdf(path=str(pdf_path), format="A4", print_background=True, prefer_css_page_size=True)
        browser.close()
    return pdf_path
