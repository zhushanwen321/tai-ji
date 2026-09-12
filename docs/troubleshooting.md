# xyz-agent 问题排查

Runtime 日志落盘到 `<数据目录>/logs/`（`runtime-YYYY-MM-DD.log`，按天轮转 + 大小滚动），pi 子进程 stdout 的 JSONL 事件流独立落盘为 `pi-<date>-<sessionId>.jsonl`（pi 卡死类问题的决定性证据）。console 输出同步 tee 到终端。以下是各层的日志获取方式。

## 日志获取

| 层级 | 开发模式 | 打包模式 |
|------|---------|---------|
| **Electron 主进程** | 终端直接看 | 终端启动 `/Applications/太极.app/Contents/MacOS/TaiJi` 或 `log show --process TaiJi` |
| **Runtime** | 终端 `[runtime:out]` / `[runtime:err]` 前缀 + `~/.xyz-agent-dev/logs/runtime-*.log` | 同主进程转发 + `~/.xyz-agent/logs/runtime-*.log` |
| **pi 子进程** | 终端 pi 自身输出 + `~/.xyz-agent-dev/logs/pi-<date>-<sessionId>.jsonl` | `~/.xyz-agent/logs/pi-<date>-<sessionId>.jsonl` + pi 日志目录 `~/.xyz-agent/agent/logs/` |
| **升级子系统** | `~/.xyz-agent-dev/update/update-error.log`（JSONL 512KB×2 轮转；失败登记含 errorCode/rawCause/engine/releaseSource，成功登记 source-selection/source-failover/download-success） | `~/.xyz-agent/update/update-error.log`（同左） |
| **前端 DevTools** | Cmd+Option+I 打开 | 同左 |

**打包模式启动应用获取完整日志**：

```bash
# 方法 1：终端启动（推荐，直接看到所有 console 输出）
/Applications/太极.app/Contents/MacOS/TaiJi

# 方法 2：macOS 系统日志（过滤 TaiJi 和 runtime 子进程）
log stream --predicate 'process == "TaiJi"' --level debug

# 方法 3：Console.app → 搜索 TaiJi
```

## 关键诊断路径

**打包后应用结构** (`/Applications/太极.app/Contents/Resources/`)：

```
Resources/
├── app.asar.unpacked/dist/runtime/   # runtime bundle（必须在 unpacked 目录）
│   ├── index.cjs                      # runtime 入口
│   └── plugin-bootstrap.cjs           # plugin Worker 入口
├── pi/                                # bundled pi 二进制 + agent 资源
│   ├── pi-darwin-arm64                # pi 可执行文件
│   ├── agent/                         # agent skills/extensions
│   └── assets/                        # agent 资源文件
├── extensions/                        # builtin pi extensions
│   └── @zhushanwen/<pkg>/             # 18 个 @zhushanwen/pi-*（esbuild bundle 产物）
└── bin/xyz-settings                   # xyz-settings CLI（pi Skill 引用）
```

> **注**：builtin pi extensions（18 个 `@zhushanwen/pi-*`，数量与分组以 `packages/shared/src/mandatory-extensions.json` 为 SSOT）随应用打包内置在 `Resources/extensions/@zhushanwen/` 下，离线可用、无需安装。其中 infrastructure 级 6 个（`pi-pending-notifications` / `pi-session-reader` / `pi-structured-output` / `pi-agent-ext` / `pi-system-prompt` / `pi-msg-id-mapper`）不可禁用，feature 级可在 Settings → Extensions 中禁用/启用。第三方扩展（任意 npm 包 / 本地目录 / git）经 Settings → Extensions 安装到数据目录。

**数据目录** (`~/.xyz-agent/`)：

```
~/.xyz-agent/
├── config.json           # 运行时配置（API key 等）
├── config.toml           # pi 配置
├── runtime.port          # runtime 端口号（文本文件）
├── session-data/         # session 持久化数据
├── agent/logs/          # pi 日志（extension-logger 写 <agentDir>/logs/，agentDir = <dataDir>/agent）
├── plugins/              # 插件数据
└── update/               # 升级子系统（update-error.log 登记 + manual/ 手动认领目录：断网逃生通道，name+size+sha256 三重校验）
```

**开发模式差异**：数据目录 `~/.xyz-agent-dev/`，端口 +100（3310-3320），Electron userData 隔离。

## 常见问题排查清单

### 1. pi 启动失败："Failed to start bundled pi process"

```bash
# 检查 pi 二进制是否存在
ls -la /Applications/太极.app/Contents/Resources/pi/pi-darwin-*

# 检查 pi 二进制是否可执行
file /Applications/太极.app/Contents/Resources/pi/pi-darwin-arm64
chmod +x /Applications/太极.app/Contents/Resources/pi/pi-darwin-arm64  # 如果权限丢失

# 检查是否架构不匹配（Intel Mac 上只有 arm64 二进制）
uname -m  # arm64 还是 x86_64

# 终端启动看完整错误
/Applications/太极.app/Contents/MacOS/TaiJi
```

常见原因：
- pi 二进制缺失（打包时 `extraResources` 配置错误或 `resources/pi/` 内容不完整）
- 权限丢失（`chmod +x`）
- 架构不匹配（Intel Mac 安装了 arm64-only DMG）
- symlink 问题（`resources/pi/` 中有指向外部绝对路径的 symlink，打包后目标不存在）

### 2. Runtime 启动失败："Runtime bundle not found" 或 "Runtime health check timed out"

```bash
# 检查 runtime bundle 是否存在于 unpacked 目录
ls -la /Applications/太极.app/Contents/Resources/app.asar.unpacked/dist/runtime/

# 手动启动 runtime 做冒烟测试
XYZ_AGENT_PACKAGED=1 ELECTRON_RUN_AS_NODE=1 \
  /Applications/太极.app/Contents/MacOS/TaiJi \
  /Applications/太极.app/Contents/Resources/app.asar.unpacked/dist/runtime/index.cjs \
  --port=9999
# 然后 curl http://localhost:9999/health
```

常见原因：
- `asarUnpack` 失效（`files` 排除了 `dist/runtime`，导致无文件可 unpack）
- `tsup.config.ts` 的 `noExternal` 缺少新依赖，运行时 `Cannot find module`
- 端口范围 3210-3220 全部被占用

### 3. 端口冲突

```bash
# 检查 runtime 端口
cat ~/.xyz-agent/runtime.port

# 检查端口占用
lsof -i :3210 -P | grep LISTEN

# 清理残留进程
lsof -i :3210-3220 -P | grep LISTEN | awk '{print $2}' | sort -u
```

### 4. Extension 相关问题

builtin pi extensions（18 个 `@zhushanwen/pi-*`，数量与分组以 `packages/shared/src/mandatory-extensions.json` 为 SSOT）随应用打包内置，不经过 npm 安装，离线可用：

```bash
# 检查打包产物中的 builtin extensions
ls /Applications/太极.app/Contents/Resources/extensions/@zhushanwen/

# builtin 扩展不生效时，检查是否被禁用（infrastructure 级 6 个不可禁用）
cat ~/.xyz-agent/agent/settings.json
```

第三方扩展（任意 npm 包 / 本地目录 / git）经 Settings → Extensions 页面安装，走 `npm install` 到数据目录，安装失败最常见原因是网络：

```bash
# 检查用户级 npm extension 安装目录
ls ~/.xyz-agent/npm/node_modules/@zhushanwen/

# 检查 settings.json 的 packages[] 是否记录了该 extension
cat ~/.xyz-agent/agent/settings.json | grep '@zhushanwen/pi'

# 检查 npm registry 可达性
npm view @zhushanwen/pi-goal version
```

若安装失败，在 Settings · Extensions 页面会有错误提示，错误码来自 npm installer：`not_found`（包名错误）、`network`（npm registry 不可达）、`extract` / `integrity`（下载内容异常）。

### 5. Dev 模式 Vite 不更新

```bash
# 确认 1420 端口属于当前 worktree
lsof -i :1420 -P | grep node
# 检查进程 cwd 是否指向当前 worktree 的 renderer 目录
```

### 6. subagent 没走 relay 通道：先查首启执行器探针（2026-08-25 relay 通道）

relay 激活前有一个执行器探针（spawn 执行器跑 `--eval "process.exit(0)"`，验证能以纯 node 语义执行 JS）。**探针失败会被缓存到 runtime 重启为止**（模块级 Map，key = 执行器路径），之后每次 spawn 主 pi 都直接回落现状直连、不再重试——所以「subagent 为什么没走 relay」第一件事是翻 runtime 启动后**首次**主 pi spawn 的日志：

```bash
grep "node executor probe failed" ~/.xyz-agent/logs/runtime-*.log   # dev 用 ~/.xyz-agent-dev
# 命中即：[relay] node executor probe failed for <execPath> (isElectron=...) — relay deactivated, spawning direct
```

另两个静默不激活的常态路径：staged 代理脚本缺失（`resources/extensions/@zhushanwen/pi-subagent-workflow/relay/relay.mjs`，bundle 登记未就绪属预期）、socket server 未监听。三者都不报错，只表现为回落直连。

### 7. bash 工具里启动 Electron 二进制被静默降级纯 node 模式（ELECTRON_RUN_AS_NODE=1）

