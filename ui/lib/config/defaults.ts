// Canonical default UI/runner/LLM config. Returned as a fresh deep copy each call
// so callers (cli readConfig, run-store/config loadUiConfig) can mutate or spread
// without sharing state. config.yaml overrides are layered on top by the loaders.
export function defaultConfig(): ProGuide.Dict {
  return {
    runner: {
      browser: 'chromium',
      parallel_workers: 'auto',
      video: 'on',
      screenshots: 'on',
      traces: 'retain_on_failure'
    },
    identity: {
      run_user_email: '',
      run_user_name: '',
      project_name: '',
      project_key: '',
      require_user_email: false,
      require_project_name: false
    },
    auth: {
      login_route: '',
      validate_route: '',
      user_selector: '',
      pass_selector: '',
      submit_selector: '',
      success_check: ''
    },
    llm: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      temperature: 0.2,
      max_cases: 12,
      max_context_chars: 50000,
      max_output_tokens: 8000
    }
  };
}
