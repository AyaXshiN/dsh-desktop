'use strict';

/**
 * 基于 GitHub Releases 的自动更新（electron-updater / NSIS）。
 * 仅对"安装版"生效；便携/zip 版只能提示去 Releases 手动下载。
 */

const { app, dialog, Notification, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

let installed = null;
let checking = false;
let pendingVersion = null;

function isInstalledBuild() {
  if (installed !== null) return installed;
  if (!app.isPackaged) { installed = false; return installed; }
  const exe = app.getPath('exe').toLowerCase();
  // NSIS 安装版运行于用户可写安装目录（默认 %LOCALAPPDATA%\Programs\...）
  installed = exe.includes(pathSegment('programs'));
  return installed;
}

function pathSegment(segment) {
  return `${require('node:path').sep}${segment}${require('node:path').sep}`;
}

function applyProxy(proxy) {
  try {
    const session = autoUpdater.netSession;
    if (session && typeof session.setProxy === 'function') {
      session.setProxy(proxy ? { proxyRules: proxy } : { mode: 'system' });
    }
  } catch { /* 老版本 electron-updater 无 netSession，走系统代理 */ }
}

function onUpdateError(err, window) {
  checking = false;
  try {
    dialog.showMessageBox(window || undefined, {
      type: 'error',
      title: '检查更新失败',
      message: '无法检查更新',
      detail: String(err && err.message ? err.message : err)
    });
  } catch { /* 忽略 */ }
}

/**
 * @param {object} opts { window, settings, onState }
 */
function setupUpdater(opts) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('update-available', (info) => {
    pendingVersion = info.version;
    if (opts.onState) opts.onState({ status: 'downloading', version: info.version });
    new Notification({
      title: 'DeepSeek Harness 更新',
      body: `发现新版本 v${info.version}，正在后台下载…`
    }).show();
  });
  autoUpdater.on('update-not-available', () => {
    checking = false;
    if (opts.onState) opts.onState({ status: 'none' });
    if (opts.manual) {
      dialog.showMessageBox(opts.window || undefined, {
        type: 'info', title: '检查更新', message: '已是最新版本',
        detail: `当前版本 v${app.getVersion()}`
      });
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    checking = false;
    pendingVersion = info.version;
    if (opts.onState) opts.onState({ status: 'ready', version: info.version });
    dialog.showMessageBox(opts.window || undefined, {
      type: 'info',
      title: '更新已就绪',
      message: `DeepSeek Harness v${info.version} 已下载完成`,
      detail: '重启应用即可完成更新。',
      buttons: ['立即重启', '稍后']
    }).then(({ response }) => {
      if (response === 0) {
        try { autoUpdater.quitAndInstall(false, true); } catch { /* 忽略 */ }
      }
    });
  });
  autoUpdater.on('error', (err) => onUpdateError(err, opts.window));
}

function checkForUpdates(opts) {
  const settings = opts.settings();
  applyProxy(settings.proxy);
  if (!isInstalledBuild()) {
    dialog.showMessageBox(opts.window || undefined, {
      type: 'info',
      title: '检查更新',
      message: '当前为便携版，无法自动更新',
      detail: '请到 GitHub Releases 页面手动下载最新版本。'
    });
    return;
  }
  if (checking) return;
  checking = true;
  opts.manual = true;
  if (opts.onState) opts.onState({ status: 'checking' });
  autoUpdater.checkForUpdates().catch((err) => onUpdateError(err, opts.window));
}

function startupCheck(opts) {
  const settings = opts.settings();
  if (!settings.autoUpdate) return;
  if (!isInstalledBuild()) return;
  applyProxy(settings.proxy);
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => { /* 静默失败，不打扰用户 */ });
  }, 10000);
}

module.exports = { setupUpdater, checkForUpdates, startupCheck, isInstalledBuild };
