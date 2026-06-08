from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

import typer

from proguide.case_runs import execute_prepared_run, list_run_records, prepare_markdown_run
from proguide.agents.planner_agent import build_agentic_test_plan
from proguide.detector import DetectedProject, detect_project
from proguide.env import load_runtime_env
from proguide.feedback import activity
from proguide.generator import generate_tests
from proguide.markdown_cases import recommended_markdown_template
from proguide.models import LLMConfig, PRDDocument, TestPlan, ToolConfig
from proguide.models import CredentialSet
from proguide.paths import DEFAULT_PROGUIDE_DIR, build_paths, ensure_layout
from proguide.planner import build_test_plan, load_test_plan, save_test_plan
from proguide.prd import load_config, load_prd, save_config, save_normalized_prd, write_yaml
from proguide.reporter import write_html_report
from proguide.runner import make_run_id, run_pytest
from proguide.server import ServerManager, is_url_ready
from proguide.utils import as_relative


app = typer.Typer(help="CLI local para generar, ejecutar y documentar pruebas QA de frontend.")


@app.command(help="Crea la estructura inicial de ProGuide dentro del proyecto objetivo.")
def init(
    root: Path = typer.Option(Path("."), "--root", help="Raiz del proyecto frontend objetivo."),
    force: bool = typer.Option(False, "--force", help="Sobrescribe la configuracion y el PRD de ejemplo si ya existen."),
) -> None:
    paths = build_paths(root)
    ensure_layout(paths)

    if force or not paths.config_path.exists():
        save_config(paths.config_path, ToolConfig())

    if force or not paths.default_prd_path.exists():
        write_yaml(paths.default_prd_path, _sample_prd())

    typer.echo(f"Created layout at {as_relative(paths.proguide_dir, paths.root)}")
    typer.echo(f"Config: {as_relative(paths.config_path, paths.root)}")
    typer.echo(f"PRD: {as_relative(paths.default_prd_path, paths.root)}")


@app.command(help="Detecta framework, gestor de paquetes, comando de arranque y URL base.")
def detect(root: Path = typer.Option(Path("."), "--root", help="Raiz del proyecto frontend objetivo.")) -> None:
    detected = detect_project(root)
    typer.echo(f"Framework: {detected.framework.value}")
    typer.echo(f"Package manager: {detected.package_manager}")
    typer.echo(f"Start command: {detected.start_command or '(not found)'}")
    typer.echo(f"Base URL: {detected.base_url}")
    typer.echo(f"Reason: {detected.reason}")


@app.command("case-template", help="Escribe una plantilla Markdown recomendada para casos QA.")
def case_template(
    output: Path | None = typer.Option(None, "--output", "-o", help="Ruta donde guardar la plantilla Markdown."),
) -> None:
    template = recommended_markdown_template()
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(template, encoding="utf-8")
        typer.echo(f"Template: {output}")
        return
    typer.echo(template)


@app.command("case-interpret", help="Interpreta un archivo Markdown y crea un run editable sin ejecutar tests.")
def case_interpret(
    source: Path = typer.Option(..., "--source", "-s", help="Archivo Markdown con casos QA."),
    base_url: str = typer.Option("", "--base-url", help="URL objetivo para el run."),
    root: Path = typer.Option(Path("."), "--root", help="Raiz donde guardar proguide_tests/runs."),
    agent: bool = typer.Option(False, "--agent/--no-agent", help="Usa LLM para interpretar el Markdown."),
    ticket: str | None = typer.Option(None, "--ticket", help="Ticket o requerimiento asociado."),
    module: str | None = typer.Option(None, "--module", help="Modulo funcional."),
    title: str | None = typer.Option(None, "--title", help="Titulo del documento de evidencia."),
    qa_owner: str | None = typer.Option(None, "--qa-owner", help="Responsable QA."),
    dev_owner: str | None = typer.Option(None, "--dev-owner", help="Responsable desarrollo."),
) -> None:
    _require_file(source, "el Markdown de casos", "Crea un archivo .md o ejecuta `proguide case-template -o casos.md`.")
    load_runtime_env(root)
    try:
        with activity("Interpretando casos Markdown...", "Casos Markdown interpretados."):
            run, cases = prepare_markdown_run(
                root=root,
                source_md=source,
                base_url=base_url,
                metadata={
                    "ticket": ticket,
                    "module": module,
                    "title": title,
                    "qa_owner": qa_owner,
                    "dev_owner": dev_owner,
                },
                use_agent=agent,
            )
    except Exception as exc:
        typer.secho("No pude interpretar el Markdown.", fg=typer.colors.RED)
        typer.echo(str(exc))
        raise typer.Exit(1) from exc
    ready = sum(1 for case in cases if case.automation_state.value == "listo")
    typer.echo(f"Run: {run.id}")
    typer.echo(f"Cases: {len(cases)} | Ready: {ready} | Needs review: {len(cases) - ready}")
    typer.echo(f"Preview file: {Path(run.data_dir) / 'normalized_cases.json'}")


