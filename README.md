# ProGuide Test E2E

ProGuide Test is a local-first QA tool. It lets a QA agent pass Markdown test cases to a CLI/MCP server, generate Python pytest + Playwright code, run it against a real app, and inspect results in a local Fastify viewer.

## QA Quick Start

Use this section if you only want to install and run ProGuide against an application. You do not need the ProGuide source repository.

### Prerequisites

- Node.js 20 or newer.
- Python 3.12 or compatible available on the machine.

ProGuide creates and maintains its own Python runtime under the user profile. QA users do not install `pytest`, `playwright`, or browsers manually.

### Install From GitHub Release

For public or internally accessible GitHub Releases:

```bash
npm install -g https://github.com/molivera-proguide/proguide-test/releases/download/v0.1.1/proguide-test-0.1.1.tgz
```

For private repositories:

```bash
gh release download v0.1.1 --repo molivera-proguide/proguide-test --pattern "proguide-test-*.tgz" --dir .
npm install -g ./proguide-test-0.1.1.tgz
```

### Configure Your QA Workspace

Run ProGuide from the app or workspace you want to test. This is the workspace root, not the ProGuide tool source.

Example:

```text
C:\QA\frontend-app\
  .env
  proguide_tests\
    config.yaml
    runs\
```

Put the company Anthropic/Claude key in `C:\QA\frontend-app\.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...
```

ProGuide also accepts these aliases:

```env
API_KEY=sk-ant-...
PROGUIDE_LLM_API_KEY=sk-ant-...
```

The LLM provider/model is maintained by the ProGuide tool. QA users only provide the API key. The current default is Anthropic Claude Sonnet.

```powershell
cd C:\QA\frontend-app
proguide doctor --json
```

The first `doctor`, `run`, or MCP execution can take a few minutes because ProGuide creates its managed Python runtime, installs `pytest`/`playwright`, and installs Chromium. After that, QA only needs the API key.

`proguide doctor --json` should return actionable checks for Node, the managed Python runtime, API key, viewer port, and run storage.

### Use CLI Directly

Create a run from Markdown without executing:

```powershell
@'
## Caso 1 - Login exitoso

Criticidad: alta
Descripcion: Valida que un usuario pueda iniciar sesion.

Pasos:
- Abrir /login
- Completar usuario y password validos
- Enviar el formulario

Resultado esperado:
- Se muestra el dashboard
'@ | proguide create --stdin --base-url http://localhost:3000 --json
```

Execute cases against a running app:

```powershell
@'
## Caso 1 - Login exitoso

Criticidad: alta
Descripcion: Valida que un usuario pueda iniciar sesion.

Pasos:
- Abrir /login
- Completar usuario y password validos
- Enviar el formulario

Resultado esperado:
- Se muestra el dashboard
'@ | proguide run --stdin --base-url http://localhost:3000 --json
```

Useful commands:

```bash
proguide execute <run_id> --json
proguide get-run <run_id> --json
proguide get-code <run_id> <case_id> --json
proguide list-runs --limit 20 --json
proguide viewer --json
```

The JSON response includes `run_url`. Open it to inspect status, generated Python code, evidence, and results.

### Use With Claude Code

Register ProGuide as a Claude Code MCP server from the QA workspace/app under test. This mirrors the TestSprite-style setup: the QA user only passes `API_KEY`.

```powershell
cd C:\QA\frontend-app
claude mcp add --transport stdio --env API_KEY=your_api_key proguide-test -- proguide mcp
```

If the API key is already in `C:\QA\frontend-app\.env`, the command can omit it:

```powershell
cd C:\QA\frontend-app
claude mcp add --transport stdio proguide-test -- proguide mcp
```

Claude Code provides the project directory to MCP servers; ProGuide uses that automatically. `PROGUIDE_MCP_ROOT` is only an advanced override.

### Use With Cursor

Create `.cursor/mcp.json` in the QA workspace/app under test:

```json
{
  "mcpServers": {
    "proguide-test": {
      "command": "proguide",
      "args": ["mcp"],
      "env": {
        "API_KEY": "your_api_key"
      }
    }
  }
}
```

If the API key is already in `.env`, omit the `env` block:

```json
{
  "mcpServers": {
    "proguide-test": {
      "command": "proguide",
      "args": ["mcp"]
    }
  }
}
```

### Agent Setup Snippets