打包模式下 relay 激活时会给**主 pi 进程 env 注入 `ELECTRON_RUN_AS_NODE=1`**（与 `XYZ_SUBAGENT_RELAY_*` 三 env 同点注入——代理 CLI 复用 Electron 二进制当纯 node 跑必需此变量）。该变量经握手帧原样透传给 relay 子进程及其后代，于是 **subagent 的 bash 工具里启动任何 Electron 二进制**（如 `npx electron .`、直接执行 .app 内的二进制）会被 Electron 静默切到纯 node 模式——无窗口、无报错，看起来像「命令没反应」。

定位：在 bash 工具里 `env | grep ELECTRON` 确认；这是 relay 通道的刻意设计（dev 模式执行器是独立 node、不注入）。终端服务不受影响（TerminalService 独立构造 env，已剥离该变量）。

### 8. runtime 启动即退出："fatal: relay server init failed"

relay socket server 在 runtime listen 后同步初始化，失败是 **fatal**（`console.error('[runtime] fatal: relay server init failed')` + exit 1，fail-fast 语义对齐 initLogger 先例）——覆盖/复用 socket 会劫持他人注册表，宁可不起。常见原因：

```bash
# <dataDir>/run 不可写（registry mkdirSync 抛错会走到这）
ls -la ~/.xyz-agent/run/          # dev 用 ~/.xyz-agent-dev
# 残留 socket 文件被活实例持有（实例冲突）
lsof | grep relay-.*\.sock
```

### 9. agent 会话内执行 validate-runtime-bundle 失败："Bundled pi binary not found"

**症状**：从 agent 会话内跑 `bash scripts/validate-runtime-bundle.sh` 报
`[runtime] fatal: relay server init failed: Error: Bundled pi binary not found at <root>/pi/pi-darwin-arm64`
被 commit 卡住；或 agent 会话内其它依赖「打包态判定」的行为异常（如 `isPackaged()` 返回错误结果）。

**根因**：agent 会话的 shell 环境里泄漏了本不该存在的 `XYZ_AGENT_PACKAGED=1`（打包标记只在 main→runtime
注入链上有意义；它一且出现在 agent 会话 env 里，会话内再起的 runtime 子进程就会误判自己运行在打包态，按打包路径解析捆绑二进制 → 必然找不到而 fatal）。历史受害链：runtime→pi 的 spawn 曾用整体替换式白名单 env 但未剥出站 deny 键，标志随继承链下潜到所有后代进程。

**治理现状**：已由子进程 env 出站契约治理（C-proc-09）——六个 spawn 点接线经 `buildOutboundChildEnv`
构建器组装（deny 剥 `XYZ_AGENT_PACKAGED` / `XYZ_RUNTIME_TOKEN`），pre-commit 守卫
`.githooks/check_spawn_env_boundary.py` 拦截未接线的新增调用点。

**如何确认**：
```bash
# 会话内直接查泄漏
# 会话内直接查泄漏：有输出 = 泄漏确认（出站契约只保证会话内再 spawn 的子进程
# 不再携带该标志，不影响本会话自身的 env 快照）
printenv | grep XYZ_AGENT_PACKAGED
# 旁证对照：剥除后重跑原命令应恢复正常
env -u XYZ_AGENT_PACKAGED bash scripts/validate-runtime-bundle.sh
```
若仍命中，说明该调用点未经出站契约构建器（守卫漏网或存量豁免），带着报错文件行号去
`.githooks/check_spawn_env_boundary.py` 豁免名单核对。
### 10. 升级中断手动恢复（升级脚本 staging 状态机残余窗口）

自动升级在换装阶段（备份 mv 与原子换装 mv 之间，毫秒级窗口）被断电/强杀命中时，app 无法自愈（自愈代码运行在 app 进程内，此时无执行机会）：**双击图标无反应、`/Applications` 下 `太极.app` 缺失，同时存在 `太极.app.old` / `太极.app.new`**。`(.old 与 .new 均为完整可用副本，缺失的只是正式位置的名字。)

识别残留：

```bash
ls -la /Applications/ | grep '太极.app'
# 典型残留形态：太极.app 不在列表，太极.app.old 与 太极.app.new 同时存在
```

二选一恢复（执行后 app 即可正常启动）：

```bash
# 回到旧版（丢弃未装完的新版）
mv /Applications/太极.app.old /Applications/太极.app

