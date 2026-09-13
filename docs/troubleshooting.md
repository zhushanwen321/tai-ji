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

**打包模式启动应用获取完整日志**：终端启动 `/Applications/太极.app/Contents/MacOS/TaiJi`（推荐，直接看到所有 console 输出）；或 `log stream --predicate 'process == "TaiJi"' --level debug`；或 Console.app 搜索 TaiJi。

## 关键诊断路径

**打包后应用结构** (`/Applications/太极.app/Contents/Resources/`)：

```
Resources/
├── app.asar.unpacked/dist/runtime/   # runtime bundle（必须在 unpacked 目录）：index.cjs 入口 + plugin-bootstrap.cjs
├── pi/                                # bundled pi 二进制（pi-darwin-arm64）+ agent/ skills/extensions + assets/
├── extensions/                        # builtin pi extensions（esbuild bundle 产物）
│   └── @zhushanwen/<pkg>/
└── bin/xyz-settings                   # xyz-settings CLI（pi Skill 引用）
```

> **注**：builtin pi extensions（数量与分组以 `packages/shared/src/mandatory-extensions.json` 为 SSOT）随应用打包内置在 `Resources/extensions/@zhushanwen/` 下，离线可用、无需安装。其中 infrastructure 级不可禁用，feature 级可在 Settings → Extensions 中禁用/启用。第三方扩展（任意 npm 包 / 本地目录 / git）经 Settings → Extensions 安装到数据目录。

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
ls -la /Applications/太极.app/Contents/Resources/pi/pi-darwin-*   # 二进制是否存在
file /Applications/太极.app/Contents/Resources/pi/pi-darwin-arm64  # 是否 Mach-O 可执行
chmod +x /Applications/太极.app/Contents/Resources/pi/pi-darwin-arm64  # 权限丢失时修复
uname -m   # 架构匹配检查（Intel Mac 上只有 arm64 二进制）
/Applications/太极.app/Contents/MacOS/TaiJi   # 终端启动看完整错误
```

常见原因：pi 二进制缺失（`extraResources` 配置错误或 `resources/pi/` 内容不完整）、权限丢失（`chmod +x`）、架构不匹配（Intel Mac 装了 arm64-only DMG）、symlink 问题（`resources/pi/` 有指向外部绝对路径的 symlink，打包后目标不存在）。

### 2. Runtime 启动失败："Runtime bundle not found" 或 "Runtime health check timed out"

```bash
ls -la /Applications/太极.app/Contents/Resources/app.asar.unpacked/dist/runtime/

# 手动启动 runtime 冒烟测试，然后 curl http://localhost:9999/health
XYZ_AGENT_PACKAGED=1 ELECTRON_RUN_AS_NODE=1 \
  /Applications/太极.app/Contents/MacOS/TaiJi \
  /Applications/太极.app/Contents/Resources/app.asar.unpacked/dist/runtime/index.cjs \
  --port=9999
