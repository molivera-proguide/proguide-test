import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { slug } from '../shared/text.js';

// Run identity resolution: derive run user, project name/key, git branch/commit and
// source provenance from metadata, UI config, env vars, git and project files.
// Extracted verbatim from run-store/runs.js; resolveRunIdentity is imported back there.

export async function resolveRunIdentity(
  root: string,
  metadata: ProGuide.Dict = {},
  config: ProGuide.Dict = {}
): Promise<ProGuide.Dict> {
  const rootPath = path.resolve(root);
  const identityConfig = config.identity || {};
  const git = gitIdentity(rootPath);
  const packageName = await packageProjectName(rootPath);
  const pyprojectName = await pyprojectProjectName(rootPath);
  const remoteProjectName = projectNameFromRemote(git.remote);
  const folderName = path.basename(rootPath);

  const runUserEmail = firstValue(
    metadata.run_user_email,
    metadata.user_email,
    identityConfig.run_user_email,
    process.env.PROGUIDE_RUN_USER_EMAIL,
    git.email
  );
  const runUserName = firstValue(
    metadata.run_user_name,
    metadata.user_name,
    identityConfig.run_user_name,
    process.env.PROGUIDE_RUN_USER_NAME,
    git.name
  );
  const projectName = firstValue(
    metadata.project_name,
    metadata.project,
    metadata.app_name,
    identityConfig.project_name,
    process.env.PROGUIDE_PROJECT_NAME,
    packageName,
    pyprojectName,
    remoteProjectName,
    folderName
  );
  const projectKey = firstValue(
    metadata.project_key,
    identityConfig.project_key,
    process.env.PROGUIDE_PROJECT_KEY,
    slug(projectName)
  );

  if (identityConfig.require_user_email && !runUserEmail) {
    throw new Error(
      'Falta metadata de usuario: configura identity.run_user_email, PROGUIDE_RUN_USER_EMAIL o pasa run_user_email por MCP/CLI.'
    );
  }
  if (identityConfig.require_project_name && !projectName) {
    throw new Error(
      'Falta metadata de proyecto: configura identity.project_name, PROGUIDE_PROJECT_NAME o pasa project_name por MCP/CLI.'
    );
  }

  return {
    run_user_email: runUserEmail || '',
    run_user_name: runUserName || '',
    company_domain: emailDomain(runUserEmail),
    project_name: projectName || '',
    project_key: projectKey || '',
    workspace_root: rootPath,
    run_source:
      firstValue(metadata.run_source, metadata.source, process.env.PROGUIDE_RUN_SOURCE) || '',
    git_branch: git.branch || '',
    git_commit: git.commit || '',
    identity_source: {
      run_user_email: sourceFor([
        ['metadata', metadata.run_user_email || metadata.user_email],
        ['config', identityConfig.run_user_email],
        ['env', process.env.PROGUIDE_RUN_USER_EMAIL],
        ['git', git.email]
      ]),
      run_user_name: sourceFor([
        ['metadata', metadata.run_user_name || metadata.user_name],
        ['config', identityConfig.run_user_name],
        ['env', process.env.PROGUIDE_RUN_USER_NAME],
        ['git', git.name]
      ]),
      project_name: sourceFor([
        ['metadata', metadata.project_name || metadata.project || metadata.app_name],
        ['config', identityConfig.project_name],
        ['env', process.env.PROGUIDE_PROJECT_NAME],
        ['package_json', packageName],
        ['pyproject', pyprojectName],
        ['git_remote', remoteProjectName],
        ['folder', folderName]
      ]),
      project_key: sourceFor([
        ['metadata', metadata.project_key],
        ['config', identityConfig.project_key],
        ['env', process.env.PROGUIDE_PROJECT_KEY],
        ['derived', slug(projectName)]
      ])
    }
  };
}

function gitIdentity(root: string): ProGuide.Dict<string> {
  return {
    email: gitValue(root, ['config', '--get', 'user.email']),
    name: gitValue(root, ['config', '--get', 'user.name']),
    remote: gitValue(root, ['config', '--get', 'remote.origin.url']),
    branch: gitValue(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    commit: gitValue(root, ['rev-parse', '--short', 'HEAD'])
  };
}

function gitValue(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 2500,
    windowsHide: true
  });
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

async function packageProjectName(root: string): Promise<string> {
  const packagePath = path.join(root, 'package.json');
  try {
    const data = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    return cleanProjectName(data.name || '');
  } catch {
    return '';
  }
}

async function pyprojectProjectName(root: string): Promise<string> {
  try {
    const text = await fs.readFile(path.join(root, 'pyproject.toml'), 'utf8');
    const match = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    return cleanProjectName(match?.[1] || '');
  } catch {
    return '';
  }
}

function projectNameFromRemote(remote: unknown): string {
  const text = String(remote || '').trim();
  if (!text) return '';
  const withoutQuery = text.split(/[?#]/)[0];
  const last =
    withoutQuery
      .split(/[/:\\]/)
      .filter(Boolean)
      .at(-1) || '';
  return cleanProjectName(last.replace(/\.git$/i, ''));
}

function cleanProjectName(value: unknown): string {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace(/^@[^/]+\//, '');
}

function firstValue(...values: unknown[]): string {
  return values.map((value) => String(value ?? '').trim()).find(Boolean) || '';
}

function sourceFor(entries: Array<[string, unknown]>): string {
  const found = entries.find(([, value]) => String(value ?? '').trim());
  return found?.[0] || '';
}

function emailDomain(email: unknown): string {
  const match = String(email || '')
    .trim()
    .match(/@([^@\s]+)$/);
  return match ? match[1].toLowerCase() : '';
}
