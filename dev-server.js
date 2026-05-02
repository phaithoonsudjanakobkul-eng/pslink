#!/usr/bin/env node
/**
 * PSLink Dev Server (Beefy Edition)
 *
 * Usage:
 *   npm run dev              HTTPS local + Chrome dev profile + DevTools
 *                            + AUTO-DEPLOY to GitHub Pages on save (90s debounce)
 *   npm run dev:tunnel       above + Cloudflare Tunnel public URL
 *   npm run dev:headless     no auto-open browser
 *   npm run dev:local        skip auto-deploy (private edit session)
 *
 * Hotkeys (in this terminal):
 *   r  force reload         o  open browser         d  force deploy NOW
 *   t  start tunnel         q / Ctrl+C  quit
 *
 * Auto-deploy: watches index.html → after 90s of no edits → runs
 *   git add -A && git commit -m "deploy: <timestamp>" && git push
 * GitHub Pages then rebuilds in ~30s.  See HAS_GIT/noDeploy guards.
 */

const { spawn, exec } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

// === Config ===
const FILE = 'index.html';
const HTTP_PORT = 8090;
const HTTPS_PORT = 8443;
const DIR = __dirname;
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const args = process.argv.slice(2);
const wantTunnel = args.includes('tunnel');
const noOpen = args.includes('--no-open');
const noDeploy = args.includes('--no-deploy');

// Node 16+ security mitigation requires shell:true to spawn .cmd shims (npx, etc.) on Windows.
// But shell:true on cmd.exe re-splits args on whitespace, breaking values like "PSLink with PWA.html".
// Workaround: wrap any arg containing whitespace in double quotes — cmd.exe preserves the quoted
// value atomically when forwarding to the child process.
const IS_WIN = process.platform === 'win32';
const q = (s) => /\s/.test(s) ? `"${s}"` : s;

// === Console helpers (no chalk dep) ===
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
  magenta: '\x1b[35m', red: '\x1b[31m', gray: '\x1b[90m',
};
const ts = () => new Date().toTimeString().slice(0, 8);
const log = (tag, msg, color = 'cyan') =>
  console.log(`${C.gray}[${ts()}]${C.reset} ${C[color]}[${tag}]${C.reset} ${msg}`);

// === Banner ===
console.log('');
console.log(`${C.bold}${C.cyan}╔═══════════════════════════════════════════════╗${C.reset}`);
console.log(`${C.bold}${C.cyan}║         PSLink Dev Server (Beefy)             ║${C.reset}`);
console.log(`${C.bold}${C.cyan}╚═══════════════════════════════════════════════╝${C.reset}`);
console.log('');

// === Network IP ===
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name in nets) {
    for (const ni of nets[name]) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}
const LAN_IP = getLocalIP();

// === Port check ===
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '0.0.0.0');
  });
}

// === Chrome path ===
function findChrome() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const CHROME = findChrome();

// === QR (graceful fallback if package missing) ===
function showQR(url) {
  try {
    const qr = require('qrcode-terminal');
    qr.generate(url, { small: true });
  } catch (e) {
    console.log(`  ${C.gray}(run ${C.yellow}npm install${C.gray} once for inline QR)${C.reset}`);
    console.log(`  ${C.cyan}${url}${C.reset}`);
  }
}

// === State ===
let liveServer = null;
let httpsProxy = null;
let tunnelProc = null;
let announced = false;

// === Auto-deploy state ===
const DEPLOY_DEBOUNCE_MS = 90 * 1000;  // 90s after last save → auto git push
const HAS_GIT = fs.existsSync(path.join(DIR, '.git'));
let _deployTimer = null;
let _pendingChanges = 0;
let _lastDeployAt = null;
let _deployInFlight = false;

// === Find PID holding a port (Windows) ===
function findPortPid(port) {
  if (!IS_WIN) return null;
  try {
    const out = require('child_process').execSync(`netstat -ano -p tcp`, { encoding: 'utf8' });
    const re = new RegExp(`\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`);
    const m = out.match(re);
    return m ? parseInt(m[1], 10) : null;
  } catch (e) { return null; }
}

