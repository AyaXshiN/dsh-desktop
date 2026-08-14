'use strict';

/**
 * 预加载脚本：为引导页/错误页/设置页提供受控桥接，
 * 并在 DSH 主页面里以同源方式订阅 /api/events.host 事件流，
 * 把 host/session-status、host/agent-error 等事件转发给主进程（用于桌面通知）。
 *
 * 只暴露白名单 API，不注入 Node 能力。
 */

const { contextBridge, ipcRenderer } = require('electron');

/* ---------------- 受控 API ---------------- */

contextBridge.exposeInMainWorld('dshDesktop', {
  // 启动进度（引擎安装等）
  onProgress(callback) {
    ipcRenderer.on('bootstrap:progress', (_event, payload) => callback(payload));
  },
  // 设置
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    onChange(callback) {
      ipcRenderer.on('settings:changed', (_event, settings) => callback(settings));
    }
  },
  // 应用信息
  appInfo: () => ipcRenderer.invoke('app:info'),
  // 动作
  retryBoot: () => ipcRenderer.invoke('app:retry-boot'),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  checkUpdates: () => ipcRenderer.invoke('app:check-updates'),
  pickDirectory: () => ipcRenderer.invoke('app:pick-directory'),
  quit: () => ipcRenderer.invoke('app:quit')
});

/* ---------------- DSH 事件流桥（仅 DSH 页面） ---------------- */

let streamStarted = false;

function startHostEventBridge() {
  if (streamStarted) return;
  // 仅在实际加载了 DSH 页面的窗口里跑（file: 页面不需要）
  if (!window.location.protocol.startsWith('http')) return;
  streamStarted = true;
  connect();

  function connect() {
    let aborted = false;
    const controller = new AbortController();
    fetch('/api/events.host', { signal: controller.signal })
      .then((response) => {
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const pump = () => reader.read().then(({ done, value }) => {
          if (done) throw new Error('stream closed');
          buffer += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = chunk.split('\n')
              .filter((line) => line.startsWith('data: '))
              .map((line) => line.slice(6))
              .join('');
            if (!data) continue;
            try {
              const envelope = JSON.parse(data);
              const frame = envelope && envelope.payload;
              if (frame && typeof frame.type === 'string') {
                ipcRenderer.send('dsh:host-event', frame);
              }
            } catch { /* 丢弃坏帧 */ }
          }
          return pump();
        });
        return pump();
      })
      .catch(() => {
        if (aborted) return;
        setTimeout(connect, 3000); // 断线重连
      });
    window.addEventListener('beforeunload', () => {
      aborted = true;
      try { controller.abort(); } catch { /* 忽略 */ }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startHostEventBridge);
} else {
  startHostEventBridge();
}
