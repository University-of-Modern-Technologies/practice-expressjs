#!/usr/bin/env node
/* global process, console */

// One entry point for running the stack, so the same command works in
// PowerShell, cmd, bash and zsh. Only Node built-ins: this runs before any
// dependency is installed.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  ['API_PORT', 3000, 'API'],
  ['WEB_PORT', 3100, 'web client'],
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

function readEnv(file = '.env') {
  const target = path.join(root, file);
  if (!existsSync(target)) return {};
  const values = {};
  for (const line of readFileSync(target, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function run(command, args, { cwd = root } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
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
  if (!existsSync(target)) writeFileSync(target, randomBytes(12).toString('base64url'));
  return readFileSync(target, 'utf8').trim();
}

function ensureEnv() {
  if (!existsSync(path.join(root, '.env'))) {
    fail('.env is missing. Run `npm run setup` first.');
  }
}

function printAddresses() {
  const env = readEnv();
  const http = env.HTTP_PORT || 8080;
  console.log('');
  console.log(green(`Ready: http://localhost:${http}`));
  console.log(`  API docs:  http://localhost:${http}/docs`);
  console.log(`  Health:    http://localhost:${http}/health/ready`);
  console.log('');
  console.log('  Sign in as admin@crm-training.example');
  console.log(`  Password:  ${env.SEED_USER_PASSWORD ?? 'the SEED_USER_PASSWORD value from .env'}`);
}

async function confirm(question) {
  if (process.argv.includes('--yes') || process.argv.includes('-y')) return true;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(yellow(`${question} Type "yes" to continue: `));
  prompt.close();
  return answer.trim() === 'yes';
}

const extra = process.argv.slice(3).filter((argument) => argument !== '--yes' && argument !== '-y');

const commands = {
  async setup() {
    const existing = readEnv();
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
    if (!existsSync(path.join(root, 'frontend/.env.local'))) {
      copyFileSync(
        path.join(root, 'frontend/.env.example'),
        path.join(root, 'frontend/.env.local'),
      );
    }
    ensurePortainerPassword();

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
          'If it is not this stack holding them, put other values into .env before `npm start`.',
        ),
      );
    }
    console.log(`\nNext: ${bold('npm start')}`);
  },

  start() {
    ensureEnv();
    requireDocker();
    compose('dev', ['up', '-d', '--build', '--wait', ...extra]);
    printAddresses();
  },

  stop() {
    compose('dev', ['--profile', 'tools', 'down', '--remove-orphans']);
  },

  // Production images are built once by `build`; starting only builds what is missing.
  'prod:start'() {
    ensureEnv();
    requireDocker();
    compose('prod', ['up', '-d', '--wait', ...extra]);
    printAddresses();
  },

  'prod:stop'() {
    compose('prod', ['--profile', 'tools', 'down', '--remove-orphans']);
  },

  build() {
    ensureEnv();
    requireDocker();
    compose('prod', ['build', ...extra]);
  },

  test() {
    run('npm', ['test'], { cwd: path.join(root, 'backend') });
    run('npm', ['test'], { cwd: path.join(root, 'frontend') });
  },

  'start:api'() {
    ensureEnv();
    requireDocker();
    compose('dev', ['up', '-d', '--build', '--wait', 'api']);
    console.log(green(`\nAPI: http://localhost:${readEnv().API_PORT || 3000}/docs`));
  },

  'start:infra'() {
    ensureEnv();
    requireDocker();
    compose('dev', ['up', '-d', '--wait', ...storageServices]);
    console.log(green('\nStorage is up. Start the API on this machine: npm run dev'));
  },

  async clean() {
    if (!(await confirm('This deletes the databases. Every record is lost.'))) {
      console.log('Cancelled.');
      return;
    }
    compose('dev', ['--profile', 'tools', 'down', '--volumes', '--remove-orphans']);
  },

  logs() {
    compose('dev', ['logs', '-f', '--tail=100', ...extra]);
  },

  ps() {
    compose('dev', ['ps']);
  },

  'db:migrate'() {
    ensureEnv();
    compose('dev', ['run', '--rm', 'migrate']);
  },

  'db:seed:demo'() {
    ensureEnv();
    compose('dev', ['run', '--rm', 'migrate', 'npm', 'run', 'db:seed:demo']);
  },

  tools() {
    ensureEnv();
    requireDocker();
    const password = ensurePortainerPassword();
    compose('dev', ['--profile', 'tools', 'up', '-d', 'portainer']);
    console.log(green(`\nPortainer: http://localhost:${readEnv().PORTAINER_PORT || 9000}`));
    console.log('  User:      admin');
    console.log(`  Password:  ${password}  (from ${portainerPasswordFile})`);
  },
};

const command = commands[process.argv[2]];
if (!command) {
  console.log(`Usage: node scripts/stack.mjs <${Object.keys(commands).join('|')}>`);
  process.exit(process.argv[2] ? 1 : 0);
}
await command();