// === Pre-flight ===
async function preflight() {
  for (const [label, port] of [['HTTP', HTTP_PORT], ['HTTPS', HTTPS_PORT]]) {
    const free = await isPortFree(port);
    if (!free) {
      const pid = findPortPid(port);
      log('port', `Port ${port} (${label}) is busy${pid ? ` — held by PID ${pid}` : ''}`, 'red');
      if (pid) {
        log('port', `Run: ${C.yellow}taskkill /F /PID ${pid}${C.reset}  (or close the previous dev server)`, 'red');
      }
      process.exit(1);
    }
  }
  log('check', `✓ Ports ${HTTP_PORT} (HTTP) + ${HTTPS_PORT} (HTTPS) free`, 'green');
  if (!CHROME) {
    log('check', `Chrome not found — will fall back to default browser`, 'yellow');
  } else {
    log('check', `✓ Chrome found`, 'green');
  }
  if (LAN_IP) {
    log('check', `✓ LAN IP: ${C.bold}${LAN_IP}${C.reset}`, 'green');
  }
  console.log('');
}

// === live-server (HTTP) ===
function startLiveServer() {
  log('init', `Starting live-server on :${HTTP_PORT}...`, 'cyan');
  const ignorePatterns = '*.xlsx,*.pdf,*.eml,*.png,*.jpg,*.jpeg,*.webp,*.tif,*.tiff,*.rar,*.zip,*.onnx,*.safetensors,*.log,backup*.html,node_modules,.chrome-dev';
  liveServer = spawn('npx', [
    'live-server',
    `--port=${HTTP_PORT}`,
    '--no-browser',
    '--wait=400',
    '--no-css-inject',
    `--watch=${q(FILE)}`,
    `--ignore=${ignorePatterns}`,
  ], { cwd: DIR, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let httpReady = false;
  const onData = (data) => {
    const text = data.toString();
    if (!httpReady && /Serving|listening/i.test(text)) {
      httpReady = true;
      log('http', `✓ live-server ready`, 'green');
    }
    if (/change detected/i.test(text)) {
      log('reload', `${C.yellow}● ${FILE} changed — reloading${C.reset}`, 'yellow');
    }
  };
  liveServer.stdout.on('data', onData);
  liveServer.stderr.on('data', onData);

  // live-server doesn't always print a clear "ready" — start HTTPS after 1.5s
  setTimeout(startHttpsProxy, 1500);
}

// === local-ssl-proxy (HTTPS) ===
function startHttpsProxy() {
  log('init', `Starting HTTPS proxy on :${HTTPS_PORT}...`, 'cyan');
  const certPath = path.join(DIR, '.certs', 'cert.pem');
  const keyPath = path.join(DIR, '.certs', 'key.pem');
  const hasMkcert = fs.existsSync(certPath) && fs.existsSync(keyPath);
  const proxyArgs = [
    'local-ssl-proxy',
    `--source=${HTTPS_PORT}`,
    `--target=${HTTP_PORT}`,
    '--hostname=0.0.0.0',
  ];
  if (hasMkcert) {
    proxyArgs.push(`--cert=${q(certPath)}`, `--key=${q(keyPath)}`);
    log('init', `Using mkcert trusted cert ${C.dim}(.certs/)${C.reset}`, 'green');
  } else {
    log('init', `No mkcert cert — using auto self-signed (browser will warn)`, 'yellow');
  }
  httpsProxy = spawn('npx', proxyArgs, { cwd: DIR, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

  httpsProxy.stdout.on('data', (data) => {
    if (!announced) {
      log('https', `✓ HTTPS proxy ready`, 'green');
      announceURLs();
    }
  });
  httpsProxy.stderr.on('data', () => { /* swallow */ });

  // Fallback announce after 1.5s if proxy didn't print
  setTimeout(() => { if (!announced) announceURLs(); }, 1500);
}

// === Announce ===
function announceURLs() {
  if (announced) return;
  announced = true;

  const enc = encodeURIComponent(FILE);
  const localUrl = `https://localhost:${HTTPS_PORT}/${enc}`;
  const lanUrl = LAN_IP ? `https://${LAN_IP}:${HTTPS_PORT}/${enc}` : null;

  console.log('');
  console.log(`${C.bold}${C.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  console.log(`${C.bold}  PSLink ready${C.reset}\n`);
  console.log(`  ${C.cyan}● Local:   ${C.reset}${localUrl}`);
  if (lanUrl) console.log(`  ${C.cyan}● Network: ${C.reset}${lanUrl}  ${C.gray}(mobile)${C.reset}`);
  console.log('');
  console.log(`  ${C.dim}Self-signed cert — accept browser warning on first visit.${C.reset}`);
  console.log(`${C.bold}${C.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}\n`);

  if (lanUrl) {
    console.log(`${C.cyan}  Scan QR on phone (same Wi-Fi):${C.reset}`);
    showQR(lanUrl);
    console.log('');
  }

  if (!noOpen) openBrowser(localUrl);
  if (wantTunnel) startTunnel();
  startAutoDeploy();
  bindHotkeys();
}

// === Open Chrome (uses main profile so existing Gist token / API keys are available) ===
function openBrowser(url) {
  if (!CHROME) {
    log('open', `Default browser → ${url}`, 'cyan');
    exec(`start "" "${url}"`);
    return;
  }
  log('chrome', `Opening Chrome with DevTools...`, 'cyan');
  const child = spawn(CHROME, [
    '--auto-open-devtools-for-tabs',
    url,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  log('chrome', `✓ Launched`, 'green');
}

// === Cloudflare Tunnel (auto-restart) ===
function startTunnel(retry = 0) {
  log('tunnel', `Starting Cloudflare Tunnel${retry ? ` (retry ${retry}/5)` : ''}...`, 'magenta');
  tunnelProc = spawn('npx', ['cloudflared', 'tunnel', '--url', `http://localhost:${HTTP_PORT}`], {
    cwd: DIR, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
  });

  let tunnelUrl = null;
  const handler = (data) => {
    const text = data.toString();
    const m = text.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
    if (m && !tunnelUrl) {
      tunnelUrl = m[1];
      const fullUrl = `${tunnelUrl}/${encodeURIComponent(FILE)}`;
      console.log('');
      log('tunnel', `${C.bold}✓ Public:${C.reset} ${C.cyan}${fullUrl}${C.reset}`, 'magenta');
      console.log('');
      showQR(fullUrl);
      console.log('');
    }
  };
  tunnelProc.stdout.on('data', handler);
  tunnelProc.stderr.on('data', handler);

  tunnelProc.on('close', (code) => {
    if (code !== 0 && retry < 5) {
      log('tunnel', `Disconnected — restart in 3s...`, 'yellow');
      setTimeout(() => startTunnel(retry + 1), 3000);
    } else if (code !== 0) {
      log('tunnel', `Failed after 5 retries`, 'red');
    }
  });
}

// === Auto-deploy to GitHub Pages (debounced) ===
// Watches FILE → after DEPLOY_DEBOUNCE_MS of no changes → git add+commit+push.
// One commit per "edit session" instead of one-per-save (debounce collapses bursts).
// Disabled via --no-deploy flag or when no .git directory present.
function _deployStatusLine() {
  const last = _lastDeployAt ? `last ${_lastDeployAt}` : 'never';
  const pending = _pendingChanges > 0 ? ` · ${_pendingChanges} change${_pendingChanges > 1 ? 's' : ''} pending` : '';
  return `${last}${pending}`;
}

function scheduleDeploy() {
  if (!HAS_GIT || noDeploy) return;
  _pendingChanges++;
  log('deploy', `${C.gray}● change queued — push in ${DEPLOY_DEBOUNCE_MS / 1000}s ${C.dim}(${_deployStatusLine()})${C.reset}`, 'magenta');
  if (_deployTimer) clearTimeout(_deployTimer);
  _deployTimer = setTimeout(runDeploy, DEPLOY_DEBOUNCE_MS);
}

function runDeploy(force = false) {
  if (!HAS_GIT) {
    log('deploy', `Not a git repo — skipping`, 'yellow');
    return;
  }
  if (_deployInFlight) {
    log('deploy', `Already pushing — will retry on next save`, 'yellow');
    return;
  }
  if (_pendingChanges === 0 && !force) {
    log('deploy', `${C.gray}No pending changes${C.reset}`, 'gray');
    return;
  }
  _deployInFlight = true;
  if (_deployTimer) { clearTimeout(_deployTimer); _deployTimer = null; }
  const stamp = new Date().toLocaleString('en-GB', { hour12: false });
  log('deploy', `${C.magenta}📤 Pushing to GitHub...${C.reset}`, 'magenta');
  // git add -A stages every tracked change (index.html, manifest.json, etc.).
  // .gitignore filters out backups/secrets so this is safe.
  const cmd = `git add -A && git commit -m "deploy: ${stamp}" && git push`;
  exec(cmd, { cwd: DIR }, (err, stdout, stderr) => {
    _deployInFlight = false;
    const out = String(stdout || '');
    const errOut = String(stderr || '');
    // "nothing to commit" goes to git's STDOUT (not stderr), so check both streams.
    // Means user hit 'd' with no real changes, or the watched file was touched
    // without content diff (IDE auto-save, mtime bump). Treat as success.
    if (/nothing to commit/i.test(out) || /nothing to commit/i.test(errOut)) {
      const evt = _pendingChanges > 0
        ? ` ${C.gray}(${_pendingChanges} fs event${_pendingChanges > 1 ? 's' : ''} from IDE — content unchanged, no diff)${C.reset}`
        : '';
      log('deploy', `${C.gray}Nothing to push — already in sync${C.reset}${evt}`, 'gray');
      _pendingChanges = 0;
      return;
    }
    if (err) {
      // Drop CRLF line-ending warning lines (harmless on Windows, not the real failure).
      const realLines = errOut.split('\n')
        .filter(l => l.trim() && !/LF will be replaced by CRLF/i.test(l));
      const firstLine = realLines[0] || err.message.split('\n')[0] || 'unknown error';
      log('deploy', `${C.red}Push failed:${C.reset} ${firstLine}`, 'red');
      if (realLines.length > 1) {
        log('deploy', `${C.gray}  ${realLines.slice(1, 3).join(' · ')}${C.reset}`, 'gray');
      }
      log('deploy', `${C.gray}Will retry on next file save${C.reset}`, 'gray');
      return;
    }
    _pendingChanges = 0;
    _lastDeployAt = ts();
    log('deploy', `${C.green}✓ Pushed at ${_lastDeployAt} — live at github.io in ~30s${C.reset}`, 'green');
  });
}

function startAutoDeploy() {
  if (noDeploy) {
    log('deploy', `${C.yellow}Auto-deploy DISABLED ${C.dim}(--no-deploy flag)${C.reset}`, 'yellow');
    return;
  }
  if (!HAS_GIT) {
    log('deploy', `${C.gray}No .git directory — auto-deploy unavailable${C.reset}`, 'gray');
    return;
  }
  log('deploy', `${C.magenta}Auto-deploy ON${C.reset} ${C.gray}(${DEPLOY_DEBOUNCE_MS / 1000}s debounce after last save · 'd' to push now)${C.reset}`, 'magenta');
  try {
    fs.watch(path.join(DIR, FILE), { persistent: true }, (eventType) => {
      if (eventType === 'change') scheduleDeploy();
    });
  } catch (e) {
    log('deploy', `${C.red}fs.watch failed: ${e.message}${C.reset}`, 'red');
  }
}

// === Hotkeys ===
function bindHotkeys() {
  console.log(`${C.dim}  Hotkeys: ${C.reset}${C.bold}r${C.reset}=reload  ${C.bold}o${C.reset}=open  ${C.bold}d${C.reset}=deploy  ${C.bold}t${C.reset}=tunnel  ${C.bold}q${C.reset}=quit\n`);
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (key) => {
    const k = key.toString();
    if (k === '' || k === 'q') return shutdown();
    if (k === 'r') {
      log('action', 'Force reload (touch file)', 'yellow');
      const now = new Date();
      try { fs.utimesSync(path.join(DIR, FILE), now, now); } catch (e) {}
    } else if (k === 'o') {
      openBrowser(`https://localhost:${HTTPS_PORT}/${encodeURIComponent(FILE)}`);
    } else if (k === 'd') {
      log('action', 'Force deploy NOW (skip debounce)', 'magenta');
      runDeploy(true);
    } else if (k === 't') {
      if (!tunnelProc) startTunnel();
      else log('tunnel', 'Already running', 'gray');
    }
  });
}

// === Shutdown ===
// On Windows, p.kill('SIGTERM') only kills the shell wrapper; the spawned grandchildren
// (live-server, local-ssl-proxy) survive and orphan the ports. Use taskkill /T /F to
// terminate the whole process tree rooted at our spawned PID.
function killTree(p) {
  if (!p || p.killed || p.exitCode !== null) return;
  if (IS_WIN) {
    try {
      require('child_process').spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (e) {}
  } else {
    try { p.kill('SIGTERM'); } catch (e) {}
  }
}
function shutdown() {
  console.log(`\n${C.yellow}Shutting down...${C.reset}`);
  for (const p of [liveServer, httpsProxy, tunnelProc]) killTree(p);
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// === Go ===
(async () => {
  await preflight();
  startLiveServer();
})();
