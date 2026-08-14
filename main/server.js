'use strict';

/**
 * DSH 桌面端 —— dsh web 子进程管理。
 *
 * 职责：
 *  - 解析启动参数与可选环境变量（--port / DSH_PORT、--workspace / DSH_WORKSPACE）
 *  - 定位可用的 Node.js（优先系统 node；DSH 依赖 sharp/node-pty 等原生模块，
 *    因此不能用 Electron 内置 Node，ABI 不兼容）
 *  - 定位 dsh CLI（优先随应用捆绑的 @deepseek-ai/dsh 的 lib/bin.js）
 *  - 拉起 `dsh --profile web --port <port>` 并轮询 HTTP 就绪
 *  - 把子进程 stdout/stderr 写入日志文件，供错误页展示
 *  - 退出时可靠地终止子进程（含 Windows 下 taskkill 兜底）
 */

const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_PORT = 3210;
const DEFAULT_READY_TIMEOUT_MS = 120000;

/* ------------------------------------------------------------------ */
/* 启动参数与环境变量                                                   */
/* ------------------------------------------------------------------ */

function parseCliArgs(argv) {
  const out = { port: undefined, workspace: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1] !== undefined) out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice('--port='.length));
    else if (a === '--workspace' && argv[i + 1] !== undefined) out.workspace = argv[++i];
    else if (a.startsWith('--workspace=')) out.workspace = a.slice('--workspace='.length);
  }
  return out;
}

function resolvePort(args, env) {
  const raw = args.port !== undefined ? args.port
    : env.DSH_PORT !== undefined && env.DSH_PORT !== '' ? Number(env.DSH_PORT)
      : DEFAULT_PORT;
  if (!Number.isInteger(raw) || raw < 0 || raw > 65535) {
    throw new Error(`无效端口: ${JSON.stringify(raw)}（可用 --port <0-65535> 指定，0 表示由系统分配）`);
  }
  return raw;
}

function resolveWorkspace(args, env) {
  const candidate = args.workspace !== undefined ? args.workspace
    : env.DSH_WORKSPACE || os.homedir();
  const dir = path.resolve(candidate);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`工作目录不存在或不是目录: ${dir}`);
  }
  return dir;
}

/* ------------------------------------------------------------------ */
/* 可执行文件定位                                                      */
/* ------------------------------------------------------------------ */

