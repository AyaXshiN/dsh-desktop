'use strict';

/**
 * DeepSeek Harness Desktop v0.2 —— Electron 壳主进程。
 *
 * 相对 v0.1 新增（仿照 cc-haha 桌面端思路的本地能力）：
 *  - 系统托盘（显示/隐藏/退出）
 *  - 关闭窗口最小化到托盘（可配置）
 *  - 开机自启（可配置）
 *  - 全局快捷键显示/隐藏窗口（可配置）
 *  - 原生桌面通知：订阅 DSH /api/events.host 事件流，任务完成/出错时通知
 *  - 本地设置面板（renderer/settings.html）
 *  - GitHub Releases 自动更新（electron-updater，仅安装版）+ 代理支持
 *  - dsh 引擎按需定位/自动安装（不再打进安装包）
 */

const {
  app, BrowserWindow, Menu, Tray, dialog, shell,
  ipcMain, globalShortcut, nativeImage, Notification
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const settingsStore = require('./settings');
const updater = require('./updater');
const {
  DshServer,
  parseCliArgs,
  resolveWorkspace,
  resolveNodeExecutable,
  resolveDshBin
} = require('./server');

const PRODUCT_NAME = 'DeepSeek Harness Desktop';
const PROTOCOL = 'dsh-desktop';
const APP_ROOT = path.resolve(__dirname, '..');
const RENDERER_DIR = path.join(APP_ROOT, 'renderer');
const ICON_PATH = path.join(APP_ROOT, 'build', 'icon.png');

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let server = null;
let serverUrl = null;
let logDir = null;
let logFile = null;
let stopping = false;
let quitting = false;
let bootAttempt = 0;
let updaterOpts = null;

const sessionRunning = new Map(); // sessionId -> boolean（用于"任务完成"通知）

/* ------------------------------------------------------------------ */
/* 单实例 + 深链                                                       */
/* ------------------------------------------------------------------ */

function handleDeepLink(argv) {
  const candidates = Array.isArray(argv) ? argv : [];
  for (const token of candidates) {
    if (typeof token === 'string' && token.startsWith(`${PROTOCOL}://`)) {
      const action = token.slice(`${PROTOCOL}://`.length);
      if (action === 'retry') retryBoot();
      else if (action === 'logs') openLogs();
    }
  }
}

function openLogs() {
  if (logFile && fs.existsSync(logFile)) shell.showItemInFolder(logFile);
  else if (logDir) shell.openPath(logDir).catch(() => {});
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    handleDeepLink(argv);
    showMainWindow();
  });
  app.on('open-url', (_event, url) => handleDeepLink([url]));

  if (process.defaultApp) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function windowBaseOptions(extra) {
  return {
    backgroundColor: '#0b1020',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(RENDERER_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    },
    ...extra
  };
}

function createMainWindow() {
  mainWindow = new BrowserWindow(windowBaseOptions({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    title: PRODUCT_NAME
  }));

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // 关闭 → 托盘（可配置）
  mainWindow.on('close', (event) => {
    if (!quitting && settingsStore.get().closeToTray && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isOurs = (serverUrl && url.startsWith(serverUrl.replace(/\/$/, '')))
      || url.startsWith('file:');
    if (!isOurs) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url).catch(() => {});
    }
  });

  showLoading();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    if (server && server.state === 'ready' && serverUrl) {
      mainWindow.loadURL(serverUrl).catch(() => {});
      return;
    }
    if (server && server.state === 'starting') return; // 正在启动，loading 页已就位
    if (!server) boot();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow(windowBaseOptions({
    width: 560,
    height: 660,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: 'DeepSeek Harness 设置'
  }));
  settingsWindow.removeMenu();
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
  settingsWindow.loadFile(path.join(RENDERER_DIR, 'settings.html')).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* 引导 / 启动                                                         */
/* ------------------------------------------------------------------ */

function showLoading() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadFile(path.join(RENDERER_DIR, 'loading.html')).catch(() => {});
}

function sendProgress(line) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bootstrap:progress', line);
  }
}