@app.command("case-run", help="Ejecuta casos Markdown normalizados contra una URL sin PRD ni codigo fuente.")
def case_run(
    source: Path = typer.Option(..., "--source", "-s", help="Archivo Markdown con casos QA."),
    base_url: str = typer.Option(..., "--base-url", help="URL objetivo."),
    root: Path = typer.Option(Path("."), "--root", help="Raiz donde guardar proguide_tests/runs."),
    agent: bool = typer.Option(False, "--agent/--no-agent", help="Usa LLM para interpretar el Markdown."),
    email: str | None = typer.Option(None, "--email", help="Email para login simple."),
    username: str | None = typer.Option(None, "--username", help="Usuario para login simple."),
    password: str | None = typer.Option(None, "--password", help="Password para login simple. No se guarda en claro."),
    ticket: str | None = typer.Option(None, "--ticket", help="Ticket o requerimiento asociado."),
    module: str | None = typer.Option(None, "--module", help="Modulo funcional."),
    title: str | None = typer.Option(None, "--title", help="Titulo del documento de evidencia."),
    qa_owner: str | None = typer.Option(None, "--qa-owner", help="Responsable QA."),
    dev_owner: str | None = typer.Option(None, "--dev-owner", help="Responsable desarrollo."),
    pdf: bool = typer.Option(True, "--pdf/--no-pdf", help="Genera evidencia PDF ademas de HTML."),
) -> None:
    _require_file(source, "el Markdown de casos", "Crea un archivo .md o ejecuta `proguide case-template -o casos.md`.")
    _require_runner_dependencies()
    load_runtime_env(root)
    credentials = CredentialSet(email=email, username=username, password=password)
    try:
        with activity("Preparando run Markdown...", "Run Markdown preparado."):
            run, cases = prepare_markdown_run(
                root=root,
                source_md=source,
                base_url=base_url,
                metadata={
                    "ticket": ticket,
                    "module": module,
                    "title": title,
                    "qa_owner": qa_owner,
                    "dev_owner": dev_owner,
                },
                use_agent=agent,
            )
        typer.echo(f"Run: {run.id}")
        review = [case for case in cases if case.automation_state.value != "listo"]
        if review:
            typer.echo(f"{len(review)} caso(s) requieren revision y no se ejecutaran.")
        with activity("Ejecutando casos Markdown con Playwright...", "Ejecucion Markdown finalizada."):
            summary = execute_prepared_run(
                root=root,
                run_id=run.id,
                base_url=base_url,
                credentials=credentials,
                create_pdf=pdf,
            )
    except Exception as exc:
        typer.secho("No pude ejecutar los casos Markdown.", fg=typer.colors.RED)
        typer.echo(str(exc))
        raise typer.Exit(1) from exc
    run_dir = build_paths(root).runs_dir / run.id
    typer.echo(_summary_line(summary))
    typer.echo(f"Results: {run_dir / 'results.json'}")
    typer.echo(f"Evidence HTML: {run_dir / 'evidence.html'}")
    if (run_dir / "evidence.pdf").exists():
        typer.echo(f"Evidence PDF: {run_dir / 'evidence.pdf'}")