function tryRun(cmd, args, extraEnv) {
  try {
    const r = spawnSync(cmd, args, {
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      timeout: 15000,
      stdio: 'ignore'
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * 解析用于运行 dsh 的 Node.js。
 * 返回 { command, env }；env 里可能带 ELECTRON_RUN_AS_NODE（仅兜底路径需要）。
 */
function resolveNodeExecutable(env) {
  if (env.DSH_NODE) {
    if (!tryRun(env.DSH_NODE, ['-v'])) {
      throw new Error(`DSH_NODE 指定的 Node.js 不可用: ${env.DSH_NODE}`);
    }
    return { command: env.DSH_NODE, env: {} };
  }
  if (tryRun('node', ['-v'])) return { command: 'node', env: {} };
  const asNode = { ELECTRON_RUN_AS_NODE: '1' };
  if (tryRun(process.execPath, ['-v'], asNode)) {
    return { command: process.execPath, env: asNode };
  }
  throw new Error('找不到可用的 Node.js。请安装 Node.js（https://nodejs.org/）或通过环境变量 DSH_NODE 指定其路径。');
}

/**
 * 解析 dsh CLI 入口（v0.2：引擎按需定位/安装，不再打进安装包）。
 * 顺序：DSH_BIN → 应用捆绑(node_modules，开发用) → 应用数据目录 runtime → PATH 上的 dsh
 *       → npx 缓存扫描（复用用户已有的 dsh）→ 自动安装到 runtime 目录。
 * 返回 { kind: 'script', path } 或 { kind: 'command', command }。
 */
const DSH_VERSION = '0.1.0-rc.6';

function runtimeDir(userDataDir, env) {
  if (env.DSH_DESKTOP_RUNTIME) return path.resolve(env.DSH_DESKTOP_RUNTIME);
  return path.join(userDataDir, 'runtime');
}

function bundledBinPath(appRoot, isPackaged) {
  const candidates = [];
  if (isPackaged) {
    candidates.push(
      path.join(process.resourcesPath, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    );
  }
  candidates.push(path.join(appRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function runtimeBinPath(userDataDir, env) {
  const candidate = path.join(runtimeDir(userDataDir, env), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  return fs.existsSync(candidate) ? candidate : null;
}

function npxCacheBinPath(env) {
  const base = env.LOCALAPPDATA
    ? path.join(env.LOCALAPPDATA, 'npm-cache', '_npx')
    : path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
  if (!fs.existsSync(base)) return null;
  let best = null;
  let bestTime = 0;
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(base, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (!fs.existsSync(candidate)) continue;
      const mtime = fs.statSync(candidate).mtimeMs;
      if (mtime > bestTime) { bestTime = mtime; best = candidate; }
    }
  } catch { /* 扫描失败就跳过 */ }
  return best;
}

function commandExists(command) {
  return tryRun(command, ['--version']);
}

/**
 * 自动安装 dsh 引擎到应用数据目录（首次运行、或找不到已有引擎时）。
 */
function installDshRuntime(userDataDir, env, onProgress) {
  const target = runtimeDir(userDataDir, env);
  const npmCmd = env.DSH_DESKTOP_NPM || 'npm';
  return new Promise((resolve, reject) => {
    fs.mkdirSync(target, { recursive: true });
    onProgress?.(`首次运行：正在安装 DeepSeek Harness 引擎 @deepseek-ai/dsh@${DSH_VERSION}（约需 1-3 分钟，仅此一次）…`);
    const child = spawn(npmCmd, [
      'install', `@deepseek-ai/dsh@${DSH_VERSION}`,
      '--no-audit', '--no-fund', '--no-package-lock', '--prefix', target
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    });
    let tail = '';
    const eat = (chunk) => {
      const text = String(chunk);
      tail = (tail + text).slice(-2000);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onProgress?.(`安装引擎… ${line.trim().slice(0, 120)}`);
      }
    };
    child.stdout.on('data', eat);
    child.stderr.on('data', eat);
    child.on('error', (err) => reject(new Error(`无法启动 npm 安装引擎: ${err.message}\n请先安装 Node.js（https://nodejs.org/）`)));
    child.on('exit', (code) => {
      if (code === 0) {
        const bin = runtimeBinPath(userDataDir, env);
        if (bin) resolve({ kind: 'script', path: bin });
        else reject(new Error('引擎安装完成但未找到入口文件，请查看日志'));
      } else {
        reject(new Error(`DeepSeek Harness 引擎安装失败（npm exit=${code}）：\n${tail.slice(-800)}`));
      }
    });
  });
}

async function resolveDshBin(opts) {
  const { appRoot, isPackaged, userDataDir, env, onProgress } = opts;

  // 1. 显式指定
  if (env.DSH_BIN) {
    if (fs.existsSync(env.DSH_BIN)) return { kind: 'script', path: env.DSH_BIN };
    return { kind: 'command', command: env.DSH_BIN };
  }
  // 2. 应用捆绑（开发模式 / 旧版完整包）
  const bundled = bundledBinPath(appRoot, isPackaged);
  if (bundled) return { kind: 'script', path: bundled };
  // 3. 应用数据目录 runtime（此前自动安装过）
  const runtime = runtimeBinPath(userDataDir, env);
  if (runtime) return { kind: 'script', path: runtime };
  // 4. PATH 上的 dsh 命令
  if (commandExists('dsh')) return { kind: 'command', command: 'dsh' };
  // 5. npx 缓存（用户此前用 npx 跑过 dsh）
  const npx = npxCacheBinPath(env);
  if (npx) {
    onProgress?.('复用本机已有的 DeepSeek Harness 引擎（来自 npx 缓存）');
    return { kind: 'script', path: npx };
  }
  // 6. 自动安装
  onProgress?.('本机未找到 DeepSeek Harness 引擎，将自动安装（仅首次需要）');
  return installDshRuntime(userDataDir, env, onProgress);
}

/* ------------------------------------------------------------------ */
/* HTTP 就绪探测                                                       */
/* ------------------------------------------------------------------ */

function httpGetOk(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/* ------------------------------------------------------------------ */
/* DshServer                                                           */
/* ------------------------------------------------------------------ */

class DshServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {{command:string, env?:object}} opts.node      运行 dsh 的 Node
   * @param {{kind:'script',path:string}|{kind:'command',command:string}} opts.bin
   * @param {number}  opts.port           web 端口（0 = 系统分配，从 stdout 解析实际端口）
   * @param {string}  opts.workspace      dsh 进程的工作目录（即 DSH workspace 根）
   * @param {object}  [opts.env]          额外环境变量（如 DSH_HOME）
   * @param {string}  [opts.logFile]      日志文件路径；缺省不落盘
   * @param {number}  [opts.readyTimeoutMs]
   */
  constructor(opts) {
    super();
    this.node = opts.node;
    this.bin = opts.bin;
    this.port = opts.port;
    this.workspace = opts.workspace;
    this.env = { ...process.env, ...(opts.env || {}) };
    this.logFile = opts.logFile || null;
    this.readyTimeoutMs = opts.readyTimeoutMs || DEFAULT_READY_TIMEOUT_MS;
    this.captureOutput = opts.captureOutput !== false;
    this.child = null;
    this.url = null;
    this.state = 'idle'; // starting | ready | failed | stopped
    this.logTail = [];
  }

  writeLog(line) {
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, `${new Date().toISOString()} ${line}\n`);
      } catch { /* 日志写入失败不影响主流程 */ }
    }
  }

  log(line) {
    this.logTail.push(line);
    if (this.logTail.length > 300) this.logTail.shift();
    this.writeLog(line);
    this.emit('log', line);
  }

  start() {
    if (this.child) return Promise.reject(new Error('dsh 服务已在运行'));
    this.state = 'starting';
    this.log(`[dsh-desktop] 启动 dsh web（port=${this.port}, workspace=${this.workspace}）`);

    const args = ['--profile', 'web', '--port', String(this.port)];
    const baseOpts = {
      cwd: this.workspace,
      env: { ...this.env, ...this.node.env, FORCE_COLOR: '0' },
      windowsHide: true,
      stdio: this.captureOutput ? ['ignore', 'pipe', 'pipe'] : 'ignore'
    };

    let child;
    if (this.bin.kind === 'script') {
      child = spawn(this.node.command, [this.bin.path, ...args], baseOpts);
      this.log(`[dsh-desktop] node=${this.node.command} bin=${this.bin.path}`);
    } else {
      child = spawn(this.bin.command, args, {
        ...baseOpts,
        shell: process.platform === 'win32'
      });
      this.log(`[dsh-desktop] command=${this.bin.command}`);
    }
    this.child = child;

    if (this.captureOutput) {
      child.stdout.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (!line) continue;
          this.log(line);
          const m = line.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)/);
          if (m) {
            const url = `${m[1]}/`;
            this.log(`[dsh-desktop] 解析到实际地址: ${m[1]}`);
            this.url = url;
          }
        }
      });
      child.stderr.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line) this.log(`[stderr] ${line}`);
        }
      });
    }
    child.on('error', (err) => {
      this.log(`[spawn-error] ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      this.log(`[dsh-desktop] dsh 进程退出 code=${code} signal=${signal}`);
      if (this.child === child) this.child = null;
      if (this.state === 'starting' || this.state === 'ready') {
        // 就绪前退出 = 启动失败；就绪后退出 = 意外崩溃
        this.state = 'failed';
      } else if (this.state !== 'stopped') {
        this.state = 'stopped';
      }
      this.emit('exit', code, signal);
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      const deadline = Date.now() + this.readyTimeoutMs;
      const onExitEarly = (code, signal) => {
        if (settled) return;
        settled = true;
        this.state = 'failed';
        const tail = this.logTail.slice(-40).join('\n');
        reject(new Error(`dsh web 进程提前退出（code=${code}, signal=${signal}）：\n${tail}`));
      };
      child.once('exit', onExitEarly);

      const probe = () => {
        if (settled) return;
        if (this.child !== child) {
          // stop() 被调用
          settled = true;
          this.state = 'stopped';
          reject(new Error('dsh 服务已停止'));
          return;
        }
        const url = this.url || `http://127.0.0.1:${this.port}/`;
        httpGetOk(url, 1000).then((ok) => {
          if (settled) return;
          if (ok) {
            settled = true;
            child.removeListener('exit', onExitEarly);
            this.state = 'ready';
            this.url = url;
            this.log(`[dsh-desktop] 服务就绪: ${url}`);
            resolve({ url, port: Number(new URL(url).port) });
          } else if (Date.now() > deadline) {
            settled = true;
            child.removeListener('exit', onExitEarly);
            this.state = 'failed';
            reject(new Error(`等待 dsh web 就绪超时（${this.readyTimeoutMs}ms）@ http://127.0.0.1:${this.port}/`));
          } else {
            setTimeout(probe, 250);
          }
        }).catch(() => {
          if (!settled && Date.now() <= deadline) setTimeout(probe, 250);
        });
      };
      probe();
    });
  }

  stop() {
    const child = this.child;
    if (!child) return Promise.resolve();
    if (this.state !== 'failed') this.state = 'stopping';
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.state = 'stopped';
        resolve();
      };
      if (child.exitCode !== null || child.signalCode !== null) return finish();
      const timer = setTimeout(() => {
        if (process.platform === 'win32' && child.pid) {
          try {
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          } catch { /* 忽略 */ }
        }
        finish();
      }, 4000);
      child.once('exit', () => { clearTimeout(timer); finish(); });
      try { child.kill(); } catch { clearTimeout(timer); finish(); }
    });
  }
}

module.exports = {
  DshServer,
  DEFAULT_PORT,
  DSH_VERSION,
  parseCliArgs,
  resolvePort,
  resolveWorkspace,
  resolveNodeExecutable,
  resolveDshBin,
  installDshRuntime,
  runtimeBinPath,
  httpGetOk
};
