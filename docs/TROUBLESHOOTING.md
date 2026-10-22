# taiji 问题排查

Runtime 日志落盘到 `<数据目录>/logs/`（`runtime-YYYY-MM-DD.log`，按天轮转 + 大小滚动），pi 子进程 stdout 的 JSONL 事件流独立落盘为会话树内 `ext-sessions/<sessionId>/logs/pi-<date>.jsonl`（pi 卡死类问题的决定性证据；文件名不带 sessionId——sessionId 在目录路径。无归属日志 relay `pi-relay-<date>-<recordId>.jsonl` 等仍留 `<数据目录>/logs/`）。console 输出同步 tee 到终端。以下是各层的日志获取方式。

## 日志获取

| 层级 | 开发模式 | 打包模式 |
|------|---------|---------|
| **Electron 主进程** | 终端直接看 | 终端启动 `/Applications/TaiJi.app/Contents/MacOS/TaiJi` 或 `log show --process TaiJi` |
| **Runtime** | 终端 `[runtime:out]` / `[runtime:err]` 前缀 + `~/.taiji-dev/logs/runtime-*.log` | 同主进程转发 + `~/.taiji/logs/runtime-*.log` |
| **pi 子进程** | 终端 pi 自身输出 + `~/.taiji-dev/ext-sessions/<sessionId>/logs/pi-<date>.jsonl` | `~/.taiji/ext-sessions/<sessionId>/logs/pi-<date>.jsonl` + pi 日志目录 `~/.taiji/agent/logs/` |
| **Renderer console** | `~/.taiji-dev/logs/renderer-console-<date>.log`（renderer 进程 warn/error 泛捕流，main 侧 console-message 监听落盘） | `~/.taiji/logs/renderer-console-<date>.log`（同左） |
| **升级子系统** | `~/.taiji-dev/update/update-error.log`（JSONL 512KB×2 轮转；失败登记含 errorCode/rawCause/engine/releaseSource，成功登记 source-selection/source-failover/download-success） | `~/.taiji/update/update-error.log`（同左） |
| **前端 DevTools** | Cmd+Option+I 打开 | 同左 |

**打包模式启动应用获取完整日志**：终端启动 `/Applications/TaiJi.app/Contents/MacOS/TaiJi`（推荐，直接看到所有 console 输出）；或 `log stream --predicate 'process == "TaiJi"' --level debug`；或 Console.app 搜索 TaiJi。

## 旧布局会话数据手工清扫

session 维度衍生数据的现行落点是 session 存储树 `<数据目录>/ext-sessions/<sessionId>/<域>/`，删除会话时整树进废纸篓（mac 可在访达废纸篓恢复整树）。**存储树反转前创建的会话**，其衍生数据仍留在旧布局目录原位、应用不再读写；删除这类旧会话时只回收新树半边，旧布局部分成为磁盘残留——这是显式取舍（不做迁移、不做自动清理），需要回收时按下表手工定位删除。

**例外：会话日志域不做静置**——旧布局会话日志（`pi-*.jsonl(.N.gz)` / `pi-crash-*.log` / `signal-forensics-*.jsonl`）仍由全局日志保留期清理（默认 7 天，`readLogKeepDays`）按 `pi-` / `signal-forensics-` 文件名前缀继续覆盖，超龄自动删除：按本表定位旧日志大概率扑空属正常（已超龄被清），一般无需手工清扫。

sessionId 的取法：侧栏会话列表 / `<数据目录>/agent/sessions/<encodeCwd>/<ts>_<sessionId>.jsonl` 文件名的末段。

**一般域**（目录名或文件名直接含 sessionId，按「旧布局路径 × sessionId」匹配）：

| 域 | 旧布局路径 | 定位方式 |
|---|---|---|
| 图片附件 | `<数据目录>/attachments/<sessionId>/` | 目录名即 sessionId |
| 会话产物 | `<数据目录>/artifacts/<sessionId>/` | 目录名即 sessionId |
| 图片缓存 | `<数据目录>/cache/images/<sessionId>/` | 目录名即 sessionId |
| 插件 KV | `<数据目录>/session-data/<sessionId>.json` | 文件名即 sessionId |
| 后台任务登记 | `<数据目录>/agent/base-tool-enhance/<sessionId>/` | 目录名即 sessionId |
| 会话导出 | `<数据目录>/agent/tmp/session-view-<sessionId>.md` | 文件名即 sessionId |
| btw 线会话 | `<数据目录>/agent/btw/<encodeCwd>/<mainSid>/` | 两层分区，第二层目录名 = 主会话 sessionId |
| 会话日志 | `<数据目录>/logs/pi-<date>-<sessionId>.jsonl`（含 `.N.gz` 轮转）、`pi-crash-<date>-<sessionId>.log`、`signal-forensics-<date>-<sessionId>.jsonl` | 文件名内嵌 sessionId（`pi-relay-<date>-<recordId>.jsonl` 无 sessionId，不按本表匹配）。**本域不静置**：保留期清理（默认 7 天）按前缀继续覆盖，超龄已自动删，一般无需手工清扫 |
| 画布 | `<数据目录>/canvases/<canvasId>/` | 旧布局无 sessionId 关联（按画布 id 分区）——只能逐目录核对内容，或整目录清理 |

**例外两域**（旧布局按 encodeCwd / cwd-slug 分区、文件按 recordId / runId 命名，sessionId 只存在于记录内容字段 `rootSessionId` 内，不能按目录名匹配，须按记录字段过滤定位）：

| 域 | 旧布局路径 | 定位方式 |
|---|---|---|
| subagent 记录 | `<数据目录>/agent/subagents/<encodeCwd>/{sessions,records,model-switch}/` | 读 `records/` 下每条 `<recordId>.json` 的 `rootSessionId` 字段，命中目标 sessionId 的记录连同同 enc 段下对应 `sessions/` 文件一起删 |
| workflow 运行状态 | `<数据目录>/agent/sessions/<cwd-slug>/workflow-state/<runId>.record.jsonl` | 读每条 journal 首行 run 创建记录的 `rootSessionId` 字段，命中目标 sessionId 的 run 整文件删 |

> encodeCwd / cwd-slug = 工作目录路径编码成的目录名（例：`/home/user/proj` → `--home-user-proj--`）。

**不在清扫范围**：pi 会话 jsonl 本体 `<数据目录>/agent/sessions/<encodeCwd>/<ts>_<sessionId>.jsonl` 及其 sidecar——它是会话本体而非衍生数据，删除它等于删除会话本身（走应用内删除，删除时主文件进废纸篓）。

## 关键诊断路径

**打包后应用结构** (`/Applications/TaiJi.app/Contents/Resources/`)：

```
Resources/
├── app.asar.unpacked/dist/runtime/   # runtime bundle（必须在 unpacked 目录）：index.cjs 入口 + plugin-bootstrap.cjs
├── pi/                                # bundled pi 二进制（pi-darwin-arm64）+ agent/ skills/extensions + assets/
├── extensions/                        # builtin pi extensions（esbuild bundle 产物）
│   └── @zhushanwen/<pkg>/
└── bin/taiji-settings                   # taiji-settings CLI（pi Skill 引用）
```

> **注**：builtin pi extensions（数量与分组以 `packages/shared/src/mandatory-extensions.json` 为 SSOT）随应用打包内置在 `Resources/extensions/@zhushanwen/` 下，离线可用、无需安装。其中 infrastructure 级不可禁用，feature 级可在 Settings → Extensions 中禁用/启用。第三方扩展（任意 npm 包 / 本地目录 / git）经 Settings → Extensions 安装到数据目录。

**数据目录** (`~/.taiji/`)：

```
~/.taiji/
├── config.json           # 运行时配置（API key 等）
├── config.toml           # pi 配置
├── ui-preferences.json   # UI 语言（renderer 经 config.setUiLocale 写，extension 读取热生效）
├── runtime.port          # runtime 端口号（文本文件）
├── session-data/         # session 持久化数据
├── agent/logs/          # pi 日志（extension-logger 写 <agentDir>/logs/，agentDir = <dataDir>/agent）
├── plugins/              # 插件数据
└── update/               # 升级子系统（update-error.log 登记 + manual/ 手动认领目录：断网逃生通道，name+size+sha256 三重校验）
```

**开发模式差异**：数据目录 `~/.taiji-dev/`，端口 +100（3310-3320），Electron userData 隔离。

### 浏览器浮层诊断信号（display-containers W2，2026-10-03 登记）

浮层浏览器三类失败/回执信号（renderer 经 preload `browser` 通道可达）：

| 信号 | 形态 | 含义与处置 |
|---|---|---|
| create 失败 reject | `browserCreate` IPC reject（原「主进程 warn 后静默 return」已消灭） | view 创建失败（window 失联等）→ 浮层 `browser-create-error` 占位 + 重试。**池满不是失败**（LRU 自动淘汰） |
| render-process-gone | 页面进程崩溃信号 → 错误态占位 | 占位文案区分「创建失败 vs 页面加载失败」两类；重试 = create+show+navigate 整链重发 |
| forward-keys rejected 回执 | 转发键清单双端匹配失败的拒收回执 | 键矩阵漂移信号——核对 `apps/electron/main/browser/gateway/forward-keys.ts` 与 renderer 注册处上报清单是否同源；settings 改键 / 窗口重载后的重报窗口期属已知可接受（毫秒级） |

## 常见问题排查清单

### 1. pi 启动失败："Failed to start bundled pi process"

```bash
ls -la /Applications/TaiJi.app/Contents/Resources/pi/pi-darwin-*   # 二进制是否存在
file /Applications/TaiJi.app/Contents/Resources/pi/pi-darwin-arm64  # 是否 Mach-O 可执行
chmod +x /Applications/TaiJi.app/Contents/Resources/pi/pi-darwin-arm64  # 权限丢失时修复
uname -m   # 架构匹配检查（Intel Mac 上只有 arm64 二进制）
/Applications/TaiJi.app/Contents/MacOS/TaiJi   # 终端启动看完整错误
```

常见原因：pi 二进制缺失（`extraResources` 配置错误或 `resources/pi/` 内容不完整）、权限丢失（`chmod +x`）、架构不匹配（Intel Mac 装了 arm64-only DMG）、symlink 问题（`resources/pi/` 有指向外部绝对路径的 symlink，打包后目标不存在）。

### 2. Runtime 启动失败："Runtime bundle not found" 或 "Runtime health check timed out"

```bash
ls -la /Applications/TaiJi.app/Contents/Resources/app.asar.unpacked/dist/runtime/

# 手动启动 runtime 冒烟测试，然后 curl http://localhost:9999/health
TAIJI_AGENT_PACKAGED=1 ELECTRON_RUN_AS_NODE=1 \
  /Applications/TaiJi.app/Contents/MacOS/TaiJi \
  /Applications/TaiJi.app/Contents/Resources/app.asar.unpacked/dist/runtime/index.cjs \
  --port=9999
```

常见原因：`asarUnpack` 失效（`files` 排除了 `dist/runtime`）、`tsup.config.ts` 的 `noExternal` 缺少新依赖（运行时 `Cannot find module`）、端口范围 3210-3220 全部被占用。

### 3. 端口冲突

```bash
cat ~/.taiji/runtime.port                      # 当前 runtime 端口
lsof -i :3210 -P | grep LISTEN                     # 端口占用
lsof -i :3210-3220 -P | grep LISTEN | awk '{print $2}' | sort -u   # 清理残留进程前先定位 PID
```

### 4. Extension 相关问题

builtin pi extensions（数量与分组以 `packages/shared/src/mandatory-extensions.json` 为 SSOT）随应用打包内置，不经过 npm 安装：

```bash
ls /Applications/TaiJi.app/Contents/Resources/extensions/@zhushanwen/   # 打包产物中的 builtin extensions
cat ~/.taiji/agent/settings.json                                    # builtin 扩展不生效时查是否被禁用
```

第三方扩展经 Settings → Extensions 页面安装，走 `npm install` 到数据目录，安装失败最常见原因是网络：

```bash
ls ~/.taiji/npm/node_modules/@zhushanwen/                 # 用户级 npm extension 安装目录
cat ~/.taiji/agent/settings.json | grep '@zhushanwen/pi'  # settings.json packages[] 是否记录
npm view @zhushanwen/pi-goal version                          # npm registry 可达性
```

安装失败错误码来自 npm installer：`not_found`（包名错误）、`network`（npm registry 不可达）、`extract` / `integrity`（下载内容异常）。

### 5. Dev 模式 Vite 不更新

```bash
lsof -i :1420 -P | grep node
# 确认 1420 端口属于当前 worktree，且进程 cwd 指向当前 worktree 的 renderer 目录
```

### 6. subagent 没走 runtime control 通道：查 control env 与传输选择

