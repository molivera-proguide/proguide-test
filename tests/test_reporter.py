from __future__ import annotations

from pathlib import Path

from proguide.models import RunSummary, TestResult as ProGuideTestResult, TestStatus as ProGuideTestStatus
from proguide.reporter import write_html_report


def test_writes_html_report(tmp_path: Path) -> None:
    summary = RunSummary(
        run_id="run-1",
        base_url="http://localhost:5173",
        started_at="2026-06-04T00:00:00Z",
        finished_at="2026-06-04T00:00:10Z",
        results=[
            ProGuideTestResult(
                id="auth_login_valid_login",
                title="Valid user logs in",
                status=ProGuideTestStatus.passed,
                steps=["passed: submit form"],
                expected=["user is redirected to home"],
                videos=["videos/auth/video.webm"],
            )
        ],
    )

    report_path = write_html_report(summary, tmp_path)

    html = report_path.read_text(encoding="utf-8")
    assert "ProGuide QA Report" in html
    assert "Valid user logs in" in html
    assert "videos/auth/video.webm" in html