```

常见原因：`asarUnpack` 失效（`files` 排除了 `dist/runtime`）、`tsup.config.ts` 的 `noExternal` 缺少新依赖（运行时 `Cannot find module`）、端口范围 3210-3220 全部被占用。

### 3. 端口冲突

```bash
cat ~/.xyz-agent/runtime.port                      # 当前 runtime 端口
lsof -i :3210 -P | grep LISTEN                     # 端口占用
lsof -i :3210-3220 -P | grep LISTEN | awk '{print $2}' | sort -u   # 清理残留进程前先定位 PID
```

### 4. Extension 相关问题

builtin pi extensions（数量与分组以 `packages/shared/src/mandatory-extensions.json` 为 SSOT）随应用打包内置，不经过 npm 安装：

```bash
ls /Applications/太极.app/Contents/Resources/extensions/@zhushanwen/   # 打包产物中的 builtin extensions
cat ~/.xyz-agent/agent/settings.json                                    # builtin 扩展不生效时查是否被禁用
```

第三方扩展经 Settings → Extensions 页面安装，走 `npm install` 到数据目录，安装失败最常见原因是网络：

```bash
ls ~/.xyz-agent/npm/node_modules/@zhushanwen/                 # 用户级 npm extension 安装目录
cat ~/.xyz-agent/agent/settings.json | grep '@zhushanwen/pi'  # settings.json packages[] 是否记录
npm view @zhushanwen/pi-goal version                          # npm registry 可达性
```

安装失败错误码来自 npm installer：`not_found`（包名错误）、`network`（npm registry 不可达）、`extract` / `integrity`（下载内容异常）。

### 5. Dev 模式 Vite 不更新

```bash
lsof -i :1420 -P | grep node
# 确认 1420 端口属于当前 worktree，且进程 cwd 指向当前 worktree 的 renderer 目录
```

### 6. subagent 没走 relay 通道：先查首启执行器探针

relay 激活前的执行器探针（spawn 执行器跑 `--eval "process.exit(0)"`）**失败会被缓存到 runtime 重启为止**，之后每次 spawn 主 pi 都直接回落直连、不再重试——「subagent 为什么没走 relay」第一件事查首启日志：

```bash
grep "node executor probe failed" ~/.xyz-agent/logs/runtime-*.log   # dev 用 ~/.xyz-agent-dev
```

另有 staged 代理脚本缺失、socket server 未监听两个静默不激活的常态路径，均只表现为回落直连。机制细节见 relay 模块（`packages/runtime/src/` relay 相关源码注释，待后续批次补注释）。

### 7. bash 工具里启动 Electron 二进制被静默降级纯 node 模式（ELECTRON_RUN_AS_NODE=1）

打包模式下 relay 激活时给主 pi 进程 env 注入 `ELECTRON_RUN_AS_NODE=1`（代理 CLI 复用 Electron 二进制当纯 node 跑所必需），并经握手帧透传给 relay 子进程及后代——subagent 的 bash 工具里启动任何 Electron 二进制（如 `npx electron .`）会被静默切到纯 node 模式：无窗口、无报错。定位：bash 工具里 `env | grep ELECTRON`。这是 relay 通道的刻意设计，终端服务不受影响（TerminalService 独立构造 env 已剥离）。机制细节见 relay 模块（源码注释待后续批次补齐）。

### 8. runtime 启动即退出："fatal: relay server init failed"

relay socket server 在 runtime listen 后同步初始化，失败即 fatal + exit 1（fail-fast：覆盖/复用 socket 会劫持他人注册表，宁可不起）。常见原因：`<dataDir>/run` 不可写、残留 socket 文件被活实例持有：

```bash
ls -la ~/.xyz-agent/run/          # dev 用 ~/.xyz-agent-dev
lsof | grep relay-.*\.sock
```

机制细节见 relay 模块（源码注释待后续批次补齐）。

### 9. agent 会话内执行 validate-runtime-bundle 失败："Bundled pi binary not found"

**症状**：agent 会话内跑 `bash scripts/validate-runtime-bundle.sh` 报 `[runtime] fatal: relay server init failed: Bundled pi binary not found`；或其它依赖「打包态判定」的行为异常（如 `isPackaged()` 返回错误结果）。

**根因**：agent 会话 env 泄漏了 `XYZ_AGENT_PACKAGED=1`（打包标记只在 main→runtime 注入链上有意义），会话内再起的 runtime 子进程误判打包态、按打包路径解析捆绑二进制。

**如何确认**：

```bash
printenv | grep XYZ_AGENT_PACKAGED   # 有输出 = 泄漏确认（出站契约不改变本会话自身 env 快照）
env -u XYZ_AGENT_PACKAGED bash scripts/validate-runtime-bundle.sh   # 旁证：剥除后应恢复正常
```

若仍命中，说明该调用点未经出站契约构建器，带报错文件行号去 `.githooks/check_spawn_env_boundary.py` 豁免名单核对。治理：约束 C-proc-09（子进程 env 出站契约，`buildOutboundChildEnv` deny 剥除）+ pre-commit 守卫 `.githooks/check_spawn_env_boundary.py`，详见 [design/env-propagation-boundary.md](design/env-propagation-boundary.md)。

### 10. 升级中断手动恢复（升级脚本 staging 状态机残余窗口）

自动升级在换装阶段（备份 mv 与原子换装 mv 之间，毫秒级窗口）被断电/强杀命中时，app 无法自愈（自愈代码运行在 app 进程内，此时无执行机会）：**双击图标无反应、`/Applications` 下 `太极.app` 缺失，同时存在 `太极.app.old` / `太极.app.new`**。（`.old` 与 `.new` 均为完整可用副本，缺失的只是正式位置的名字。）

```bash
ls -la /Applications/ | grep '太极.app'   # 识别残留：太极.app 不在列表，.old 与 .new 同时存在