function showError(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const query = `log=${encodeURIComponent(logFile || '')}`;
    mainWindow.loadFile(path.join(RENDERER_DIR, 'error.html'), { query }).catch(() => {});
  }
  dialog.showMessageBox(mainWindow || undefined, {
    type: 'error',
    title: 'DeepSeek Harness 启动失败',
    message: 'dsh web 服务未能启动',
    detail: `${message}\n\n日志文件：${logFile || '(未写入)'}`,
    buttons: ['退出', '重试']
  }).then(({ response }) => {
    if (response === 1) retryBoot();
    else app.quit();
  });
}

async function boot() {
  if (stopping || quitting) return;
  bootAttempt += 1;
  showLoading();
  sendProgress('正在定位 DeepSeek Harness 引擎…');

  try {
    const args = parseCliArgs(process.argv.slice(app.isPackaged ? 1 : 2));
    const settings = settingsStore.get();
    const port = args.port !== undefined ? args.port : settings.port;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`无效端口: ${port}`);
    const workspace = resolveWorkspace({ workspace: args.workspace ?? (settings.workspace || undefined) }, process.env);
    const node = resolveNodeExecutable(process.env);
    const bin = await resolveDshBin({
      appRoot: APP_ROOT,
      isPackaged: app.isPackaged,
      userDataDir: app.getPath('userData'),
      env: process.env,
      onProgress: sendProgress
    });

    server = new DshServer({ node, bin, port, workspace, logFile });
    server.on('log', (line) => {
      if (process.env.DSH_DESKTOP_DEBUG === '1') console.log(`[dsh] ${line}`);
      sendProgress(line);
    });
    server.on('exit', (code, signal) => {
      if (!stopping && server && server.state === 'failed') {
        showError(`dsh 进程意外退出（code=${code}, signal=${signal}）`);
      }
    });

    const { url } = await server.start();
    serverUrl = url;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.loadURL(url).catch(() => {});
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  }
}

function retryBoot() {
  if (stopping || quitting || !app.isReady()) return;
  Promise.resolve(server ? server.stop() : null)
    .catch(() => {})
    .then(() => {
      server = null;
      serverUrl = null;
      boot();
    });
}

/* ------------------------------------------------------------------ */
/* 托盘                                                                */
/* ------------------------------------------------------------------ */

function createTray() {
  if (tray) return;
  let icon = nativeImage.createFromPath(ICON_PATH);
  if (!icon.isEmpty()) {
    icon = icon.resize({ width: 16, height: 16 });
  } else {
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip(PRODUCT_NAME);
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
    else showMainWindow();
  });
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '显示 / 隐藏主窗口',
      click: () => {
        if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
        else showMainWindow();
      }
    },
    { type: 'separator' },
    { label: '设置', click: () => createSettingsWindow() },
    { label: '检查更新', click: () => updater.checkForUpdates(updaterOpts) },
    { label: '打开日志', click: () => openLogs() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
}