@app.command("runs", help="Lista el historial local de runs.")
def runs(root: Path = typer.Option(Path("."), "--root", help="Raiz donde se guarda proguide_tests/runs.")) -> None:
    records = list_run_records(root)
    if not records:
        typer.echo("No hay runs guardados.")
        return
    for record in records:
        typer.echo(
            f"{record.id} | {record.status.value} | cases={record.total_cases} | "
            f"passed={record.passed} failed={record.failed} inconclusive={record.inconclusive} | "
            f"{record.base_url or '-'} | {record.source_filename or '-'}"
        )


@app.command("ui", help="Levanta la UI local Fastify para ProGuide Test Cases.")
def ui(
    root: Path = typer.Option(Path("."), "--root", help="Raiz donde guardar y leer proguide_tests/runs."),
    host: str = typer.Option("127.0.0.1", "--host", help="Host local para Fastify."),
    port: int = typer.Option(8787, "--port", help="Puerto local para Fastify."),
    install: bool = typer.Option(False, "--install", help="Instala dependencias npm de la UI antes de iniciar."),
) -> None:
    ui_dir = Path(__file__).resolve().parent.parent / "ui"
    package_json = ui_dir / "package.json"
    if not package_json.exists():
        typer.secho(f"No encontre la UI Fastify en {ui_dir}", fg=typer.colors.RED)
        raise typer.Exit(1)
    npm = _resolve_npm_executable()
    if install or not (ui_dir / "node_modules").exists():
        if not install:
            typer.secho("Faltan dependencias npm de la UI.", fg=typer.colors.RED)
            typer.echo(f"Ejecuta: {npm} --prefix {ui_dir} install")
            typer.echo("O inicia con: proguide ui --install")
            raise typer.Exit(1)
        typer.echo("Instalando dependencias npm de la UI...")
        completed = subprocess.run([npm, "install"], cwd=ui_dir, text=True, check=False)
        if completed.returncode != 0:
            raise typer.Exit(completed.returncode)

    env = os.environ.copy()
    env["PROGUIDE_UI_ROOT"] = str(root.resolve())
    env["PROGUIDE_UI_HOST"] = host
    env["PROGUIDE_UI_PORT"] = str(port)
    env["PROGUIDE_PYTHON"] = sys.executable
    env["PYTHONPATH"] = os.pathsep.join([str(Path(__file__).resolve().parent.parent), env.get("PYTHONPATH", "")]).strip(os.pathsep)
    typer.echo(f"UI local: http://{host}:{port}")
    completed = subprocess.run([npm, "start"], cwd=ui_dir, env=env, text=True, check=False)
    raise typer.Exit(completed.returncode)


@app.command(help="Lee el PRD compacto y genera un plan de pruebas en JSON.")
def plan(
    prd: Path = typer.Option(Path(DEFAULT_PROGUIDE_DIR) / "prd" / "prd.yaml", "--prd", help="Ruta del PRD compacto en YAML."),
    root: Path = typer.Option(Path("."), "--root", help="Raiz del proyecto frontend objetivo."),
    output: Path | None = typer.Option(None, "--output", help="Ruta de salida para el plan de pruebas JSON."),
    agent: bool = typer.Option(True, "--agent/--no-agent", help="Usa el agente LLM para expandir el plan de pruebas."),
) -> None:
    paths = build_paths(root)
    _require_file(
        prd,
        "el PRD",
        "Ejecuta `proguide init` en el proyecto objetivo y luego edita `proguide_tests/prd/prd.yaml`.",
    )
    plan_path = output or paths.default_plan_path
    load_runtime_env(paths.root)
    prd_doc = load_prd(prd)
    config = load_config(paths.config_path)
    test_plan = _build_plan(prd_doc, as_relative(prd, paths.root), config, paths.root, agent)
    save_test_plan(plan_path, test_plan)
    save_normalized_prd(paths.prd_dir / "normalized_prd.json", prd_doc)
    typer.echo(f"Planned {len(test_plan.cases)} test case(s): {as_relative(plan_path, paths.root)}")


