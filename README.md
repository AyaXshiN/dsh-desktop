# DeepSeek Harness Desktop

DeepSeek Harness 的桌面端壳：Electron 窗口内嵌启动本机的 `dsh web` 服务，**复用你现有的
`$DSH_HOME` 配置**（插件、凭据、会话历史都在），得到和浏览器版完全一致的功能，
外加一整套原生桌面体验。

架构思路参考了 Electron 包装 Claude Code 的同类项目（如 cc-haha 桌面版），但全部代码为
本项目全新编写，不读取、不修改任何其他项目目录。

## 功能（v0.2）

| 类别 | 功能 |
|---|---|
| 核心 | Electron 窗口内嵌 `dsh web`；就绪探测、崩溃检测、错误页一键重试 |
| 原生桌面 | 系统托盘（显示/隐藏/退出）、关闭最小化到托盘、开机自启、全局快捷键（默认 `Ctrl+Alt+D`） |
| 通知 | 订阅 DSH `/api/events.host` 事件流：**任务完成 / 出错时弹原生通知**（窗口不在前台时） |
| 设置 | 本地设置面板（文件菜单 → 设置）：自启/托盘/通知/端口/工作目录/快捷键/更新/代理 |
| 更新 | GitHub Releases 自动更新（electron-updater，**仅安装版**），支持自定义代理 |
| 精简 | dsh 引擎**不打包进安装包**：自动定位（PATH / npx 缓存）或首次运行自动安装到应用数据目录 |

## 工作原理

```
┌──────────────────────────── Electron ────────────────────────────┐
│  main.js                                                          │
│    ├─ 引导页 (loading.html) → 定位/安装 dsh 引擎 → 等待服务就绪    │
│    ├─ spawn: node <dsh>/lib/bin.js --profile web --port <port>    │
│    ├─ 轮询 http://127.0.0.1:<port>/ 直到就绪（支持 --port 0）      │
│    ├─ BrowserWindow.loadURL(...) + 托盘 + 通知 + 快捷键            │
│    └─ preload.js 以页面同源订阅 /api/events.host → 原生通知       │
└───────────────────────────────────────────────────────────────────┘
                          │
                          ▼
              dsh web（系统 Node.js 运行）
              DSH_HOME = ~/.dsh（默认继承环境变量）
              → 你的插件 / 凭据 / 会话全部直接可用
```

引擎定位顺序：`DSH_BIN` → 应用捆绑（开发）→ 应用数据目录 `runtime` → PATH 上的 `dsh`
→ npx 缓存 → **自动安装**（`npm install @deepseek-ai/dsh@0.1.0-rc.6`，仅首次，需要网络）。

> 为什么用**系统 Node.js** 跑 dsh，而不是 Electron 内置 Node：
> dsh 依赖 sharp / node-pty 等原生模块，Electron 的 Node ABI 与它们不兼容。
> 因此需要本机安装 Node.js（DSH 本身也要求）。

## 快速开始（开发模式）

前置：Node.js ≥ 20、npm。

```powershell
cd dsh-desktop
npm install
npm start
```

## 打包 / 发布

```powershell
npm run dist
```

产物在 `dist/`：NSIS 安装包（`DeepSeek-Harness-Desktop-<版本>-win-x64.exe`）+ zip 免安装包。
产物命名统一为 GitHub 安全格式（`artifactName`），可直接上传 Releases。
打包使用国内镜像（`.npmrc` 已配置）。应用未签名，SmartScreen 提示选"仍要运行"。

> **为什么没有便携版 exe**：electron-builder 的 portable 目标在本机环境中解压异常
> （长时间空转 + 解压不完整导致缺包），已移除该目标；请使用安装包或 zip。

### 自动更新（GitHub Releases）

自动更新基于 electron-updater + GitHub Releases，**是的，需要把产物上传到 GitHub**：

1. 创建仓库（如 `dsh-desktop`），把本目录推送上去
2. `package.json` 里 `build.publish` 已配置为 `AyaXshiN/dsh-desktop`（换仓库时改这里）
3. 发布流程二选一：
   - 本地执行 `npm run dist` 后，在 GitHub 仓库 **Releases → Draft a new release**，
     上传 `DeepSeek-Harness-Desktop-<版本>-win-x64.exe`、同名 `.blockmap` 和 `latest.yml`
     （版本号 tag 写 `v<版本>`；完整步骤见 [GITHUB_RELEASE.md](GITHUB_RELEASE.md)）
   - 或设置 `GH_TOKEN` 环境变量后执行 `npx electron-builder --win --publish always` 自动发布
4. 安装版用户启动时会自动检查更新；也可在 文件菜单/托盘/设置 里手动"检查更新"

> 更新说明：zip 免安装版无法自更新，会提示去 Releases 手动下载；
> GitHub 直连不畅时在"设置 → 更新代理"里填你的代理（如 `http://127.0.0.1:7890`）。

## 命令行参数与环境变量

| 参数 / 变量 | 默认 | 说明 |
|---|---|---|
| `--port <n>` / `DSH_PORT` | 设置页可改，默认 `3210` | dsh web 监听端口 |
| `--workspace <dir>` / `DSH_WORKSPACE` | 设置页可改，默认用户主目录 | dsh 工作目录（DSH workspace 根） |
| `DSH_HOME` | `~/.dsh` | 沿用 DSH 官方变量：profile/插件/会话目录 |
| `DSH_NODE` | 自动探测 | 运行 dsh 的 Node.js 路径 |
| `DSH_BIN` | 自动定位 | 指定 dsh 入口（.js 文件或命令名） |
| `DSH_DESKTOP_RUNTIME` | 应用数据目录 runtime | 引擎自动安装位置 |
| `DSH_DESKTOP_DEBUG=1` | 关 | dsh 子进程日志打到终端 |

## 与浏览器版并存注意事项

- 桌面版默认端口 `3210`，与本机浏览器版（如 `3080`）不冲突。
- 两个实例共享同一 `$DSH_HOME` 会话存储，**建议不要同时开两个 dsh web 实例**处理同一工作区。
- 桌面版安装插件与官方完全一致：`dsh plugin --profile web add <npm包名或 github:作者/仓库>`。

## 项目结构

```
dsh-desktop/
├── main/
│   ├── main.js       主进程：窗口/托盘/菜单/通知/快捷键/自启/生命周期
│   ├── server.js     dsh 子进程管理 + 引擎定位与自动安装
│   ├── settings.js   设置持久化（%APPDATA%\DeepSeek Harness Desktop\settings.json）
│   └── updater.js    GitHub Releases 自动更新
├── renderer/
│   ├── preload.js    受控桥接 + /api/events.host 事件流订阅
│   ├── loading.html  启动引导页（实时进度）
│   ├── error.html    启动失败页（重试/日志）
│   └── settings.html 本地设置面板
├── scripts/
│   ├── verify-server.js   无 Electron 冒烟验证
│   ├── make-icon.ps1      生成 build/icon.png
│   └── asar-peek.js       只读探查参考项目 asar（开发用）
└── build/icon.png         应用图标
```

## 验证

```powershell
npm run verify   # 隔离环境拉起 dsh web，验证引擎定位 + 页面可达后自动清理
```
