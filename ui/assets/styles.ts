// @ts-check

// App CSS for the viewer, returned as a string and inlined by layout(). Pure,
// no dependencies (no interpolation). Extracted verbatim from server.js.

export function styles() {
  return `
    :root {
      --bg: #07090e;
      --bg-2: #0b0f17;
      --surface: rgba(255, 255, 255, 0.024);
      --surface-2: rgba(255, 255, 255, 0.045);
      --border: rgba(255, 255, 255, 0.085);
      --border-strong: rgba(255, 255, 255, 0.16);
      --text: #e9eef5;
      --muted: #8793a6;
      --faint: #5d6878;
      --accent: #34e0b0;
      --accent-2: #2bd0d6;
      --accent-soft: rgba(52, 224, 176, 0.12);
      --radius: 16px;
      --radius-sm: 10px;
      --shadow: 0 24px 60px -28px rgba(0, 0, 0, 0.85);
      --font-display: "Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif;
      --font-body: "Hanken Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background: var(--bg);
      font-family: var(--font-body);
      font-size: 14.5px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    .bg-aurora, .bg-grid { position: fixed; inset: 0; pointer-events: none; z-index: 0; }
    .bg-aurora {
      background:
        radial-gradient(820px 520px at 12% -8%, rgba(52, 224, 176, 0.16), transparent 60%),
        radial-gradient(720px 540px at 96% 4%, rgba(43, 208, 214, 0.13), transparent 58%),
        radial-gradient(900px 700px at 70% 110%, rgba(80, 110, 255, 0.10), transparent 60%);
      filter: saturate(115%);
    }
    .bg-grid {
      background-image:
        linear-gradient(rgba(255,255,255,0.022) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.022) 1px, transparent 1px);
      background-size: 46px 46px;
      mask-image: radial-gradient(circle at 50% 0%, #000 0%, transparent 78%);
    }
    h1, h2, h3 { margin: 0; font-family: var(--font-display); font-weight: 600; letter-spacing: -0.02em; line-height: 1.08; }
    h1 { font-size: clamp(28px, 4.6vw, 46px); }
    h2 { font-size: 17px; letter-spacing: -0.01em; display: flex; align-items: center; gap: 10px; }
    a { color: var(--accent); text-decoration: none; font-weight: 600; transition: color .15s ease; }
    a:hover { color: #6cf0cc; }
    code { font-family: var(--font-mono); font-size: 0.86em; background: var(--surface-2); padding: 2px 6px; border-radius: 6px; color: var(--accent); }
    .mono { font-family: var(--font-mono); }
    .muted { color: var(--muted); }
    .nowrap { white-space: nowrap; }

    /* App bar */
    .appbar {
      position: sticky; top: 0; z-index: 10;
      display: flex; align-items: center; justify-content: space-between;
      gap: 16px;
      padding: 14px clamp(18px, 4vw, 40px);
      background: color-mix(in srgb, var(--bg) 72%, transparent);
      backdrop-filter: blur(14px) saturate(140%);
      border-bottom: 1px solid var(--border);
    }
    .brand { display: inline-flex; align-items: center; gap: 11px; color: var(--text); font-weight: 700; }
    .brand:hover { color: var(--text); }
    .brand-mark {
      display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px;
      color: #04130d; background: linear-gradient(140deg, var(--accent), var(--accent-2));
      box-shadow: 0 6px 20px -6px var(--accent-soft), inset 0 1px 0 rgba(255,255,255,0.4);
    }
    .brand-name { font-family: var(--font-display); font-size: 17px; letter-spacing: -0.01em; }
    .brand-dim { color: var(--faint); font-weight: 500; }
    .appnav { margin-left: auto; display: flex; align-items: center; gap: 8px; }
    .appnav a {
      display: inline-flex; align-items: center; min-height: 32px; padding: 5px 10px;
      border-radius: 999px; color: var(--muted); border: 1px solid transparent;
      font-size: 13px; font-weight: 700;
    }
    .appnav a:hover { color: var(--accent); border-color: var(--border-strong); background: var(--surface-2); }
    .appbar-tag { font-size: 11.5px; color: var(--faint); border: 1px solid var(--border); padding: 4px 10px; border-radius: 999px; letter-spacing: 0.04em; }

    .shell { position: relative; z-index: 1; max-width: 1520px; margin: 0 auto; padding: clamp(20px, 4vw, 44px) clamp(16px, 4vw, 40px) 80px; }

    /* Hero */
    .hero { padding: 28px 0 8px; max-width: 760px; }
    .eyebrow {
      display: inline-flex; align-items: center; gap: 8px;
      font-family: var(--font-mono); font-size: 11.5px; letter-spacing: 0.14em; text-transform: uppercase;
      color: var(--accent); padding: 6px 12px; border: 1px solid var(--border-strong); border-radius: 999px;
      background: var(--accent-soft);
    }
    .hero h1 { margin: 20px 0 0; }
    .dot-accent { color: var(--accent); }
    .lede { margin: 16px 0 0; font-size: 16.5px; color: var(--muted); max-width: 60ch; }

    /* Layout grids */
    .grid { display: grid; gap: 20px; margin-top: 28px; min-width: 0; }
    .two { grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr); align-items: start; }
    .detail { grid-template-columns: minmax(0, 1fr); align-items: start; }
    .case-detail-grid { grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr); align-items: start; }
    .case-detail-grid > *, .detail-side, .code-section, .code-panels, .code-panel { min-width: 0; }
    .detail-side { display: grid; gap: 20px; }

    /* Panels */
    .panel {
      position: relative;
      min-width: 0;
      background: linear-gradient(180deg, var(--surface-2), var(--surface));
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 22px;
      box-shadow: var(--shadow);
    }
    .panel::before {
      content: ""; position: absolute; inset: 0 0 auto 0; height: 1px; border-radius: var(--radius) var(--radius) 0 0;
      background: linear-gradient(90deg, transparent, var(--border-strong), transparent);
    }
    .cases-panel { padding: 26px; }
    .panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
    .panel-sub { margin: 0; color: var(--faint); font-size: 12.5px; }
    .step-chip {
      display: grid; place-items: center; min-width: 26px; height: 26px; padding: 0 7px; border-radius: 8px;
      font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--accent);
      background: var(--accent-soft); border: 1px solid var(--border-strong);
    }

    /* Forms */
    .form-grid { display: grid; gap: 16px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .field { display: grid; gap: 7px; }
    .field.span-2 { grid-column: 1 / -1; }
    .field-label { color: var(--muted); font-size: 12.5px; font-weight: 600; letter-spacing: 0.01em; }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: rgba(0, 0, 0, 0.28);
      color: var(--text);
      padding: 11px 13px;
      font: inherit;
      transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
    }
    input::placeholder { color: var(--faint); }
    input:hover, textarea:hover, select:hover { border-color: var(--border-strong); }
    input:focus, textarea:focus, select:focus {
      outline: none; border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-soft);
      background: rgba(0, 0, 0, 0.4);
    }
    textarea { min-height: 110px; resize: vertical; }
    .file-field input[type="file"] { padding: 9px 12px; cursor: pointer; color: var(--muted); }
    input[type="file"]::file-selector-button {
      margin-right: 12px; padding: 7px 13px; border: 1px solid var(--border-strong); border-radius: 8px;
      background: var(--surface-2); color: var(--text); font: inherit; font-weight: 600; cursor: pointer;
      transition: background .15s ease, border-color .15s ease;
    }
    input[type="file"]::file-selector-button:hover { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
    label.field { color: var(--text); }
    pre { white-space: pre-wrap; background: rgba(0,0,0,0.35); padding: 14px; border-radius: var(--radius-sm); overflow: auto; font-family: var(--font-mono); }

    /* Buttons */
    .actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; grid-column: 1 / -1; margin-top: 4px; flex-wrap: wrap; }
    button, .button-link {
      display: inline-flex; align-items: center; justify-content: center; gap: 9px;
      border: 1px solid transparent;
      background: linear-gradient(140deg, var(--accent), var(--accent-2));
      color: #04130d;
      border-radius: var(--radius-sm);
      padding: 11px 18px;
      font: inherit; font-weight: 700; letter-spacing: -0.01em;
      cursor: pointer; min-height: 42px; text-decoration: none;
      box-shadow: 0 10px 26px -12px var(--accent-soft), inset 0 1px 0 rgba(255,255,255,0.35);
      transition: transform .14s ease, box-shadow .18s ease, opacity .15s ease, filter .15s ease;
    }
    button:hover, .button-link:hover { transform: translateY(-1px); filter: brightness(1.06); box-shadow: 0 16px 32px -14px rgba(52,224,176,0.5); color: #04130d; }
    button:active, .button-link:active { transform: translateY(0); }
    button svg, .button-link svg { transition: transform .18s ease; }
    button:hover svg { transform: translateX(2px); }
    button:disabled { opacity: 0.7; cursor: progress; transform: none; }
    button.is-loading { background: var(--surface-2); color: var(--muted); box-shadow: none; }
    .button-link.ghost, .back-link {
      background: var(--surface-2); color: var(--text);
      border: 1px solid var(--border-strong); box-shadow: none;
    }
    .button-link.ghost:hover { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); filter: none; box-shadow: none; }
    .back-link { display: inline-flex; align-items: center; gap: 7px; padding: 6px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600; color: var(--muted); }
    .back-link:hover { color: var(--accent); border-color: var(--accent); }

    /* Tool band (detail header) */
    .tool-band { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap; padding: 12px 0 4px; }
    .tool-band-main { display: flex; flex-direction: column; gap: 12px; }
    .tool-band h1 { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; font-size: clamp(26px, 4vw, 38px); }
    .run-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0; }
    .run-meta .mono { font-size: 13px; color: var(--muted); }
    .meta-sep { color: var(--faint); }

    .identity-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-top: 18px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: rgba(255,255,255,0.026);
    }
    .identity-strip div { min-width: 0; display: grid; gap: 2px; }
    .identity-strip dt {
      color: var(--faint);
      font-size: 10.5px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .identity-strip dd {
      margin: 0;
      min-width: 0;
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Live run progress */
    .run-progress {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(260px, 0.58fr);
      gap: 16px 22px;
      align-items: center;
      margin-top: 20px;
      padding: 18px 20px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background:
        linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.026)),
        rgba(0,0,0,0.16);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .run-progress-main { min-width: 0; display: grid; gap: 8px; }
    .run-progress-kicker { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .run-progress h2 { font-size: clamp(18px, 2.2vw, 26px); display: block; letter-spacing: 0; }
    .run-progress p { margin: 0; max-width: 82ch; }
    .run-progress-track {
      grid-column: 1 / -1;
      height: 8px;
      border-radius: 999px;
      background: rgba(255,255,255,0.07);
      overflow: hidden;
      border: 1px solid var(--border);
    }
    .run-progress-track span {
      display: block;
      width: var(--progress, 0%);
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
      transition: width .35s ease;
    }
    .run-progress.is-active .run-progress-track span {
      background:
        linear-gradient(90deg, rgba(52,224,176,0.72), rgba(43,208,214,0.92), rgba(130,184,255,0.72));
      background-size: 180% 100%;
      animation: progressFlow 1.2s linear infinite;
    }
    .run-progress.is-error .run-progress-track span { background: linear-gradient(90deg, #ff637a, #c4a6ff); }
    .run-progress-steps {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .run-progress-step {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 28px;
      padding: 4px 9px;
      border-radius: 999px;
      color: var(--faint);
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.025);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .run-progress-step i {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
      opacity: 0.55;
    }
    .run-progress-step.is-done { color: var(--accent); border-color: rgba(52,224,176,0.28); background: var(--accent-soft); }
    .run-progress-step.is-active { color: #82b8ff; border-color: rgba(78,158,255,0.36); background: rgba(78,158,255,0.12); }
    .run-progress-step.is-active i {
      width: 11px;
      height: 11px;
      border: 2px solid currentColor;
      border-right-color: transparent;
      background: transparent;
      opacity: 1;
      animation: spin .7s linear infinite;
    }
    .run-progress-step.is-error { color: #ff8298; border-color: rgba(255,99,122,0.34); background: rgba(255,99,122,0.1); }
    .run-progress-counts { justify-self: end; color: var(--faint); font-size: 11.5px; }
    @keyframes progressFlow { to { background-position: -180% 0; } }

    /* Usage dashboard */
    .usage-page { display: grid; gap: 20px; margin-top: 28px; min-width: 0; }
    .usage-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; min-width: 0; }
    .usage-strip {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 18px;
      margin-top: 20px;
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.025));
      box-shadow: var(--shadow);
      min-width: 0;
    }
    .usage-strip-main { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-width: 0; }
    .usage-strip-main .eyebrow { padding: 4px 9px; font-size: 10px; }
    .usage-strip-main strong { font-family: var(--font-display); font-size: 22px; line-height: 1; }
    .usage-strip-kv { display: flex; align-items: center; gap: 14px; margin: 0; }
    .usage-strip-kv div { display: grid; gap: 2px; }
    .usage-strip-kv dt {
      color: var(--faint);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .usage-strip-kv dd { margin: 0; font-family: var(--font-mono); color: var(--text); font-size: 12px; }
    .usage-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; min-width: 0; }
    .usage-stat {
      min-width: 0;
      padding: 18px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: linear-gradient(180deg, var(--surface-2), var(--surface));
      box-shadow: var(--shadow);
    }
    .usage-stat span {
      display: block;
      color: var(--faint);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .usage-stat strong {
      display: block;
      margin-top: 10px;
      font-family: var(--font-display);
      font-size: clamp(22px, 3vw, 34px);
      line-height: 1;
      overflow-wrap: anywhere;
    }
    .usage-stat small { display: block; margin-top: 9px; color: var(--muted); }
    .usage-table th, .usage-table td { white-space: nowrap; }
    .usage-table td:nth-child(4) { white-space: normal; min-width: 220px; }
    .usage-provider {
      display: block;
      color: var(--accent);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .usage-model { display: block; margin-top: 2px; color: var(--muted); font-size: 11.5px; }

    /* Tables */
    .table-wrap { overflow-x: auto; border-radius: var(--radius-sm); }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 13px 12px; text-align: left; vertical-align: middle; }
    th {
      color: var(--faint); font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
      border-bottom: 1px solid var(--border-strong);
    }
    td { border-bottom: 1px solid var(--border); font-size: 13.5px; }
    tbody tr { transition: background .14s ease; }
    tbody tr:hover { background: var(--surface-2); }
    tbody tr:last-child td { border-bottom: none; }
    .case-row { cursor: pointer; outline: none; }
    .case-row.is-live { background: rgba(78, 158, 255, 0.055); box-shadow: inset 3px 0 0 rgba(78, 158, 255, 0.65); }
    .case-row.is-live:hover { background: rgba(78, 158, 255, 0.09); }
    .case-row:focus-visible { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
    .col-n { width: 46px; color: var(--faint); }
    .case-title { font-weight: 600; color: var(--text); }
    .case-title-link { color: var(--text); font-weight: 700; }
    .case-title-link:hover { color: var(--accent); }
    #casesTable .case-title { min-width: 320px; }
    #casesTable .message-cell { min-width: 280px; }
    #casesTable .evidence-cell { min-width: 150px; }
    #casesTable .code-cell { min-width: 124px; white-space: nowrap; }
    #casesTable .code-cell .chip-link + .chip-link { margin-left: 6px; }
    .truncate { max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-link { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
    .row-link svg { opacity: 0; transform: translateX(-3px); transition: all .16s ease; }
    tr:hover .row-link svg { opacity: 1; transform: translateX(0); }

    /* Badges */
    .badge {
      display: inline-flex; align-items: center; gap: 7px; border-radius: 999px;
      padding: 4px 11px 4px 9px; font-size: 12px; font-weight: 600; letter-spacing: 0.01em;
      text-transform: capitalize; background: var(--surface-2); color: var(--muted);
      border: 1px solid var(--border); white-space: nowrap;
    }
    .badge-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 20%, transparent); }
    .status-spinner {
      width: 12px; height: 12px; border-radius: 50%;
      border: 2px solid currentColor; border-right-color: transparent;
      animation: spin .7s linear infinite;
    }
    .passed, .listo { background: rgba(52, 224, 176, 0.13); color: #57e9bf; border-color: rgba(52, 224, 176, 0.3); }
    .failed { background: rgba(255, 99, 122, 0.13); color: #ff8298; border-color: rgba(255, 99, 122, 0.3); }
    .ready, .pending { background: rgba(255,255,255,0.045); color: var(--muted); border-color: var(--border); }
    .running, .queued, .started, .executing, .ejecutando, .generating, .interpreting { background: rgba(78, 158, 255, 0.14); color: #82b8ff; border-color: rgba(78, 158, 255, 0.32); }
    .inconclusive, .necesita_revision { background: rgba(255, 191, 73, 0.14); color: #ffce7a; border-color: rgba(255, 191, 73, 0.3); }
    .blocked, .no_automatizable_aun, .setup_failed, .error { background: rgba(178, 132, 255, 0.14); color: #c4a6ff; border-color: rgba(178, 132, 255, 0.32); }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Evidence chips */
    .evidence-cell { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip-link {
      display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600;
      background: var(--surface-2); border: 1px solid var(--border-strong); color: var(--muted);
      transition: all .14s ease;
    }
    .chip-link:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }

    /* Case detail */
    .case-detail-head { display: grid; gap: 14px; margin-bottom: 24px; }
    .case-detail-head h2 { font-size: clamp(24px, 3.4vw, 38px); line-height: 1.04; display: block; }
    .detail-lede { margin: 0; color: var(--muted); max-width: 78ch; font-size: 15.5px; }
    .result-note {
      margin: 0 0 24px; padding: 14px 16px; border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm); background: rgba(255,255,255,0.035);
    }
    .result-note strong { display: block; margin-bottom: 6px; color: var(--text); }
    .result-note p { margin: 0; color: var(--muted); }
    .result-note.failed { border-color: rgba(255, 99, 122, 0.35); background: rgba(255, 99, 122, 0.08); }
    .error-console-section { gap: 10px; }
    .error-console {
      margin: 0;
      max-height: 520px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      border: 1px solid rgba(255, 99, 122, 0.28);
      border-radius: var(--radius-sm);
      background: #090d16;
      color: #f4f7fb;
      padding: 14px 16px;
      font-family: var(--font-mono);
      font-size: 12.5px;
      line-height: 1.55;
    }
    .api-evidence-section { gap: 14px; }
    .api-evidence {
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      background: rgba(255,255,255,0.028);
      overflow: hidden;
    }
    .api-evidence summary {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      cursor: pointer; padding: 12px 14px; color: var(--text);
      border-bottom: 1px solid var(--border);
    }
    .api-method { color: var(--accent); font-weight: 700; }
    .api-url { color: var(--muted); overflow-wrap: anywhere; }
    .api-status {
      display: inline-flex; align-items: center; min-height: 24px; padding: 2px 9px;
      border-radius: 999px; border: 1px solid var(--border-strong); font-size: 12px; font-weight: 700;
    }
    .api-status.passed { color: #83f0c8; background: rgba(69, 211, 166, 0.12); border-color: rgba(69, 211, 166, 0.28); }
    .api-status.failed { color: #ff9bab; background: rgba(255, 99, 122, 0.12); border-color: rgba(255, 99, 122, 0.28); }
    .api-redacted { margin: 12px 14px 0; font-size: 13px; }
    .api-evidence-grid, .api-evidence-checks {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 14px;
    }
    .api-evidence h4 { margin: 0 0 8px; color: var(--muted); font-size: 12px; font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .08em; }
    .detail-section { display: grid; gap: 12px; margin-top: 24px; }
    .detail-section.compact { margin-top: 18px; }
    .detail-section h3 {
      margin: 0; color: var(--muted); font-family: var(--font-mono); font-size: 11px;
      text-transform: uppercase; letter-spacing: 0.08em;
    }
    .detail-list { margin: 0; padding-left: 18px; color: var(--text); }
    .detail-list li + li { margin-top: 8px; }
    .code-section-head {
      display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    }
    .code-tabs {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: rgba(0, 0, 0, 0.2);
    }
    .code-tab {
      min-height: 30px;
      padding: 5px 11px;
      border-radius: 8px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
      box-shadow: none;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0;
    }
    .code-tab:hover {
      transform: none;
      filter: none;
      box-shadow: none;
      color: var(--accent);
      background: var(--surface-2);
    }
    .code-tab.is-active {
      color: var(--accent);
      border-color: var(--border-strong);
      background: var(--accent-soft);
    }
    .code-panel[hidden] { display: none; }
    .code-block {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      overflow: hidden;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      background:
        linear-gradient(180deg, rgba(6, 10, 17, 0.98), rgba(8, 12, 20, 0.96)),
        rgba(0, 0, 0, 0.32);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.045);
    }
    .code-block-head {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 10px 13px 10px 14px;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.025)),
        rgba(0, 0, 0, 0.18);
    }
    .code-block-head::before {
      content: "";
      width: 34px;
      height: 10px;
      border-radius: 999px;
      background:
        radial-gradient(circle at 5px 5px, #ff6a76 0 4px, transparent 4.5px),
        radial-gradient(circle at 17px 5px, #ffc35f 0 4px, transparent 4.5px),
        radial-gradient(circle at 29px 5px, #53df9d 0 4px, transparent 4.5px);
      flex: 0 0 auto;
    }
    .code-block-head .mono {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .code-lang {
      flex: 0 0 auto;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 3px 8px;
      color: var(--accent);
      background: var(--accent-soft);
      font-family: var(--font-mono);
      font-size: 10.5px;
      font-weight: 700;
    }
    .code-block pre {
      margin: 0;
      max-height: 460px;
      border-radius: 0;
      background: transparent;
      padding: 0;
      font-size: 12.5px;
      line-height: 1.55;
    }
    .code-block code {
      padding: 0;
      border-radius: 0;
      background: transparent;
      color: var(--text);
    }
    .code-editor {
      display: block;
      width: 100%;
      max-width: 100%;
      counter-reset: code-line;
      white-space: pre;
      overflow-x: auto;
      overflow-y: auto;
      font-family: var(--font-mono);
      tab-size: 2;
    }
    .code-line {
      counter-increment: code-line;
      display: table;
      min-width: 100%;
      min-height: 1.55em;
      padding: 0 16px 0 0;
    }
    .code-line::before {
      content: counter(code-line);
      display: inline-block;
      width: 46px;
      margin-right: 14px;
      padding: 0 10px 0 0;
      color: rgba(135, 147, 166, 0.54);
      text-align: right;
      border-right: 1px solid rgba(255, 255, 255, 0.07);
      background: rgba(255, 255, 255, 0.018);
      user-select: none;
    }
    .code-line:first-child { padding-top: 14px; }
    .code-line:first-child::before { padding-top: 14px; margin-top: -14px; }
    .code-line:last-child { padding-bottom: 14px; }
    .code-line:last-child::before { padding-bottom: 14px; margin-bottom: -14px; }
    .tok-keyword { color: #ff8fb3; font-weight: 700; }
    .tok-string { color: #f2ce6f; }
    .tok-number { color: #a7c7ff; }
    .tok-comment { color: #68778d; font-style: italic; }
    .tok-function { color: #6fe4ff; }
    .tok-punctuation { color: #9aa7ba; }
    .code-empty {
      padding: 14px 16px;
      border: 1px dashed var(--border-strong);
      border-radius: var(--radius-sm);
      background: rgba(255, 255, 255, 0.025);
    }
    .code-empty p { margin: 0; }
    .timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
    .timeline-item {
      display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 12px; align-items: start;
      padding: 12px 0; border-top: 1px solid var(--border);
    }
    .timeline-item:first-child { border-top: none; }
    .timeline-status {
      display: inline-flex; justify-content: center; border-radius: 999px; padding: 3px 8px;
      font-family: var(--font-mono); font-size: 10.5px; color: var(--muted);
      background: var(--surface-2); border: 1px solid var(--border);
    }
    .timeline-item.passed .timeline-status { color: #57e9bf; border-color: rgba(52, 224, 176, 0.3); background: rgba(52, 224, 176, 0.1); }
    .timeline-item.failed .timeline-status { color: #ff8298; border-color: rgba(255, 99, 122, 0.3); background: rgba(255, 99, 122, 0.1); }
    .timeline-item.started .timeline-status { color: #82b8ff; border-color: rgba(78, 158, 255, 0.32); background: rgba(78, 158, 255, 0.12); }
    .timeline-item p { margin: 0; color: var(--text); }
    .timeline-item small { display: block; margin-top: 5px; color: var(--muted); }
    .detail-kv { margin: 0; display: grid; gap: 0; }
    .detail-kv div { display: grid; grid-template-columns: 98px minmax(0, 1fr); gap: 12px; padding: 11px 0; border-top: 1px solid var(--border); }
    .detail-kv div:first-child { border-top: none; padding-top: 0; }
    .detail-kv dt { color: var(--faint); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
    .detail-kv dd { margin: 0; min-width: 0; color: var(--text); overflow-wrap: anywhere; }
    .evidence-preview {
      display: block; overflow: hidden; border-radius: var(--radius-sm); border: 1px solid var(--border-strong);
      background: rgba(0,0,0,0.28);
    }
    .evidence-preview img { display: block; width: 100%; max-height: 280px; object-fit: cover; }
    .evidence-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }

    /* Empty state */
    .empty { display: grid; place-items: center; gap: 4px; padding: 40px 16px; text-align: center; }
    .empty-mark { font-size: 34px; color: var(--border-strong); line-height: 1; margin-bottom: 8px; }
    .empty p { margin: 0; font-weight: 600; color: var(--text); }

    /* Reveal on load */
    .reveal { animation: reveal .55s cubic-bezier(.2,.7,.2,1) both; animation-delay: var(--delay, 0s); }
    @keyframes reveal { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } html { scroll-behavior: auto; } }

    @media (max-width: 900px) {
      .two, .detail, .case-detail-grid, .form-grid, .usage-grid, .usage-stats, .usage-strip, .run-progress, .identity-strip { grid-template-columns: 1fr; }
      .field.span-2 { grid-column: auto; }
      .tool-band { align-items: flex-start; }
      .actions { justify-content: flex-start; }
      .truncate { max-width: 220px; }
      .timeline-item { grid-template-columns: 1fr; gap: 7px; }
      .timeline-status { justify-content: flex-start; width: max-content; }
      .usage-strip { align-items: start; }
      .usage-strip-kv { flex-wrap: wrap; }
      .run-progress-steps { justify-content: flex-start; }
      .run-progress-counts { justify-self: start; }
    }
  `;
}
