#!/usr/bin/env node
/* global process, console */

// One entry point for running the stack, so the same command works in
// PowerShell, cmd, bash and zsh. Only Node built-ins: this runs before any
// dependency is installed.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeFiles = {
  dev: ['compose.yaml', 'compose.override.yaml'],
  prod: ['compose.yaml'],
};
const envFiles = [
  ['.env.example', '.env'],
  ['backend/.env.example', 'backend/.env'],
];
const generatedSecrets = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];
const portainerPasswordFile = '.portainer-password';
const storageServices = ['postgres', 'redis', 'mongo'];
const ports = [
  ['HTTP_PORT', 8080, 'application (nginx)'],
  ['API_PORT', 8000, 'API'],
  ['WEB_PORT', 3000, 'web client'],
  ['POSTGRES_PORT', 5432, 'PostgreSQL'],
  ['REDIS_PORT', 6379, 'Redis'],
  ['MONGO_PORT', 27017, 'MongoDB'],
];

const colour = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = colour('32');
const yellow = colour('33');
const red = colour('31');
const bold = colour('1');

function fail(message, code = 1) {
  console.error(red(`Error: ${message}`));
  process.exit(code);
}

// The rules Docker Compose reads `.env` by, so this script and the stack see
// the same values: surrounding spaces are trimmed, matching quotes removed, and
// `#` starts a comment only after a space in an unquoted value.
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const QUOTED_VALUE = /^(['"])(.*?)\1(?:\s+#.*)?$/;

function parseEnvValue(raw) {
  const text = raw.trim();
  const quoted = QUOTED_VALUE.exec(text);
  return quoted ? quoted[2] : text.replace(/\s+#.*$/, '').trim();
}

// A blank value is left out, so every caller falls back to its default.
function readEnv(file = '.env') {
  const target = path.join(root, file);
  if (!existsSync(target)) return {};
  const values = {};
  for (const line of readFileSync(target, 'utf8').split(/\r?\n/)) {
    const match = ENV_LINE.exec(line);
    if (!match) continue;
    const value = parseEnvValue(match[2]);
    if (value !== '') values[match[1]] = value;
  }
  return values;
}

// npm and npx are `.cmd` shims on Windows and start only through a shell. A shell
// joins separate arguments without escaping them, so the command goes in whole.
function spawnTool(command, args, options) {
  return process.platform === 'win32'
    ? spawnSync([command, ...args].join(' '), { ...options, shell: true })
    : spawnSync(command, args, options);
}

function run(command, args, { cwd = root, env = process.env } = {}) {
  const result = spawnTool(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) fail(`${command} is not installed or not in PATH`, 2);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function compose(mode, args) {
  const result = spawnSync(
    'docker',
    ['compose', ...composeFiles[mode].flatMap((file) => ['-f', file]), ...args],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error) fail('docker is not installed or not in PATH', 2);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function requireDocker() {
  const result = spawnSync('docker', ['info'], { cwd: root, stdio: 'ignore' });
  if (result.error) fail('docker is not installed or not in PATH', 2);
  if (result.status !== 0) {
    fail('the Docker daemon is not responding. Start Docker Desktop and try again.', 2);
  }
}

function somethingAnswers(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const settle = (answered) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(500);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

function canBind(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

// Binding alone is not enough on Windows: a listener on 0.0.0.0 does not stop a
// second one on 127.0.0.1, and the two then split the traffic between them.
async function portIsFree(port) {
  return !(await somethingAnswers(port)) && (await canBind(port));
}

function writeEnvFile(source, target, secrets) {
  const lines = readFileSync(path.join(root, source), 'utf8').split(/\r?\n/);
  const content = lines
    .map((line) => {
      const key = /^([A-Z_]+)=/.exec(line)?.[1];
      return key && key in secrets ? `${key}=${secrets[key]}` : line;
    })
    .join('\n');
  writeFileSync(path.join(root, target), content);
}

function ensurePortainerPassword() {
  const target = path.join(root, portainerPasswordFile);
  // Docker creates an empty directory in place of a bind-mounted file that is
  // missing; a stack started that way once leaves it behind.
  if (existsSync(target) && statSync(target).isDirectory()) {
    try {
      rmdirSync(target);
    } catch {
      fail(`${portainerPasswordFile} is a directory that is not empty. Remove it and try again.`);
    }
  }
  if (!existsSync(target) || readFileSync(target, 'utf8').trim() === '') {
    writeFileSync(target, randomBytes(12).toString('base64url'));
  }
  return readFileSync(target, 'utf8').trim();
}

// The pre-commit hook lives in the root package: `npm install` there brings
// husky and lint-staged, and husky's `prepare` script wires the hook into git.
function installHooks() {
  const result = spawnTool('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.log(yellow('The pre-commit hook was not installed; `npm install` in the root failed.'));
  } else if (!existsSync(path.join(root, '.git'))) {
    console.log(
      yellow('Not a git repository: after `git init`, run setup again for the pre-commit hook.'),
    );
  } else {
    console.log(green('Installed the pre-commit hook (format and lint of staged files)'));
  }
}

function ensureEnv() {
  for (const [, target] of envFiles) {
    if (!existsSync(path.join(root, target))) {
      fail(`${target} is missing. Run \`npm run setup\` first.`);
    }
  }
}

function ensureInstalled(dir) {
  if (!existsSync(path.join(dir, 'node_modules'))) {
    fail(`${path.basename(dir)} dependencies are not installed. Run \`npm run local:install\`.`);
  }
}

const apiPort = () => Number(readEnv().API_PORT || 8000);
const backend = path.join(root, 'backend');
const frontend = path.join(root, 'frontend');

// Each step starts the one before it and adds its own part: storage, then the
// API, then the web client and the proxy. The step that is already up is
// left as is, so starting a larger one over a smaller one costs seconds.

function startStorage() {
  ensureEnv();
  requireDocker();
  compose('dev', ['up', '-d', '--wait', ...storageServices]);
  // Migrations and the base seed run once and exit; what is applied is skipped.
  compose('dev', ['run', '--rm', '--build', 'migrate']);
}

function startApi() {
  startStorage();
  compose('dev', ['up', '-d', '--build', '--wait', '--no-deps', 'api']);
}

function startAll() {
  startApi();
  compose('dev', ['up', '-d', '--build', '--wait', '--no-deps', 'web']);
  // After the web client, not with it: nginx resolves its upstreams on start.
  compose('dev', ['up', '-d', '--build', '--wait', '--no-deps', 'nginx']);
}

// Production mode serves no API docs (API_DOCS_ENABLED is off there).
function printAddresses({ docs = true } = {}) {
  const http = readEnv().HTTP_PORT || 8080;
  const password = readEnv('backend/.env').SEED_USER_PASSWORD;
  console.log('');
  console.log(green(`Ready: http://localhost:${http}`));
  if (docs) console.log(`  API docs:  http://localhost:${http}/api/docs`);
  console.log(`  Health:    http://localhost:${http}/api/health/ready`);
  console.log('');
  console.log('  Sign in as admin@crm-training.example');
  console.log(`  Password:  ${password ?? 'the SEED_USER_PASSWORD value from backend/.env'}`);
}

async function confirm(question) {
  if (process.argv.includes('--yes') || process.argv.includes('-y')) return true;
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await prompt.question(yellow(`${question} Type "yes" to continue: `));
  prompt.close();
  return answer.trim() === 'yes';
}

const extra = process.argv.slice(3).filter((argument) => argument !== '--yes' && argument !== '-y');

const commands = {
  async setup() {
    const existing = readEnv('backend/.env');
    const secrets = Object.fromEntries(
      generatedSecrets.map((key) => [key, existing[key] || randomBytes(32).toString('base64url')]),
    );

    for (const [source, target] of envFiles) {
      if (existsSync(path.join(root, target))) {
        console.log(`${target} already exists, left as is`);
      } else {
        writeEnvFile(source, target, secrets);
        console.log(green(`Created ${target}`));
      }
    }
    ensurePortainerPassword();
    installHooks();

    const env = readEnv();
    const busy = [];
    for (const [key, fallback, label] of ports) {
      const port = Number(env[key] || fallback);
      if (!(await portIsFree(port))) busy.push(`  ${key}=${port} (${label})`);
    }
    if (busy.length > 0) {
      console.log(yellow('\nThese ports are already taken on this machine:'));
      console.log(busy.join('\n'));
      console.log(
        yellow(
          'If it is not this stack holding them, put other values into .env before starting it.',
        ),
      );
    }
    console.log(`\nNext: ${bold('npm run docker:all')}`);
  },

  'local:install'() {
    run('npm', ['ci'], { cwd: backend });
    run('npm', ['ci'], { cwd: frontend });
  },

  // One API port for every way of running it, so the web client always finds it.
  // Two processes on one port do not fail on Windows, they split the traffic.
  async 'local:api'() {
    ensureEnv();
    ensureInstalled(backend);
    const port = apiPort();
    if (!(await portIsFree(port))) {
      fail(
        `port ${port} is already taken, most likely by the api container of this stack.\n` +
          'Stop the containers (npm run docker:stop) and run local:api again.',
      );
    }
    startStorage();
    run('npm', ['run', 'dev'], { cwd: backend });
  },

  'local:web'() {
    ensureInstalled(frontend);
    const env = { ...process.env, API_ORIGIN: `http://127.0.0.1:${apiPort()}` };
    const webPort = String(readEnv().WEB_PORT || 3000);
    run('npx', ['next', 'dev', '--port', webPort], { cwd: frontend, env });
  },

  'docker:db'() {
    startStorage();
    console.log(green('\nStorage is up and migrated. API on this machine: npm run local:api'));
  },

  'docker:api'() {
    startApi();
    console.log(green(`\nAPI: http://localhost:${apiPort()}/api/docs`));
  },

  'docker:all'() {
    startAll();
    printAddresses();
  },

  // Builds what changed and starts it; an image that is up to date takes seconds.
  'docker:prod'() {
    ensureEnv();
    requireDocker();
    compose('prod', ['up', '-d', '--build', '--wait']);
    printAddresses({ docs: false });
  },

  'docker:build'() {
    ensureEnv();
    requireDocker();
    compose('prod', ['build', ...extra]);
  },

  // Both modes share the project and its service names, so one `down` stops either.
  'docker:stop'() {
    compose('dev', ['--profile', 'tools', 'down', '--remove-orphans']);
  },

  async 'docker:clean'() {
    if (!(await confirm('This deletes the databases. Every record is lost.'))) {
      console.log('Cancelled.');
      return;
    }
    compose('dev', ['--profile', 'tools', 'down', '--volumes', '--remove-orphans']);
  },

  'docker:logs'() {
    compose('dev', ['logs', '-f', '--tail=100', ...extra]);
  },

  'docker:ps'() {
    compose('dev', ['ps']);
  },

  'docker:portainer'() {
    ensureEnv();
    requireDocker();
    const password = ensurePortainerPassword();
    compose('dev', ['--profile', 'tools', 'up', '-d', 'portainer']);
    console.log(green(`\nPortainer: http://localhost:${readEnv().PORTAINER_PORT || 9000}`));
    console.log('  User:      admin');
    console.log(`  Password:  ${password}  (from ${portainerPasswordFile})`);
  },

  'db:migrate'() {
    ensureEnv();
    compose('dev', ['run', '--rm', 'migrate']);
  },

  'db:seed:demo'() {
    ensureEnv();
    compose('dev', ['run', '--rm', 'migrate', 'npm', 'run', 'db:seed:demo']);
  },

  test() {
    run('npm', ['test'], { cwd: backend });
    run('npm', ['test'], { cwd: frontend });
  },

  // The API and web client jobs of CI; integration tests, the migrations check
  // and the image build run there as well (`test:integration`, `docker:build`).
  check() {
    commands['check:api']();
    commands['check:web']();
  },

  'check:api'() {
    run('npm', ['run', 'ci'], { cwd: backend });
  },

  'check:web'() {
    run('npm', ['run', 'ci'], { cwd: frontend });
  },

  // Talks to the storage of `docker:db`; it never starts containers itself.
  'test:integration'() {
    run('npm', ['run', 'test:integration'], { cwd: backend });
  },
};

const command = commands[process.argv[2]];
if (!command) {
  console.log(`Usage: node scripts/stack.mjs <${Object.keys(commands).join('|')}>`);
  process.exit(process.argv[2] ? 1 : 0);
}
await command();