@app.command(help="Genera archivos pytest/Playwright versionables a partir del plan de pruebas.")
def generate(
    prd: Path = typer.Option(Path(DEFAULT_PROGUIDE_DIR) / "prd" / "prd.yaml", "--prd", help="Ruta del PRD compacto en YAML."),
    root: Path = typer.Option(Path("."), "--root", help="Raiz del proyecto frontend objetivo."),
    plan_path: Path | None = typer.Option(None, "--plan", help="Ruta de un plan de pruebas JSON existente."),
    output_dir: Path | None = typer.Option(None, "--output-dir", help="Carpeta donde se escriben los tests generados."),
    agent: bool = typer.Option(True, "--agent/--no-agent", help="Usa el agente LLM si hace falta crear el plan."),
) -> None:
    paths = build_paths(root)
    actual_plan_path = plan_path or paths.default_plan_path
    actual_output_dir = output_dir or paths.generated_dir
    if actual_plan_path.exists():
        test_plan = load_test_plan(actual_plan_path)
    else:
        _require_file(
            prd,
            "el PRD",
            "Ejecuta `proguide init` en el proyecto objetivo y luego edita `proguide_tests/prd/prd.yaml`.",
        )
        load_runtime_env(paths.root)
        prd_doc = load_prd(prd)
        config = load_config(paths.config_path)
        test_plan = _build_plan(prd_doc, as_relative(prd, paths.root), config, paths.root, agent)
        save_test_plan(actual_plan_path, test_plan)

    written = _generate_tests_with_feedback(test_plan, actual_output_dir)
    typer.echo(f"Generated {len(written)} file(s) in {as_relative(actual_output_dir, paths.root)}")


@app.command(help="Levanta el frontend, ejecuta los tests generados y crea el reporte HTML.")
def run(
    root: Path = typer.Option(Path("."), "--root", help="Raiz del proyecto frontend objetivo."),
    plan_path: Path | None = typer.Option(None, "--plan", help="Ruta del plan de pruebas JSON."),
    tests_dir: Path | None = typer.Option(None, "--tests-dir", help="Carpeta de tests generados."),
    reuse_existing: bool = typer.Option(False, "--reuse-existing", help="Usa una app ya levantada si la URL base responde."),
) -> None:
    paths = build_paths(root)
    ensure_layout(paths)
    actual_plan_path = plan_path or paths.default_plan_path
    _require_file(
        actual_plan_path,
        "el plan de pruebas",
        "Ejecuta `proguide plan --prd proguide_tests/prd/prd.yaml` o usa `proguide test` para el flujo completo.",
    )
    test_plan = load_test_plan(actual_plan_path)
    config = load_config(paths.config_path)
    detected = detect_project(paths.root)
    command, base_url = _resolve_server(config, detected)
    _require_runner_dependencies()
    run_dir = paths.runs_dir / make_run_id()

    if reuse_existing and is_url_ready(base_url):
        resolved_url = base_url
        typer.echo(f"Frontend existente detectado: {resolved_url}")
        summary = _run_pytest_with_feedback(
            tests_dir=tests_dir or paths.generated_dir,
            run_dir=run_dir,
            plan=test_plan,
            base_url=resolved_url,
            config=config,
            project_root=paths.root,
        )
    else:
        server = ServerManager(
            root=paths.root,
            command=command,
            base_url=base_url,
            ready_timeout_seconds=config.app.ready_timeout_seconds,
            log_path=run_dir / "server.log",
        )
        try:
            with activity("Levantando servidor frontend local...", "Servidor frontend listo."):
                resolved_url = server.start()
            typer.echo(f"Frontend listo: {resolved_url}")
            summary = _run_pytest_with_feedback(
                tests_dir=tests_dir or paths.generated_dir,
                run_dir=run_dir,
                plan=test_plan,
                base_url=resolved_url,
                config=config,
                project_root=paths.root,
            )
        finally:
            server.stop()

    report_path = write_html_report(summary, run_dir)
    typer.echo(_summary_line(summary))
    typer.echo(f"Report: {as_relative(report_path, paths.root)}")


