// Host Iron Front from your own PC in one step: installs and builds the game when
// needed, starts the game server, opens it in your browser, and can open a free
// Cloudflare tunnel so friends anywhere can join.
//
//   Windows: double-click "Start Iron Front.bat"
//   Mac / Linux: npm run play
//
// Options: --tunnel / --no-tunnel (skip the question), --no-browser. PORT changes the port.

import { exec, spawn, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const PORT = Number(process.env.PORT ?? 8787);
const LOCAL_URL = `http://localhost:${PORT}`;
const WIN = process.platform === 'win32';
const args = new Set(process.argv.slice(2));

const say = (text = '') => console.log(text);
function fail(text) {
  say();
  say(`!! ${text}`);
  process.exit(1);
}

// ------------------------------------------------------------ Node version

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) fail(`Iron Front needs Node.js 20 or newer (you have ${process.versions.node}). Get the LTS version from https://nodejs.org.`);

// ------------------------------------------------------------ install & build (only when needed)

/** Runs a fixed command like "npm install" (through the shell, so npm.cmd is found on Windows). */
function run(command) {
  const r = spawnSync(command, { stdio: 'inherit', shell: true });
  if (r.status !== 0) fail(`"${command}" didn't work. Check the messages above.`);
}

const mtime = file => (existsSync(file) ? statSync(file).mtimeMs : 0);
/** Newest change time of a file or of anything inside a folder. */
function newest(path) {
  if (!existsSync(path)) return 0;
  if (!statSync(path).isDirectory()) return mtime(path);
  return Math.max(0, ...readdirSync(path).map(name => newest(join(path, name))));
}

const installed = mtime('node_modules/.package-lock.json');
if (!installed || mtime('package-lock.json') > installed || mtime('package.json') > installed) {
  say('Installing what the game needs (first time only, takes a minute or two)...');
  run('npm install --no-audit --no-fund');
}

const built = Math.min(mtime('dist/index.html'), mtime('dist-server/server.cjs'));
const sources = Math.max(...['src', 'server', 'index.html', 'package.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.server.json'].map(newest));
if (!built || sources > built) {
  say('Building the game (after the first time, only when the game changed)...');
  run('npm run build');
}

// ------------------------------------------------------------ save key

// Saved online matches are sealed with this key, so nobody can open a save to peek
// through the fog. It lives in your home folder, so it survives updating the game.
const KEY_FILE = join(homedir(), '.iron-front-save-secret');
let saveSecret = process.env.SAVE_SECRET;
if (!saveSecret) {
  if (!existsSync(KEY_FILE)) writeFileSync(KEY_FILE, randomBytes(32).toString('hex'));
  saveSecret = readFileSync(KEY_FILE, 'utf8').trim();
}

// ------------------------------------------------------------ tunnel question

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase()); }));
}

/** cloudflared on the PATH, or where the Windows installer puts it. */
function findCloudflared() {
  const onPath = spawnSync('cloudflared --version', { stdio: 'ignore', shell: true });
  if (onPath.status === 0) return 'cloudflared';
  const candidates = WIN
    ? [join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'cloudflared', 'cloudflared.exe')]
    : ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'];
  return candidates.find(existsSync) ?? null;
}

let wantTunnel = args.has('--tunnel');
if (!wantTunnel && !args.has('--no-tunnel')) {
  say();
  say('Friends on your Wi-Fi can always join. For friends elsewhere, Iron Front can open a');
  say('free Cloudflare tunnel that gives you a link that works from anywhere.');
  wantTunnel = (await ask('Open a tunnel for friends over the internet? (y/n) ')).startsWith('y');
}
let cloudflared = null;
if (wantTunnel) {
  cloudflared = findCloudflared();
  if (!cloudflared) {
    say();
    say("The tunnel needs Cloudflare's free cloudflared tool, which isn't installed yet.");
    say(WIN ? 'Install it by running this in a Command Prompt, then start Iron Front again:'
      : 'Install it (Mac: brew install cloudflared), then start Iron Front again.');
    if (WIN) say('    winget install --id Cloudflare.cloudflared');
    say('For now the game starts for you and friends on your Wi-Fi.');
  }
}

// ------------------------------------------------------------ server

const children = [];
function stopAll() {
  for (const c of children) if (c.exitCode === null) c.kill();
}
process.on('SIGINT', () => { stopAll(); process.exit(0); });
process.on('exit', stopAll);

function openBrowser(url) {
  if (args.has('--no-browser')) return;
  const cmd = WIN ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

say();
say('Starting the Iron Front server...');
const server = spawn(process.execPath, ['dist-server/server.cjs'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), SAVE_SECRET: saveSecret },
});
children.push(server);
let started = false;
server.stderr.on('data', d => process.stderr.write(d));
server.stdout.on('data', d => {
  const text = String(d);
  process.stdout.write(text);
  if (!started && text.includes('Iron Front server on')) {
    started = true;
    onServerReady();
  }
});
server.on('exit', code => {
  if (!started) {
    fail(`The server didn't start. If it says the port is in use, Iron Front is probably already running:\n   open ${LOCAL_URL}, or close the other Iron Front window first.`);
  }
  say();
  say(`The server stopped (code ${code}).`);
  process.exit(code ?? 0);
});

function onServerReady() {
  say();
  say(`The game is running. Open ${LOCAL_URL} (your browser should open it now).`);
  say('Friends on your Wi-Fi: send them the "same network" address above.');
  openBrowser(LOCAL_URL);
  if (cloudflared) startTunnel();
  else footer();
}

function footer() {
  say();
  say('Keep this window open while you play. Press Ctrl+C or close it to stop.');
  say('Tip: click Save in the game before stopping, so you can carry on later.');
}

// ------------------------------------------------------------ tunnel

function startTunnel() {
  say();
  say('Opening the tunnel for friends over the internet...');
  const tunnel = spawn(cloudflared, ['tunnel', '--url', LOCAL_URL], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(tunnel);
  const recent = [];
  let link = null;
  const read = d => {
    for (const line of String(d).split(/\r?\n/)) {
      if (!line.trim()) continue;
      recent.push(line);
      if (recent.length > 8) recent.shift();
      const found = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (found && !link) {
        link = found[0];
        say();
        say('==================================================================');
        say('  Friends anywhere can join at:');
        say(`     ${link}`);
        say('  (This link changes every time you start Iron Front.)');
        say('==================================================================');
        footer();
      }
    }
  };
  tunnel.stdout.on('data', read);
  tunnel.stderr.on('data', read);
  tunnel.on('exit', () => {
    say();
    say(link
      ? 'The tunnel closed, so friends outside your Wi-Fi can no longer connect. Restart Iron Front to get a new link.'
      : "The tunnel couldn't start. Its last messages were:");
    if (!link) for (const line of recent) say(`   ${line}`);
    if (!link) footer();
  });
}
