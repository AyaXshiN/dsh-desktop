'use strict';

/**
 * 桌面端设置持久化：<userData>/settings.json
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  autoLaunch: false,        // 开机自启
  closeToTray: true,        // 关闭窗口时最小化到托盘
  notifications: true,      // 回合完成等桌面通知
  port: 3210,               // dsh web 端口
  workspace: '',            // dsh 工作目录（空 = 用户主目录）
  proxy: '',                // 更新器代理，如 http://127.0.0.1:7890
  shortcut: 'CommandOrControl+Alt+D', // 全局显示/隐藏快捷键
  autoUpdate: true          // 启动时自动检查更新（仅安装版）
});

let cached = null;
let filePath = null;

function init(userDataDir) {
  filePath = path.join(userDataDir, 'settings.json');
  const out = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const key of Object.keys(DEFAULTS)) {
      if (raw[key] !== undefined) out[key] = raw[key];
    }
  } catch { /* 首次运行或无权限，用默认值 */ }
  cached = out;
  return out;
}

function get() {
  return cached ? { ...cached } : { ...DEFAULTS };
}

function set(patch) {
  cached = { ...(cached || DEFAULTS), ...patch };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(cached, null, 2), 'utf8');
  } catch { /* 写入失败不影响运行 */ }
  return { ...cached };
}

module.exports = { DEFAULTS, init, get, set };
