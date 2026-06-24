// Shared declarations used by JSDoc during the JS-to-TS migration.
declare global {
  namespace ProGuide {
    type Dict<T = any> = Record<string, T>;

    interface Metadata extends Dict {
      app_name?: string | null;
      title?: string | null;
      ticket?: string | null;
      module?: string | null;
      qa_owner?: string | null;
      dev_owner?: string | null;
      project_name?: string | null;
      project_key?: string | null;
      run_user_email?: string | null;
      run_user_name?: string | null;
      run_source?: string | null;
    }

    interface ApiRequest extends Dict {
      method: string;
      path: string;
      headers?: Dict;
      query?: Dict;
      expected_status?: number | null;
      body?: unknown;
      captures?: ApiCapture[];
    }

    interface ApiCapture extends Dict {
      name: string;
      source?: string;
      path?: string | null;
      header?: string;
    }

    interface ApiAssertion extends Dict {
      type: string;
      expected?: unknown;
      path?: string;
      operator?: string;
      name?: string;
      reason?: string;
      raw?: unknown;
    }

    interface ApiRequestEntry extends Dict {
      id: string;
      title: string;
      request: ApiRequest;
      assertions: ApiAssertion[];
      captures: ApiCapture[];
      debug?: boolean;
    }

    interface CaseInput extends Dict {
      id?: string;
      title?: string;
      type?: string;
      kind?: string;
      test_type?: string;
      request?: Dict;
      api?: Dict;
      requests?: unknown[];
      flow?: unknown[];
      api_requests?: unknown[];
      request_steps?: unknown[];
      steps?: unknown[];
      original_steps?: unknown[];
      expected?: unknown[];
      expected_results?: unknown[];
      executable_steps?: Dict[];
      captures?: unknown;
      save?: unknown;
      extract?: unknown;
    }

    interface RunRecord extends Dict {
      id: string;
      app_name?: string | null;
      status?: string;
    }

    interface UsageContext {
      runId?: string | null;
      runDir?: string | null;
    }

    interface ViewerHealth extends Dict {
      service?: string;
      root?: string;
      pid?: number;
      port?: number;
      capabilities?: string[];
    }

    interface DoctorCheck extends Dict {
      name: string;
      ok: boolean;
      required?: boolean;
    }

    interface CliError extends Error {
      exitCode?: number;
    }
  }
}

export {};
