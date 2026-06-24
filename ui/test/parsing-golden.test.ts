import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareMarkdownRun } from '../proguide-service.js';

// Characterization (golden) test for the deterministic Markdown -> normalized
// case pipeline (parseMarkdownCases -> normalize -> route/assertion inference).
// This is the safety net for the Phase 2 refactor that splits proguide-service
// into per-domain modules: any change in parsing, step normalization, confidence
// scoring, route inference, or API request/assertion shaping must be intentional
// and update this test. useAgent:false keeps it free of LLM/Playwright.

const SAMPLE_MD = `# Suite Demo

## TC-UI-001 Login valido
Pasos:
1. Ir a /login
2. Escribir "qa@example.test" en [name="email"]
3. Click en [type="submit"]

Resultado esperado:
- Ver el texto "Bienvenido"

## TC-API-001 Crear usuario
Tipo: API
Metodo: POST
Endpoint: /users
Body:
- name: Mario

Resultado esperado:
- Status 201
- body.name = Mario
- body.id existe
`;

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pg-golden-'));
}

test('markdown pipeline normalizes UI and API cases deterministically', async () => {
  const root = makeTempRoot();
  try {
    const mdPath = path.join(root, 'casos.md');
    fs.writeFileSync(mdPath, SAMPLE_MD, 'utf8');

    const { cases } = await prepareMarkdownRun({
      root,
      sourceMd: mdPath,
      baseUrl: 'http://x.test',
      useAgent: false
    });

    assert.equal(cases.length, 2);

    // --- UI case: id slug, step normalization, confidence, route inference ---
    const ui = cases[0];
    assert.equal(ui.id, 'caso_1_ui_001_login_valido');
    assert.equal(ui.type, 'ui');
    assert.equal(ui.title, 'UI-001 Login valido');
    assert.equal(ui.route, '/login');
    assert.equal(ui.automation_state, 'listo');
    assert.equal(ui.priority, 'media');
    assert.deepEqual(ui.expected_results, ['Ver el texto "Bienvenido"']);
    assert.deepEqual(
      ui.executable_steps.map((step) => ({
        number: step.number,
        normalized_action: step.normalized_action,
        confidence: step.confidence
      })),
      [
        { number: 1, normalized_action: 'go to /login', confidence: 0.85 },
        {
          number: 2,
          normalized_action: 'fill [name="email"] with qa@example.test',
          confidence: 0.95
        },
        { number: 3, normalized_action: 'click [type="submit"]', confidence: 0.95 }
      ]
    );

    // --- API case: request + assertion normalization ---
    const api = cases[1];
    assert.equal(api.id, 'caso_2_api_001_crear_usuario');
    assert.equal(api.type, 'api');
    assert.equal(api.title, 'API-001 Crear usuario');
    assert.equal(api.automation_state, 'listo');
    assert.equal(api.executable_steps.length, 0);
    assert.deepEqual(api.request, {
      method: 'POST',
      path: '/users',
      headers: {},
      query: {},
      expected_status: null,
      body: { name: 'Mario' }
    });
    assert.deepEqual(api.assertions, [
      { type: 'status', expected: 201 },
      { type: 'body_path', path: 'name', operator: 'equals', expected: 'Mario' },
      { type: 'body_path', path: 'id', operator: 'exists' }
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