托管态下 runtime 持有引擎进程 spawn 权：runtime 向主 pi 进程注入 `TAIJI_SUBAGENT_CONTROL_SOCKET`（control socket 路径）与 `TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID`，extension 侧 `EngineClient` 以 `isControlEnvActive`（socket 非空）为唯一谓词选择 `RuntimeEngineTransport`；env 缺失/空串（standalone、旧 runtime）回落 local transport（`TAIJI_AGENT_DEBUG=1` 时可见 debug 日志 `transport selected: local (no control env)`）。env 存在但 socket 不可达 / `hello` 失败 → `engine_transport_unavailable`（显式失败，不回落 local）；control server init 失败是 runtime fatal（见 #8），不会以「control server 未监听」形态到达这里。

```bash
# 1. control server 是否监听（runtime 首启日志）
grep "subagent-control" ~/.taiji/logs/runtime-*.log                    # dev 用 ~/.taiji-dev
# 2. 主 pi 子树是否带 control 两键（subagent bash 工具内）
printenv | grep TAIJI_SUBAGENT_CONTROL
# 3. extension 侧传输选择（需 TAIJI_AGENT_DEBUG=1）
grep "transport selected" ~/.taiji/agent/logs/subagents-*.log
```

托管态 transport 失败是显式错误（不静默回落 local）：`engine_transport_unavailable`（connect/hello 失败——runtime 未运行或正在重启）、`engine_transport_lost`（连接中途丢失——runtime 崩溃/重启）、`engine_open_timeout`（runtime 侧 engine_open/spawn 停滞）、`engine_frame_too_large` / `engine_backpressure_overflow`（帧上限/背压溢出）——恢复 = 重启 taiji 后重跑（连接不原地重试）。引擎执行器解析失败呈现 `engine_not_found`（`resolveEngineNodeLaunch` 路径不可解析或执行器探针失败，恢复指引随错误文案）；executor 探针结果按进程缓存，失败后需重启相关进程才会重探。raw mirror 丢弃/seq 空洞 → `degraded:true`：live 视图停止更新但不影响 run，reload 查看历史即可。机制细节见 `infra/subagent-control/` 源码注释与 [architecture/subagent-engine-protocolization.md](architecture/subagent-engine-protocolization.md)。

### 7. bash 工具里启动 Electron 二进制被静默降级纯 node 模式（ELECTRON_RUN_AS_NODE=1）

打包模式下 runtime sidecar 由 main 以 `ELECTRON_RUN_AS_NODE=1` 启动（Electron 二进制当纯 node 跑 sidecar 的必需条件），打包态 runtime 再经 `getEngineRootsSpawnEnv` 以 extras 显式注入 pi 子进程（`engine-roots.ts:65-67` → `process-manager.ts` 注入 env → `rpc-client.ts:277-283` 的 `buildPiOutboundEnv`（`extras: this.options.env`）交 `buildOutboundChildEnv` 构建；`ENV_WHITELIST_PREFIXES` 不含 `ELECTRON_` 前缀，不是白名单继承），runtime spawn 引擎遇到 Electron 执行器时同样注入（SDK node-executor 的宿主矩阵①/②）——subagent 的 bash 工具里启动任何 Electron 二进制（如 `npx electron .`）会被静默切到纯 node 模式：无窗口、无报错。定位：bash 工具里 `env | grep ELECTRON`。终端服务不受影响（TerminalService 独立构造 env 已剥离）。**playwright e2e 形态（fail-fast 非静默）[2026-09-22]**：经 subagent bash 跑 `npx playwright test --project=electron*` 时，launch-app fixture 的 `{...process.env}` 把该变量透传给 Playwright 拉起的 Electron → 纯 node 化不认 `--remote-debugging-port=0` → 全部用例 `electron.launch: Process failed to launch!` + `bad option` + exit 9（对照：直接跑 `--version` 打出 `v24.15.0` 而非 `Electron x.y.z` 即此病）。对策 = e2e 运行命令前缀 `env -u ELECTRON_RUN_AS_NODE`（CI 无此变量时 no-op）；pnpm dev 正规链（dev-instance `buildDevEnv` LEAK_ENV_KEYS）已内置剥离不受影响。机制细节见 `packages/subagent-engine-sdk/src/node-executor.ts` 的宿主矩阵注释与 `apps/electron/main/supervisor/process-control.ts` 的 sidecar env 注释。

**同根因的第二个症状面（2026-09-19 实测）：playwright electron 轨在 agent bash 里全灭**——`npx playwright test --project=electron` 报 `electron.launch: Process failed to launch!` + `Electron: bad option: --remote-debugging-port=0`（`--version` 回显 `v24.x` 而非 `v42.3.3` = 已被降级为裸 node，node 的 CLI 不认该开关）；与代码无关，**跑 e2e 前先 `env -u ELECTRON_RUN_AS_NODE`**（例：`env -u ELECTRON_RUN_AS_NODE npx playwright test --project=electron-smoke`）。别误判为 Electron 二进制损坏或构建失败。解除该变量后 mock 轨与 real 轨均可跑通（2026-09-20 实测：electron 轨 64/64 全绿，real 轨为凭证无关的 faux LLM 装配，无需真实 provider）。

**配套陷阱：mock/real 两轨共用同一份 renderer 产物，须分批构建**——两条轨都读 `apps/electron/renderer/dist`，构建期由 `VITE_MOCK` define 决定走哪条 transport 链，而 e2e globalSetup 只查产物存在、不查构建形态。故跑完 real 轨（`VITE_E2E=true pnpm run build:e2e`）后必须重建 mock bundle（`VITE_E2E=true VITE_MOCK=true pnpm run build:e2e`）再跑 mock 轨，否则 mock spec 全部以 30s 超时呈现。两个方向的形态错配均已由 pre-flight fail-fast 拦住并给出重建命令：`launch-app-real.ts` 的 `assertRealRendererBundle`（mock 产物在场）+ `launch-app.ts` 的 `assertMockRendererBundle`（real 产物在场，判据 = mock fixture 标记串 `Promise 代码评审`，两 fixture 共享导出）。

### 8. runtime 启动即退出："fatal: subagent control server init failed"

subagent control server 在 runtime listen 后同步初始化，失败即 fatal + exit 1（fail-fast：托管态下 control 通道是引擎 spawn 的唯一权威，init 失败拒绝启动，避免「以为 runtime 在管、实际 local spawn」的静默分裂）。常见原因：`<dataDir>/run` 不可写；socket 路径超长（macOS unix domain socket 104 字节上限，`assertSocketPathLength` 在 listen 前 fail-fast）；本 pid 对应的 socket 路径残留（pid 复用：跨代 sweep 的 skipPath 就是本实例即将 listen 的路径，不探不删）。跨实例不会因「残留 socket 被活实例持有」而失败：`getControlSocketPath` 按 pid 命名天然隔离，sweep 对活实例的 socket 只 warn 保留、不动它。

```bash
ls -la ~/.taiji/run/          # dev 用 ~/.taiji-dev；per-runtime 文件名为 subagent-<pid>.sock
lsof | grep subagent-.*\.sock
```

**listen EINVAL（2026-09-18 B5b 实测）**：socket 路径 `<dataDir>/run/subagent-<pid>.sock` 受 macOS unix domain socket 104 字节路径上限约束——dataDir 路径过长（深层临时目录 / 长目录名，实测 106 字节中招）时 bind EINVAL，runtime 起不来且日志仅此一行。短 dataDir（如 `/tmp/<短前缀>`，全路径含 socket 文件名 ≤100 字节）无此问题。e2e spec 的 mkdtemp 前缀必须短（skill-reload-askuser 系列前缀曾因此从中招形态改短）。

机制细节见 `infra/subagent-control/control-server.ts` / `paths.ts` 源码注释（路径长度门禁 `assertSocketPathLength` 在 listen 前 fail-fast）。

### 9. agent 会话内执行 validate-runtime-bundle 失败："Bundled pi binary not found"

**症状**：agent 会话内跑 `bash scripts/validate-runtime-bundle.sh` 报 `[runtime] fatal: subagent control server init failed: Bundled pi binary not found`；或其它依赖「打包态判定」的行为异常（如 `isPackaged()` 返回错误结果）。

**根因**：agent 会话 env 泄漏了 `TAIJI_AGENT_PACKAGED=1`（打包标记只在 main→runtime 注入链上有意义），会话内再起的 runtime 子进程误判打包态、按打包路径解析捆绑二进制。

**如何确认**：

```bash
printenv | grep TAIJI_AGENT_PACKAGED   # 有输出 = 泄漏确认（出站契约不改变本会话自身 env 快照）
env -u TAIJI_AGENT_PACKAGED bash scripts/validate-runtime-bundle.sh   # 旁证：剥除后应恢复正常
```

若仍命中，说明该调用点未经出站契约构建器，带报错文件行号去 `.githooks/check_spawn_env_boundary.py` 豁免名单核对。治理：约束 C-proc-09（子进程 env 出站契约，`buildOutboundChildEnv` deny 剥除）+ pre-commit 检查 `.githooks/check_spawn_env_boundary.py`，详见 [architecture/env-propagation-boundary.md](architecture/env-propagation-boundary.md)。

### 10. 升级中断手动恢复（升级脚本 staging 状态机残余窗口）

自动升级在换装阶段（备份 mv 与原子换装 mv 之间，毫秒级窗口）被断电/强杀命中时，app 无法自愈（自愈代码运行在 app 进程内，此时无执行机会）：**双击图标无反应、`/Applications` 下 `TaiJi.app` 缺失，同时存在 `TaiJi.app.old` / `TaiJi.app.new`**。（`.old` 与 `.new` 均为完整可用副本，缺失的只是正式位置的名字。）

```bash
ls -la /Applications/ | grep 'TaiJi.app'   # 识别残留：TaiJi.app 不在列表，.old 与 .new 同时存在

# 二选一恢复（执行后 app 即可正常启动）：
mv /Applications/TaiJi.app.old /Applications/TaiJi.app   # 回到旧版（丢弃未装完的新版）
mv /Applications/TaiJi.app.new /Applications/TaiJi.app   # 改用手动装新版（若 .new 异常可再换回旧版命令）
```

补充：`.old` 或 `.new` 单独残留（`TaiJi.app` 在位且可启动）属良性残留，下次启动自动清理；从 DMG 只读卷运行时升级会被拒绝（update-result 写 `read-only volume`），请先将 `TaiJi.app` 拖入「应用程序」文件夹再触发升级。

### 11. pnpm store 布局翻转（pre-commit 护栏红 / install 报 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY）

**现象**：commit 被护栏 `.githooks/check_pnpm_store_layout.sh` 拦截（报「store 布局翻转」）；或 `pnpm install` 间歇非 TTY abort（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）。

**判定**：比对 `node_modules/.modules.yaml` 的 `storeDir` 与当前环境解析的 store 路径（`grep storeDir node_modules/.modules.yaml`）。两个已知劈叉源：

1. **沙箱 HOME 覆写**（引擎 worker 侧 install 写入自身 store）——记录路径含引擎沙箱目录即此形态。
2. **pnpm launcher 双版本**（全局 pnpm 是 launcher，bin/pnpm.mjs 实体版本可能高于项目 `packageManager` 钉定版本，两版 store 版本段不同，如 v11 vs v10）——裸 `pnpm store path` 与 install 写入劈叉。**判定基准必须与 install 同源**：护栏用 `corepack pnpm store path`（按项目 packageManager 解析；corepack 缺失回退裸 pnpm）。

**恢复**（`.modules.yaml` up-to-date 时 install 跳过重写，须删清单强制）：

```bash
rm node_modules/.modules.yaml
CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install   # 约 7s 重建，然后重试 commit
```

**防护**：护栏 `.githooks/check_pnpm_store_layout.sh`（pre-commit 第 0 段 + validate-runtime-bundle Gate 0），翻转即红并输出 [FIX] 指引。根治已落地（引擎共享宿主 HOME），护栏语义 = 防 HOME 覆写回退与版本段劈叉（正常恒绿，红 = 上述两形态之一复发）。

### 12. subagent 完成后不回收 / 回收慢：sessionFile 获取链与 workflow 域守护特征串（2026-09-10 重放移植重写；2026-09-11 H1 续聊链修订）

> 机制与串语义权威：[architecture/subagent-chat-run-unification.md](architecture/subagent-chat-run-unification.md) + `packages/pi-subagent-cli/src` 代码注释；原设计文档 design/subagent-agent-end-recovery-replay.md 已删（2026-09-13，git 可追溯），本节只留排障入口。**防误判**：2026-09-10 前的旧特征串（`backfilled via late get_state response` / `located via sessionDir scan` / `unobtainable after 15s recovery window` / `no-descendant fast path` 等）与 chat 域热路径日志侧（roundLifecycle 相位帧 / `interact` / ChatSessionRegistry / `chat-round-first-round-watchdog`）在现树均已不存在——按旧串 grep 恒零命中是预期，不是日志丢失。