@app.command(help="Ejecuta el flujo completo: planifica, genera, levanta servidor, corre tests y reporta.")
def test(
    prd: Path = typer.Option(Path(DEFAULT_PROGUIDE_DIR) / "prd" / "prd.yaml", "--prd", help="Ruta del PRD compacto en YAML."),
    root: Path = typer.Option(Path("."), "--root", help="Raiz del proyecto frontend objetivo."),
    reuse_existing: bool = typer.Option(False, "--reuse-existing", help="Usa una app ya levantada si la URL base responde."),
    agent: bool = typer.Option(True, "--agent/--no-agent", help="Usa el agente LLM para expandir el plan de pruebas."),
) -> None:
    paths = build_paths(root)
    ensure_layout(paths)
    _require_file(
        prd,
        "el PRD",
        "Ejecuta `proguide init` en el proyecto objetivo y luego edita `proguide_tests/prd/prd.yaml`.",
    )
    load_runtime_env(paths.root)
    prd_doc = load_prd(prd)
    config = load_config(paths.config_path)
    test_plan = _build_plan(prd_doc, as_relative(prd, paths.root), config, paths.root, agent)
    save_test_plan(paths.default_plan_path, test_plan)
    save_normalized_prd(paths.prd_dir / "normalized_prd.json", prd_doc)
    _generate_tests_with_feedback(test_plan, paths.generated_dir)
    detected = detect_project(paths.root)
    command, base_url = _resolve_server(config, detected)
    _require_runner_dependencies()
    run_dir = paths.runs_dir / make_run_id()

    if reuse_existing and is_url_ready(base_url):
        resolved_url = base_url
        typer.echo(f"Frontend existente detectado: {resolved_url}")
        summary = _run_pytest_with_feedback(
            tests_dir=paths.generated_dir,
            run_dir=run_dir,
            plan=test_plan,
            base_url=resolved_url,
            config=config,
            project_root=paths.root,
        )
    else:
        server = ServerManager(
            root=paths.root,
            command=command,
            base_url=base_url,
            ready_timeout_seconds=config.app.ready_timeout_seconds,
            log_path=run_dir / "server.log",
        )
        try:
            with activity("Levantando servidor frontend local...", "Servidor frontend listo."):
                resolved_url = server.start()
            typer.echo(f"Frontend listo: {resolved_url}")
            summary = _run_pytest_with_feedback(
                tests_dir=paths.generated_dir,
                run_dir=run_dir,
                plan=test_plan,
                base_url=resolved_url,
                config=config,
                project_root=paths.root,
            )
        finally:
            server.stop()

    report_path = write_html_report(summary, run_dir)
    typer.echo(f"Planned and generated {len(test_plan.cases)} test case(s).")
    typer.echo(_summary_line(summary))
    typer.echo(f"Report: {as_relative(report_path, paths.root)}")


@app.command("agent-check", help="Verifica configuracion, dependencias y API key del agente LLM.")
def agent_check(root: Path = typer.Option(Path("."), "--root", help="Raiz del proyecto frontend objetivo.")) -> None:
    paths = build_paths(root)
    loaded = load_runtime_env(paths.root)
    config = _with_default_llm(load_config(paths.config_path))
    try:
        _require_agent_ready(config)
    except RuntimeError as exc:
        typer.secho(str(exc), fg=typer.colors.RED)
        raise typer.Exit(1) from exc
    env_note = " .env cargado." if loaded else ""
    typer.echo(f"Agente listo: provider={config.llm.provider}, model={config.llm.model}.{env_note}")


def _resolve_server(config: ToolConfig, detected: DetectedProject) -> tuple[str, str]:
    command = detected.start_command if config.app.start_command == "auto" else config.app.start_command
    base_url = detected.base_url if config.app.base_url == "auto" else config.app.base_url
    if not command:
        typer.secho("No encontre un comando para levantar el frontend.", fg=typer.colors.RED)
        typer.echo(f"Raiz analizada: {detected.root}")
        typer.echo(f"Motivo: {detected.reason}")
        typer.echo("Soluciones:")
        typer.echo("1. Ejecuta el comando desde la raiz del proyecto frontend objetivo.")
        typer.echo("2. O configura app.start_command y app.base_url en proguide_tests/config.yaml.")
        raise typer.Exit(1)
    return command, base_url