The CLI can print setup snippets for Claude Code, Cursor, and generic MCP clients:

```bash
proguide agent-setup
proguide agent-setup --client claude-code
proguide agent-setup --client cursor --json
proguide agent-setup --client generic --json
```

Then ask Claude Code:

```text
Usa ProGuide para crear un run desde estos casos Markdown, ejecutarlo contra http://localhost:3000 y devolverme el run_url.
```

Available MCP tools:

| Tool | Description |
| --- | --- |
| `run_markdown_cases` | Imports QA Markdown cases, generates Python Playwright code, executes pytest/Playwright, and returns run evidence. |
| `create_run_from_markdown` | Imports QA Markdown cases and returns a `run_id` without executing. |
| `execute_run` | Generates code and executes an existing run. |
| `get_run` | Reads run status, cases, events, and summary. |
| `get_generated_code` | Reads generated Python code for a case. |
| `list_runs` | Lists local runs. |

The result viewer defaults to `http://127.0.0.1:8787/runs`. If that port is occupied, ProGuide automatically tries the following ports. Use `PROGUIDE_VIEWER_PORT` only when you need to force a specific port.

## Developer Guide

Use this section if you are changing ProGuide itself.

### Local Setup

Install Python development dependencies:

```bash
python -m pip install -e ".[dev,runner,llm]"
python -m playwright install chromium
```

Install Node dependencies:

```bash
npm --prefix ui install
```

Configure local development keys in the repository `.env`:

```env
OPENAI_API_KEY=sk-...
```

OpenAI remains supported for local development. Company QA usage should prefer `llm.provider: anthropic`.

### Run Tests

Python suite:

```bash
python -m pytest
```

Node CLI/MCP smoke tests:

```bash
npm --prefix ui test
```

Syntax and packaging checks:

```bash
node --check ui/cli.js
node --check ui/mcp-server.js
node --check ui/viewer.js
node --check ui/server.js
node --check ui/proguide-service.js
npm --prefix ui run proguide -- doctor --json
cd ui
npm pack --dry-run
```

### Develop The Node CLI/MCP

From the ProGuide source checkout:

```bash
npm --prefix ui run proguide -- doctor --json
npm --prefix ui run proguide -- create --stdin --base-url http://localhost:3000 --json
npm --prefix ui run proguide -- execute <run_id> --json
npm --prefix ui run proguide -- get-run <run_id> --json
npm --prefix ui run proguide -- viewer --json
```

Start MCP from the source checkout:

```bash
PROGUIDE_MCP_ROOT="$PWD" npm --prefix ui run mcp
```

Start the Fastify viewer from source:

```bash
PROGUIDE_UI_ROOT="$PWD" npm --prefix ui start
```

### Package For GitHub Release

The package name is `@proguide/test` and it exposes the `proguide` binary.

Package locally:

```bash
cd ui
npm pack
```

`npm pack` runs `ui/scripts/sync-python-runtime.js` before packaging. That copies the Python support package from `proguide/` into `ui/python/` so QA users do not need the source repository.

### Publish With GitHub Actions

CI for pull requests and pushes under `ui/` is defined in:

```text
.github/workflows/ui-ci.yml
```

The release workflow is:

```text
.github/workflows/release-cli.yml
```

Create a release by pushing a version tag:

```bash
git tag v0.1.1
git push origin v0.1.1
```

The workflow runs tests, creates `proguide-test-0.1.1.tgz`, uploads it as a workflow artifact, and attaches it to the GitHub Release.

### Data Contract

Runs are stored under the QA workspace:

```text
proguide_tests/
  config.yaml
  runs/
    <run_id>/
      run.json
      source.md
      normalized_cases.json
      test_plan.json
      events.jsonl
      results.json
      generated/
      artifacts/
```

Passwords entered through CLI/MCP are passed to the runner process as environment variables and should not be persisted. Markdown-derived secret-looking lines are masked, for example `Password: ******`.

### Legacy Python CLI

The repository still includes the original Python CLI for PRD-based flows:

```bash
proguide init
proguide detect
proguide plan --prd proguide_tests/prd/prd.yaml
proguide generate --prd proguide_tests/prd/prd.yaml
proguide run
proguide test --prd proguide_tests/prd/prd.yaml
```

The current MCP/agent MVP uses the Node CLI in `ui/` as the distributable entrypoint.