排障入口（三条现行 warn 特征串；①③ 来自 `pi-subagent-cli`，② 来自 `subagent-core`；日志统一落 `<dataDir>/agent/logs/subagents-<date>.log`，裸 pi CLI 需 `TAIJI_AGENT_EXT_LOG=1` 或 `TAIJI_AGENT_DEBUG=1` 才落盘）：

```bash
grep -E "\[sessionfile\]|agent_end get_state backfill|workflow no-progress watchdog" \
  ~/.taiji/agent/logs/subagents-*.log   # dev 前缀换 ~/.taiji-dev/agent/logs/
```

- ① `[sessionfile] unobtainable ... (all acquisition paths missed)` — sessionFile 四路获取（spawn 握手 / 迟到 response / agent_end 惰性回补 / close 后缀反查）全 miss，transcript 锚点缺失但不会误配；按 warn 尾句人工归档或重派任务，高频出现说明握手链系统性故障。
- ② `agent_end get_state backfill failed` — 惰性回补链抛错，`killChild` 在 finally 必达（run 不因回补失败挂死），全 miss 归 ①。
- ③ `workflow no-progress watchdog ... fired` — workflow 域 30min 无协议事件/stream delta 的静默楔死熔断（cancel 帧 → 收敛窗 → killAll）；产出仍在刷新时不 fire。注意 env `TAIJI_SUBAGENT_SETTLED_WATCHDOG_MS<=0` 会连带关闭本熔断。

H1 后续聊要点：每轮续聊 = 独立 run（`RunParams.resume` 续写原 session 文件），无长驻 chat 进程形态；跨重启续聊数据源 = `<sessionFile>.record-binding` 绑定 sidecar——「subagent not found or not owned」按序查 record 存在性 → sidecar 文件 → `cold-lookup.ts` 恢复。「失败后无通知」或「失败即 closed」属异常，查 Continuation onRunSettled 失败分支。workflow origin record 排查须带 `includeFinished:true` + `includeWorkflow:true` 成对；成败判读看 outcome 不看 closedReason（见观察项 #14）。

### 13. record 直写检查拦截（eslint no-restricted-imports / check-record-write-surface）

> 权威 SSOT：[architecture/subagent-record-persistence-consolidation.md](architecture/subagent-record-persistence-consolidation.md)（§3.3 检查分级 / §3.1 意图级 API 表）；约束登记 C-data-20。

record 持久化写侧（事件文件 `<recordsDir>/<id>.events` / `.record-binding` 绑定 sidecar / `.alive` 写权声明 / manifest / sessions-index / `subagent-record` entry）的唯一写入口 = `RecordStore` 意图原语（`packages/subagent-core/src/execution/persistence/record-store.ts`）；事件流是 record 域唯一事实源（收条由 `record-settled` / `record-round-idle` 帧承载），manifest 是带水位（eventsStamp）纯索引派生视图。两级检查：eslint `no-restricted-imports`（store 外禁 import 写函数，模块边界一级拦截）+ pre-commit `scripts/check-record-write-surface.mjs`（写函数 / 字面量直写形态 grep 门兜底，含 `.events` 事件文件直写判定）。

- 处置：改调 RecordStore 意图原语（`markSettled` / `markRoundIdle` / `markReopened` / `markSettledOut` / `acquireWriteLease` / `reportRecordTransition`；legacy 终态桥接族 `markFinalized` / `markCancelled` 保留至读侧兼容收尾）；读函数不受限。复跑：`node scripts/check-record-write-surface.mjs`（应输出 store 外零命中）。
- 误拦判定：新写侧确属 store 外自有域时，在检查脚本 `EXTENSION_DOMAIN_ALLOWLIST` 登记文件并注明设计依据（登记处即登记），禁止行内豁免绕过。

### 14. catalog provider 自定义网关失效 / 端点与官网不符（启动清洗剥除手编网关，2026-09-10 D2 已接受代价）

```bash
grep "stripped unmarked provider-level keys" ~/.taiji/logs/runtime-*.log   # dev 用 ~/.taiji-dev
```

命中即启动清洗剥除了未显式标记的手编 catalog 网关（判定锚 = providers.json extras 的 `gatewayBaseUrl` 标记，无标记即剥）。恢复：Settings → Providers 展开该 provider，在「端点（自定义网关）」重设网关 URL 并保存一次（标记落盘后不再被剥）。判定锚权威 = `packages/core/src/domain/settings/provider-edit-form.ts` 防线注释（原设计文档 catalog-provider-field-authority.md 已删除，git 可追溯）。

### 15. Coding Plan 额度查询失败 / 数据疑似过期（2026-09-10 配置交互重构）

先核对「界面显示的凭证来源」与磁盘字段/文件是否一致，不猜凭证有没有填（`no-credential` = 按 `credentialSource` 选中的链路解析不到凭证，不是「凭证一个都没有」；`exclusive` 缺专属 Key 文件即失败、不回退）。检查三命令（`CD=~/.taiji`，dev 用 `~/.taiji-dev`）：`grep "\[quota\] fetch failed" $CD/logs/runtime-*.log | tail -20`（失败原因）· `grep -n -A6 '"quota"' $CD/agent/config/providers.json`（credentialSource 字段）· `ls -la $CD/secrets/`（secrets 实际文件）。

恢复：失败态浮层的「刷新/配置」双入口；设置页「保存并测试」是唯一落盘 + 查询动作，齐备性不满足时按钮置灰并给字段级提示。机制权威 = quota 配置相关代码注释与约束登记（原设计文档 design/coding-plan-quota-config-ux.md 已删除，git 可追溯）。

### 16. dev 数据目录实际落点（per-worktree 实例目录）

**现象**：找 dev 实例的 session / 日志时落点不对；或 dev 首启没配模型，新建会话直接报 `No model configured. Please configure a provider and model in Settings before starting a session.`。

**现状**：dev 数据目录 = 装配器派生的 `~/.taiji-dev/instances/<worktree>/`——`main.ts` dev 分支受控采信树内实例目录（外部 `TAIJI_AGENT_DATA_DIR` 仅当 `path.resolve` 后位于 `~/.taiji-dev` 树内才采信，其余一律固定回 `~/.taiji-dev`，防宿主 env 泄漏语义保留；`TAIJI_E2E=1` 受控装配豁免）。解析纯函数 = `apps/electron/main/utils/dev-data-dir.ts`（行为矩阵 = `main/test/dev-data-dir.test.ts`）。早期 dev 数据可能仍留在 `~/.taiji-dev/` 根——实例目录找不到旧 session 时去根目录核对。

**排障动作**：

```bash
ls -la ~/.taiji-dev/instances/<worktree>/agent/sessions/   # session 数据落点（per-worktree）
ls -la ~/.taiji-dev/instances/<worktree>/logs/             # runtime-*.log 等全局日志落点
ls -la ~/.taiji-dev/instances/<worktree>/ext-sessions/<sessionId>/logs/   # pi-<date>.jsonl 会话日志落点（树内）
```

首启缺配置（provider / secrets / 默认模型）时装配器自动从只读模板 `~/.taiji-dev.template/` 按 `TEMPLATE_TOP_FILES` / `TEMPLATE_TOP_DIRS` 白名单复制进实例目录（白名单定义见 `apps/electron/scripts/dev-instance-lib.mjs`，`node apps/electron/scripts/dev-instance.mjs init-template --seed-from <源>` 生成模板；模板只读，勿直改）。

**实验隔离正式通道（2026-09-19）**：需要独立数据目录（基线采集 / mock 实例 / 多实验并行 / 多 worktree 隔离）时，用装配器显式参数 `node apps/electron/scripts/dev-instance.mjs --data-dir ~/.taiji-dev/<suffix>`——值域限 `~/.taiji-dev/` 树内（fs-guard 白名单与路径检查按该前缀放行），装配器注入 `TAIJI_DEV_ASSEMBLED=1` 供 main.ts dev 分支采信（显式标记 + 值域白名单双约束，裸 env 泄漏仍不采信，2026-09-08 防线语义不变）。此通道取代已废弃的「临时改 main.ts dataDir + 用完 revert」实验做法。

### 17. 子包目录 `pnpm exec vitest` 全仓扫跑 + 测试红线「测试禁止触碰真实数据目录」

**现象**：在子包目录（如 `packages/renderer/`）执行 `pnpm exec vitest run`，跑的不是该包测试而是全仓扫描（大量无关包测试启动，甚至触发数据目录防线红灯）。

**根因**（实测，pnpm workspace 行为）：`pnpm exec` 会把 cwd 切回仓库根再执行 bin——vitest 收到的 root 是仓库根，包级 vitest.config.ts（含 `taijiTestConfig` 防线注入）不生效。

**正确跑法**：

```bash
cd <子包目录> && <repo-root>/node_modules/.bin/vitest run   # cwd 留在包内，包级 config 生效
vitest run --root <子包目录>                                 # 或从仓库根指定 root
```

全仓入口只有仓库根一个（根级兜底 config 防线齐备）；单包测试永远用上面两种形态，禁 `pnpm exec vitest` / `pnpm vitest`。测试数据目录红线全文见 AGENTS.md「测试」节。

### 18. 宿主 shell 注入 `TAIJI_AGENT_DATA_DIR=~/.taiji` 时的测试行为（自动脱钩，2026-09-17）

**现象（旧行为）**：Electron / dev 宿主 shell 的 env 天然带 `TAIJI_AGENT_DATA_DIR=~/.taiji`（app 自身的数据目录）。在该 shell 里跑 `pnpm test`，或在该 shell 里 `git commit`（pre-commit 钩子内的检查单测同为 vitest），会被 global-setup 以「指向真实用户数据目录」为由拒跑，必须 `env -u TAIJI_AGENT_DATA_DIR` 才能继续——人人需感知的环境摩擦。

**现状（自动脱钩 + 单行通告）**：`test-guard/global-setup.ts` 检测到注入值指向**真实数据目录**或**非白名单目录**时，不再 `exit 1`，而是删除该 env 并落 tmp 重定向（判定条件与 `isInjectedEnvAllowed` 白名单共用，单一实现）：

```
[global-setup] 检测到宿主注入的 TAIJI_AGENT_DATA_DIR=/Users/<user>/.taiji（真实用户数据目录）——已自动脱钩，本次测试改用 tmp 重定向
```

**安全性等价**：测试永远拿不到真实目录（脱钩后一律 tmp 重定向），第二层 fs-guard（setupFiles 切面）仍拦全部白名单外破坏性操作；**合法注入不受影响**——注入 `tmpdir()` 或 `~/.taiji-dev` 之下的路径（CI 自定义 tmp / dev 实例）仍「尊重不覆盖」。

**排障**：输出里出现该通告 = 当前 shell 带宿主 env（正常现象，无需处理）；确需显式指定数据目录时，注入白名单内路径。

### 19. e2e real 轨用例失败：sidebar 出现 mock 假会话数据（e2e 产物形态错误，2026-09-18）

**现象**：`e2e/*-real.spec.ts`（launch-app-real）跑出诡异失败——sidebar 列出大量不存在于临时数据目录的会话（mock 假数据），新建 session 的条目永远不出现；同 spec 的纯 WS 断言用例（不经 UI）却全绿。

**真相**：playwright global-setup 构建产物时恒定注入 `VITE_MOCK=true`（mock 形态 bundle）。mock 轨与 real 轨共享同一份 `apps/electron/dist` 产物，谁最后构建产物就是谁的形态——real spec 跑在 mock bundle 上时 renderer 走 `mock://localhost`（连接日志可证），根本不连 runtime。

**排障动作**：

```bash
# real 轨前重建 real 形态产物（无 VITE_MOCK）
VITE_E2E=true pnpm run build:e2e
# real 轨跑完、要跑 mock 轨（launch-app 形态）前再重建 mock 形态产物
VITE_E2E=true VITE_MOCK=true pnpm run build:e2e
```