# 二选一恢复（执行后 app 即可正常启动）：
mv /Applications/太极.app.old /Applications/太极.app   # 回到旧版（丢弃未装完的新版）
mv /Applications/太极.app.new /Applications/太极.app   # 改用手动装新版（若 .new 异常可再换回旧版命令）
```

补充：`.old` 或 `.new` 单独残留（`太极.app` 在位且可启动）属良性残留，下次启动自动清理；从 DMG 只读卷运行时升级会被拒绝（update-result 写 `read-only volume`），请先将 `太极.app` 拖入「应用程序」文件夹再触发升级。

### 11. pnpm install 报 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY（间歇，单跑却成功）

**现象**：commit / e2e 脚本里 `pnpm install` 间歇失败（非 TTY abort）；同一命令单独重跑有时成功（假象：管道 `| tail` 后 `$?` 是 tail 的退出码）。

**根因**（2026-09-03 PR #196）：pnpm store 路径默认随 **HOME** 解析。引擎侧（覆写 HOME 的沙箱）pre-commit 内 verify-*.sh 自含 install 把引擎侧 store 写进 `node_modules/.modules.yaml` 的 `storeDir`；本地（正常 HOME）install 发现布局过期 → 判定删除重建 → 非 TTY abort。**双向翻转**：谁最后 install 谁的 storeDir 生效。

```bash
grep storeDir node_modules/.modules.yaml
# ~/.pnpm-store/v10 = 本地布局（健康）；~/.zcode/zsw/... = 被引擎侧翻转（先恢复再 commit）

CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install   # 约 6-7s 重建本地布局，然后重试 commit
```

**防护**：护栏 `.githooks/check_pnpm_store_layout.sh`（pre-commit 第 0 段 + validate-runtime-bundle Gate 0），翻转即红并输出 [FIX] 指引。根治已落地（引擎共享宿主 HOME），护栏语义 = 防 HOME 覆写回退（正常恒绿，红 = 回退信号）。

### 12. subagent 完成后不回收 / 回收慢：sessionFile 获取链与 workflow 域守护特征串（2026-09-10 重放移植重写；2026-09-11 H1 续聊链修订）

> 权威 SSOT：[design/subagent-agent-end-recovery-replay.md](design/subagent-agent-end-recovery-replay.md) + [architecture/subagent-chat-run-unification.md](architecture/subagent-chat-run-unification.md)，机制与串语义以 SSOT 为准，本节只留排障入口。**防误判**：2026-09-10 前的旧特征串（`backfilled via late get_state response` / `located via sessionDir scan` / `unobtainable after 15s recovery window` / `no-descendant fast path` 等）与 chat 域热路径日志面（roundLifecycle 相位帧 / `interact` / ChatSessionRegistry / `chat-round-first-round-watchdog`）在现树均已不存在——按旧串 grep 恒零命中是预期，不是日志丢失。

排障入口（三条现行 warn 特征串；①③ 来自 `pi-subagent-cli`，② 来自 `subagent-core`；日志统一落 `<dataDir>/agent/logs/subagents-<date>.log`，裸 pi CLI 需 `XYZ_AGENT_EXT_LOG=1` 或 `XYZ_AGENT_DEBUG=1` 才落盘）：

```bash
grep -E "\[sessionfile\]|agent_end get_state backfill|workflow no-progress watchdog" \
  ~/.xyz-agent/agent/logs/subagents-*.log   # dev 前缀换 ~/.xyz-agent-dev/agent/logs/