/* ------------------------------------------------------------------ */
/* 菜单                                                                */
/* ------------------------------------------------------------------ */

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '设置', click: () => createSettingsWindow() },
        { label: '检查更新', click: () => updater.checkForUpdates(updaterOpts) },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '在浏览器中打开',
          click: () => {
            if (serverUrl) shell.openExternal(serverUrl).catch(() => {});
          }
        },
        { label: '打开日志', click: () => openLogs() },
        { type: 'separator' },
        {
          label: '关于 DeepSeek Harness Desktop',
          click: () => {
            dialog.showMessageBox(mainWindow || undefined, {
              type: 'info',
              title: '关于',
              message: PRODUCT_NAME,
              detail: `内嵌 DeepSeek Harness 的桌面壳。\n版本：v${app.getVersion()}\n服务地址：${serverUrl || '(未启动)'}\n日志：${logFile || '(未写入)'}`
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* 原生通知（DSH 事件流）                                              */
/* ------------------------------------------------------------------ */

function isWindowFocused() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused());
}

function handleHostEvent(frame) {
  const settings = settingsStore.get();
  if (!settings.notifications) return;
  switch (frame.type) {
    case 'host/session-status': {
      const wasRunning = sessionRunning.get(frame.sessionId) === true;
      sessionRunning.set(frame.sessionId, frame.running === true);
      if (wasRunning && frame.running === false && !isWindowFocused()) {
        new Notification({
          title: 'DeepSeek Harness',
          body: '任务已完成',
          icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined
        }).on('click', () => showMainWindow()).show();
      }
      break;
    }
    case 'host/agent-error': {
      if (!isWindowFocused()) {
        new Notification({
          title: 'DeepSeek Harness 出错',
          body: String(frame.message || '会话发生错误').slice(0, 200),
          icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined
        }).on('click', () => showMainWindow()).show();
      }
      break;
    }
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* IPC（设置页 / 引导页 / 错误页）                                     */
/* ------------------------------------------------------------------ */

function setupIpc() {
  ipcMain.handle('settings:get', () => settingsStore.get());
  ipcMain.handle('settings:set', (_event, patch) => {
    const next = settingsStore.set(patch || {});
    applyRuntimeSettings(next);
    return next;
  });
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    productName: PRODUCT_NAME
  }));
  ipcMain.handle('app:retry-boot', () => retryBoot());
  ipcMain.handle('app:open-logs', () => openLogs());
  ipcMain.handle('app:check-updates', () => updater.checkForUpdates(updaterOpts));
  ipcMain.handle('app:pick-directory', async () => {
    const result = await dialog.showOpenDialog(settingsWindow || mainWindow || undefined, {
      title: '选择工作目录',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.on('dsh:host-event', (_event, frame) => handleHostEvent(frame));
}

/* ------------------------------------------------------------------ */
/* 运行时设置应用（自启/快捷键）                                       */
/* ------------------------------------------------------------------ */

function applyRuntimeSettings(settings) {
  // 开机自启
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(settings.autoLaunch),
      path: process.execPath,
      args: app.isPackaged ? [] : [APP_ROOT]
    });
  } catch { /* 忽略 */ }

  // 全局快捷键
  globalShortcut.unregisterAll();
  const shortcut = settings.shortcut && String(settings.shortcut).trim();
  if (shortcut) {
    try {
      const ok = globalShortcut.register(shortcut, () => {
        if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) mainWindow.hide();
        else showMainWindow();
      });
      if (!ok) console.error(`[dsh-desktop] 快捷键注册失败（可能被占用）: ${shortcut}`);
    } catch { /* 忽略 */ }
  }

  // 托盘可见性（关闭到托盘时托盘必须存在）
  if (settings.closeToTray && !tray) createTray();

  // 更新代理
  if (updaterOpts) updaterOpts.settings = () => settingsStore.get();
}

/* ------------------------------------------------------------------ */
/* 应用生命周期                                                        */
/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  logFile = path.join(logDir, 'dsh-web.log');

  settingsStore.init(app.getPath('userData'));
  buildMenu();
  setupIpc();
  createMainWindow();
  if (settingsStore.get().closeToTray) createTray();
  applyRuntimeSettings(settingsStore.get());

  updaterOpts = {
    window: null,
    settings: () => settingsStore.get(),
    onState: () => {}
  };
  try {
    updater.setupUpdater(updaterOpts);
    updater.startupCheck(updaterOpts);
  } catch (err) {
    console.error('[dsh-desktop] 更新器初始化失败:', err.message);
  }

  boot();
});

app.on('window-all-closed', () => {
  // 关闭到托盘模式下窗口只是隐藏；真正全关（含设置窗）且无托盘才退出
  if (!tray || quitting) app.quit();
});

app.on('activate', () => showMainWindow());

app.on('before-quit', (event) => {
  if (stopping || quitting) return;
  quitting = true;
  if (server) {
    event.preventDefault();
    stopping = true;
    server.stop()
      .catch(() => {})
      .finally(() => {
        stopping = false;
        server = null;
        app.quit();
      });
    return;
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (tray) { tray.destroy(); tray = null; }
});