判别信号：runtime 日志（`<dataDir>/logs/runtime-*.log`）只有 spec 自身的 WS 连接、无 renderer 连接；renderer console 出现 `[ws] connecting to mock://localhost`。该形态错误已由 launch 前检查拦截：`e2e/fixtures/launch-app-real.ts` 的 pre-flight `assertRealRendererBundle`（判据 = mock fixture 标记串命中 assets/*.js，real 构建经死分支摇除零命中）校验产物形态，mock 产物在场即 fail-fast 并给出上面的重建命令。

### 20. 表单/命令提交后状态条假忙约 30s / 非断连期 `[chat] finalizeSession reason=timeout` warn

**现象**：命令路径弹窗（如 `/permission rule`、`/permission model`）**提交**后状态条显示进行中约 30s 后自行恢复；console 同期出现 `[chat] finalizeSession sid=... reason=timeout` warning（attach 调试可见，含 sid——timeout 分支已无 dev 门，生产 attach 同样可见；生产落 `renderer-console-<date>.log`（`<dataDir>/logs/`），无需 attach）。

**判定**：该形态的常态命中侧已全部清零——scheduler 表单走 `expectTurn: false` 声明即时收尾（ADR-0073），plain dialog 提交侧已由通路级即时收尾解决（`sendPiResponse` 应答终局无条件清 pendingSend，生产者穷尽论证与落地 commit 见 ADR-0072 收敛条目）。**任何提交源命中 30s timeout 均属真异常形态**（pi 僵死 / 协议漂移 / 极端延迟 / 新扩展源未按通道选型实现——选型指引见 development-guide §5.1）。

**排障**：确认提交源类型——plain dialog 命令（band 弹窗）或已声明 `expectTurn: false` 的表单提交后仍命中 30s = turn 信号链断裂（先取 `renderer-console-<date>.log` 确认 warn 落盘形态（含 sid），再按 pi tee 日志 + ping 信号归因）；ask-user/plan 表单提交出现该 warn 说明 turn 未续接（真异常，同上归因）；新 form 扩展源提交命中 = 未声明 `expectTurn: false`（缺省 true 走桥接，发现即补声明）；新命令扩展源需要「提交后开 turn」的应改用 `uiFormInteract` 并声明 expectTurn（裸 select 通路按无 turn 收尾，恒清不桥接）。

### 21. bun 路径测试假绿：`bunx vitest` 不带 `--bun` 静默跑系统 node（2026-09-21）

**症状**：手工跑 zcode-session-source 的 bun:sqlite 路径测试（`bunx vitest run`）全绿，但 bun 驱动语义分支（`get()` 未命中返 null、`close()` 不 checkpoint 等）实际没被测到——整趟跑的是系统 node 的 node:sqlite。

**根因**：vitest 可执行文件的 shebang 是 node，`bunx` 默认按 shebang 用 node 启动它——进程内 `typeof Bun === 'undefined'`，D3 双驱动探测走 node 分支。`bunx` ≠ bun 运行时，必须显式 `--bun` 才把 vitest 本体跑在 bun 下。

**正确做法**：真 bun 路径 = 包目录内 `bunx --bun --no-install vitest run`。该命令已固化在检查 `scripts/check-bun-driver.mjs`（bun 那一跑由它承担，node 趟由常规 vitest 覆盖；手工验证时可加 `typeof Bun` 探针确认运行时形态）。

### 22. 测试防线被绕过：非 vitest-config 入口执行测试会写真实数据目录（2026-09-22 事故）

**症状**：`~/.taiji/` 下出现测试命名的目录/文件（如 `attachments/att-store-*`——`attachment-store.test.ts` 的用例 sessionId 命名），而测试红线的双层防线（globalSetup 固定 `TAIJI_AGENT_DATA_DIR` + fs-guard 白名单拦截）本应阻止一切真实目录写入。

**根因**：防线挂在 vitest config（`taijiTestConfig` 工厂）上，**只对经 config 启动的 vitest 进程生效**。绕过形态：`bun test`（Bun 测试运行器自动把 `import from 'vitest'` 映射到 `bun:test`，完全不读 vitest.config）、或任何不经项目 config 的执行方式——此时无 env 固定（dataDir 解析回真实 `~/.taiji`）、无 fs-guard（拦截不发生）。标准入口已复现验证有效：包目录 `pnpm vitest run` 写入被正确钉到 tmp。

**恢复**：① 按测试命名模式识别垃圾条目（`att-store-*` 等用例 sessionId 命名、tmp 下 `logger-test-*`/`zcode-engine-*` 等本仓 fixture 前缀），核对条目内无用户数据后删除；② 会话数据核查：`agent/sessions/` 在事故时段的修改检查（本次事故会话区零触碰）。tmp 大量残留会让依赖 readdir 的用例超时（实测 21 万条目时 `countSnapshotDirs` 单次 >3.6s）。

**防范**：跑测试只用标准入口——包目录 `pnpm vitest run`、仓库根 vitest（根级兜底 config 同挂防线）、bun 路径只走 `bunx --bun vitest`（检查同口径）；禁止 `bun test` 执行本项目测试文件。

### 23. runtime 启动即拒绝："fatal: data directory already served by a live runtime instance"

**现象**：runtime 进程启动秒退（exit 1），日志含上述 fatal 与 `live at: 127.0.0.1:<port> (source: ...)` 定位行。

**判定**：同数据目录已有活 runtime 实例（单实例检查，约束 C-proc-25）。检查读 `<dataDir>/runtime-instance.json`（runtime 自登记）与 `<dataDir>/runtime.port`（supervisor 通道）候选端口做 TCP 探活，任一可达即拒绝；端口不可达但 instance.json 登记 pid 存活（启动窗口内的预登记实例，probe 通过即登记、早于 listen）同样拒绝——双 runtime 共享数据目录会导致第二实例 reattach 抢管他人 session、退出时 destroyAll + control 通道 kill-on-disconnect 屠杀全部主 pi 与 subagent，拒绝是正确防御。

**排障**：定位行带 `reachable: true`（端口可达）时按 `lsof -i :<port>` 确认持有者——app 正常重启的竞态窗口等旧实例退出后重试即自愈；定位行带 `reachable: false`（pid 存活但未 listen）时先等并发的另一实例完成启动再重试，`ps -p <pid>` 确认其身份；要并行跑第二实例（dev / e2e / 验收脚本）必须给独立 `TAIJI_AGENT_DATA_DIR`（mkdtemp 或 `~/.taiji-dev/instances/<worktree>`），禁止继承 prod 数据目录 env 起 runtime；仅当持有 pid / 端口确认是无关进程（pid 复用占位）时可删 `runtime-instance.json` 后重试。app 正常链路（Electron supervisor）stop 时等旧 runtime 完全退出才 spawn 新实例，不应触发本报错——频繁出现说明有绕过 supervisor 的独立 runtime 在同目录运行。



### 24. dev 构建下组件实例 `$el` 是注释节点（模板首注释致 Fragment 根）

**现象**：仅在 dev 构建出现的「取不到真实 DOM 元素」类失效——如组件实例 `$el` 为注释节点（nodeType 8），`root === activeElement` / `root.contains(...)` 恒 false；生产构建行为正常（vue 编译剥离模板注释），happy-dom 直挂测试也不暴露（测试态注释被剥离）。

**判定**：Vue 模板顶部有 HTML 注释块时，dev 构建 subTree 根为 Fragment，`instance.$el` 解析为首子注释节点——**任何「实例 → 真实输入根元素」的取法禁止依赖 `$el`**。

**排障**：组件经 `defineExpose` 暴露真实元素 getter（先例 `ComposerInput.getInputElement()`），消费方读 expose 元素、缺失即 fail-closed，禁回退 `$el`（ADR-0073 [HISTORICAL]，事故 = W1 F-1 直发门 dev 全变体静默失效）。

### 25. 导入的 zcode 会话 usage 缺失两级症状：stats WARN（已知降级）与续聊即死（毒消息，2026-09-21 事故，已根治）

- **症状 A（轻）**：runtime 日志反复 `replicated-state usage snapshot fetch failed (attempt=N/4): Cannot read properties of undefined (reading 'input')` WARN——token 用量统计（辅助功能）降级，续聊正常。
- **症状 B（重）**：续聊发出后 25ms 内 turn 即死，pi tee 日志 `turn_end` 带 `stopReason:"error"` + `errorMessage:"Cannot read properties of undefined (reading 'totalTokens')"`，且与症状 A 并存。
- **根因**：产物中存在「assistant 消息、stopReason 为终态（stop/toolUse/length）、无 usage 键」的 entry。pi 0.84.4 读侧对此无检查（pi-semantics PS-41：`agent-session.js:2678` stats 读 `.input`、`:2721` turn 前上下文扫描读 `.totalTokens` 仅跳过 aborted/error）。pi 原生写侧连错误轮都写全零 usage，原生会话不触发；只有导入产物能违反该隐式不变量。
- **成因与根治**：旧版 zcode 导入转换器把「取消轮」（zcode `data.error.turnResult=cancelled`、无 step-finish part）映射成 `stopReason:'stop'` 且不写 usage——设计期「message 级 stopReason 零消费」断言只查了 taiji 渲染链、漏了 pi 读侧。已根治（converter `unsealedStopReason`：cancelled→aborted / error 家族→error；`zeroUsage` 不变量门：assistant 恒带 usage 对象，缺失零值兜底——全零是 pi「无测量数据」的合法编码）。
- **修复配方（存量毒产物，手术式）**：备份 jsonl → 定位毒 entry（assistant + 终态 stopReason + 无 usage）→ 补 `stopReason:'aborted'`（zcode 源有取消证据时）与全零 usage 对象 → 验证：`parseSessionEntries` + PS-41 双谓词零违例 → 重启应用或切走再切回该会话（运行中 pi 进程持旧内存态，改文件不生效于已加载会话）。
- **排查特征**：「续聊即死 + reading 'totalTokens' + stats WARN」三者并存 = 症状 B；仅 stats WARN（续聊正常）= 症状 A（毒 entry 的 stopReason 恰为 aborted/error 时 2721 跳过、仅 2678 崩）。两者同根（usage 缺键），根治后新导入产物均不再出现；存量产物按修复配方手术。

### 26. workflow run 状态异常排查：run 事件 journal 取证（2026-09-21 run 显式状态机落地）

- **取证源**：workflow run 生命周期由显式状态机裁决（`subagent-core/src/orchestration/run-events.ts`，`RUN_MACHINE` 机器声明（@zhushanwen/state-machine，[ADR-0152](adr/decisions.md)）+ `transition` 纯函数，表外转移 fail-fast）；record 流 journal 是 run 态权威派生视图源——`<agentDir>/workflow-state/<runId>.record.jsonl`（[D1] record 单源，后缀经 core `RUN_EVENTS_SUFFIX`；workspace 有活跃 session 时为 `<agentDir>/sessions/<slug>/workflow-state/`，推导 = `resolvePiWorkflowStateDir`），JSONL 逐行（`run-created / phase-started / agent-started / agent-retrying / agent-settled / phase-settled / run-interrupted / run-resumed / run-settled`；`agent-started` 载荷携带 `phase?` = 剧本 phase 归属，抽屉分组视图供源；成员词表权威源 = `subagent-core/src/orchestration/run-events.ts` 的 `RUN_EVENT_TYPES`）。旧格式 `.events.jsonl` 两件套不读不写（历史 run 不进 GUI 列表、resume 拒绝，随孤儿对账清理自然消亡）——不是取证源。
- **判定姿势**：run 卡死/终态异常先读 journal 事件序列对照合法转移表——① 缺 `run-settled` 事件 = run 未终局（查 pump 日志）；② schema 任务武装回执异常：journal 里没有也不该有 `armed` 事件（占位事件已随 D5 删除——回执经运行时事件路由喂入宿主等待门，不落 journal）；现行断言点 = run 终态 failed 且 error 文案含 `[schema-arming]`（宿主 armed 回执等待窗窗满合成失败 outcome，fail-fast 先行——查引擎侧武装断言与 `@zhushanwen/pi-structured-output` 扩展装载；native 引擎 + schema 任务才有武装面，emulated 引擎 / 无 schema 任务豁免不适用本条）；③ debug 日志 `run event dispatch yielded (runId=...)` = 表外转移让位，常见根因是派发链 runId 键错、事件落进占位键（旁证：binding sidecar `.record-binding` 的 `parentRunId` 为 `sar-unattached` 占位而非真实 runId = 未走 workflowAgentDispatch 通道）。
- **注册表派生视图**：run 列表态 = journal fold（四相 missing/active/terminal/interrupted），不看文件 mtime；journal 缺失即 missing 相，手工挪动/删除 journal 文件直接改变派生视图结果。

### 27. 项目 skill 实体（.agents）排障：symlink 形态判定 / 实体还原 / 检出旧 ref 脱钩（2026-09-25 ADR-0086）

- **现状**：`.agents` 实体唯一一份在 workspace 根（`<workspace>/.agents/`），各 worktree 经 symlink 共享，git 不跟踪（`git status` 干净是常态）。backup = `refs/skills-snapshot`（pre-commit 尾部段自动维护；远端同名 ref = 跨机器权威备份点）。
- **判定姿势**：`ls -la .agents` 应显示 `-> ../.agents`；`git ls-files .agents | wc -l` 应为 0。commit 被第 0 段拦下时按错误信息分派：symlink 悬空 = 实体丢失（走还原）；symlink 指错目标 = 重建（`rm .agents && ln -sfn ../.agents .agents`）；`.agents` 是真实目录 = 该分支检出的是迁移前内容（先落迁移 commit 再删目录重建；bisect/detached 态直接 `rm -rf .agents && ln -sfn ../.agents .agents` 后 continue——禁 merge，会污染 bisect 序列）。
- **实体还原**（实体误删 / `.bare` 损坏）：`git archive refs/skills-snapshot | tar -x -C <workspace 根>`；本地 ref 不可用先 `git fetch github refs/skills-snapshot:refs/skills-snapshot`（本 workspace remote 名 = `github`；fresh clone 默认 `origin`——`refs/remotes/origin/*` 是 remote 改名前的 stale 残留，`rev-parse origin/main` 仍解析出陈旧值属半工作陷阱，勿作为依据）。还原后 `diff -r` 核对。
- **快照链排障**：`git rev-parse refs/skills-snapshot` 不存在 = 任一 worktree 手动跑 `bash .githooks/snapshot-skills.sh`；hook 输出 `[WARN] skills 快照失败` = 非阻断（下次 commit 自动重试，多为离线 push 超时）；跨机器重建前 `git ls-remote github refs/skills-snapshot` 核对新鲜度。

### 28. e2e/console 兜底检索撞 error 级 `ResizeObserver loop completed with undelivered notifications`（2026-10-06 ui-redesign-combined D3 验收登记）

**现象**：验收/调试经 CDP 捕获 console 时，流式虚拟列表跟随滚动的采样窗口内出现多条 `[console.error] source=window-onerror: ResizeObserver loop completed with undelivered notifications.`（典型：对话流行数 liveness 采样类剧本）。

**判定**：Chromium 机制性噪声，环境类、非产品缺陷——同一帧内 ResizeObserver 回调改布局导致投递循环超限，浏览器以 ErrorEvent 冒泡到 window.onerror。判定依据：触发场景吻合 renderer 的 ResizeObserver 使用点（对话流五个 composable，rAF-RO 时序见 docs/testing/01-chat-panel-composer.md）；同 step 的功能断言全部通过。

**排障**：e2e/验收任务书含「无 error 级 console」字面判据时，命中本条按归因豁免（带保留通过），豁免须在验收记录留痕（归因 + 功能断言通过证据），禁止静默吞；功能断言同窗失败则不适用本条，按真实缺陷归因。

### 29. 本地签名构建报 `invalid destination for symbolic link in bundle`

**现象**：本地 `pnpm build` / `pnpm build:dir`（electron-builder + codesign）报 codesign `invalid destination for symbolic link in bundle`；CI 不受影响（走真实下载 + dereference 复制）。

**判定**：worktree 的 `apps/electron/resources/pi/` 顶层条目是 git-cwt 创建 worktree 时 symlink 到 workspace 级缓存 `.pi-binary-cache/` 的 dev 提速形态；electron-builder 拷贝源是磁盘而非 git，按链接原样拷进 bundle 后 codesign 以「bundle 必须自包含」拒绝指向外部的链接。构建入口（`build:pre` 公共前置）与 preflight 检查 7 已挂 `scripts/check-pi-resources-links.mjs` 自动拦截，正常应在构建前就红并给恢复指引。

**恢复**：

```bash
node scripts/check-pi-resources-links.mjs --fix   # 外部 symlink → 真实复制（递归实体化，修毕复检）
```

替换后重跑构建。下次 git-cwt 创建 worktree 会重建 symlink 形态，签名构建前检测会自动拦截并提示本命令；`--fix` 遇环形链接报错时按提示删除旧缓存目录后重跑 `scripts/prepare-pi-resources.sh`。

### 30. updater-script-integration 测试偶发 waitFor 超时（S1「staging 主二进制就位」）

**判定**：`apps/electron/main/test/updater-script-integration.test.ts` 的 waitFor 预算 = 30s（按 `TAIJI_WAIT_DEBUG=1` 实测耗时分布 2-6s 校准的 5x 上界，吸收系统瞬态尖峰；成本仅真死锁时失败报告晚到，成功路径立即返回）。超时错误消息携带实测等待时长，按它直接归因：贴近 30s = 系统级瞬态尖峰（hdiutil 排队/换页类外部负载），复跑即绿；数量级偏离（分钟级）= 真退化，查 hdiutil/磁盘/被测脚本变更，禁止直接放大预算。

**观测**：`TAIJI_WAIT_DEBUG=1` 打印该文件每次 waitFor 的成功耗时。

### 31. subagent 一开始就失败：`engine_prompt_not_delivered` / `engine_prompt_rejected`

**语义**：prompt response 是唯一成功回执。prompt 写入后**完全没有任何 stdout 字节（任意 chunk）**满 30s（`TAIJI_SUBAGENT_PROMPT_ACK_TIMEOUT_MS` 可覆盖）→ `engine_prompt_not_delivered`；stdin 不可用 / 写入 EPIPE → 同码（立即失败，不等 30s）；pi 回 `success:false` → `engine_prompt_rejected`（立即失败）。出现任意 stdout 字节（chunk；含未成行的 partial 数据）只取消零输出计时器并记 `prompt ack delayed` warn，**不是结算、不杀子进程**，run 继续等 prompt response。引擎层对两者都不自动重试（prompt 可能已产生副作用）；是否重跑由上层 recovery 文案决定。pi 语义锚点 = PS-81（[pi-semantics.json](pi-semantics.json)；探针 `pi-semantics-prompt-response.test.ts`——pi 升级时该断言由版本门禁复验）。

**诊断五元组**（随失败写进日志并拼入 `outcome.error`，有界）：`pid` / `bytesWritten`（stdin 已写字节）/ `stdoutBytes` / `stdoutBytesAfterPrompt`（prompt 写入后的 stdout 字节）/ `getStateAnswered`（get_state 是否已应答），另附 `lastEventType` / `stdoutSeen`。判定优先看 `stdoutBytesAfterPrompt`：为 0 = 通道彻底无响应（查引擎/pi 启动与 stdin 接线）；非 0 但无 prompt response = pi 已活跃但未受理 prompt（查 pi 侧 busy/queue/extension takeover 原因）。

**日志**：`[prompt-ack]` 由引擎进程产生，经 `host/log` 反向通道进宿主侧引擎日志（`<数据目录>/logs/` 下按 `[prompt-ack]` grep；debug 级需 `TAIJI_AGENT_DEBUG=1`/`TAIJI_AGENT_EXT_LOG`）。引擎 stderr 全量不回写 runtime 日志——失败时尾部片段随 `stderrTail` 进 `outcome.error`，以诊断五元组为主要证据。：

```bash
grep "\[prompt-ack\]" <数据目录>/logs/*.log
# prompt acked in Xms (disposition=...)      正常（debug 级）
# prompt ack delayed: ...                    有 stdout 活动，零输出计时器取消（run 继续）
# prompt not delivered (timeout): ...        零输出 30s（engine_prompt_not_delivered）
# prompt rejected by pi: ...                 success:false（engine_prompt_rejected）
# prompt delivery lost (failNow): ...        stdin 不可用 / EPIPE（同归 not_delivered）
```

**恢复动作**：按错误文案内联的 `Recovery` 重跑任务；复现时保留 `outcome.error` 的诊断摘要 + 上述日志 + `engine_open`/`engine_opened` 时间点（runtime 日志 `[subagent-control] engine opened`）。`engine_prompt_rejected` 的 pi error 文本（busy / queue / extension takeover）由 pi 侧给出，不归结为 taiji 传输故障。

### 32. 引擎 / 任务 pi 残留（组杀与启动 sweep）

**机制**：托管态下控制面裁决统一走组杀（POSIX 负 pid 进程组 + 子孙递归兜底；Windows `taskkill /PID <pid> /T /F`），信号发出即返回，真实 exit 由 child exit 事件收尾——**pid 文件只在 exit 确认后删除**；杀链失败时 pid 文件保留给下次启动 sweep。连接关闭 → 该连接全部通道 fan-out 组杀；runtime 退出 → 引擎 stdin EOF → SDK `armEngineSelfDestruct` 自灭；runtime 异常死亡 → 下次启动 `sweepOrphanEnginePids` 对 owner 已死的引擎组立即收割（pid 复用防护：现持有者启动时间晚于登记则只删记录不杀）。

**取证**：

```bash
grep "kill decision" <数据目录>/logs/runtime-*.log
# [subagent-control] kill decision action=terminate_channel channelId=... engineId=...
#   pid=... rootSessionId=... parentRecordId=... reason=...
grep "reaping orphan engine group\|removed stale control socket\|held by a live runtime" <数据目录>/logs/runtime-*.log
```

POSIX 按进程表定位（引擎 CLI 命令行含 `pi-subagent-cli`，任务 pi 为 `pi --mode rpc`）：

```bash
pgrep -fl "pi-subagent-cli"          # 引擎
pgrep -fl "pi --mode rpc"            # 任务 pi（按 recordId / session 目录核对归属）
```

Windows 等效：`tasklist /FI "PID eq <pid>"` 核对单进程；按命令行定位用 PowerShell `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*pi-subagent-cli*' } | Select-Object ProcessId,ParentProcessId,CommandLine`。

**处置**：① 先确认 owner runtime 是否仍存活（pid 文件 `<数据目录>/run/subagent-engines/*.pid` 含 `runtimePid`/`spawnedAt`）——owner 活着交给它管，owner 死则重启 taiji 触发启动 sweep；② 手工清理只在核对 `spawnedAt` 与进程启动时间一致后按进程组终止（POSIX `kill -TERM -<pgid>`，Windows `taskkill /PID <pid> /T /F`），避免 pid 复用误杀；③ 反复残留且 sweep 日志无收割行 = 按缺陷报（杀链失败会留 debug 兜底行 `group kill fallback` / `orphan kill fallback`）。

### 33. collect 域三类排查：日志有 collected 但对话流无通知 / 缺省 collect 挂满 1h / collect 一直等不到（result-collect phase 2 交付，2026-10-17 登记）

- **症状一：投递日志有 `collected` 条目、对话流却无该通知**——先判定是不是 collect 语义：`collected`（ack outcome 枚举）= 该通知随 `collect_results` 工具返回值到达 agent，**构造性不注入对话流**（双重呈现消除，ADR-0146）；对照 `delivered` = 注入对话流。判据 = 按载体与注入史区分：查该 turn 是否有 collect_results 调用、工具返回的 `collected` 数组是否含此 id。属 collect 语义 = 正常，非投递丢失；确认无 collect 调用却出现 `collected` 终局才按缺陷报（collected 只写于从未注入的挂起条目）。
- **症状二：缺省 collect 挂满 3_600_000（1h）无返回**——多为 lifetime 债权升级边沿：升级时点已存活的 managed session 的 lifetime 死亡债权键（注册于升级前、无 kind 标记）被缺省等待集计入（无到达边沿，等不到）。三条恢复路径：① agent 显式传 `ids`（目标键集合）即绕过缺省集；② 用户 ESC 中断等待（AbortSignal 正常返回，已收子集保留）；③ runtime 进程重启自愈（claims 为 runtime 内存态，重启后旧 lifetime 键重开 watch 走 fail-closed 即时注销）——managed session 死亡注销亦自愈。判据 = 缺省集含 `type:"session"` 且无 `kind:"lifetime"` 标记的旧注册条目。
- **症状三：collect 一直等不到某任务（stillOpen 直到超时）**——按「等待中与返回后同、无死因信息」的诚实行为排查三类真残余：① subagent 子进程静默死亡（无终态通知生产者）；② managed watch 应答未达（cancelled/timeout 不动 pending，等待下次 session_start 清理收尾）；③ fork 子 session 继承的父 session register（bash 域永久活跃 / subagent 域等待窗口内无注销）。处置：孤儿等待占比高（>10%）或用户可感知长挂反馈时，重审死亡类 reason 边沿接入（设计登记的重审触发条件）；个别任务确认死亡后显式传剩余 ids 续收。
- **通用取证**：投递日志（journal）条目的 `collectKey` 键集字段 + ack outcome 值；pending entries 的 register/unregister 对（`kind`/`status` 字段）；机制 SSOT = ADR-0146 + 设计档案 `.tmp/tech-design/result-collect.md` §3.1 失败路径（六形态 + [端口缺席]）。

### 34. 自装引擎包（TAIJI_AGENT_ENGINE_ROOTS / config.json engines）的发现优先级，与自装旧版包 chat 报 engine_capability_unsupported（协议 v1.x）

- **症状**：自装引擎包后 chat 请求同步报 `engine_capability_unsupported`；或多处安装同 id 引擎时「装了新版却不生效」。
- **处置建议**：同 id 引擎「后装载覆盖先装载」（生效优先级与扫描序相反：L3 config.json > L2 node_modules > L1 宿主根 > L1 env），发现顺序、包级三态与能力兜底的细节以 `packages/subagent-core/src/execution/engine/engine-discovery-scan.ts`（scanEngines）代码为准；`[engine-discovery]` 前缀宿主日志有 same-id override 留痕。旧版引擎包 capabilities 声明缺失/unsupported 时 chat 必被能力预检拒绝（错误文案含恢复指引），升级引擎包是最短恢复路径；注意与「protocol 版本不兼容」（unusable 不装载）区分。

### 35. dev 实例数据目录共享污染（R-13，已修复：受控采信）

- **症状（修复前）**：多 worktree 各自 `pnpm dev` 时，实例数据目录未按 C-dev-01 预期落在 `~/.taiji-dev/instances/<worktree>/`，而是共用同一目录（sandbox 探针插件/权限/会话互相可见，单实例锁互踢）。
- **现状**：`main.ts` dev 块经 `utils/dev-data-dir.ts` 的 `resolveDevDataDir` 受控采信——装配器注入的 `instances/<worktree>` 实例目录生效（多 worktree 并行 dev 自动隔离），树外值（泄漏形态 `~/.taiji` 等）仍固定回 `~/.taiji-dev`。
- **处置建议**：排查多实例互相污染类问题先核对实际数据目录（日志首行/`getDataDir()` 输出），不要按文档预期推定；需要干净环境时使用 `--fresh`。

### 36. e2e real 轨执行环境三坑（2026-09-19 session 导入验收实测）

- **坑① 沙箱杀子进程**：沙箱化终端（如 AI agent 的 sandbox bash）里跑 `npx playwright test <real 轨 spec>`，e2e 派生的 runtime/pi 子进程会被持续 SIGKILL（supervisor 日志呈 `exitCode 137` 循环重启、runtime 死前零错误输出、无 jetsam 系统记录）——症状是 WS reply 超时/「连接中…」卡死，极具迷惑性。**处置**：real 轨一律非沙箱执行；取证先看 `<dataDir>/logs/main-*.log` 的 supervisor restart decision 与 `log show` 查 jetsam（有 = 系统内存压力，无 = 沙箱/外部 kill）。
- **坑② bundle 陈旧分裂**：`build:e2e` 链 = main + preload + vite 三产物，**不含 build:runtime**——runtime 源码改动后直接跑 real 轨会用旧 runtime bundle，行为与源码对不上且无告警。**处置**：改过 runtime 后重跑 real 轨前先 `VITE_E2E=true pnpm run build:e2e`（会重建 runtime），或核对 `apps/electron/dist*/runtime` 产物 mtime 晚于源码最后改动。
- **坑③ mock/real 构建产物互斥覆盖**：mock 轨（`VITE_MOCK=true`）与 real 轨（`VITE_E2E=true` 不传 VITE_MOCK）写同一 renderer 产物目录，后构建者覆盖前者——mock 轨 spec 在 real bundle 下会以「UI 停空态/元素找不到」失败，real 轨 spec 在 mock bundle 下被 `assertRealRendererBundle` 检查拦截（报 mock fixture 标记）。**处置**：切换轨之前按轨重建 bundle；mock 轨的 13 个失败里若混着 real spec 的 8-38ms 秒败，属预期拦截非回归。

### 37. 终端多实例（一会话多终端）四类症状定位（2026-10-04 交付）

终端实例标识为 `term:<会话id>:<序号>`，注册表与序号分配的**唯一事实源在 runtime**（重键 `ptyMap` + 会话级计数器），界面经 `terminal.list` 对账恢复。按症状分路：

- **「开第二个终端返回的还是第一个」**：先看是**反向混跑**还是缺陷——dev 工作流里 renderer 走 Vite HMR、runtime 是 tsx **非 watch**，所以「新界面 × 旧 runtime」可真实共存；旧 runtime 会按会话幂等复用单 PTY（静默复用、无报错）。处置：重启 `pnpm dev`（runtime 侧改动不重启不生效）；打包形态无混跑窗口（界面与后台成对原子更新）。
- **「活着的死实例」**（切换条有条目、输入必得 `unknown_terminal_id`）：`spawn` 完成到界面建档之间的窗口内实例就已死亡（`terminal.exit` 帧无归属可投递）→ 残留条目。**自动回收双通道**：首次对该条目的 `write` / `kill` / `attach` 收到否定回执（`unknown_terminal_id`）即执行三路径清理；或下一次 `terminal.list` 对账（清单外条目）回收。若**反复出现且不自动消失**，取证 `<数据目录>/logs/runtime-*.log` 的 `[terminal]` 行与 `terminal.list` 返回，按缺陷报（回收通道应幂等）。
- **runtime 重启后旧终端输出消失 / 编号从「终端 1」重算**：**既定语义**（世代变更：注册表纯内存，重启即清空、序号重算；界面经世代重置清输出分区与写队列）。判据 = auth token 变化（**端口值不可靠**——重启常落回原端口）。反向异常：**同世代 WS 闪断却丢了历史** = 世代判据误判，查 `getCurrentToken()` 读侧与连接态保存的旧值。
- **应用退出后仍有终端子进程**：正常退出路径由 shutdown 序的 `dispose-terminal-pties`（`destroyAllPties`）全量清理；**异常死亡**（SIGKILL / 崩溃）下 `nohup`/disown 类子进程可能残留（已登记的前提 P5，属 OS 层行为）——按系统进程表定位后手动清理。

### 38. e2e smoke 全灭 `electron.launch: Process failed to launch`（宿主会话 ELECTRON_RUN_AS_NODE 泄漏，2026-10-01）

- **症状**：`npx playwright test --project=electron-smoke` 全部用例秒级失败（40-60ms），报 `electron.launch: Process failed to launch!` + `bad option: --remote-debugging-port=0`（或 `--inspect=0`）+ 清理期 `kill EPERM`；同窗口内 `--project=visual-chromium`（纯 chromium，不经 electron.launch）正常。
- **根因**：执行环境泄漏 `ELECTRON_RUN_AS_NODE=1`（taiji 桌面宿主 spawn 的 agent 会话可见）。该变量使 Electron 主二进制按纯 Node 运行——chromium/Electron 专属旗标全部不识别（`bad option`）即退出。**误诊陷阱**：此形态下 `Electron --version` 打印的是内嵌 Node 版本（42.x 内嵌 Node 24.15.0）而非 Electron 版本；且 Electron 42 mac 主二进制本就是 ~50KB 薄启动器（重量在 Frameworks）——「二进制只有 33KB/版本号不对 = dist 坏了」是泄漏导致的误诊，勿据此重装缓存（本次误删 @electron/get 缓存 zip 一份，无害但浪费一轮下载）。
- **处置**：e2e/验收执行环境 `unset ELECTRON_RUN_AS_NODE` 再跑（Gate A 脚本与 A6 剧本已内建防御）；排查入口 `env | grep ELECTRON`。

### 39. dev-merge 自动创建的 worktree 解析成 bare repo（config.worktree 缺失，2026-10-01）

- **症状**：dev-merge.sh 自动创建目标 dev worktree 后，merge 预检报 `致命错误：该操作必须在一个工作区中运行`，且被误报成「有未提交改动（tracked）」；`git -C <dev> rev-parse --is-bare-repository` 返回 `true`。
- **根因**：共享 config `core.bare=true`（bare repo + worktree 布局）下，worktree 依赖 per-worktree `config.worktree`（`core.bare=false` + `core.hooksPath`）覆盖。该补写是 git-cwt 包装层（`~/.shell/07-git-ws.sh`，[2026-09-11] 同族注释）的职责，`create-worktree.sh` 与 `setup-worktree.sh` 都不做——dev-merge.sh 绕过包装层直调创建脚本即漏。已修（auto-create 后补写 worktree 级 config；check_clean 区分 git 失败 exit≥2 与真脏）。
- **连带发现**：`.bare/custom-hooks/setup-worktree.sh` 曾丢失可执行位（`[ -x ]` 为假 → 项目 hook 被静默跳过，依赖安装与 Electron/pi 缓存链接全缺）。已 `chmod +x` 根治；症状 = 创建输出无「执行项目 setup hook」行且新 worktree 无 node_modules。
- **处置**：现症修复 = `git --git-dir=<.bare/worktrees/<name>> config --worktree core.bare false` + `core.hooksPath <同目录>/hooks`，再补跑 `bash .bare/custom-hooks/setup-worktree.sh <worktree路径>`。

### 40. workflow 脚本 / agent frontmatter 显式指定的模型没生效（被用户覆盖压过——合法行为，非解析回归）

- **症状**：workflow 脚本的 run 级 `model` 参数、`agent()` 调用参数或 agent frontmatter 显式写了模型，实际执行却用了另一个模型（面板/命令切换过的模型）。
- **机制**：subagent/workflow 执行域的模型解析链有第 0 层「用户覆盖」——用户经面板模型选择器或 `/subagent-model` 命令对某 subagent 会话 / workflow run 下达过实时切换后，覆盖值优先级最高（压过 frontmatter 与脚本/调用参数显式指定，用户覆盖赢）；覆盖作用域 = 该会话/run 的剩余执行（含中断后 resume 与主 agent 重启后重开）。机制 SSOT：ADR-0129；术语见 docs/CONTEXT.md「模型覆盖」词条。
- **三步排查**：
  1. **查覆盖记账在场**：workflow run → run 事件 journal（`<数据目录>` 下 workflow-state 的 `<runId>.record.jsonl` 文件）grep `model-override` 帧；chat 域 subagent → record 事件文件 grep `record-model-override` 帧。覆盖帧在场 = 用户覆盖赢生效，属预期行为而非 bug。
  2. **resume 场景查生效值**：journal 的 `run-resumed` 事件携带生效模型——三档回落：resume 显式参数（协议预留）> 持久化覆盖记录 > run 创建时模型。
  3. **查成员实际执行模型**：成员 pi session 文件的 `model_change` 条目序列（尾条目 = 当前实际使用模型，审计权威）。
- **处置**：需要脚本显式模型赢时，对该目标再次切换即可（覆盖替换幂等——新覆盖值压旧值，不存在叠加）；确认从未切换过而模型仍不符预期，才按模型解析回归排查（三层解析：调用参数 > frontmatter > ctxModel）。
### 41. 新建 worktree 基线落后 main：幽灵 remote-tracking ref（origin/* 残留镜像，2026-10-20 事故）

**症状**：从 landing 页创建 worktree（base 选 `origin/main` 或默认），新分支起点落后本地 main 几百个提交；`git rev-parse --verify origin/main` 却能通过（ref 存在）。

**判定**：`refs/remotes/origin/*` 的更新通道有且只有「名为 origin 的远端被 fetch」——`git remote` 清单里没有 origin（如 bare workspace 远端叫别的名字）时，这组 ref 是外部工具（git-cwt 兼容镜像等）抄写后冻结的死数据。两查：

```bash
git -C <repo> remote                          # 清单里没有 'origin' 即中招
git -C <repo> for-each-ref refs/remotes/origin --format='%(refname) %(objectname:short)'
```

runtime 侧防护（2026-10-20 落地）：默认 base 不再硬编码 `origin/main`，按 `git remote` 实况动态推导（checkout.defaultRemote → origin → 单一远端 → 清单首个；无远端用本地 main，实现 `packages/runtime/src/services/worktree/default-base-resolver.ts`）；显式传 `<remote>/<branch>` 时若远端未配置且 ref 落在 `refs/remotes/` 下会拒绝采信（RT-8#8 warn 留痕 + fallback 推导默认）；打开仓库（workspace.record）后台 fetch 默认远端保新鲜。

**恢复动作**（清理残留 refs，卫生性修复）：

```bash
git -C <barePath> for-each-ref --format='%(refname)' refs/remotes/origin | xargs -n1 git -C <barePath> update-ref -d
```

已受害的分支用 `git merge main` 补齐（快进或常规合并均可）。
### 33. LLM 网络代理分流失效：配了代理规则的服务商仍直连失败（pi 升级后高发）

**症状**：settings「网络代理」页已启用并配置规则，但命中规则的服务商请求仍不走代理（或代理软件侧无新 CONNECT 隧道）；典型触发时点 = pi 版本升级后（分流依赖两个 pi/Node 未承诺前提：上游 SDK 默认 fetch 运行时读 `globalThis.fetch`；外部 undici 包 `setGlobalDispatcher` 写入的槽与 Node 内置 fetch 读取的槽一致——任一被升级打破即静默失效）。

**判定**（按顺序，先机器后人工）：

```bash
node scripts/network-proxy-drift-probe.mjs   # 分流前提探针：PASS/FAIL 结论行 + 原因
```

- 探针 **PASS**（mock 代理记录到 CONNECT 且 mock 回复可解）= 槽共享前提完好（探针只覆盖这一项；「上游 SDK 默认 fetch 运行时读 globalThis.fetch」另一前提不在探针覆盖内，由验收场景 1 全链路断言承载）——两前提均完好而分流仍失效时才转配置/代理软件侧排查 → 走 settings「网络代理」页「测试连接」两段归因：第一段「代理不可达（连接被拒绝/超时）」= 代理服务器没起或地址/端口错（恢复指引：启动代理软件，或关闭网络代理开关恢复直连）；第二段「代理可达但经代理出站失败」= 代理出口到目标服务商不通（恢复指引：检查代理出口网络或核对规则）。
- 探针 **FAIL** = 机制层前提被 pi/Node 升级打破（子进程回复为空 / mock 代理记录为空，记录为空特指请求绕过代理直连——槽共享失效）→ 按升级处置评估修复（extension bundle 内 undici 升至与 pi 内嵌同 major，或改复用宿主 undici 实例）；用户侧暂回退 = 关闭网络代理开关恢复直连（P2 一键禁用即恢复）。
- socks5 协议形态构造失败（undici `Socks5ProxyAgent` 实验性 API 变化）：extension 记 error、不安装分流器、全部直连——查 extension 日志（`<agentDir>/logs/`，dev 为 `~/.taiji-dev/instances/<worktree>/agent/logs/`）中的错误文案（含恢复动作），核对协议字段与代理端口（socks5 端口误填 http 服务会以「经代理出站失败」呈现）。
- 配置文件问题（手改坏 JSON / 字段非法）：extension 校验失败同样不安装分流器全直连，配置 SSOT = `<piAgentDir>/config/network-proxy-ext-config.json`；改正配置自下一轮对话（turn）起生效。

**机制背景**：分流器安装 / 匹配语义 / 未命中委托的现行决策登记见 [docs/adr/decisions.md](adr/decisions.md) ADR-0147~0150；验收工具（mock 代理 / SOCKS5）用法见 `scripts/network-proxy-mocks/` 各脚本头注；漂移探针用法见 `scripts/network-proxy-drift-probe.mjs` 头注。

## 环境变量速查

| 变量 | 用途 | 生产默认值 | 开发默认值 |
|------|------|-----------|------------|
| `TAIJI_AGENT_DATA_DIR` | 数据目录 | `~/.taiji` | `~/.taiji-dev/instances/<worktree>`（装配器注入、树内受控采信；树外值固定 `~/.taiji-dev`） |
| `TAIJI_AGENT_PORT_OFFSET` | 端口偏移 | `0` | `100` |
| `TAIJI_AGENT_PACKAGED` | 打包标记 | `1` | 未设置 |
| `ELECTRON_RUN_AS_NODE` | Node 模式 | `1`（runtime 子进程） | 未设置 |
| `VITE_MOCK=true` | Mock 模式 | — | 可选 |
| `TAIJI_RUNTIME_BASH_RPC_TIMEOUT_MS` | bash RPC 超时逃生门（0=不限时） | 未设置（默认 1h） | 可选 |
| `TAIJI_SUBAGENT_SETTLED_WATCHDOG_MS` | settled-watchdog 收尾段/两段全关（≤0 会连带关闭 workflow no-progress 熔断，见 §12 ③） | 未设置 | 可选 |

> 注意：`TAIJI_RUNTIME_BASH_RPC_TIMEOUT_MS` 在 runtime 进程生命周期内**读一次即缓存**（`rpc-client.ts` resolveBashRpcTimeoutMs——中途改 env 不生效且无提示，超时决策须进程内稳定）。改后必须重启应用/`pnpm dev` 才生效。

## 历史排查规则 [HISTORICAL]（从 AGENTS.md 外移 2026-08-17）

### git status untracked 目录展开

`git status` **必须带 `--untracked-files=all`（`-uall`）**：默认把 untracked 目录折叠成带尾斜杠的单行，与文件树 `FileNode.path` 失配 → overlay key 查不到 → 目录徽章误显、子文件无角标。载体：`packages/runtime/src/services/git/git-state-service.ts`（getStatus）；测试基线：`git-state-service.test.ts` 断言命令参数。

### 禁止写死项目绝对路径

runtime 代码禁止出现特定项目的绝对路径或硬编码假设：workspace 根 / bare repo 经 `WorkspaceDetector.detect(currentCwd)` 向上查找 `.bare` 推导；数据目录经 `getDataDir()` / `getConfigDir()`（`packages/shared/src/paths.ts`）。检查：`grep -rnE "/Users/|/home/[a-z]|<本机 workspace 目录名>" packages/runtime/src/` 不得在逻辑代码中出现（前两个模式查任意用户绝对路径，第三个按本机实际 workspace 目录名填入）。关联教训：git 跟踪的脚本默认无 x 位，执行外部脚本用 `spawn('bash', [scriptPath, ...args])` 包装（直接 spawn 会 EACCES）。

### 跨层机制排查必须穷尽所有层（pi extension ↔ taiji runtime）

分层架构里每层只看自己视角，「我这层没做」≠「没发生」。涉及 pi extension ↔ runtime 的跨层机制排查，必须穷尽所有可能发起方：① runtime 侧（event-interpreter / session-service / message-dispatcher）常只是旁观转发；② pi 进程内的 extension 机制（开发期源码在 `extensions/`，用户机器运行时在 `~/.taiji/npm/node_modules/@zhushanwen/pi-*/src/`）；③ pi 私有协议语义见 `packages/shared/src/message.ts` 注释；④ 设计文档见 `docs/extensions/extension-conventions.md`。判断依据：涉及 pi 的 session loop / turn 调度 / LLM 调用的行为，发起方几乎一定在 pi 进程内。当用户领域知识与排查结论冲突时，**优先怀疑排查范围不全**，而非怀疑用户（事故：explorer 只看 runtime 侧就断言「background subagent 完成后主 agent 不续跑」，真相是 pi 进程内 extension 发起续跑）。

### 模型名大小写漂移致 429（2026-08-27 事故 A）

已并入上方「pi 行为观察项 #6（PS-01）」——机制、排查路径与预防以该条目为准。

### 共享 pre-commit hook 被旧版 install-hooks.sh 覆盖（2026-09-04 复发两次）

bare repo + worktree 结构下，`.bare/hooks/pre-commit` 是全部 worktree 共享的运行时副本，任一旧分支 worktree 跑 `pnpm install` 都会用其分支旧版源无条件覆盖共享副本（护栏段静默消失）。检测：`grep -c 'UNSAFE_STREAM_CHECKER=' <bare>/hooks/pre-commit`（结果 0 即被旧源覆盖）。恢复：在含最新护栏段（≥ 4ecea728f）的 worktree 跑 `bash .githooks/install-hooks.sh`。根治：旧 worktree 分支更新到含护栏段基线；CI invariant 在本地失效窗口期兜底。

### 本地 tag 污染与 GitCode 镜像全量拒收（2026-09-07 v0.9.14 发布事故）

两层叠加：① 镜像 push 时 `refs/remotes/github/HEAD` symref 被 refspec 展开成 `refs/heads/HEAD`，GitCode 判 HEAD 为保留关键字，pre-receive 一票否决整个 push（报错不指向真凶）；② `git fetch upstream`（pi-mono）的 tag auto-follow 把 285 个上游 tag 拉进本地，污染注入镜像。防线已落地：镜像脚本 tags 走独立命名空间 + push 前删 HEAD symref + 推后逐条比对引用集（`scripts/gitcode-release-sync.mjs`）+ 上游 auto-follow 已断（`remote.upstream.tagOpt=--no-tags`）。本地 tag 自愈：`git fetch github --force --prune --prune-tags`。排障提示：GitCode 报 `pre-receive hook declined` 且无 `remote:` 详情时，先二分 refspec 找被拒引用，不要当瞬时故障重试。

### 归因排障默认优先序：读日志 → 代码定界 → 对照实验（2026-09-12 基线实验教训）

症状跨多个候选改动窗口需归因时，**默认按固定优先序推进，禁止跳级上对照实验**：① **读日志**（subagent 镜像日志 / `<dataDir>/logs/` / pi 会话 jsonl / 引擎 stdout——现有日志常已含断点位置）；② **代码定界**（`git log`/`git blame` 圈嫌疑窗口，2 分钟级成本，能直接否决错误线索）；③ **对照实验**仅当①②穷尽、且两个候选的修复路径真实分叉时启动。两条核心教训：归因标签与修复动作解耦时实验无价值（最终都要修最新代码）；实验判据本身未经校验时，实验连归因都给不了。

### 周期轮询/兜底定时器的合法性判定（2026-08-28）

新增任何周期定时器（setInterval / 递归 setTimeout 循环 / 轮询兜底）前，必须按下表归类并回答该类的问题；处置登记与外部对照证据见 [architecture/pi-boundary-reliability.md 附录 C](architecture/pi-boundary-reliability.md#附录-c轮询定时器处置全清单2026-08-28d9-执行登记)。**判定原则：变化时对方会主动 push 的信息，禁止用周期 pull 兜底**——兜底轮询会掩盖主链路 bug（事故 B 的 30s 轮询就让「回执丢失」隐性存在了很久）。

| 类 | 判据 | 规则 | 实例 |
|---|---|---|---|
| ① 自有状态对账 | 状态变化 100% 经由自身请求/事件路径 | **禁止周期轮询**。主链路 = 回执 + 事件失效；周期 pull 会掩盖主链路 bug | thinkingLevel 30s 轮询（已随设计定案删除，附录 C.4） |
| ② 活性探测 | 对端死掉/卡死时无法自报 | 允许，但**优先升级式触发**（事件静默超时 / 请求失败再探），无条件周期须论证 | pingPi 60s、WS 15s ping+45s watchdog、Electron 30s /health |
| ③ 外部世界 | 数据源在外部、无 push 通道 | 允许轮询；频率 = 外部约束（API 限额 / 下游缓存 TTL），不做无依据加密 | 应用更新检查（GitHub + GitCode 双源，全源限流退避——rateLimited = 全部源均在退避窗口才报；周期 60min 不变） |
| ④ 空转 | 有 push 通道仍轮询，或产出数据无消费者 | **删除或事件化** | plugin-host 30s memory monitor（lastActiveAt 只写不读，已删）、handoff 2s 轮询（onExit 多播化后已事件化） |

新增定时器必须自答三个问题（写进代码注释）：**这个信息会变吗？变的时候对方为什么不 push？轮询周期掩盖的是什么主链路缺口？** 答不出第三个问题 = 该定时器在代偿某个未修的主链路 bug，先修主链路。

历史锚点：2026-08-28 D9 处置前全仓 12 处常规定时机制，经 ZCode / deepseek-harness / opencode 源码对照后 5 项当日删减或降频、1 项定案删除——「兜底轮询保平安」哲学被实证推翻，外部实现靠「被动信号 + 有界预算 + 便宜重建」达到同等可靠性。

## pi 行为观察项（未验证风险登记，2026-08-20 pi-assumption-remediation W6）

pi 升级（`PI_VERSION` bump）或触碰相关模块时逐条重验；锚点均为实装版（当前 0.84.4，核对方式见 AGENTS.md pi 段查阅规则）。来源：审计报告 A/B（`.taiji-harness/2026-08-19-pi-assumption-audit/`）。

**机器登记互链（2026-08-28 pi-boundary-reliability）**：本节是人读处置层，带 PS 编号的条目对应 [docs/pi-semantics.json](pi-semantics.json) 的 PS-xx 条目（唯一机器源：probe 型配探针测试，observe 型即本节处置建议；无 PS 编号的条目 = 机器登记层尚未收录的观察，登记留待后续）；pi 升级时 `node scripts/check-pi-semantics.mjs`（pre-commit + CI）自动门禁版本漂移。机制描述不双写——语义断言与 pi 锚点的权威源是 json，本节只留处置建议。

### 1. F8：subagent-workflow SIGINT re-raise 在 pi 挂起窗口可能失效（PS-13）

- **pi 锚点**：`modes/interactive/interactive-mode.js:3193-3223`（handleCtrlZ 挂起期间注册空 `ignoreSigint`，SIGCONT 才移除）
- **机制**：`extensions/subagent-workflow/src/index.ts:654-680` 的 sigintHandler 收割后 re-raise SIGINT，依据「移除自身后无其他 SIGINT listener（pi 不注册）→ 默认终止」。该断言在 interactive 挂起（Ctrl-Z suspend）窗口不成立——re-raise 的 SIGINT 被 pi 的 `ignoreSigint` 吞掉，进程不死且本 extension listener 已移除，Ctrl+C 永久失效（直到 SIGCONT）
- **触发条件**：本地 pi CLI interactive 模式 + subagent-workflow extension 激活 + 进程挂起态（suspend to background）收到 SIGINT。taiji 桌面链路不走这条（runtime supervisor 用 SIGTERM，pi rpc-mode 自带 SIGTERM handler）
- **处置建议**：re-raise 前检查 `process.listenerCount("SIGINT")`，移除自身后仍 >0 时不依赖默认终止，改用 `process.exit(exitCode)` 兜底。升级 pi 后若 interactive 模式信号处理有变，重测 Ctrl-Z 挂起 + Ctrl-C 组合

### 2. F10：jsonl-run-store「首写立即可见」在 pi 延迟首写窗口内不成立（PS-14）

- **症状**：全新 session + 首条 assistant 产出前进程 crash 的窗口内，run entry 只在内存、盘上无文件（pi 延迟首写：首条 assistant 到达才创建并 flush session 文件）
- **处置建议**：现有兜底已生效——读序 entry > state 文件 > 空，crash 恢复仍可发现 run，无需改动。升级 pi 时核对延迟首写分支是否仍在，pi 改为立即落盘则本条可关闭。机制与「禁止在首次 flush 前创建/触碰 session 文件」防线见约束 C-pi-08（`docs/constraints.json`）与 `packages/runtime/src/infra/pi/session-file-utils.ts` 注释

### 3. U1：pi-ai/compat 入口是上游自声明的临时模块（时间炸弹）（PS-15）

- **pi 锚点**：`pi-ai dist/compat.js` 头注释——"This module is deleted with the coding-agent ModelManager migration"（随 coding-agent ModelManager 迁移完成而删除）
- **机制**：`extensions/shared/llm-shared/src/call.ts:16-20` 顶层静态 `import { completeSimple, ... } from "@earendil-works/pi-ai/compat"`。上游删除该入口后加载期即炸，波及所有经 llm-shared 调 LLM 的 pi-* extension（goal / scheduler / structured-output 等）
- **触发条件**：升级到「ModelManager 迁移完成」版本的 pi-ai（无明确时间表，以 changelog / package.json exports 为准）
- **处置建议**：每次 pi 升级 PR 必查两项——`node -e "require.resolve('@earendil-works/pi-ai/package.json')"` 的 exports 是否仍含 `./compat`、pi-ai changelog 是否提及 ModelManager 迁移；命中时将 llm-shared 迁移到新 API（`createModels()` + provider factories），迁移前禁止发布依赖旧入口的 extension 版本

### 4. thinking 档位按模型族钳制且 pi 静默（final gate P2，2026-08-20）（PS-12）

- **pi 锚点**：`pi-ai models.js clampThinkingLevel`（不支持的档就近回落）；`types.d.ts:257`「xhigh/max 仅部分模型族支持」；`agent-session.js setThinkingLevel` 钳制后 isChanging=false → 不写 entry 不发事件
- **机制**：UI 思考档全集（off~max 7 档，W2 SSOT）对所有模型一视同仁——mimo 族实际止于 high，选「最高(max)」被 pi 钳到 high，用户无感知实际生效档位。reply/缓存已改回生效值（P3 修复），剩余缺口在 UI 侧无「该模型最高支持 X」提示
- **触发条件**：模型族 supported levels 不含所选档（mimo 族 + xhigh/max；其他族见 `get_available_thinking_levels` RPC）
- **处置建议**：UI 侧调 `get_available_thinking_levels`（按当前模型过滤档位或禁用置灰 + 提示），需要时立项。**2026-08-28 更新**：档位可用集已由能力注册表结构性解决（C-pi-12：runtime 经 pi-ai 同源函数算 supportedLevels 下发，前端零推导；探针断言见 PS-12 条目）

### 5. fork 路径 spawn 仍可能带 --model 压过 fork 源模型终态（P1 同族，final gate 观察项）（PS-16）

- **机制**：restoreSession 已改 `inheritSessionModel: true`（P1 修复，模型终态由 pi 从 model_change entry 恢复）；forkSession 的 createSession 仍透传 presetClientOptions.model——fork 文件内若含 model_change entry（截断点之前有切换记录），附着后被 preset model（或全局默认兜底）压过，分叉会话模型 ≠ 源会话模型
- **触发条件**：fork 一个会话内切换过模型的 session（截断点在 model_change entry 之后）
- **处置建议**：与 P1 修复方向相同（fork 附着路径设 inheritSessionModel），但 fork 语义「launch 配置 vs 源终态谁优先」需产品裁决，且截断点早于首条 model_change 时无 entry 可恢复——登记待裁决，未随 P1 一并修（gate 只实证了 restore 路径）

### 6. `--model` 是 pattern 非精确 ID：大小写/包含匹配可静默换模（PS-01，2026-08-27 事故 A）

- **pi 锚点**：`dist/cli/args.js:245`（help 自述 "Model pattern or ID"）；`dist/core/model-resolver.js` findExactModelReferenceMatch（id 匹配为 toLowerCase 相等，canonical 双命中判歧义作废）→ 无 exact 命中时 contains 模糊 → `localeCompare` 降序取最大
- **机制**：「扩展层校验通过」不代表「子进程按此 id 执行」——两套匹配规则互不知晓；models-store 远端目录周期刷新（PS-11）引入大小写变体家族后，昨日全等命中的串今日可掉进模糊分支命中无权限模型 → 429 无权限空转（表象：「昨天能用的模型今天 429」）
- **触发条件**：派发用非全等 id + 合并清单含大小写家族条目
- **处置建议**：已由切片 1 全等裁决结构性拦截（`assertCanonicalModelRef`，start 同步期拒单 + 问句式纠错）；新扩展拼 `--model` 必须经 shared/model-ref.ts（G4 通道禁则拦裸串，`check_subagent_channels.py` 拦截）；探针断言见 pi-semantics-model-resolution.test.ts。排查路径：查 `<agentDir>/models-store.json` 的 mtime/大小写变体家族新增条目

### 7. reasoning 是思考能力总开关，缺失即「仅关」（PS-02，2026-08-27 事故 B）

- **pi 锚点**：`pi-ai dist/models.js:548-558`——getSupportedThinkingLevels 在 `!model.reasoning`（含 undefined）时直接返回 `["off"]`，thinkingLevelMap 仅在开关打开后参与档位计算
- **机制**：同一字段缺失两侧语义相反——pi 解释 undefined 为「关」，历史上前端 resolveAvailableLevels 解释为「支持全档」；GUI 手动添加模型若无 reasoning 字段，思考等级设置恒被钳回 off（用户表象：「设了最高过一会自动变关」，实际从第一毫秒起就是关）
- **处置建议**：已由能力注册表结构性消除（C-pi-12）——禁止任何域内代码复活「本地推断档位」
- **存量恢复（失败模式 D，2026-09-10 用户数据实测）**：修复前经 discover 合并 / 行级策略写入的模型，models.json 里 `reasoning` 字段可能缺失（pi 判「关」，弹层只剩「关」）。无需迁移脚本，两条路径任选——① GUI：在 Settings → Providers 编辑体里对该模型行重新设置一次思考策略（**含 all-levels**），保存即救回（`pickStrategy` 联动补显式 `reasoning: true` 并重写 thinkingLevelMap）；② 手动：在 `~/.taiji/agent/models.json` 该模型条目补 `"reasoning": true`，重启应用后生效。判据：composer 的思考档位弹层不再只显示「关」

### 8. set_thinking_level RPC 响应无 data，生效值须补读（PS-03，2026-08-27 事故 B）

- **pi 锚点**：`dist/modes/rpc/rpc-mode.js:387-389`——set_thinking_level 分支 `session.setThinkingLevel(command.level)` 后 return success 无第三参
- **机制**：改状态 RPC 的返回不含生效值；pi 钳制档位时请求值 ≠ 生效值，读不到生效值就是显示假值（事故 B 的回执断在最后一跳）
- **处置建议**：runtime 的 set→get_state→effective 回执链是唯一正确姿势（已实装）；已登记 C-pi-13（改状态 RPC 一律回生效值，消费方禁乐观写请求值）

### 9. steer / nextTurn 是 at-most-once 内存队列，消费窗极窄（PS-05/06，2026-08-27 事故 A）

- **pi 锚点**：`pi-agent-core dist/agent.js:321/:243`（steeringQueue 全文仅 2 个 drain 点：run 轮询 getSteeringMessages / 手动 continue()，run 收尾后无补触发）；`dist/core/agent-session.js` `_pendingNextTurnMessages` 唯一 drain 点 = 用户驱动 prompt()（注入后立即清空）
- **机制**：投递内核重试的是「send 函数调用」而非「消息进入主会话」这一事实——依赖它们发终态通知 = 基线 session 十余次完成仅 1 次送达（事故 A 实测）
- **处置建议**：结果语义通知必须走确认式送达（C-ext-19：session-delivery 账本 + 幂等键，at-least-once）；steer/followUp 仅限交互式注入（非结果语义）；探针断言见 pi-semantics-steering-drain / agent-session.test.ts

### 10. settled 事件先复位再广播：边沿回调内 isIdle 恒真（PS-07）

- **pi 锚点**：`dist/core/agent-session.js:325-336`——`_emitAgentSettled` 首行复位 `_isAgentRunActive = false` 再发 agent_settled 事件
- **机制**：settled 边沿驱动的通知通道不会撞上残留 busy 态——delivery-port 的注入链与文本车道对账器的 settled 边沿重投依赖此序；若 pi 未来调换次序，注入/重投时序需重验
- **处置建议**：探针检查（pi-semantics-agent-session.test.ts）；消费 settled 边沿的新代码可假定回调内 idle，但 pi 升级时此条目自动进重验清单（verifiedWith 门禁）

### 11. plain appendEntry（type=custom）不进 LLM 上下文（PS-09）

- **pi 锚点**：`dist/core/session-manager.js:165-186`——sessionEntryToContextMessages 仅映射 message/custom_message/branch_summary/compaction，兜底返回 `[]`
- **机制**：appendEntry 写的 custom entry 是持久化状态记录，AI 看不到；想让 AI 看到必须走 custom_message（sendCustomMessage）或 sendUserMessage
- **处置建议**：这正是 extension 日志规范选 appendEntry 做「事后排查」通道的技术依据（不耗 token，见 logging-conventions.md）；反向地，靠 appendEntry「通知 AI」的代码是 bug——结果语义通知走账本 courier（C-ext-19）

### 12. chat 轮 cancel 后子进程退出原因呈 exit code 143 而非 signal SIGTERM（协议 v1.x）[HISTORICAL]

> 2026-09 H1 后 chat 域整族退役（续聊轮 = 新 run + resume 锚点，见 §12 头注），原锚点与 `engine_round_aborted`/`engine_round_crashed` 错误码在现树 grep 恒零命中是预期。

- **机制**：pi rpc-mode 对 SIGTERM 的 trap 是优雅收尾后自行 `process.exit(143)`（`dist/modes/rpc/rpc-mode.js` trap 段）——子进程以主动 exit 结束，OS 层无信号终止事件，宿主只能拿到 (143, null)。该语义仍适用 run 链任务子进程（观察对象 `packages/pi-subagent-cli/src/spawn-runner.ts`）
- **处置**：无需修复；判读时注意「引擎进程被信号杀死」（呈 `signal SIGTERM`）与「pi 收到 SIGTERM 自行退出」（呈 exit 143）的形态差异，比对事故取证时不要误判

### 14. closedReason:"gc" 是统一终态占位，不是故障（2026-08-27 事故 A）

- **机制**：pi 的 session close 事件把 done/failed/crashed 等全部终态统一改写为 `closed + closedReason:"gc"`——"gc" 是「非用户主动关闭」的占位终态，不代表垃圾回收、不代表异常
- **处置建议**：看到它先别当故障查——**看 outcome 字段**（completed / failed / cancelled 一等字段）判成败，禁止对 closedReason 做 switch 推导（历史上下游三处同构各自重新推导成败，是「写入时合并终态、丢失区分度」问题类的温床）；若消费方还在读 closedReason 判成败，改为消费 outcome。（暂无 PS 互链：机器登记层未收录该语义锚点，补登记留待后续）

### 17. pi openai-completions 适配层对「缺 usage 的错误响应」崩坏（2026-09-19 导入验收发现，上游健壮性问题，既有未修）

- **症状**：续聊大上下文会话（实测 230K tokens）时 assistant 恒定 `stopReason=error`：`undefined is not an object (evaluating 'usage.totalTokens')`，秒级失败（上游 100ms 即拒）。
- **机制**：provider 上游渠道对超窗口请求返回**不含 usage 字段**的错误响应，pi openai-completions 适配层解析时未对 usage 缺失做防御。凭据/通路无问题（同 provider 小上下文请求成功）。
- **处置建议**：先排除渠道窗口限制（换小会话/先 compact 压缩再续聊）；根治需 pi 适配层对缺 usage 错误响应健壮降级——pi 上游问题按项目规则不改 pi 源码，待上游修复或由 taiji 侧降级链吸收。

