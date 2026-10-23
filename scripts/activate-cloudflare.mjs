import { spawnSync } from 'node:child_process';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const configPath = join(projectDir, 'wrangler.json');
const wranglerPath = join(projectDir, 'node_modules/wrangler/bin/wrangler.js');
const placeholder = '00000000-0000-0000-0000-000000000000';
const databaseName = 'memecoin-radar';
const accountPattern = /^[a-f0-9]{32}$/i;
const databasePattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

// Keep Wrangler output private: whoami includes email, and failures may contain
// credential details. Only the fixed status messages below reach the terminal.
function runWrangler(args, env) {
  return spawnSync(process.execPath, [wranglerPath, ...args, '--config', configPath], {
    cwd: projectDir,
    env: {
      ...env,
      CI: 'true',
      BROWSER: 'none',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_SEND_ERROR_REPORTS: 'false',
      WRANGLER_WRITE_LOGS: 'false',
      WRANGLER_LOG_SANITIZE: 'true',
      WRANGLER_NO_SKILLS_UPDATE_PROMPTS: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 300_000,
  });
}

function parseJson(result) {
  if (result.status !== 0 || result.error) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

async function loadConfig() {
  return JSON.parse(await readFile(configPath, 'utf8'));
}

async function saveConfig(config) {
  const temporaryPath = join(dirname(configPath), `.wrangler-${process.pid}.json.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, configPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

function selectAccount(user, env, config) {
  const accounts = Array.isArray(user.accounts)
    ? [...new Set(user.accounts.map(account => account.id).filter(id => accountPattern.test(id ?? '')))]
    : [];
  const explicit = env.CLOUDFLARE_ACCOUNT_ID;
  const selected = explicit || (accounts.length === 1 ? accounts[0] : undefined);
  if (!selected || !accountPattern.test(selected) || !accounts.includes(selected)) return undefined;
  // An old config must never move to a different account silently.
  if (config.account_id && config.account_id !== selected) return undefined;
  return selected;
}

function databaseBinding(config) {
  const matches = config.d1_databases?.filter(binding => binding.binding === 'DB');
  if (matches?.length !== 1 || matches[0].database_name !== databaseName) return undefined;
  return matches[0];
}

/**
 * Existing Wrangler authentication only. --check performs whoami and local
 * reads; RADAR_CONFIRMED_FREE_PLAN=1 records a prior human plan confirmation.
 * It is not a plan lookup: whoami does not expose the Workers billing plan.
 * Dependencies can be replaced in tests without executing remote operations.
 */
export async function activateCloudflare({
  check = false,
  env = process.env,
  run = runWrangler,
  readConfig = loadConfig,
  writeConfig = saveConfig,
  report = message => process.stdout.write(`${message}\n`),
} = {}) {
  const stop = status => {
    report(status);
    return 1;
  };
  let user;
  try {
    user = parseJson(await run(['whoami', '--json'], env));
  } catch {
    return stop('AUTH_REQUIRED');
  }
  if (!user?.loggedIn) return stop('AUTH_REQUIRED');

  let config;
  try {
    config = await readConfig();
  } catch {
    return stop('ACCOUNT_REQUIRED');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return stop('ACCOUNT_REQUIRED');
  const accountId = selectAccount(user, env, config);
  if (!accountId) return stop('ACCOUNT_REQUIRED');
  if (env.RADAR_CONFIRMED_FREE_PLAN !== '1') return stop('FREE_PLAN_CONFIRMATION_REQUIRED');
  if (check) {
    report('READY');
    return 0;
  }

  // Pin every consequential Wrangler command to the verified account. CI and
  // closed stdin disable interactive prompts; this script never runs login.
  const selectedEnv = { ...env, CLOUDFLARE_ACCOUNT_ID: accountId };
  let stage = 'D1_CONFIG_INVALID';
  try {
    const binding = databaseBinding(config);
    if (!binding) return stop(stage);
    const configuredId = binding.database_id;
    const needsId = !configuredId || configuredId === placeholder;
    if (!needsId && !databasePattern.test(configuredId)) return stop(stage);

    stage = 'D1_LIST_FAILED';
    let databases = parseJson(await run(['d1', 'list', '--json'], selectedEnv));
    if (!Array.isArray(databases)) return stop(stage);
    let matches = databases.filter(database => database.name === databaseName);
    if (matches.length > 1) return stop('D1_CONFIG_CONFLICT');
    if (!matches.length) {
      // A configured database disappearing is a conflict, not permission to
      // replace it with a newly created database.
      if (!needsId) return stop('D1_CONFIG_CONFLICT');
      stage = 'D1_CREATE_FAILED';
      const created = await run(['d1', 'create', databaseName, '--update-config=false'], selectedEnv);
      if (created.status !== 0 || created.error) return stop(stage);
      stage = 'D1_LIST_FAILED';
      databases = parseJson(await run(['d1', 'list', '--json'], selectedEnv));
      if (!Array.isArray(databases)) return stop(stage);
      matches = databases.filter(database => database.name === databaseName);
    }
    const databaseId = matches.length === 1 ? matches[0].uuid : undefined;
    if (!databaseId || !databasePattern.test(databaseId)) return stop('D1_CONFIG_CONFLICT');
    if (!needsId && databaseId !== configuredId) return stop('D1_CONFIG_CONFLICT');
    report('D1_READY');

    stage = 'CONFIG_WRITE_FAILED';
    // Re-read to preserve unrelated local edits and reject account/DB changes
    // made while the remote lookup was running.
    const current = await readConfig();
    const currentBinding = databaseBinding(current);
    if (!currentBinding || currentBinding.database_id !== configuredId ||
        (current.account_id && current.account_id !== accountId)) {
      return stop('D1_CONFIG_CONFLICT');
    }
    if (current.account_id !== accountId || needsId) {
      current.account_id = accountId;
      if (needsId) currentBinding.database_id = databaseId;
      await writeConfig(current);
    }
    report('CONFIG_READY');

    stage = 'MIGRATIONS_FAILED';
    const migrated = await run(['d1', 'migrations', 'apply', 'DB', '--remote'], selectedEnv);
    if (migrated.status !== 0 || migrated.error) return stop(stage);
    report('MIGRATIONS_APPLIED');

    stage = 'DEPLOY_FAILED';
    const deployed = await run(['deploy', '--strict'], selectedEnv);
    if (deployed.status !== 0 || deployed.error) return stop(stage);
    report('DEPLOYED');
    const url = deployed.stdout?.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b/i)?.[0];
    if (url) report(url);
    return 0;
  } catch {
    return stop(stage);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--check') || args.length > 1) {
    process.stdout.write('ACTIVATION_ARGUMENTS_INVALID\n');
    process.exitCode = 1;
  } else {
    try {
      process.exitCode = await activateCloudflare({ check: args[0] === '--check' });
    } catch {
      process.stdout.write(args[0] === '--check' ? 'AUTH_REQUIRED\n' : 'ACTIVATION_FAILED\n');
      process.exitCode = 1;
    }
  }
}