```

- ① `[sessionfile] unobtainable ... (all acquisition paths missed)` — sessionFile 四路获取（spawn 握手 / 迟到 response / agent_end 惰性回补 / close 后缀反查）全 miss，transcript 锚点缺失但不会误配；按 warn 尾句人工归档或重派任务，高频出现说明握手链系统性故障。
- ② `agent_end get_state backfill failed` — 惰性回补链抛错，`killChild` 在 finally 必达（run 不因回补失败挂死），全 miss 归 ①。
- ③ `workflow no-progress watchdog ... fired` — workflow 域 30min 无协议事件/stream delta 的静默楔死熔断（cancel 帧 → 收敛窗 → killAll）；产出仍在刷新时不 fire。注意 env `XYZ_SUBAGENT_SETTLED_WATCHDOG_MS<=0` 会连带关闭本熔断。

H1 后续聊要点：每轮续聊 = 独立 run（`RunParams.resume` 续写原 session 文件），无长驻 chat 进程形态；跨重启续聊数据源 = `<sessionFile>.record-binding` 绑定 sidecar——「subagent not found or not owned」按序查 record 存在性 → sidecar 文件 → `cold-lookup.ts` 恢复。「失败后无通知」或「失败即 closed」属异常，查 Continuation onRunSettled 失败分支。workflow origin record 排查须带 `includeFinished:true` + `includeWorkflow:true` 成对；成败判读看 outcome 不看 closedReason（见观察项 #14）。

### 13. record 直写守卫拦截（eslint no-restricted-imports / check-record-write-surface）

> 权威 SSOT：[architecture/subagent-record-persistence-consolidation.md](architecture/subagent-record-persistence-consolidation.md)（§3.3 守卫分级 / §3.1 意图级 API 表）；约束登记 C-data-20。

record 持久化写面（`.state` / `.alive` / manifest / sessions-index / `subagent-record` entry）的唯一写入口 = `RecordStore` 意图原语（`packages/subagent-core/src/execution/record-store.ts`）。两级守卫：eslint `no-restricted-imports`（store 外禁 import 终态/.alive/sessions-index 写函数，模块边界一级拦截）+ pre-commit `scripts/check-record-write-surface.mjs`（类方法 / 字面量直写形态 grep 门兜底）。

- 处置：改调 RecordStore 意图原语（`markFinalized` / `markCancelled` / `acquireWriteLease` / `markIdleArchived` / `rematerializeManifest` / `markBatchFinalized` / `reportRecordTransition`）；读函数不受限。复跑：`node scripts/check-record-write-surface.mjs`（应输出 store 外零命中）。
- 误拦判定：新写面确属 store 外自有域时，在守卫脚本 `EXTENSION_DOMAIN_ALLOWLIST` 登记文件并注明设计依据（登记处即台账），禁止行内豁免绕过。

### 14. catalog provider 自定义网关失效 / 端点与官网不符（启动清洗剥除手编网关，2026-09-10 D2 已接受代价）

```bash
grep "stripped unmarked provider-level keys" ~/.xyz-agent/logs/runtime-*.log   # dev 用 ~/.xyz-agent-dev
```

命中即启动清洗剥除了未显式标记的手编 catalog 网关（判定锚 = providers.json extras 的 `gatewayBaseUrl` 标记，无标记即剥）。恢复：Settings → Providers 展开该 provider，在「端点（自定义网关）」重设网关 URL 并保存一次（标记落盘后不再被剥）。判定锚权威 = `packages/core/src/domain/settings/use-provider-edit.ts` 防线注释（原设计文档 catalog-provider-field-authority.md 已删除，git 可追溯）。

### 15. Coding Plan 额度查询失败 / 数据疑似过期（2026-09-10 配置交互重构）

先核对「界面显示的凭证来源」与磁盘字段/文件是否一致，不猜凭证有没有填（`no-credential` = 按 `credentialSource` 选中的链路解析不到凭证，不是「凭证一个都没有」；`exclusive` 缺专属 Key 文件即失败、不回退）。检查三命令（`CD=~/.xyz-agent`，dev 用 `~/.xyz-agent-dev`）：`grep "\[quota\] fetch failed" $CD/logs/runtime-*.log | tail -20`（失败原因）· `grep -n -A6 '"quota"' $CD/pi/agent/config/providers.json`（credentialSource 字段）· `ls -la $CD/secrets/`（secrets 实际文件）。

恢复：失败态浮层的「刷新/配置」双入口；设置页「保存并测试」是唯一落盘 + 查询动作，齐备性不满足时按钮置灰并给字段级提示。机制权威 = quota 配置相关代码注释与约束登记（原设计文档 design/coding-plan-quota-config-ux.md 已删除，git 可追溯）。

## pi 数据布局迁移（方案 B，2026-09-10）

数据布局已对齐 pi 0.84.x 默认布局：pi 的 agent 目录从 `<dataDir>/pi/agent` 上移到 `<dataDir>/agent`，`<dataDir>/pi/` 层退役（迁移备份为 `pi.backup-v2-<ts>/`）。旧版数据目录（`~/.xyz-agent` / `~/.xyz-agent-dev`）各跑一次 `node scripts/migrate-pi-layout-v2.mjs <数据目录>`（推荐「先迁后升」时序），新装机无需迁移。脚本幂等可重入（运行中进程检测 → `pi/` 原子改名备份 → agent 上移 → 旧 session 按 cwd 分发 → 输出迁移报告），支持「先升后迁」续传与中断重跑。识别旧布局残留：runtime 启动 WARN 或 session-reader `doctor` action。迁移后鉴权异常 / provider 缺项先查报告「冲突清单」；操作细节、回滚与备份清理命令见脚本头注释与迁移报告尾部。

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

`git status` **必须带 `--untracked-files=all`（`-uall`）**：默认把 untracked 目录折叠成带尾斜杠的单行，与文件树 `FileNode.path` 失配 → overlay key 查不到 → 目录徽章误显、子文件无角标。载体：`packages/runtime/src/services/git/git-state-service.ts`（getStatus）；测试基线：`git-state-service.test.ts` 断言命令参数。

### 禁止写死项目绝对路径

runtime 代码禁止出现特定项目的绝对路径或硬编码假设：workspace 根 / bare repo 经 `WorkspaceDetector.detect(currentCwd)` 向上查找 `.bare` 推导；数据目录经 `getDataDir()` / `getConfigDir()`（`packages/shared/src/paths.ts`）。检查：`grep -rn "xyz-agent-workspace\|/Users/zhushanwen" packages/runtime/src/` 不得在逻辑代码中出现。关联教训：git 跟踪的脚本默认无 x 位，执行外部脚本用 `spawn('bash', [scriptPath, ...args])` 包装（直接 spawn 会 EACCES）。

### 跨层机制排查必须穷尽所有层（pi extension ↔ xyz-agent runtime）

分层架构里每层只看自己视角，「我这层没做」≠「没发生」。涉及 pi extension ↔ runtime 的跨层机制排查，必须穷尽所有可能发起方：① runtime 侧（event-interpreter / session-service / message-dispatcher）常只是旁观转发；② pi 进程内的 extension 机制（开发期源码在 `extensions/`，用户机器运行时在 `~/.xyz-agent/npm/node_modules/@zhushanwen/pi-*/src/`）；③ pi 私有协议语义见 `packages/shared/src/message.ts` 注释；④ 设计文档见 `docs/extensions/extension-conventions.md`。判断依据：涉及 pi 的 session loop / turn 调度 / LLM 调用的行为，发起方几乎一定在 pi 进程内。当用户领域知识与排查结论冲突时，**优先怀疑排查范围不全**，而非怀疑用户（事故：explorer 只看 runtime 侧就断言「background subagent 完成后主 agent 不续跑」，真相是 pi 进程内 extension 发起续跑）。

### 模型名大小写漂移致 429（2026-08-27 事故 A）

已并入上方「pi 行为观察项 #6（PS-01）」——机制、排查路径与预防以该条目为准。

### 共享 pre-commit hook 被旧版 install-hooks.sh 覆盖（2026-09-04 复发两次）

bare repo + worktree 结构下，`.bare/hooks/pre-commit` 是全部 worktree 共享的运行时副本，任一旧分支 worktree 跑 `pnpm install` 都会用其分支旧版源无条件覆盖共享副本（护栏段静默消失）。检测：`grep -c 'UNSAFE_STREAM_CHECKER=' <bare>/hooks/pre-commit`（结果 0 即被旧源覆盖）。恢复：在含最新护栏段（≥ 4ecea728f）的 worktree 跑 `bash .githooks/install-hooks.sh`。根治：旧 worktree 分支更新到含护栏段基线；CI invariant 在本地失效窗口期兜底。

### 本地 tag 污染与 GitCode 镜像全量拒收（2026-09-07 v0.9.14 发布事故）

两层叠加：① 镜像 push 时 `refs/remotes/github/HEAD` symref 被 refspec 展开成 `refs/heads/HEAD`，GitCode 判 HEAD 为保留关键字，pre-receive 一票否决整个 push（报错不指向真凶）；② `git fetch upstream`（pi-mono）的 tag auto-follow 把 285 个上游 tag 拉进本地，污染注入镜像。防线已落地：镜像脚本 tags 走独立命名空间 + push 前删 HEAD symref + 推后逐条比对引用集（`scripts/gitcode-release-sync.mjs`）+ 上游 auto-follow 已断（`remote.upstream.tagOpt=--no-tags`）。本地 tag 自愈：`git fetch github --force --prune --prune-tags`。排障提示：GitCode 报 `pre-receive hook declined` 且无 `remote:` 详情时，先二分 refspec 找被拒引用，不要当瞬时故障重试。

### 归因排障默认优先序：读日志 → 代码定界 → 对照实验（2026-09-12 基线实验教训）

症状跨多个候选改动窗口需归因时，**默认按固定优先序推进，禁止跳级上对照实验**：① **读日志**（relay 镜像日志 / `<dataDir>/logs/` / pi 会话 jsonl / 引擎 stdout——现有日志常已含断点位置）；② **代码定界**（`git log`/`git blame` 圈嫌疑窗口，2 分钟级成本，能直接否决错误线索）；③ **对照实验**仅当①②穷尽、且两个候选的修复路径真实分叉时启动。两条核心教训：归因标签与修复动作解耦时实验无价值（最终都要修最新代码）；实验判据本身未经校验时，实验连归因都给不了。

### 周期轮询/兜底定时器的合法性判定（2026-08-28）

新增任何周期定时器（setInterval / 递归 setTimeout 循环 / 轮询兜底）前，必须按下表归类并回答该类的问题；处置台账与外部对照证据见 [architecture/pi-boundary-reliability.md 附录 C](architecture/pi-boundary-reliability.md#附录-c轮询定时器处置全清单2026-08-28d9-执行台账)。**判定原则：变化时对方会主动 push 的信息，禁止用周期 pull 兜底**——兜底轮询会掩盖主链路 bug（事故 B 的 30s 轮询就让「回执丢失」隐性存在了很久）。

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
- **存量恢复（失败模式 D，2026-09-10 用户数据实测）**：修复前经 discover 合并 / 行级策略写入的模型，models.json 里 `reasoning` 字段可能缺失（pi 判「关」，弹层只剩「关」）。无需迁移脚本，两条路径任选——① GUI：在 Settings → Providers 编辑体里对该模型行重新设置一次思考策略（**含 all-levels**），保存即救回（`pickStrategy` 联动补显式 `reasoning: true` 并重写 thinkingLevelMap）；② 手动：在 `~/.xyz-agent/agent/models.json` 该模型条目补 `"reasoning": true`，重启应用后生效。判据：composer 的思考档位弹层不再只显示「关」

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

- **pi 锚点**：`dist/core/session-manager.js:165-186`——sessionEntryToContextMessages 仅映射 message/custom_message/branch_summary/compaction，兜底返回 `[]`
- **机制**：appendEntry 写的 custom entry 是持久化状态记录，AI 看不到；想让 AI 看到必须走 custom_message（sendCustomMessage）或 sendUserMessage
- **处置建议**：这正是 extension 日志规范选 appendEntry 做「事后排查」通道的技术依据（不耗 token，见 logging-conventions.md）；反向地，靠 appendEntry「通知 AI」的代码是 bug——结果语义通知走账本 courier（C-ext-19）

### 12. chat 轮 cancel 后子进程退出原因呈 exit code 143 而非 signal SIGTERM（协议 v1.x）[HISTORICAL]

> 2026-09 H1 后 chat 域整族退役（续聊轮 = 新 run + resume 锚点，见 §12 头注），原锚点与 `engine_round_aborted`/`engine_round_crashed` 错误码在现树 grep 恒零命中是预期。

- **机制**：pi rpc-mode 对 SIGTERM 的 trap 是优雅收口后自行 `process.exit(143)`（`dist/modes/rpc/rpc-mode.js` trap 段）——子进程以主动 exit 结束，OS 层无信号终止事件，宿主只能拿到 (143, null)。该语义仍适用 run 链任务子进程（观察对象 `packages/pi-subagent-cli/src/spawn-runner.ts`）
- **处置**：无需修复；判读时注意「引擎进程被信号杀死」（呈 `signal SIGTERM`）与「pi 收到 SIGTERM 自行退出」（呈 exit 143）的形态差异，比对事故取证时不要误判

### 13. 自装引擎包（XYZ_AGENT_ENGINE_ROOTS / config.json engines）的发现优先级，与自装旧版包 chat 报 engine_capability_unsupported（协议 v1.x）

- **症状**：自装引擎包后 chat 请求同步报 `engine_capability_unsupported`；或多处安装同 id 引擎时「装了新版却不生效」。
- **处置建议**：同 id 引擎「后装载覆盖先装载」（生效优先级与扫描序相反：L3 config.json > L2 node_modules > L1 宿主根 > L1 env），发现顺序、包级三态与能力兜底的细节以 `packages/subagent-core/src/execution/engine/engine-discovery-scan.ts`（scanEngines）代码为准；`[engine-discovery]` 前缀宿主日志有 same-id override 留痕。旧版引擎包 capabilities 声明缺失/unsupported 时 chat 必被能力预检拒绝（错误文案含恢复指引），升级引擎包是最短恢复路径；注意与「protocol 版本不兼容」（unusable 不装载）区分。

### 14. closedReason:"gc" 是统一终态占位，不是故障（2026-08-27 事故 A）

- **机制**：pi 的 session close 事件把 done/failed/crashed 等全部终态统一坍缩为 `closed + closedReason:"gc"`——"gc" 是「非用户主动关闭」的占位终态，不代表垃圾回收、不代表异常
- **处置建议**：看到它先别当故障查——**看 outcome 字段**（completed / failed / cancelled 一等字段）判成败，禁止对 closedReason 做 switch 推导（历史上下游三处同构各自重新推导成败，是「写入时坍缩」问题类的温床）；若消费方还在读 closedReason 判成败，改为消费 outcome。（暂无 PS 互链：机器登记层未收录该语义锚点，补登记留待后续）
