'use strict';

/**
 * 无 Electron 依赖的冒烟验证：在隔离的 DSH_HOME（workspace/.dsh-smoke）里
 * 拉起 dsh web，确认 HTTP 就绪、页面可加载，然后干净地停掉子进程。
 *
 * 引擎解析走与桌面端完全相同的 resolveDshBin 链路
 * （捆绑 → runtime → PATH → npx 缓存 → 自动安装）。
 *
 * 用法：node scripts/verify-server.js
 * 环境变量：
 *   DSH_SMOKE_HOME        隔离的 DSH_HOME（默认 <项目>/.dsh-smoke）
 *   DSH_DESKTOP_RUNTIME   引擎自动安装目录（默认 <项目>/.dsh-smoke-runtime）
 *   DSH_SMOKE_PORT        端口（默认取空闲端口）
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const {
  DshServer,
  resolveNodeExecutable,
  resolveDshBin
} = require('../main/server');

const APP_ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

(async () => {
  const smokeHome = path.resolve(process.env.DSH_SMOKE_HOME || path.join(APP_ROOT, '.dsh-smoke'));
  fs.mkdirSync(smokeHome, { recursive: true });

  const env = {
    ...process.env,
    DSH_HOME: smokeHome,
    DSH_DESKTOP_RUNTIME: path.resolve(process.env.DSH_DESKTOP_RUNTIME || path.join(APP_ROOT, '.dsh-smoke-runtime'))
  };
  const node = resolveNodeExecutable(env);
  const progress = (line) => {
    if (process.env.DSH_DESKTOP_DEBUG === '1') console.log(`[resolve] ${line}`);
  };
  const bin = await resolveDshBin({
    appRoot: APP_ROOT,
    isPackaged: false,
    userDataDir: path.join(APP_ROOT, '.dsh-smoke-userdata'),
    env,
    onProgress: progress
  });
  const requestedPort = process.env.DSH_SMOKE_PORT !== undefined
    ? Number(process.env.DSH_SMOKE_PORT)
    : 0;
  // 沙箱内验证时不捕获子进程 stdio（管道派生子进程会被 EPERM 拦截），
  // 因此 port=0 的 stdout 解析路径不可用，改用显式空闲端口。
  const port = requestedPort > 0 ? requestedPort : await freePort();

  const server = new DshServer({
    node,
    bin,
    port,
    workspace: os.tmpdir(),
    env,
    logFile: path.join(APP_ROOT, '.dsh-smoke.log'),
    readyTimeoutMs: 180000,
    captureOutput: false
  });

  let exitCode = 0;
  try {
    console.log(`[verify] node=${node.command} bin=${JSON.stringify(bin)} port=${port}`);
    console.log(`[verify] DSH_HOME=${smokeHome}`);
    const { url } = await server.start();
    console.log(`[verify] READY ${url}`);

    const res = await fetch(url);
    const html = await res.text();
    console.log(`[verify] GET / -> ${res.status}, ${html.length} bytes`);
    if (res.status >= 500) throw new Error(`页面响应异常: ${res.status}`);
    if (!/<html/i.test(html)) throw new Error('响应不是 HTML');

    console.log('SMOKE OK: dsh web 可通过桌面壳的拉起逻辑正常提供服务');
  } catch (err) {
    exitCode = 1;
    console.error('SMOKE FAILED:');
    console.error(err && err.message ? err.message : err);
  } finally {
    await server.stop();
    console.log('[verify] 子进程已停止');
  }
  process.exit(exitCode);
})();
