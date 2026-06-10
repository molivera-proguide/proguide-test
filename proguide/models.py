from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class FrontendFramework(str, Enum):
    auto = "auto"
    vite = "vite"
    next = "next"
    angular = "angular"
    vue = "vue"
    react_cra = "react-cra"
    generic = "generic"
    unknown = "unknown"


class AppConfig(BaseModel):
    name: str = "Frontend App"
    type: Literal["frontend"] = "frontend"
    framework: FrontendFramework = FrontendFramework.auto
    start_command: str = "auto"
    base_url: str = "auto"
    ready_timeout_seconds: int = 60


class RunnerConfig(BaseModel):
    browser: Literal["chromium", "firefox", "webkit"] = "chromium"
    parallel_workers: str = "auto"
    video: Literal["on", "off"] = "on"
    screenshots: Literal["on", "off", "on_failure"] = "on_failure"
    traces: Literal["on", "off", "retain_on_failure"] = "retain_on_failure"


class LLMConfig(BaseModel):
    enabled: bool = True
    provider: Literal["openai", "anthropic", "disabled"] = "anthropic"
    model: str = "claude-haiku-4-5-20251001"
    temperature: float = 0.2
    max_cases: int = 12
    max_context_chars: int = 50000


class ToolConfig(BaseModel):
    app: AppConfig = Field(default_factory=AppConfig)
    runner: RunnerConfig = Field(default_factory=RunnerConfig)
    llm: LLMConfig = Field(default_factory=LLMConfig)


class UserCredentials(BaseModel):
    email: str | None = None
    username: str | None = None
    password: str | None = None


class Scenario(BaseModel):
    id: str
    title: str
    steps: list[str] = Field(default_factory=list)
    expected: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)

    @field_validator("steps", "expected", "tags", mode="before")
    @classmethod
    def coerce_list(cls, value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            return [value]
        return value


class Feature(BaseModel):
    id: str
    name: str
    route: str = "/"
    priority: Literal["low", "medium", "high", "critical"] = "medium"
    goal: str = ""
    success_signals: list[str] = Field(default_factory=list)
    scenarios: list[Scenario] = Field(default_factory=list)

    @field_validator("success_signals", mode="before")
    @classmethod
    def coerce_success_signals(cls, value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            return [value]
        return value


class PRDApp(BaseModel):
    name: str
    description: str = ""


class PRDDocument(BaseModel):
    model_config = ConfigDict(extra="allow")

    app: PRDApp
    users: dict[str, UserCredentials] = Field(default_factory=dict)
    features: list[Feature] = Field(default_factory=list)


class TestCase(BaseModel):
    id: str
    feature_id: str
    scenario_id: str
    title: str
    description: str
    route: str
    priority: str
    steps: list[str]
    expected: list[str]
    data: dict[str, Any] = Field(default_factory=dict)


class TestPlan(BaseModel):
    schema_version: str = "1.0"
    generated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    app_name: str
    source_prd: str
    cases: list[TestCase]


class AutomationState(str, Enum):
    ready = "listo"
    needs_review = "necesita_revision"
    not_automatable = "no_automatizable_aun"


class RunMode(str, Enum):
    url = "url"
    local_project = "proyecto_local"


class RunStatus(str, Enum):
    created = "created"
    interpreting = "interpreting"
    ready = "ready"
    generating = "generating"
    running = "running"
    passed = "passed"
    failed = "failed"
    blocked = "blocked"
    inconclusive = "inconclusive"
    setup_failed = "setup_failed"
    error = "error"
    finished = "finished"
    canceled = "canceled"


class RunEvent(BaseModel):
    run_id: str
    type: str
    status: str = ""
    message: str = ""
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    case_id: str | None = None
    step_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class CredentialSet(BaseModel):
    email: str | None = None
    username: str | None = None
    password: str | None = None
    alias: str | None = None
    persistence: Literal["ephemeral", "local_profile"] = "ephemeral"

    def masked(self) -> dict[str, str]:
        values = self.model_dump(exclude_none=True)
        if "password" in values:
            values["password"] = "******"
        return values


class NormalizedCaseStep(BaseModel):
    number: int
    original_text: str
    normalized_action: str = ""
    status: str = "pending"
    started_at: str | None = None
    finished_at: str | None = None
    duration_seconds: float = 0
    observed_result: str = ""
    screenshot: str | None = None
    error: str | None = None
    confidence: float = 1.0
    needs_review: bool = False
    review_reason: str = ""


class NormalizedMarkdownCase(BaseModel):
    id: str
    number: int
    title: str
    description: str = ""
    priority: str = "media"
    tags: list[str] = Field(default_factory=list)
    preconditions: list[str] = Field(default_factory=list)
    data_used: list[str] = Field(default_factory=list)
    data: dict[str, Any] = Field(default_factory=dict)
    original_steps: list[str] = Field(default_factory=list)
    executable_steps: list[NormalizedCaseStep] = Field(default_factory=list)
    expected_results: list[str] = Field(default_factory=list)
    confidence: float = 1.0
    automation_state: AutomationState = AutomationState.ready
    state_reason: str = ""
    original_markdown: str = ""
    route: str = "/"
    qa_owner: str | None = None
    dev_owner: str | None = None
    ticket: str | None = None
    excluded: bool = False
    parallelizable: bool = True
    result_obtained: str = ""
    status: str = "pending"
    started_at: str | None = None
    finished_at: str | None = None
    duration_seconds: float = 0
    artifacts: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("tags", "preconditions", "data_used", "original_steps", "expected_results", mode="before")
    @classmethod
    def coerce_string_list(cls, value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            return [value]
        return value


class RunRecord(BaseModel):
    id: str
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    started_at: str | None = None
    finished_at: str | None = None
    status: RunStatus = RunStatus.created
    mode: RunMode = RunMode.url
    base_url: str = ""
    source_filename: str = ""
    app_name: str | None = None
    ticket: str | None = None
    module: str | None = None
    title: str | None = None
    qa_owner: str | None = None
    dev_owner: str | None = None
    total_cases: int = 0
    passed: int = 0
    failed: int = 0
    blocked: int = 0
    inconclusive: int = 0
    setup_failed: int = 0
    pdf_path: str | None = None
    html_path: str | None = None
    data_dir: str = ""


class TestStatus(str, Enum):
    passed = "passed"
    failed = "failed"
    inconclusive = "inconclusive"
    setup_failed = "setup_failed"


class TestResult(BaseModel):
    id: str
    title: str
    status: TestStatus
    duration_seconds: float = 0
    message: str = ""
    steps: list[str] = Field(default_factory=list)
    expected: list[str] = Field(default_factory=list)
    videos: list[str] = Field(default_factory=list)
    screenshots: list[str] = Field(default_factory=list)
    traces: list[str] = Field(default_factory=list)


class RunSummary(BaseModel):
    run_id: str
    base_url: str
    started_at: str
    finished_at: str
    results: list[TestResult]

    @property
    def passed(self) -> int:
        return sum(1 for result in self.results if result.status == TestStatus.passed)

    @property
    def failed(self) -> int:
        return sum(1 for result in self.results if result.status == TestStatus.failed)

    @property
    def inconclusive(self) -> int:
        return sum(1 for result in self.results if result.status == TestStatus.inconclusive)

    @property
    def setup_failed(self) -> int:
        return sum(1 for result in self.results if result.status == TestStatus.setup_failed)