# 改用手动装新版（丢弃备份的旧版；若 .new 版本异常可再换回旧版命令）
mv /Applications/太极.app.new /Applications/太极.app
```

补充：`.old` 或 `.new` 单独残留（`太极.app` 在位且可启动）属良性残留，下次启动自动清理，无需手动处理；从 DMG 只读卷运行时升级会被拒绝（update-result 写 `read-only volume`），请先将 `太极.app` 拖入「应用程序」文件夹再触发升级。

### 11. pnpm install 报 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY（间歇，单跑却成功）

**现象**：commit / e2e 脚本里 `pnpm install` 间歇失败：`Aborted removal of modules directory due to no TTY`；同一命令单独重跑有时成功（假象：管道里 `| tail` 后 `$?` 是 tail 的退出码，`--silent` 还会吞掉真实报错）。pre-commit 的插件端到端验收随机红，`CI=true` 可"治愈"但会复发。

**根因**（2026-09-03 PR #196 实战定位）：pnpm store 路径默认随 **HOME** 解析。zsw 引擎 worker 覆写 HOME（`~/.zcode/zsw/engines/*/home-appserver`）→ 引擎侧 pre-commit 内 verify-*.sh 自含 install 把**引擎侧 store** 写进 `node_modules/.modules.yaml` 的 `storeDir`；本地（正常 HOME）install 发现 storeDir 与自身解析不一致 → 判定 node_modules 布局过期 → 要求删除重建 → 非 TTY abort。**双向翻转**：谁最后 install 谁的 storeDir 生效，另一侧下次 install 就崩。

排障口诀：

```bash
grep storeDir node_modules/.modules.yaml
# ~/.pnpm-store/v10 = 本地布局（健康）；~/.zcode/zsw/... = 被引擎侧翻转（先恢复再 commit）
```

恢复：

```bash
CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install   # 约 6-7s 重建本地布局，然后重试 commit
```

**防护与根治**：护栏 `.githooks/check_pnpm_store_layout.sh` 挂在 pre-commit 第 0 段（install-hooks.sh 生成）与 validate-runtime-bundle.sh Gate 0，翻转即红并输出 [FIX] 指引。根治已落地（2026-09 zcode 引擎共享宿主 HOME 修订，HOME 池化删除——spawn env 不再覆写 HOME）；护栏继续保留，语义是防 HOME 覆写回退（正常应恒绿，红 = 引擎侧覆写 HOME 回退的信号）。备选方案 `.npmrc` pin `store-dir` 评估结论：`~` 展开仍 HOME 相对（无效）、相对路径解析基准未验证（有 per-package store 撕裂风险）、写死绝对路径不可移植——均不采用。

### 12. subagent 完成后不回收 / 回收慢：sessionFile 获取链与 workflow 域守护特征串判读（2026-09-10 重放移植重写；2026-09-11 H1 续聊链修订）

> **本节 2026-09-10 按 replay port 重写**（权威 SSOT：[design/subagent-agent-end-recovery-replay.md](design/subagent-agent-end-recovery-replay.md)）。线 B 原实现宿主（`packages/subagent-core/src/execution/engine/engines/pi/` 整目录）已随 M0 整树重置到 dev-0.9.16 删除，旧特征串（`backfilled via late get_state response` / `located via sessionDir scan` / `unobtainable after 15s recovery window` / `no-descendant fast path` / `process killed before handshake settled` 等）**在现树已全部不存在**——按旧串 grep 恒零命中是预期，不是日志丢失。
>
> **2026-09-11 H1 修订**（[design/subagent-chat-run-unification.md](design/subagent-chat-run-unification.md)）：chat 域独立状态机整族退役——**续聊轮 = 新 run + resume 锚点**（`RunParams.resume`，pi `--session` 续写原 session 文件），无长驻 chat 进程、无热路径相位机（`roundLifecycle` 通道 / `interact` 方法 / ChatSessionRegistry 已删，grep 零命中是预期）。sessionFile 四路获取链与下方三条特征串**全部仍现行**（每轮 run 都是新 pi 子进程，握手/回补/反查照走）；新增宿主侧锚点回填路：**run 终态应答 `outcome.sessionFile`**（chatMode 续聊轮唯一锚点落点，宿主回填 record.sessionFile 并落 `.record-binding` 绑定 sidecar，见下「H1 后续聊排障要点」）。

新架构结果回收链 = 两层进程嵌套（core → `pi-subagent-cli` 引擎 CLI 进程 → `pi --mode rpc` 任务子进程）。**sessionFile 四路获取**（全部在 `pi-subagent-cli`；交付后修订 2026-09-10：原第 5 路 M4 prompt 头扫描已移除）：

1. spawn 期 get_state 握手 3×2s + 500ms 间隔（M1 契约修复：应答缺 sessionFile 不再悬挂，照常排 retry 至 3 轮耗尽 resolve 已收集字段）；
2. 握手窗口后的迟到 response（identity tracker 监听表驻留至 close，回填走 `applyGetStateFields` 同步路径 + handleReady）；
3. agent_end 惰性 get_state 单查（**M2**，1s 超时；one-shot 域专用——chat 域已随 H1 退役，chatMode 续聊轮同为 run 链、宿主侧锚点落 run 应答 `outcome.sessionFile`）；
4. close 收尾 LC-4 后缀反查（`findSessionFileByHeaderId`，需 sessionId 已知；静默回填、无独立特征串）。

**agent_end 处置**在新架构是「无条件 kill」（agent_end 即终态，无保守等待分支）；**workflow 域静默楔死**由 **M3** 在 core `SAR.run` 挂 30min 无进展守护（复用 `settled-watchdog` 原语）。

日志落盘：宿主 core 与引擎 CLI 的日志统一进 **`<dataDir>/agent/logs/subagents-<date>.log`**（core logger component = `subagents`；引擎 CLI 经 stderr + `host/log` 反向请求转投宿主日志）。桌面 runtime spawn pi 时恒注入 `XYZ_AGENT_EXT_LOG=1`，warn 级默认落盘：

```bash
# 桌面环境：runtime spawn pi 时恒注入 XYZ_AGENT_EXT_LOG=1，warn 级特征串默认落盘
# （dev 数据目录前缀换成 ~/.xyz-agent-dev/agent/logs/）
grep -E "\[sessionfile\]|agent_end get_state backfill|workflow no-progress watchdog" \
  ~/.xyz-agent/agent/logs/subagents-*.log
```

裸 pi CLI 场景默认**不落盘**（extension-logger 双开关均未注入时 no-op）：需 `XYZ_AGENT_EXT_LOG=1`（info 观测档，debug 重标 info 一并写入）或 `XYZ_AGENT_DEBUG=1`（全量）。

**三条现行特征串**（均为 warn 级；①③ 来自 `pi-subagent-cli`，② 来自 `subagent-core`。交付后修订 2026-09-10：M4 的四条特征串随其移除而消失，现树 grep 恒零命中是预期）：

**① `unobtainable for ... (all acquisition paths missed)` — 四路全 miss 的响亮异常信号（交付后新增形态）**

- 日志：`[sessionfile] unobtainable for <recordId> (all acquisition paths missed: spawn handshake, late response, agent_end backfill, LC-4 suffix lookup); record finalized without transcript anchor. Recovery: 若需 transcript 取证，用 session-reader 列 sessionDir 内 mtime 窗口文件人工归档；若需完整结果，重派任务。`
- 含义：四路获取全 miss——子进程从握手起就从未应答任何 get_state（stdin 断/楔死形态），这本身是应有响亮报错的异常信号（不做启发式自动认领，2026-09-10 用户裁定移除 M4 扫描）。run 仍正常终态、通知照发（结果正文来自 stdout 事件累积，不依赖 sessionFile）；`session_read` 指针行仍生成，session-reader 侧降级为明确「session file not found」而非悬挂。
- 下一步：该 record 的 transcript 锚点缺失但**不会误配**（无自动认领即无错绑风险）。按 warn 尾句人工处置：session-reader 列 sessionDir 内 mtime ∈ 本次 run 生命周期的 `.jsonl` 人工归档，或重派任务。**高频出现说明握手链系统性故障**（如 F6 的 relay 身份键缺失形态），应排查握手失败根因而非逐条归档。

**② `agent_end get_state backfill failed` — M2 惰性回补链抛错（kill 仍必达）**

- 日志：`[session-runner] agent_end get_state backfill failed for <recordId> (treated as miss; kill proceeds): <msg>`
- 含义：agent_end 惰性回补（1s 单查）的**结果处理链**抛错（`requestGetStateOnce` 自身永不 reject；抛点在上层回填/组帧）。`killChild` 放 finally 必达——run 不因回补失败挂死；回补超时/子进程不应答则静默 resolve 空对象（无任何串），交 close 收尾第 4 路（LC-4）兜底，全 miss 走 ① 的 warn。

**③ `workflow no-progress watchdog ... fired` — workflow 域静默楔死熔断（M3）**

- 日志：`[subagents] workflow no-progress watchdog (<phase>) fired for <recordId>: no valid protocol event for <n> min after run dispatched — aborting run (cancel frame → settle grace window → killAll if the engine does not settle). Note: a killAll group-kills the engine CLI process, so other concurrent runs on the same engine may end as engine_crashed (they still get a failure result and retry). Recovery: check state with subagents action:'list' includeFinished:true (add includeWorkflow:true to also see workflow-dispatched subagents), then re-dispatch the workflow.`
- 含义（2026-09-11 H2 修订）：workflow 域 agent() 经 `SubagentService.executeWorkflowAgent` 统一派发——**创建真实 ExecutionRecord（origin=workflow）进 RecordStore**，守护 arm 键 = record.id（原「SAR.run 直调、`sa-` 占位 taskId、不创建 ExecutionRecord」口径随 H2 W2/W4 退役——回退分支实体在 pump：无 dispatch 注入时直调 SAR.run 纯转调壳）。派发后 30min 无任何协议事件/stream delta → `AbortController.abort()` → mergedSignal → `wireAbortSignal` 阶梯（cancel 帧 → 3s 收敛窗 → killAll）。失败结果附后缀 `workflow no-progress watchdog fired: the run was aborted after a long silence window with no protocol event or stream delta. Recovery: check state with subagents action:'list' includeFinished:true (add includeWorkflow:true to also see workflow-dispatched subagents), then re-dispatch the workflow.`。30min 中段阈值是原语内**纯常量**（`settled-watchdog.ts` 注释「中段阈值 v1 不开 env」），`XYZ_SUBAGENT_SETTLED_WATCHDOG_MS` 只覆盖收尾段或两段全关，**不可缩短**——无法用 env 在真机快速构造（测试侧另有仅测试可达的窗长注入口，生产不可达）。
- **env `XYZ_SUBAGENT_SETTLED_WATCHDOG_MS<=0` 会连带关掉本节这个熔断**：`subagent-service.ts` 的 `armWorkflowNoProgressWatchdog`（原 SAR.run 挂载点，[H2 W4] 掏空归位）经同一原语入口挂载，watchdog 不 arm 则 workflow 域静默楔死同样没有独立回收计时——排查「workflow 又挂死且无终态通知」时先确认该 env 没被设成非正值（warn 文案已明示这层连带，`settled-watchdog.ts` 头注同步登记）。
- 工具执行期**不会**误 fire：pi 内置 bash 无默认超时，其执行期流式输出（`tool_execution_update`）自 2026-09-10 起被计入活性信号（1s 节流、不进正文槽）——长构建/长测试即使超过 30min 也持续刷新；静默楔死的工具仍在 30min 后被照常回收。
- 下一步：同引擎并发 run 可能被 killAll **连带** engine_crashed 失败终态化（有失败通知 + `executeAgentCall` 退避重试通道，四要素见设计决策 9）；check `subagents action:'list' includeFinished:true` (add `includeWorkflow:true` to also see workflow-dispatched subagents) 后重派 workflow。产出仍在刷新（事件/delta 持续到达）时不 fire——fire 只在连续静默满窗时发生。
- **H2 排查通道（workflow record 默认隐藏）**：workflow origin record 在五处投影**默认过滤**——subagents 工具 list / TUI /subagents / 侧栏 badge 与计数 / 后台工作指示 / GUI subagent 列表（三桶全滤）——排查 workflow 子代理必须带 `includeFinished:true` + `includeWorkflow:true` 成对（fire 后 record 必然终态，缺 includeFinished 只查 running 得空列表；成功 record 终态 = closed + reason gc，D7 成功即终态化，非异常，成败判读看 outcome 不看 closedReason）；run 视图实时进度经 parentRunId 查询（record 为真相）。

**旧文案去留（明确，防按旧串误判）**：

- **已随旧实现消失（现树 grep 恒零命中）**：`backfilled via late get_state response`、`backfilled via lazy get_state (spawn handshake had failed)`、`located via sessionDir scan`、`backfilled via sessionDir scan (close finalization)`、`unobtainable after 15s recovery window`、`entering 15s recovery window`、`retry window round N`、`no-descendant fast path`、`process killed before handshake settled`。原「区分提示」里 late vs lazy 的两路对比也随之失效（现树只有 M2 一条主动回补链，且命中不落串）。
- **已随 M4 移除消失（2026-09-10 `dbe0a60d4`，现树 grep 恒零命中）**：`recovered for ... by M4 prompt-head scan (single match)`、`M4 prompt-head scan gave up`、`M4 prompt-head scan not wired`、`M4 prompt-head scan threw`。全 miss 形态由 ① 的 `all acquisition paths missed` warn 承接。
- **已随 H1 chat 域退役消失（2026-09-11，现树 grep 恒零命中）**：chat 域热路径/相位机家族的日志面（roundLifecycle 相位帧、`interact` 投递拒收、ChatSessionRegistry superseded 抑制等）与 `chat-round-first-round-watchdog` 首轮看门狗——续聊排障不再有这些串；旧排障动作「查 chat 相位帧时序」改查 run 事件流与 run 终态应答。
- **仍存在的现行面**：本节 ①-③ 全部；`findSessionFileByHeaderId`（LC-4 后缀反查，第 4 路）仍存在但其回填静默无独立特征串；M1 握手契约修复自身无日志面。

**H1 后续聊排障要点（2026-09-11，chat 域统一进 run 域）**：

- **每轮续聊 = 一个独立 run**：message 到达 → Continuation（`conversation-continuation.ts`，每 chatMode record 一个实例）派新 run（`RunParams.resume`）→ 新 pi 子进程 `--session` 续写原文件 → run 终态应答（resolve = agent_settled）→ 轮终簿记。排障「续聊轮卡住/无通知」按 run 链查（引擎 CLI 池 → 任务子进程 → run 应答），不存在「长驻 chat 进程忙碌/拒绝」形态——原 busy 拒绝 / superseded 串扰 / EPIPE 兜底等 chat 域失败模式已随域退役。
- **跨重启续聊数据源 = `.record-binding` 绑定 sidecar**（UF-1）：宿主在 record.sessionFile 回填点落 `<sessionFile>.record-binding`（id→file + rootSessionId，`state-marker.ts` 载体族）。重启后 message 报「subagent not found or not owned」时按序查：① record 是否存在（列表可见 = 展示层重建正常，动作链走绑定解析）② 对应 session 文件旁有无 `.record-binding`（无 = 绑定写点未触达，查续聊 run 的终态应答是否到达 / `outcome.sessionFile` 是否回填——绑定写点在 run 应答回填处，handshake 面只回填 engineHandle.sessionRef 不写绑定）③ `cold-lookup.ts`（原 cold-resurrect 语义收敛为 cold-lookup：`findLightById` + `collectRecords` 经 sidecar 恢复 id→file 映射）。close 终态翻转写 `.state`，不破坏绑定文件。
- **崩溃/失败轮语义**：轮在途引擎崩溃 → 失败通知单发（Continuation 独立构造载荷，正文 = 失败摘要 + 恢复指引，dedup key `record:round`）+ record 保持 running-resumable（不被终态化短路）——「失败后无通知」或「失败即 closed」都属异常，查 Continuation onRunSettled 失败分支与 `notifyGateAllowsDelivery` 门（cancelled / parent-new / parent-fork 竞态窗拦发是设计行为）。
- **孤儿收割**：引擎 CLI 意外死亡时宿主在镜像置死前收割任务子进程（POSIX 组杀 / Windows 快照逐 pid taskkill，非主动死亡路径触发）。session 文件出现交错行 = 收割链失效证据，按设计登记升级文件锁/写者探测（红线③残余窗口：宿主重启窗）。

### 13. record 直写守卫拦截（eslint no-restricted-imports / check-record-write-surface，2026-09-12 H4 收敛）

> **权威 SSOT**：[design/subagent-record-persistence-consolidation.md](design/subagent-record-persistence-consolidation.md)（§3.3 D7 守卫分级 / §3.1 意图级 API 表）；约束登记 C-data-20。

record 持久化写面（`.state` 终态权威 / `.alive` 写权声明 / manifest 投影 / sessions-index 缓存 / `subagent-record` entry）的唯一写入口 = `RecordStore` 意图原语（`packages/subagent-core/src/execution/record-store.ts`）。两级守卫：

**① eslint 报错「store 外禁 import 终态 sidecar 写函数 / .alive 写删函数 / sessions-index 落盘函数」**（`no-restricted-imports`，模块边界一级拦截）

- 触发形态：store 外（`record-store.ts` 之外，测试豁免）import `writeFinalizedState` / `writeCancelledState`（state-marker.ts）、`writeAliveMarker` / `removeAliveMarker`（alive-store.ts）、`saveIndex`（sessions-index.ts）。
- 下一步：改调 RecordStore 意图原语——终态 = `markFinalized` / `markCancelled`（内部 `.state` writeSync 先 + manifest writeSync 后 + `.alive` 删，D8 写序单点）；写权声明 acquire = `acquireWriteLease`；归档 = `markIdleArchived`。**读函数（`readStateMarker` / `isProcessAlive` / `findForeignLiveInstance` 等）不受限**，按需 import。绑定 sidecar（`writeRecordBinding` / `updateRecordBinding`，UF-1 面）不在终态写面收敛范围。

**② pre-commit 报错「record 持久化写面守卫未通过——store 外 record 写面直写」**（`scripts/check-record-write-surface.mjs`，grep 门兜底）

- 触发形态（eslint 拦不住的写形态）：R1 六名写函数直调——类方法形态（`manifestStore.writeManifest(...)`，ManifestStore 实例方法 import 层拦不住）与独立函数形态（`saveIndex(...)` 等）；R2 `appendEntry` 调用行含 `subagent-record` 字面量（对象参数 customType 形态，record 主记录 entry 归 store 的 register/archive/reportRecordTransition 内置）。
- 下一步：manifest 投影补写走 `RecordStore.rematerializeManifest`（entry 重物化腿唯一入口）；批量终态走 `markBatchFinalized`（barrier 语义内置）；状态上报走 `reportRecordTransition` / `reportSubagentRecord`。notify-ledger 投递账、reconcile-sweep 注销、pending:register/unregister 通道的 customType 不属 `subagent-record`，天然不在拦截面。
- 复跑：`node scripts/check-record-write-surface.mjs`（应输出 `OK：... store 外 record 写面零命中`）。

**误拦判定**：新写面确属 store 职责之外（如独立 extension 自有域）时，须在守卫脚本 `EXTENSION_DOMAIN_ALLOWLIST` 登记文件并注明设计依据（登记处即台账），禁止行内豁免绕过。

### 12. catalog provider 自定义网关失效 / 端点与官网不符：启动清洗剥除了手编网关（2026-09-10 D2 已接受代价）

**症状**：catalog provider（openai / opencode-go 等内置目录 provider）的请求端点回到内置值——自定义网关（镜像站/代理）失效，或发现端点与官网文档不符。启动日志有：

```bash
grep "stripped unmarked provider-level keys" ~/.xyz-agent/logs/runtime-*.log   # dev 用 ~/.xyz-agent-dev
# 形如 [provider-repair] stripped unmarked provider-level keys on "<id>": baseUrl
```

**根因**（设计 D2 已接受代价，docs/design/catalog-provider-field-authority.md §3.3）：models.json 手编的 catalog 网关（provider 级 `baseUrl` override）且**从未经新 UI 保存过**的条目，启动清洗会剥除该键——判定锚是 providers.json extras 的 `gatewayBaseUrl` 显式标记，无标记即判「历史冻结 artifact」剥除（防 pi 升级后快照漂移导致网关钉死过时值）。

**检查**：数据目录 `pi/agent/models.json` 中该 provider 条目——`baseUrl` 键已被剥除（当前生效 = 内置目录端点）。

**恢复**：Settings → Providers 展开该 provider，在「端点（自定义网关）」输入框重设网关 URL 并保存一次——extras `gatewayBaseUrl` 标记同步写入，之后启动清洗不再剥除该键。

### 13. Coding Plan 额度查询失败 / 数据疑似过期：先查 reason 与凭证来源（2026-09-10 配置交互重构）

**症状**：设置页「保存并测试」报查询失败；对话页容量浮层的 Coding Plan 区显示失败或无数据；或改过查询类型后浮层仍显示旧平台的数据。

**根因/现状**（设计 docs/design/coding-plan-quota-config-ux.md，D1/D3/D4/D6/D12）：本次把「用哪份凭证」从隐式约定改为**显式持久化字段** `providers.json` 的 `providers[*].quota.credentialSource`（`'provider'` | `'exclusive'`），并新增失败原因 `no-credential`。因此排查第一步是核对「界面显示的来源」与「磁盘上的字段 / 文件」是否一致，而不是猜凭证有没有填。

**检查**：

```bash
CD=~/.xyz-agent            # dev 用 ~/.xyz-agent-dev
# ① 失败原因：no-credential = 按当前来源选中的链路解析不到任何凭证
grep "\[quota\] fetch failed" $CD/logs/runtime-*.log | tail -20
# ② 凭证来源字段（'provider' = 用 Provider 凭据；'exclusive' = 只读专属 Key 文件）
grep -n -A6 '"quota"' $CD/pi/agent/config/providers.json
# ③ secrets 实际文件（cookieSet / apiKeySet 标记必须与文件存在性一致）
ls -la $CD/secrets/
```

- **`no-credential` 的判据是「选中的链路解析不到凭证」，不是「凭证一个都没有」**：`exclusive` 只读 `secrets/<pid>-apikey.txt`，缺失即失败、**不再回退** auth.json → models.json；`provider` 分支则完全跳过该文件。所以「专属 Key 明明填过却报 no-credential」的第一嫌疑是 `credentialSource` 为 `exclusive` 而文件不在（手工删过 / 半提交窗口），恢复 = 重填专属 Key，或把来源切回 Provider 后重新「保存并测试」。
- **Cookie 的「空串 = 清除」**：Cookie 提交空串时 runtime 删除 `secrets/<pid>-cookie.txt` 并把 `cookieSet` 落为 `false`；删除失败会让本次保存整体失败（`[quota] failed to remove cookie secret file`）。看到「标记 false 但文件仍在」的告警即这条失败方向，重贴 Cookie 保存一次即自愈（孤儿文件在 `credentialSource` 兜底为 `'provider'` 后不再被读取）。
- **provider 删除 / 移除会一并清理**：`secrets/<pid>-{cookie,apikey}.txt` + `quota-cache.json` 条目 + 内存失败标记（D12）。删除时 `cleanProviderExtras` 失败 → secrets 删除被跳过（留下「标记与文件一致」的残留，重试删除即清）；extras 成功而 secrets 删除失败 → 惰性孤儿文件（`[quota] failed to clear provider quota secrets`，下次同 id 删除或手工删）。**注意**：删除是用户显式动作，删掉的是用户粘贴的 Cookie / 专属 Key，重新导入 provider 不会恢复，需重新粘贴。
- **类型变更后旧数据不应残留**：改类型并保存会删 `quota-cache.json` 中该 provider 的条目（内存镜像同步删），旧类型的行不会再被 `getCached` 取回并以新类型标签展示。若仍看到旧数据，查 `[quota-cache] failed to remove cache entry` 与该文件同目录的 `.tmp` 残留（`.tmp` 为原子写中间产物，rename 即消费）。
- **`not_configured`**：opencode 类 fetcher 的 Workspace 必填项为空——虽然 UI 的齐备性会挡住这个保存（按钮置灰），但 runtime 保留该分支作权威兜底；浮层提示指向「去设置里填 Workspace」。

**恢复入口**：失败态浮层的 footer 现在同时给「刷新」与「配置」（D11，此前只有「刷新」——凭证缺失时刷新只会再失败一次，形成死路）；设置页的「保存并测试」是唯一落盘 + 查询动作，齐备性不满足时按钮置灰并给字段级提示。

## pi 数据布局迁移（方案 B，2026-09-10）

数据布局已对齐 pi 0.84.x 默认布局：pi 的 agent 目录从 `<dataDir>/pi/agent` 上移到 `<dataDir>/agent`（`PI_CODING_AGENT_DIR` 新值），session jsonl 由 pi 按 cwd 写入 `<dataDir>/agent/sessions/<encodeCwd>/` 子目录。`<dataDir>/pi/` 层退役（迁移备份为 `pi.backup-v2-<ts>/`）。旧版数据目录（`~/.xyz-agent` / `~/.xyz-agent-dev`）需各跑一次迁移脚本；新装机直接是新布局，无需迁移。

### 识别旧布局残留

- **启动 WARN**：新版 runtime 启动时若发现 `<dataDir>/pi` 存在且含 `agent/` 或 `sessions/` 子目录，记 WARN 日志（`<dataDir>/logs/runtime-*.log`）——此时历史会话不在新布局中，对会话列表与 session-reader 双面不可见（数据无损，躺在原处）
- **doctor 自查**：session-reader 工具的 `doctor` action 独立探测未迁移的 `pi/` 与迁移备份 `pi.backup-v2-*/`（两者都不在会话候选根推导式内，靠独立 glob 标注并附迁移指引）

### 迁移操作（一次性手工，不在 app 启动路径）

```bash
# 推荐时序「先迁后升」：关闭应用 → 跑脚本 → 再装/启动新版
node scripts/migrate-pi-layout-v2.mjs ~/.xyz-agent       # 生产实例
node scripts/migrate-pi-layout-v2.mjs ~/.xyz-agent-dev   # dev 实例（如存在）
```

- 脚本幂等可重入：前置检查（实参形态 / 运行中进程 pgrep 自证，命中列 PID 即中止）→ `pi/` 原子改名为 `pi.backup-v2-<ts>/`（备份即暂存）→ agent 整体上移或分域并道 → 旧 session 按首行 header.cwd 分发到 `agent/sessions/<encodeCwd>/`（无 cwd 的进 `_migrated-no-cwd/`，仍可被枚举）→ 输出迁移报告（分发/跳过计数、冲突清单、避让文件 `*.old-v2-aside` / `*.new-v2-aside`、顶层残片清单、备份体积）
- 「先升后迁」是合法兜底时序：新版启动收到 WARN 后再跑脚本，续传分支把窗口期增量并道进新布局（记录型子树文件级并入，无增量丢失）；中断后重跑安全
- 迁移后鉴权异常 / provider 列表缺项：先查报告「冲突清单」与避让文件（provider 三件套 keyed union 的冲突去向，按 providerId 手工搬回）

### 备份清理与回滚

```bash
# 回滚（与迁移报告尾部命令一致）：删或改名新 agent/ + 备份改回 pi
rm -rf ~/.xyz-agent/agent && mv ~/.xyz-agent/pi.backup-v2-<ts> ~/.xyz-agent/pi

