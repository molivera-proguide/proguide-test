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
npm install -g https://github.com/molivera-proguide/proguide-test/releases/download/v0.1.6/proguide-test-0.1.6.tgz
```

For private repositories:

```bash
gh release download v0.1.6 --repo molivera-proguide/proguide-test --pattern "proguide-test-*.tgz" --dir .
npm install -g ./proguide-test-0.1.6.tgz
```

### Configure Your QA Workspace

Run ProGuide from the app or workspace you want to test. This is the workspace root, not the ProGuide tool source.

Example:

```text
C:\QA\frontend-app\
  proguide_tests\
    config.yaml
    runs\
```

Do not put company LLM API keys in arbitrary product repos. For Claude Code, pass the key only when registering the MCP server, using the same pattern as tools like TestSprite:

```powershell
cd C:\QA\frontend-app
claude mcp add proguide-test --env API_KEY=your_api_key -- proguide mcp
```

Provider-specific variables are supported for advanced setups:

```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
PROGUIDE_LLM_API_KEY=sk-...
```

Workspace `.env` files are still read for backwards compatibility, but they are not the recommended place for ProGuide LLM secrets. Avoid putting `API_KEY` in product repos because it can collide with app configuration and be committed accidentally.

The LLM provider/model is maintained by the ProGuide tool. QA users only provide the API key. The current default is Anthropic Claude Sonnet.

```powershell
cd C:\QA\frontend-app
proguide doctor --json
proguide doctor --fix --json
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

Preview normalization without creating a run:

```powershell
proguide create casos.md --dry-run --json
```

Without `--json`, dry-run prints each step as `original -> normalized` and marks low-confidence or fallback steps with `warning`.

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
proguide execute <run_id> --from-plan --json
proguide get-run <run_id> --json
proguide get-code <run_id> <case_id> --json
proguide list-runs --limit 20 --json
proguide viewer --json
```

By default `execute` regenerates `test_plan.json` from `normalized_cases.json`. Use `--from-plan` only when you intentionally edited the existing `test_plan.json` and want execution to respect it.

The JSON response includes `run_url`. Open it to inspect status, generated Python code, evidence, and results.

### Use With Claude Code

Register ProGuide as a Claude Code MCP server from the QA workspace/app under test. The supported onboarding path is to pass the key through `claude mcp add --env`, not through the app repo:

```powershell
cd C:\QA\frontend-app
claude mcp add proguide-test --env API_KEY=your_api_key -- proguide mcp
```

If ProGuide is published and you do not want to install it globally, use the npx form:

```powershell
cd C:\QA\frontend-app
claude mcp add proguide-test --env API_KEY=your_api_key -- npx @proguide/test@latest mcp
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

If your MCP client has a separate secret store, use that instead of a product-repo `.env`. Otherwise keep the key in the client MCP config's `env` block.

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
| `run_cases` | Creates and executes a run from structured cases or Markdown. Recommended tool name. |
| `create_run` | Creates a run from structured cases or Markdown without executing. Recommended tool name. |
| `run_markdown_cases` | Legacy alias for Markdown imports that executes the run. |
| `create_run_from_markdown` | Legacy alias for Markdown imports without executing. |
| `execute_run` | Generates code and executes an existing run. If no `run_id` is passed, it can create a run from `cases` or Markdown first. Pass `from_plan: true` to respect an existing `test_plan.json`. |
| `get_run` | Reads run status, cases, events, and summary. |
| `get_generated_code` | Reads generated Python code for a case. |
| `list_runs` | Lists local runs. |
| `start_viewer` | Starts or reuses the local Fastify result viewer and opens it in the local browser. Pass `run_id` to get a direct run URL. |

The result viewer defaults to `http://127.0.0.1:8787/runs`. MCP tools open the viewer URL in the local browser by default; pass `open_browser: false` or set `PROGUIDE_OPEN_BROWSER=0` for headless environments. If that port is occupied, ProGuide automatically tries the following ports. Use `PROGUIDE_VIEWER_PORT` only when you need to force a specific port.

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

Configure local development keys through your user environment or `%USERPROFILE%\.proguide\.env`. A repository `.env` still works for disposable personal keys, but do not use it for shared company secrets.

```env
PROGUIDE_LLM_API_KEY=sk-...
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
git tag v0.1.6
git push origin v0.1.6
```

The workflow runs tests, creates `proguide-test-0.1.6.tgz`, uploads it as a workflow artifact, and attaches it to the GitHub Release.

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

For negative cases that need a non-production password per case, use an explicit test-only key in Markdown:

```markdown
### Datos utilizados
- Email: qa@example.com
- Password de prueba: 12345
```

Generic `Password:` lines remain masked and are not copied into `data.user.password`.

Before code generation, ProGuide attempts a best-effort Playwright DOM snapshot for each planned route and passes visible roles, labels, placeholders, text, ids, names, and `data-testid` hints to the LLM. If the app is not reachable, execution continues without DOM context and records a `dom_context_unavailable` event.

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