def _summary_line(summary) -> str:
    return f"Passed: {summary.passed} | Failed: {summary.failed} | Inconclusive: {summary.inconclusive}"


def _build_plan(prd_doc: PRDDocument, source_prd: str, config: ToolConfig, root: Path, use_agent: bool) -> TestPlan:
    if not use_agent:
        return build_test_plan(prd_doc, source_prd)
    config = _with_default_llm(config)
    try:
        with activity("Agente creando plan de pruebas...", "Plan del agente generado."):
            return build_agentic_test_plan(prd_doc, source_prd, config, root)
    except Exception as exc:
        typer.secho("No pude ejecutar el agente planificador.", fg=typer.colors.RED)
        typer.echo(str(exc))
        typer.echo("Puedes resolverlo o correr en modo deterministico con `--no-agent`.")
        raise typer.Exit(1) from exc


def _generate_tests_with_feedback(test_plan: TestPlan, output_dir: Path) -> list[Path]:
    with activity("Generando tests Playwright en Python...", "Tests generados."):
        return generate_tests(test_plan, output_dir)


def _run_pytest_with_feedback(
    *,
    tests_dir: Path,
    run_dir: Path,
    plan: TestPlan,
    base_url: str,
    config: ToolConfig,
    project_root: Path,
):
    with activity(f"Ejecutando {len(plan.cases)} test(s) con Playwright...", "Ejecucion de tests finalizada."):
        return run_pytest(
            tests_dir=tests_dir,
            run_dir=run_dir,
            plan=plan,
            base_url=base_url,
            config=config,
            project_root=project_root,
        )


def _with_default_llm(config: ToolConfig) -> ToolConfig:
    if config.llm.provider == "disabled":
        config.llm = LLMConfig()
    return config


def _require_agent_ready(config: ToolConfig) -> None:
    from proguide.agents.planner_agent import _require_llm_ready

    _require_llm_ready(_with_default_llm(config))


def _require_file(path: Path, label: str, recovery: str) -> None:
    if path.exists():
        return
    typer.secho(f"No encontre {label}: {path}", fg=typer.colors.RED)
    typer.echo(recovery)
    raise typer.Exit(1)


def _resolve_npm_executable() -> str:
    npm = shutil.which("npm.cmd") if os.name == "nt" else None
    npm = npm or shutil.which("npm")
    if npm:
        return npm
    typer.secho("No encontre npm en PATH.", fg=typer.colors.RED)
    typer.echo("Instala Node.js/npm o abre una terminal donde `npm --version` funcione.")
    raise typer.Exit(1)


def _require_runner_dependencies() -> None:
    if importlib.util.find_spec("playwright") is not None:
        return
    typer.secho("Falta Playwright en el entorno donde esta instalado ProGuide.", fg=typer.colors.RED)
    typer.echo("Instala las dependencias del runner con:")
    typer.echo(f"{sys.executable} -m pip install -e \".[runner]\"")
    typer.echo("Luego instala el navegador:")
    typer.echo(f"{sys.executable} -m playwright install chromium")
    raise typer.Exit(1)


def _sample_prd() -> dict:
    return {
        "app": {
            "name": "Demo Login",
            "description": "Frontend app with login and authenticated home.",
        },
        "users": {
            "default": {
                "email": "test@example.com",
                "password": "password123",
            }
        },
        "features": [
            {
                "id": "auth_login",
                "name": "Login",
                "route": "/login",
                "priority": "high",
                "goal": "User can sign in and access home.",
                "success_signals": [
                    "url contains /home",
                    "page shows Dashboard",
                ],
                "scenarios": [
                    {
                        "id": "valid_login",
                        "title": "Valid user logs in",
                        "steps": [
                            "go to login page",
                            "enter valid email",
                            "enter valid password",
                            "submit form",
                        ],
                        "expected": [
                            "user is redirected to home",
                            "authenticated content is visible",
                        ],
                    }
                ],
            }
        ],
    }


if __name__ == "__main__":
    app()
