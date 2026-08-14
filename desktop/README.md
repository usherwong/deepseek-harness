# DSH Desktop

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI 包成桌面应用：macOS（Apple 芯片 / Intel）的 `.dmg`，Windows 的安装版和绿色版 `.exe`。

上游更新时，GitHub Actions 会自动同步、重新打包、发布 Release。

## 它是怎么跑起来的

`dsh web` 本来就是一个本地 HTTP 服务，所以这个壳做的事情很直白：

```
Electron 主进程
  ├── 选一个空闲的 loopback 端口
  ├── 用随包携带的 Node.js 启动  dsh web --port <port>
  ├── 等待 harness 打印 “dsh web: http://127.0.0.1:<port>” 这行就绪信号
  └── 把窗口导航到该地址；此后窗口里就是原生的 Harness Web UI
```

几个刻意的取舍：

- **随包携带 Node.js，而不是复用 Electron 内置的 Node。** harness 自己声明了 Node 版本范围，还会派生 worker 线程和子进程，它们都假设 `process.execPath` 是一个普通的 Node。真装一个 Node 进去，行为和终端里跑 `dsh` 完全一致。当 `runtime/node` 不存在时（比如没跑过 `npm run runtime` 的开发环境），壳会退回用 Electron 的 Node（`ELECTRON_RUN_AS_NODE`）。
- **就绪信号用那行 URL，而不是轮询端口。** 上游把这行输出定义为「插件树挂载完毕」的信号，轮询端口会在 `/api` 路由还没挂上时就命中。
- **harness 载荷放在 asar 外面**（electron-builder 的 `extraResources`）。`node-pty` 要以程序方式执行 `spawn-helper`，`koffi` 要从磁盘加载 `.node`，两者都不能待在 asar 里。
- **状态目录仍然是 `~/.dsh`。** 桌面版和终端里的 `dsh` 共用同一套 profile、会话和凭据。

## 本地开发

```bash
cd desktop
npm install
npm run runtime     # 装配 runtime/：harness + Node.js 二进制（约 340 MB）
npm start
```

`npm run runtime` 有两种载荷来源，由 `harness.json` 的 `mode` 决定，也可以用命令行覆盖：

```bash
node scripts/prepare-runtime.mjs --mode npm                  # 装 npm 上已发布的 @deepseek-ai/dsh
node scripts/prepare-runtime.mjs --mode npm --version 0.1.0-rc.6
node scripts/prepare-runtime.mjs --mode source               # 用当前 fork 的源码构建
```

- `npm` 模式：快，两三分钟，不需要仓库的构建工具链。**默认。**
- `source` 模式：在仓库根目录跑 `pnpm install && pnpm run build`，再 `pnpm deploy` 出 `apps/cli` 的闭包。**改了 harness 源码时用这个**，否则打出来的包里还是 npm 上的版本。

其它参数：`--node 22`（指定内置 Node 大版本）、`--skip-node`（不带 Node，退回 Electron 的）、`--platform` / `--arch`（只影响 Node 二进制的下载目标）、`--no-prune`（保留其它平台的 node-pty 预编译产物和 source map，默认会删掉，约 90 MB）。

## 本地打包

```bash
npm run dist:mac:arm64   # 或 dist:mac:x64 / dist:win
```

产物在 `desktop/dist/`。

⚠️ **一台机器只能打它自己那个架构的包。** `koffi` 的安装脚本只会下载宿主平台的原生二进制，所以 Apple 芯片上装配出来的 `runtime/` 不能拿去发给 Intel Mac。跨架构必须换机器——CI 的矩阵就是这么分的。

## CI

### `desktop-release.yml` — 构建并发布

三个 runner 并行，各打各的架构：

| runner | 产物 |
|---|---|
| `macos-15` | `*-mac-arm64.dmg` / `.zip` |
| `macos-15-intel` | `*-mac-x64.dmg` / `.zip` |
| `windows-latest` | `*-win-x64-setup.exe`、`*-win-x64-portable.exe` |

（`macos-15-intel` 是 GitHub 当前的 Intel runner 标签；如果哪天被下线了，`macos-26-intel` 或 `macos-15-large` 是等价替代。）

