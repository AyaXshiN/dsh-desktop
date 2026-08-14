# GitHub 发布指南（源码仓库 + Releases 自动更新）

> 本项目发布配置已就绪：`owner=AyaXshiN`、`repo=dsh-desktop`。
> 产物命名已统一为 GitHub 安全格式（`artifactName`），上传时无需改名。

## 一、上传到仓库的东西（源码）

在 `dsh-desktop` 目录下执行：

```powershell
cd C:\Users\19365\Desktop\dsh\dsh-desktop
git init
git add .          # .gitignore 已排除 node_modules/dist/缓存/日志/.asar-peek 等
git commit -m "dsh-desktop v0.2.0"
git branch -M main
git remote add origin https://github.com/AyaXshiN/dsh-desktop.git
git push -u origin main
```

**会提交的文件**（源码和小资源，共几十 KB）：

```
main/           主进程：main.js、server.js、settings.js、updater.js
renderer/       preload.js、loading.html、error.html、settings.html
scripts/        verify-server.js、make-icon.ps1、icon-check.ps1、asar-peek.js
build/icon.png  应用图标
package.json / package-lock.json / .npmrc / .gitignore
README.md / GITHUB_RELEASE.md / 启动.bat
```

**绝不会上传**（.gitignore 已排除）：`node_modules/`、`dist/`、
`.npm-cache/`、`.electron-cache/`、`.eb-cache/`、`.dsh-smoke/`、`*.log`、
`.asar-peek/`（里面是从参考项目只读提取的第三方代码，勿公开）。

## 二、发布前检查（本次已由开发环境完成）

- `package.json` 的 `build.publish` 已指向 `AyaXshiN/dsh-desktop` ✓
- 已用该配置重新打包，更新元数据已打进安装包 ✓
- 以后发新版：改 `package.json` 的 `version` → `npm run dist` → 上传新产物 + 新 tag

## 三、上传到 Releases 的东西（自动更新用）

在 GitHub 仓库页面 **Releases → Draft a new release**：
- Tag 填 `v0.2.0`（必须与 package.json 的 version 一致），标题 `v0.2.0`
- 上传 `dist/` 里这 4 个文件（**不要上传 builder-debug.yml**）：

```
DeepSeek-Harness-Desktop-0.2.0-win-x64.exe          安装包
DeepSeek-Harness-Desktop-0.2.0-win-x64.exe.blockmap 差分更新用
latest.yml                                          更新元数据（electron-updater 靠它找包）
DeepSeek-Harness-Desktop-0.2.0-win-x64.zip          免安装版（可选，给人手动下载）
```

> 文件名已与 latest.yml 严格一致，直接拖进去即可。
> 发布后，安装版用户启动时会自动发现新版本并下载，重启即完成更新。

### 发布说明（Release notes）模板

```markdown
## 新功能
- 系统托盘：显示/隐藏/退出，关闭窗口最小化到托盘
- 开机自启、全局快捷键（Ctrl+Alt+D）显示/隐藏窗口
- 原生桌面通知：任务完成 / 出错提醒（订阅 DSH 事件流）
- 本地设置面板：托盘/通知/端口/工作目录/代理等
- GitHub 自动更新（本版本起支持）

## 修复
- 移除便携版目标（解压异常导致无法启动），改用安装包 + zip
- dsh 引擎改为按需自动安装，安装包体积 134MB → 95.5MB

## 使用
- 下载 Setup 安装包；zip 版解压即用（不支持自动更新）
- 需要本机安装 Node.js（DSH 引擎运行依赖）

## 校验
- SHA-512 见 latest.yml
```

## 四、可选：GH_TOKEN 全自动发布（省去手动上传）

```powershell
$env:GH_TOKEN = "ghp_xxx..."   # GitHub 设置 → Developer settings → Personal access tokens
npx electron-builder --win --publish always
```

## 注意事项

- **仓库要公开**：私有仓库的自动更新需要把 GH_TOKEN 打进安装包，有泄露风险，不建议。
- 应用未签名：Windows SmartScreen 会提示，选"仍要运行"。
- 以后发新版：改 `package.json` 的 `version` → `npm run dist` → 上传 4 个文件、tag 写 `v新版本号` 即可。