# 清理备份（不自动删）：新版运行一切正常（历史会话/模型/鉴权均正常）观察一段时间后手工删
du -sh ~/.xyz-agent/pi.backup-v2-*/
rm -rf ~/.xyz-agent/pi.backup-v2-<ts>
```

- 装回旧版本的降级行为：旧版把「`pi/` 不存在」当全新安装，历史会话在旧版中不可见但数据无损躺在备份里；旧版运行重建 `pi/` 后，新版启动 WARN 会再次出现 → 重跑脚本并道即可

## 环境变量速查

| 变量 | 用途 | 生产默认值 | 开发默认值 |
|------|------|-----------|------------|
| `XYZ_AGENT_DATA_DIR` | 数据目录 | `~/.xyz-agent` | `~/.xyz-agent-dev` |
| `XYZ_AGENT_PORT_OFFSET` | 端口偏移 | `0` | `100` |
| `XYZ_AGENT_PACKAGED` | 打包标记 | `1` | 未设置 |
| `ELECTRON_RUN_AS_NODE` | Node 模式 | `1`（runtime 子进程） | 未设置 |
| `VITE_MOCK=true` | Mock 模式 | — | 可选 |
| `XYZ_RUNTIME_BASH_RPC_TIMEOUT_MS` | bash RPC 超时逃生门（0=不限时） | 未设置（默认 1h） | 可选 |
| `XYZ_SUBAGENT_SETTLED_WATCHDOG_MS` | settled-watchdog 收尾段/两段全关（≤0 会连带关闭 workflow no-progress 熔断，见 §12 ③） | 未设置 | 可选 |
| `XYZ_ZCODE_TURN_IDLE_TIMEOUT_MS` | zcode turn idle 判定（静默超时判死） | 未设置（默认 30min） | 可选 |
| `XYZ_ZCODE_TURN_MAX_TIMEOUT_MS` | zcode turn 总上界（>0 覆盖、≤0 关闭） | 未设置（默认 60min） | 可选 |

> 注意：`XYZ_RUNTIME_BASH_RPC_TIMEOUT_MS` 在 runtime 进程生命周期内**读一次即缓存**（`rpc-client.ts` resolveBashRpcTimeoutMs——中途改 env 不生效且无提示，超时决策须进程内稳定）。改后必须重启应用/`pnpm dev` 才生效。

## 历史排查规则 [HISTORICAL]（从 AGENTS.md 外移 2026-08-17）

### git status untracked 目录展开

`GitService.getStatus` 执行 `git status --porcelain=v1 -z -b` **必须带 `--untracked-files=all`**。

- 根因：默认 git 把整个 untracked 目录折叠成一行 `?? dir/`（**带尾斜杠**）。文件树 `FileNode.path` 无尾斜杠，两者失配 → overlay key 查不到 → 目录徽章误显（前缀匹配命中自身那条带斜杠记录）、展开后子文件无角标无行数
- 修复：`--untracked-files=all`（`-uall`）强制展开每个 untracked 文件到文件级，与 `FileNode.path` 格式一致。`.gitignore` 仍生效，不会因 node_modules 等爆量
- 修改位置：`packages/runtime/src/services/git-service.ts` getStatus。测试基线：`git-service.test.ts` 断言了命令参数

### 禁止写死项目绝对路径

runtime 代码禁止出现特定项目的绝对路径或硬编码假设，所有 workspace / bare repo / 数据目录路径必须从运行时上下文动态推导（xyz-agent 是通用工具，用户会在任意 bare repo + worktree 项目中使用）。

- workspace 根 / bare repo：`WorkspaceDetector.detect(currentCwd)` 向上查找 `.bare`（`workspace-detector.ts`）
- 数据目录：`getDataDir()` / `getConfigDir()`（`packages/shared/src/paths.ts`）
- 检查：`grep -rn "xyz-agent-workspace\|/Users/zhushanwen" packages/runtime/src/` 不得在逻辑代码中出现硬编码绝对路径
- 关联教训（spawn 权限）：git 跟踪的脚本默认 644 无 x 位，直接 `spawn(scriptPath)` 会 EACCES；执行外部脚本用 `spawn('bash', [scriptPath, ...args])` 包装

### 跨层机制排查必须穷尽所有层（pi extension ↔ xyz-agent runtime）

分层架构里，每层只看自己视角，「我这层没做」≠「没发生」。涉及 pi extension ↔ xyz-agent runtime 的跨层机制排查，必须穷尽所有可能发起方，不能只看 xyz-agent runtime 侧就下结论。

- 事故：排查「background subagent 完成后主 agent 是否续跑」，explorer 只看 xyz-agent runtime 就断言「不续跑」，差点设计出「永不响」的错方案。真相：续跑由 pi 进程内的 extension 发起（pi-subagent-workflow notifier 调 `pi.sendMessage(..., {triggerTurn:true, deliverAs:'steer'})`，pi 核心收到后开新 turn），xyz-agent runtime 只是旁观转发
- 排查步骤：① xyz-agent runtime 侧（event-interpreter / session-service / message-dispatcher）只是旁观转发；② pi extension 机制（pi 进程内）——开发期源码在本项目 `extensions/`，用户机器运行时安装在 `~/.xyz-agent/npm/node_modules/@zhushanwen/pi-*/src/`；③ pi 私有协议（`triggerTurn`/`deliverAs`）语义见 `packages/shared/src/message.ts` 注释；④ 设计文档：`docs/page-design/archive/v3/` + `docs/extensions/extension-conventions.md`
- 判断依据：涉及 pi 的 session loop / turn 调度 / LLM 调用的行为，发起方几乎一定在 pi 进程内；xyz-agent 的职责是 UI 状态同步 + 用户命令转发
- 教训：当用户的领域知识与 explorer 结论冲突时，**优先怀疑 explorer 排查范围不全**，而非怀疑用户

### closedReason:"gc" 是统一终态占位，不是故障（2026-08-27 事故 A）

pi 的 session close 事件把 done/failed/crashed 等全部终态统一坍缩为 `closed + closedReason:"gc"`——**"gc" 是「非用户主动关闭」的占位终态，不代表垃圾回收、不代表异常**。看到它先别当故障查。

- 判读指引：**看 outcome 字段**（completed / failed / cancelled 一等字段，切片 1 subagent-dispatch-reliability 已保证向后兼容输出）——不要对 closedReason 做 switch 推导成败；历史上下游三处同构各自重新推导成败，是「写入时坍缩」问题类的温床
- 排查「subagent 为什么显示 gc」时：先查该 subagent 的 outcome 与退出码；closedReason 本身恒无信息量；若消费方还在读 closedReason 判成败，改为消费 outcome

### 模型名大小写漂移致 429：「昨天能用今天炸」的排查路径（2026-08-27 事故 A）

pi 的 models-store.json 远端目录周期刷新（PS-11）可引入大小写家族条目，`--model` pattern 匹配结果随时间漂移——同一串昨日全等命中、今日掉进模糊分支命中无权限模型，表象是「昨天能用的模型今天 429」。

- 排查路径：① 查 `<agentDir>/models-store.json` 的 mtime/新增条目（大小写变体家族）；② 派发侧走 G4 孪生守卫复现——start 同步期对含歧义大小写变体的 registry 拒单并报「registry 含歧义大小写变体」；③ 确认派发模型入参是全等 id（`assertCanonicalModelRef`），禁裸串拼 `--model`（`check_subagent_channels.py` 拦截）
- 预防：新代码不拼 `--model` 字符串（shared/model-ref.ts 唯一入口）；能力面一律消费注册表 supportedLevels（C-pi-12）；机制详情见观察项 #6（PS-01）

### 共享 pre-commit hook 被旧版 install-hooks.sh 覆盖（2026-09-04 流写护栏事故复发）

bare repo + worktree 结构下，`.bare/hooks/pre-commit` 是全部 worktree 共享的运行时副本，由各 worktree 自己的 `.githooks/install-hooks.sh`（SSOT 在各自分支）在 `pnpm install` 的 prepare 阶段生成。**任一旧分支 worktree 跑 `pnpm install`，都会用它分支的旧版源无条件覆盖共享副本**——护栏段静默消失（旧版源既没有护栏段也没有安装后自检，覆盖时零告警）。

- 现象：本地 commit 不再触发流写逃逸护栏（或整套 pre-commit 检查行为变旧）；曾两次实际发生（2026-09-04 S2 验收发现 SSOT 缺口、当晚 design-code-sync R3 发现被旧源覆盖复发）
- 检测：`grep -c 'UNSAFE_STREAM_CHECKER=' <bare>/hooks/pre-commit`（bare 目录用 `git rev-parse --git-common-dir` 推导）——结果为 0 即被旧源覆盖；新版 install-hooks.sh 安装后自带同款自检（源缺段时 exit 1），但拦不住旧源覆盖（旧源无自检）
- 恢复：在含最新护栏段的分支（≥ 4ecea728f）worktree 里跑 `bash .githooks/install-hooks.sh` 重装共享副本
- 根治：旧 worktree 的分支更新到含护栏段与自检的基线后自然消除；在合并前，任何 worktree 的 `pnpm install` 后建议复跑上面的检测命令。CI invariant（ci.yml 独立跑护栏脚本）在本地失效窗口期兜底拦新增裸写点

### 本地 tag 污染与 GitCode 镜像全量拒收（2026-09-07 v0.9.14 发布事故）

两层问题叠加在 merge 阶段 6.5.3（GitCode 仓库镜像）爆发：

1. **镜像 push 全量拒收**：本地 `refs/remotes/github/HEAD` 跟踪 symref 被 refspec `refs/remotes/github/*` 展开成创建 `refs/heads/HEAD`，GitCode 判 HEAD 为保留关键字拒收，git pre-receive hook 一票否决整个 push——所有引用（含 main、全部 tag）一起报 `pre-receive hook declined`，报错不指向真凶。CI 时代无此问题（actions/checkout 无 `origin/HEAD` 引用），本地化后才踩中。
2. **本地 tag 空间污染**：`git fetch upstream`（pi-mono，只读参照用）的 tag auto-follow 把 285 个上游 `v*` tag 拉进本地；普通 fetch 永不更新已有 tag，GitHub 侧重打过的 tag（v0.3.15）本地还会残留过期旧位置。老脚本 `+refs/tags/*` 推本地 tags，一旦拒收解除就会把污染注入镜像。

- 防线（已落地）：镜像脚本 tags 从 `refs/remotes/github-tags/*` 命名空间推（本地再脏也推不出去）+ push 前删 `<src>/HEAD` symref + push 前刷新分支跟踪视图（fetch --prune，防 GitHub 旁路变更后推旧位置）+ 推后逐条比对引用集（不一致即 exit 非 0，见 `scripts/gitcode-release-sync.mjs`）；上游 auto-follow 已断（`.bare` 配置 `remote.upstream.tagOpt=--no-tags`，新 workspace 需重设）
- 附件镜像同标准收口（同日补齐）：`sync`/`sync-from-github` 上传完成后自动做 name 集合比对（缺失即 fail；多余只 WARN，补齐语义不删人工补件）+ 逐件 Range 探测远端大小与本地比对（抓截断/同名旧件残留），失败 exit 非 0
- 本地 tag 自愈命令（怀疑漂移时跑）：`git fetch github --force --prune --prune-tags`
- 排障提示：GitCode 报 `pre-receive hook declined` 且无 `remote:` 详情时，先二分 refspec 找被拒的具体引用（单引用逐个推），不要当瞬时故障重试
- 平台行为依赖（未契约化，链路断时先查这里）：GitCode 的 release API 创建 release 时会自动打 tag 指向默认分支当前位置（非该版本 commit，v0.9.14 实测打到了旧提交），当前链路靠 push-repo 的 force-push 纠正该 tag——若 GitCode 未来对已存在 tag 拒绝强推，6.5.3 会在 verifyMirrorAlignment 处响亮失败（缺失/改动清单），按清单核对平台侧行为是否变更，勿先怀疑脚本

### 归因排障默认优先序：读日志 → 代码定界 → 对照实验（2026-09-12 基线实验教训）

症状跨多个候选改动窗口（如「上周还是绿的」类回归）需要归因时，**默认按固定优先序推进，禁止跳级上对照实验**：

1. **读日志**：relay 镜像日志 / `<dataDir>/logs/` / pi 会话 jsonl / 引擎 stdout——现有日志常常已含断点位置（本案例中 relay 镜像日志 1 分钟就给出「断点在 pi 会话进程内收尾链」）
2. **代码定界**：`git log`/`git blame` 圈出「涉事链路代码在嫌疑窗口内是否被改过」——2 分钟级成本，且能直接否决错误线索（本案例中定界发现「GUI 派发链路代码零改动」，当场作废实验依据的『布局翻转』线索——那其实是多 worktree 各写各的正确布局）
3. **对照实验**（基线树重跑等）：仅当①②穷尽、且两个候选的**修复路径真实分叉**（归因结果会改变下一步动作）时才启动；派发实验前必须已完成②

反例（2026-09-12，sess_b05ad2ea H3 Gate B 5 FAIL 归因）：法证发现 record 布局差异后直接派发「基线树重跑」实验（预期 25-40min），未先做 2min 的代码定界；被用户质疑后停掉时实验 17.6min 零产出，而事后代码定界直接推翻实验依据。核心教训两条：

- **归因标签与修复动作解耦时，实验无价值**——无论 bug 归哪个窗口，最终都要修最新代码；`git blame` 到具体行后归因免费获得
- **实验判据本身未经校验时，实验连归因都给不了**——本次 5 FAIL 的判据（record 卡 running）与产品 idle 语义冲突（可续聊形态 running 是 by design），基线跑完只会输出错误归因

### 周期轮询/兜底定时器的合法性判定（2026-08-28）

新增任何周期定时器（setInterval / 递归 setTimeout 循环 / 轮询兜底）前，必须按下表归类并回答该类的问题；处置台账与外部对照证据见 [design/pi-boundary-reliability.md 附录 C](design/pi-boundary-reliability.md#附录-c轮询定时器处置全清单2026-08-28d9-执行台账)。**判定原则：变化时对方会主动 push 的信息，禁止用周期 pull 兜底**——兜底轮询会掩盖主链路 bug（事故 B 的 30s 轮询就让「回执丢失」隐性存在了很久）。

| 类 | 判据 | 规则 | 实例 |
|---|---|---|---|
| ① 自有状态对账 | 状态变化 100% 经由自身请求/事件路径 | **禁止周期轮询**。主链路 = 回执 + 事件失效；周期 pull 会掩盖主链路 bug | thinkingLevel 30s 轮询（已随设计定案删除，附录 C.4） |
| ② 活性探测 | 对端死掉/卡死时无法自报 | 允许，但**优先升级式触发**（事件静默超时 / 请求失败再探），无条件周期须论证 | pingPi 60s、WS 15s ping+45s watchdog、Electron 30s /health |
| ③ 外部世界 | 数据源在外部、无 push 通道 | 允许轮询；频率 = 外部约束（API 限额 / 下游缓存 TTL），不做无依据加密 | 应用更新检查（GitHub + AtomGit 双源，全源限流退避——rateLimited = 全部源均在退避窗口才报；周期 60min 不变） |
| ④ 空转 | 有 push 通道仍轮询，或产出数据无消费者 | **删除或事件化** | plugin-host 30s memory monitor（lastActiveAt 只写不读，已删）、handoff 2s 轮询（onExit 多播化后已事件化） |

新增定时器必须自答三个问题（写进代码注释）：**这个信息会变吗？变的时候对方为什么不 push？轮询周期掩盖的是什么主链路缺口？** 答不出第三个问题 = 该定时器在代偿某个未修的主链路 bug，先修主链路。

历史锚点：2026-08-28 D9 处置前全仓 12 处常规定时机制，经 ZCode / deepseek-harness / opencode 源码对照后 5 项当日删减或降频、1 项定案删除——「兜底轮询保平安」哲学被实证推翻，外部实现靠「被动信号 + 有界预算 + 便宜重建」达到同等可靠性。

## pi 行为观察项（未验证风险登记，2026-08-20 pi-assumption-remediation W6）

pi 升级（`PI_VERSION` bump）或触碰相关模块时逐条重验；锚点均为实装版（当前 0.84.4，核对方式见 AGENTS.md pi 段查阅规则）。来源：审计报告 A/B（`.xyz-harness/2026-08-19-pi-assumption-audit/`）。

**机器登记互链（2026-08-28 pi-boundary-reliability）**：本节是人读处置层，每条对应 [docs/pi-semantics.json](pi-semantics.json) 的 PS-xx 条目（唯一机器源：probe 型配探针测试，observe 型即本节处置建议）；pi 升级时 `node scripts/check-pi-semantics.mjs`（pre-commit + CI）自动门禁版本漂移。机制描述不双写——语义断言与 pi 锚点的权威源是 json，本节只留处置建议。

### 1. F8：subagent-workflow SIGINT re-raise 在 pi 挂起窗口可能失效（PS-13）

- **pi 锚点**：`modes/interactive/interactive-mode.js:3193-3223`（handleCtrlZ 挂起期间注册空 `ignoreSigint`，SIGCONT 才移除）
- **机制**：`extensions/subagent-workflow/src/index.ts:654-680` 的 sigintHandler 收割后 re-raise SIGINT，依据「移除自身后无其他 SIGINT listener（pi 不注册）→ 默认终止」。该断言在 interactive 挂起（Ctrl-Z suspend）窗口不成立——re-raise 的 SIGINT 被 pi 的 `ignoreSigint` 吞掉，进程不死且本 extension listener 已移除，Ctrl+C 永久失效（直到 SIGCONT）
- **触发条件**：本地 pi CLI interactive 模式 + subagent-workflow extension 激活 + 进程挂起态（suspend to background）收到 SIGINT。xyz-agent 桌面链路不走这条（runtime supervisor 用 SIGTERM，pi rpc-mode 自带 SIGTERM handler）
- **处置建议**：re-raise 前检查 `process.listenerCount("SIGINT")`，移除自身后仍 >0 时不依赖默认终止，改用 `process.exit(exitCode)` 兜底。升级 pi 后若 interactive 模式信号处理有变，重测 Ctrl-Z 挂起 + Ctrl-C 组合

### 2. F10：jsonl-run-store「首写立即可见」在 pi 延迟首写窗口内不成立（PS-14）

- **pi 锚点**：`dist/core/session-manager.js:724-752`（`_persist` 无 assistant message 且未 flush 时仅内存记账不落盘；首条 assistant 到达才 `openSync("wx")` 全量写出）
- **机制**：`extensions/universal/subagent-workflow/src/jsonl-run-store.ts` 期望「run entry 写入即跨 session 重启可从 jsonl 发现」。新 session 经 /wf 命令启动 workflow（主 session 尚无 assistant）的窗口内 crash，run entry 只在内存，盘上无文件
- **触发条件**：全新 session + 首条 assistant 产出前 + 窗口内进程 crash/被杀 的三重组合（概率低，未实测可达性）
- **处置建议**：现有兜底已生效——读序 entry > state 文件（store 自写）> 空，crash 恢复仍可发现 run，无需改动。升级 pi 时核对 `_persist` 的 hasAssistant 延迟首写分支是否仍在；若 pi 改为立即落盘，此观察项可关闭

### 3. U1：pi-ai/compat 入口是上游自声明的临时模块（时间炸弹）（PS-15）

- **pi 锚点**：`pi-ai dist/compat.js` 头注释——"This module is deleted with the coding-agent ModelManager migration"（随 coding-agent ModelManager 迁移完成而删除）
- **机制**：`extensions/shared/llm-shared/src/call.ts:16-20` 顶层静态 `import { completeSimple, ... } from "@earendil-works/pi-ai/compat"`。上游删除该入口后加载期即炸，波及所有经 llm-shared 调 LLM 的 pi-* extension（goal / scheduler / structured-output 等）
- **触发条件**：升级到「ModelManager 迁移完成」版本的 pi-ai（无明确时间表，以 changelog / package.json exports 为准）
- **处置建议**：每次 pi 升级 PR 必查两项——`node -e "require.resolve('@earendil-works/pi-ai/package.json')"` 的 exports 是否仍含 `./compat`、pi-ai changelog 是否提及 ModelManager 迁移；命中时将 llm-shared 迁移到新 API（`createModels()` + provider factories），迁移前禁止发布依赖旧入口的 extension 版本

### 4. thinking 档位按模型族钳制且 pi 静默（final gate P2，2026-08-20）（PS-12）

- **pi 锚点**：`pi-ai models.js clampThinkingLevel`（不支持的档就近回落）；`types.d.ts:257`「xhigh/max 仅部分模型族支持」；`agent-session.js setThinkingLevel` 钳制后 isChanging=false → 不写 entry 不发事件
- **机制**：UI 思考档全集（off~max 7 档，W2 SSOT）对所有模型一视同仁——mimo 族实际止于 high，选「最高(max)」被 pi 钳到 high，用户无感知实际生效档位（session 建立后 UI 芯片会回落显示 pi 实际值 high，但选中瞬间的「最高」与实际不符）。reply/缓存已改回生效值（P3 修复），剩余缺口在 UI 侧无「该模型最高支持 X」提示
- **触发条件**：模型族 supported levels 不含所选档（mimo 族 + xhigh/max；其他族见 `get_available_thinking_levels` RPC）
- **处置建议**：UI 侧调 `get_available_thinking_levels`（pi RPC，按当前模型过滤档位或禁用置灰 + 提示「该模型最高支持 high」）。涉及 renderer 新 RPC 通路，未随 P3 顺手实施（scope 控制），需要时立项。**2026-08-28 更新**：档位可用集已由能力注册表结构性解决（C-pi-12：runtime 经 pi-ai 同源函数算 supportedLevels 下发，前端零推导；探针断言见 PS-12 条目）

### 5. fork 路径 spawn 仍可能带 --model 压过 fork 源模型终态（P1 同族，final gate 观察项）（PS-16）

- **机制**：restoreSession 已改 `inheritSessionModel: true`（P1 修复，模型终态由 pi 从 model_change entry 恢复）；forkSession 的 createSession 仍透传 presetClientOptions.model——fork 文件内若含 model_change entry（截断点之前有切换记录），附着后被 preset model（或全局默认兜底）压过，分叉会话模型 ≠ 源会话模型
- **触发条件**：fork 一个会话内切换过模型的 session（截断点在 model_change entry 之后）
- **处置建议**：与 P1 修复方向相同（fork 附着路径设 inheritSessionModel），但 fork 语义「launch 配置 vs 源终态谁优先」需产品裁决（fork 时用户可能正想换 launch 配置），且截断点早于首条 model_change 时无 entry 可恢复——登记待裁决，未随 P1 一并修（gate 只实证了 restore 路径）

### 6. `--model` 是 pattern 非精确 ID：大小写/包含匹配可静默换模（PS-01，2026-08-27 事故 A）

- **pi 锚点**：`dist/cli/args.js:245`（help 自述 "Model pattern or ID"）；`dist/core/model-resolver.js` findExactModelReferenceMatch（id 匹配为 toLowerCase 相等，canonical 双命中判歧义作废）→ 无 exact 命中时 contains 模糊 → `localeCompare` 降序取最大
- **机制**：「扩展层校验通过」不代表「子进程按此 id 执行」——两套匹配规则互不知晓；models-store 刷新引入小写变体家族后（PS-11），昨日全等命中的串今日可掉进模糊分支命中别的模型 → 429 无权限空转
- **触发条件**：派发用非全等 id + 合并清单含大小写家族条目
- **处置建议**：已由切片 1 全等裁决结构性拦截（`assertCanonicalModelRef`，start 同步期拒单 + 问句式纠错）；新扩展拼 `--model` 必须经 shared/model-ref.ts（G4 通道禁则拦裸串）；探针断言见 pi-semantics-model-resolution.test.ts

### 7. reasoning 是思考能力总开关，缺失即「仅关」（PS-02，2026-08-27 事故 B）

- **pi 锚点**：`pi-ai dist/models.js:548-558`——getSupportedThinkingLevels 在 `!model.reasoning`（含 undefined）时直接返回 `["off"]`，thinkingLevelMap 仅在开关打开后参与档位计算
- **机制**：同一字段缺失两侧语义相反——pi 解释 undefined 为「关」，历史上前端 resolveAvailableLevels 解释为「支持全档」；GUI 手动添加模型若无 reasoning 字段，思考等级设置恒被钳回 off（用户表象：「设了最高过一会自动变关」，实际从第一毫秒起就是关）
- **处置建议**：已由能力注册表结构性消除（C-pi-12：runtime 经 pi-ai 同源函数算 supportedLevels 下发，前端零推导；addModel 表单显式写 reasoning）——禁止任何域内代码复活「本地推断档位」
- **存量恢复（失败模式 D，2026-09-10 用户数据实测）**：修复前经 discover 合并 / 行级策略写入的模型，models.json 里 `reasoning` 字段可能缺失（pi 判「关」，弹层只剩「关」）。无需迁移脚本，两条路径任选——① GUI：在 Settings → Providers 编辑体里对该模型行重新设置一次思考策略（**含 all-levels**），保存即救回（`pickStrategy` 联动补显式 `reasoning: true` 并重写 thinkingLevelMap）；② 手动：在 `~/.xyz-agent/pi/agent/models.json` 该模型条目补 `"reasoning": true`，重启应用后生效。判据：composer 的思考档位弹层不再只显示「关」

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
- **机制**：settled 边沿驱动的通知通道不会撞上残留 busy 态——notify-ledger 的 settled 边沿 courier 依赖此序；若 pi 未来调换次序，courier 投递时序需重验
- **处置建议**：探针守卫（pi-semantics-agent-session.test.ts）；消费 settled 边沿的新代码可假定回调内 idle，但 pi 升级时此条目自动进重验清单（verifiedWith 门禁）

### 11. plain appendEntry（type=custom）不进 LLM 上下文（PS-09）

- **pi 锚点**：`dist/core/session-manager.js:165-186`——sessionEntryToContextMessages 仅映射 message/custom_message/branch_summary/compaction，兑底返回 `[]`
- **机制**：appendEntry 写的 custom entry 是持久化状态记录，AI 看不到；想让 AI 看到必须走 custom_message（sendCustomMessage）或 sendUserMessage
- **处置建议**：这正是 extension 日志规范选 appendEntry 做「事后排查」通道的技术依据（不耗 token，见 logging-conventions.md）；反向地，靠 appendEntry「通知 AI」的代码是 bug——结果语义通知走账本 courier（C-ext-19）

### 12. chat 轮 cancel 后子进程退出原因呈 exit code 143 而非 signal SIGTERM（协议 v1.x）[HISTORICAL]

> **2026-09 H1 修订**：锚点 `packages/pi-subagent-cli/src/chat-session.ts` 已随 chat 域整族退役（续聊轮 = 新 run + resume 锚点，见上 §12 subagent 大节头部 H1 修订注记），其产物 `engine_round_aborted`/`engine_round_crashed` 错误码一并消失（现树 grep 恒零命中是预期）。pi 的 SIGTERM trap → 自行 `exit(143)` 语义仍适用 run 链任务子进程，观察对象改挂 run 域（`packages/pi-subagent-cli/src/spawn-runner.ts`）——run 任务子进程被 SIGTERM 杀死时同样呈 exit code 143 而非 signal。

- **现象**：chat 轮被 cancel/强关后，record/journal 的失败原因显示 `exit code 143` 而非 `signal SIGTERM`（对比：run 域引擎进程死亡呈 `signal SIGTERM`，见 conformance engine-crash 用例）。
- **根因**：pi rpc-mode 对 SIGTERM 的 trap 是优雅收口后自行 `process.exit(143)`（`dist/modes/rpc/rpc-mode.js` trap 段）——子进程以**主动 exit** 结束，OS 层无信号终止事件，chat-session 只能拿到 (143, null)。
- **判读**：信息仍如实（exit 143 + `engine_round_aborted`/`engine_round_crashed` 分诊）；两者语义差异 = 「引擎进程被信号杀死」（W6 钉的引擎层形态）vs 「pi 收到 SIGTERM 自行退出」（chat 子进程形态）。比对事故取证（2026-09-08 session 01a08091）时注意该形态差异。
- **处置**：无需修复；若需区分 cancel 主动杀与外部杀，看 record 的 `engine_round_aborted`（cancel/close/superseded）与 `engine_round_crashed`（外部信号/崩溃）错误码分诊（`packages/pi-subagent-cli/src/chat-session.ts`）。

### 13. 自装引擎包（XYZ_AGENT_ENGINE_ROOTS / config.json engines）的发现优先级，与自装旧版包 chat 报 engine_capability_unsupported（协议 v1.x）

- **现象**：用户自装引擎包后 chat 请求（conversation 形态）同步报 `engine_capability_unsupported`；或多处安装同 id 引擎时「装了新版却不生效」。
- **发现顺序与覆盖**（权威源 `packages/subagent-core/src/execution/engine/engine-discovery-scan.ts` scanEngines + engine-discovery-roots.ts）：扫描装载序 = ①L1 env `XYZ_AGENT_ENGINE_ROOTS`（`path.delimiter` 分隔的绝对路径列表；空段跳过、非绝对路径丢弃 + warn、去重）→ ②L1 宿主发现根（`HostServices.discoveryRoots().engines` + 调用方附加根）→ ③L2 node 解析（宿主入口 argv[1] 上溯 node_modules 链；打包态与 zsw vendor 态该级为空）→ ④L3 显式配置 `<agentDir>/subagents/config.json` 的 `engines{}` 段。**同 id 后装载覆盖先装载**（debug 留痕 same-id override）——生效优先级与扫描序相反：L3 config.json > L2 node_modules > L1 宿主根 > L1 env。发现时机 = session_start 扫描一次、装载即缓存（`hasEngine` 未命中走 ensureEngineDiscovered 同步补扫，只读 manifest 不 spawn 引擎）；清单投影落 `<agentDir>/subagents/engines.json`（卸载旧包后下次 session_start 扫描自动从清单消失）。逐包 skip（非引擎包即无 manifest 段者刻意静默不留痕）/unusable 留痕在 `[engine-discovery]` 前缀宿主日志。
- **包级三态**（inspectEnginePackage）：ok（装载）/ skip（无 manifest 段 = 非引擎包静默跳过；manifest 缺 id/bin/protocol、bin 解析不出 → warn 跳过）/ unusable（manifest protocol 整数超出 core 支持域 [1,2)、bin 不存在或不可执行、L3 command 解析失败 → 不装载不进清单）。
- **chat 报 `engine_capability_unsupported` 的错误路径**：自装的是**早于 chat 承载的旧版引擎包**时，发现装载本身成功（protocol 在支持域内），但其 manifest `capabilities.conversation` 声明 `'unsupported'`，或整段/单键缺失——缺失按最保守值兜底（`engine-manifest.ts` CONSERVATIVE_CAPABILITIES，conversation 亦为 `'unsupported'`，warn 留痕）。chat 请求派发的同步段、record 创建前被能力预检拦截（`capability-gate.ts` assertTaskShapeSupported → SDK `engineConversationUnsupportedError`），错误文案含恢复指引「去掉 conversation 参数（一次性任务默认形态），或修 manifest capabilities / 升级引擎包（若引擎实际支持该能力）」。注意与「protocol 版本不兼容」区分：后者 unusable 不装载，报的是引擎不存在/清单缺失，不会走到 capability 拒绝。
- **处置建议**：①升级引擎包到与 core 配套版本（能力声明的载体 = 引擎包 manifest，升级是最短恢复路径）；②旧包属自装残留 → 删除 env 根目录下旧包或 config.json `engines{}` 段对应条目，重开 session 让扫描与 engines.json 投影收敛；③「装了新版不生效」按上面覆盖顺序排查——旧包坐在更晚装载通道（L3 config.json 最晚）时会盖住新包，看 `[engine-discovery]` same-id override debug 留痕确认最终生效源；④L3 手工配置条目无 manifest 面，capabilities 取全保守值，chat 请求必被 gate 拒——属预期形态（仅适用于无 chat 需求的裸命令引擎）。
