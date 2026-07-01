import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// End-to-end validation of the grounding WALK against a controlled fixture app
// (login -> dashboard). Needs Chromium, so it is opt-in: run locally with
//   PROGUIDE_WALK_E2E=1 npm test
// CI (no Chromium) skips it. The pure grounding verdict logic is covered by the
// browserless unit tests in lib-units.test.ts.

const LOGIN_HTML = `<!doctype html><html><body>
  <h1>Iniciar sesion</h1>
  <input id="username" name="username" placeholder="Usuario" />
  <input id="password" name="password" type="password" />
  <button onclick="location.href='/dashboard'">Acceder</button>
</body></html>`;

const DASHBOARD_HTML = `<!doctype html><html><body>
  <h1>Link Analysis</h1>
  <main>Bienvenido. Panel principal cargado.</main>
  <button data-testid="logout-btn">Salir</button>
</body></html>`;

test(
  'codegen/grounding: walk reaches the post-login screen and grounds its targets',
  { skip: process.env.PROGUIDE_WALK_E2E ? false : 'set PROGUIDE_WALK_E2E=1 to run (needs Chromium)' },
  async () => {
    const { groundCases } = await import('../lib/codegen/grounding.js');
    const { defaultConfig } = await import('../lib/config/defaults.js');

    const server = http.createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(String(request.url || '').startsWith('/dashboard') ? DASHBOARD_HTML : LOGIN_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-walk-'));

    try {
      const testCase = {
        id: 'caso_login',
        route: '/',
        executable_steps: [
          { number: 1, normalized_action: '/' },
          { number: 2, normalized_action: 'fill [#username] with "u"' },
          { number: 3, normalized_action: 'fill [#password] with "p"' },
          { number: 4, normalized_action: 'click button Acceder' },
          { number: 5, normalized_action: 'wait 1 seconds' },
          { number: 6, normalized_action: 'expect text "Link Analysis"' },
          { number: 7, normalized_action: 'expect text "Texto Inexistente 123"' }
        ]
      };

      await groundCases({ root, baseUrl, config: defaultConfig(), cases: [testCase], runDir: root });

      const byNum = new Map<number, any>(testCase.executable_steps.map((s) => [s.number, s]));
      // Login-screen targets resolve.
      assert.equal(byNum.get(2).grounding.status, 'resolved');
      assert.equal(byNum.get(3).grounding.status, 'resolved');
      assert.equal(byNum.get(4).grounding.status, 'resolved');
      // Post-login assertion resolves -> the walk reached the dashboard.
      assert.equal(byNum.get(6).grounding.status, 'resolved');
      // Genuinely absent text is flagged (not silently resolved).
      assert.notEqual(byNum.get(7).grounding.status, 'resolved');

      // Assert dom_context.json was created and contains merged snapshots from both login and dashboard.
      const domContextPath = path.join(root, 'dom_context.json');
      const domContextText = await fs.readFile(domContextPath, 'utf8');
      const domContext = JSON.parse(domContextText);

      assert.equal(domContext.available, true);
      const caseContext = domContext.by_case_id.caso_login;
      assert.equal(caseContext.available, true);
      
      // Control from login screen (#username) and control from dashboard (logout-btn) must BOTH be present in the merged context
      const controls = caseContext.snapshot.controls;
      const usernames = controls.filter((c: any) => c.id === 'username');
      const logouts = controls.filter((c: any) => c.data_testid === 'logout-btn');

      assert.equal(usernames.length, 1, 'Username input from login screen must be present');
      assert.equal(logouts.length, 1, 'Logout button from dashboard must be present');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }
);

// Strict login: the button only navigates when BOTH fields are filled, and the
// fields do NOT expose name="email"/name="password" (only ids). This forces the
// field-type fallback to do the login for the walk.
const LOGIN_STRICT_HTML = `<!doctype html><html><body>
  <h1>Iniciar sesion</h1>
  <input id="user_field" placeholder="Usuario" />
  <input id="pass_field" type="password" />
  <button onclick="if(document.getElementById('user_field').value && document.getElementById('pass_field').value){location.href='/dashboard'}">Acceder</button>
</body></html>`;

test(
  'codegen/grounding: walk logs in via field-type fallback and a final snapshot captures the post-login DOM',
  { skip: process.env.PROGUIDE_WALK_E2E ? false : 'set PROGUIDE_WALK_E2E=1 to run (needs Chromium)' },
  async () => {
    const { groundCases } = await import('../lib/codegen/grounding.js');
    const { defaultConfig } = await import('../lib/config/defaults.js');

    const server = http.createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(String(request.url || '').startsWith('/dashboard') ? DASHBOARD_HTML : LOGIN_STRICT_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-walk2-'));

    try {
      // Selectors that DO NOT exist on the real DOM ([name="email"] /
      // [name="password"] vs the app's #user_field / #pass_field), AND no
      // post-login step -- exactly the shape that used to leave dom_context blind
      // to the authenticated screen (the web-suite login case).
      const testCase = {
        id: 'caso_login_fallback',
        route: '/',
        executable_steps: [
          { number: 1, normalized_action: '/' },
          { number: 2, normalized_action: 'fill [name="email"] with "u"' },
          { number: 3, normalized_action: 'fill [name="password"] with "p"' },
          { number: 4, normalized_action: 'click button Acceder' }
        ]
      };

      await groundCases({ root, baseUrl, config: defaultConfig(), cases: [testCase], runDir: root });

      const domContext = JSON.parse(await fs.readFile(path.join(root, 'dom_context.json'), 'utf8'));
      const controls = domContext.by_case_id.caso_login_fallback.snapshot.controls;
      const logouts = controls.filter((c: any) => c.data_testid === 'logout-btn');

      // Proof: the type-based fallback filled the real fields so login succeeded,
      // and the final post-step snapshot captured the dashboard -> logout-btn is
      // present in the merged context even though the case never named it.
      assert.equal(
        logouts.length,
        1,
        'post-login control must be captured via fallback login + final snapshot'
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }
);