手动触发（Actions → Desktop release → Run workflow）可以选 `mode`、指定 harness 版本、决定是否发 Release。

### `desktop-sync-upstream.yml` — 跟上游同步

每天跑一次，也可以手动触发。它做三件事：

1. `git merge upstream/master` 合上游新提交并推回 fork。壳的改动全是新增文件（`desktop/` 和这两个 workflow），正常不会冲突；一旦冲突就直接失败并在 Job Summary 里写清楚怎么手工解。
2. 查 npm 上 `@deepseek-ai/dsh` 的 `latest`，和 `harness.json` 里钉住的版本比对，不一致就自动改文件并提交。
3. 有变化才触发上面的构建发布；`source` 模式看 git 有没有新提交，`npm` 模式看版本号有没有变。

> **fork 里记得关掉上游自带的 workflow。** 仓库 Actions 页面里逐个 disable 掉 `CI`、`e2e` 之类的上游流水线，只留 `Desktop release` 和 `Sync upstream harness`，否则每次同步都会白跑一大堆和桌面版无关的检查。

## 签名

默认打出来的是未签名的包，能用，但系统会拦一下：

- **macOS**：`build/after-pack.js` 会做 ad-hoc 签名——Apple 芯片拒绝执行完全没有签名的 Mach-O，没有这一步装上就打不开。但 ad-hoc 不等于公证，从网上下载的包第一次打开仍会提示「已损坏」，清一次隔离属性即可：

  ```bash
  xattr -dr com.apple.quarantine "/Applications/DSH Desktop.app"
  ```

- **Windows**：SmartScreen 会提示未知发布者，「更多信息 → 仍要运行」。

有证书的话，把下面这些配成仓库 Secret，CI 会自动走真实签名（`build/after-pack.js` 检测到证书就不再 ad-hoc 签名）：

| Secret | 用途 |
|---|---|
| `CSC_LINK` | macOS 证书（base64 的 `.p12`） |
| `CSC_KEY_PASSWORD` | 上面这个证书的密码 |
| `WIN_CSC_LINK` | Windows 代码签名证书 |
| `WIN_CSC_KEY_PASSWORD` | 上面这个证书的密码 |

公证（notarization）还需要额外配 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 并在 `electron-builder.yml` 里打开 `mac.notarize`。

## 目录

```
desktop/
├── harness.json              # 包哪个版本的 harness、用哪种模式、内置哪个大版本的 Node
├── electron-builder.yml      # 打包配置
├── build/
│   ├── after-pack.js         # 未签名 macOS 构建的 ad-hoc 签名
│   ├── entitlements.mac.plist
│   └── icon.png              # 由 scripts/make-icon.mjs 生成
├── resources/loading.html    # 启动画面 / 失败时的错误页
├── scripts/
│   ├── prepare-runtime.mjs   # 装配 runtime/：harness 闭包 + Node 二进制
│   └── make-icon.mjs         # 纯 Node 画图标，不依赖任何图像库
└── src/
    ├── main/                 # 主进程：进程监管、窗口、菜单、设置、日志
    └── preload/              # 只给启动画面用的最小桥接
```

## 排错

日志在这里，启动画面上的「Open logs」按钮也是打开它：

- macOS：`~/Library/Application Support/DSH Desktop/logs/`
- Windows：`%APPDATA%\DSH Desktop\logs\`

`desktop.log` 是壳自己的事件，`harness.log` 是 `dsh web` 的完整输出。

| 现象 | 原因 |
|---|---|
| 启动画面停在 "Harness runtime not found" | `runtime/` 没装配。跑 `npm run runtime`。 |
| 终端工具报找不到 `git`/`node`/包管理器 | Finder 启动的 App 拿不到登录 shell 的 `PATH`。壳会用 `$SHELL -ilc` 读一次真实 `PATH`，如果你的 shell 配置里有交互式的东西卡住了探测，就会退回到默认值。 |
| macOS 提示「已损坏」 | 未公证 + 隔离属性。执行上面的 `xattr` 命令。 |
| 终端相关功能全挂 | `spawn-helper` 丢了可执行位。壳每次启动都会尝试补回来，日志里能看到。 |

想换 agent 的工作目录：菜单 **File → Change Workspace Folder**（改完会重启 harness）。
