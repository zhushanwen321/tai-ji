# 环境变量传播边界治理（env-propagation-boundary）技术设计

> **层声明**：当前层 = 技术方案层（跨进程 env 契约机制设计）。下一层产物 = 可实现的接口/模块（出站 env 契约常量 + 构建器模块 + 各进程边界接线 + 守卫脚本），因此本文档 §3 以选型对比与物理数据流为主、§4 采用最严格的真实场景验收标准（tech-design 层敏感准则 5/6/7 全适用）。
>
> **一句话结论**：把 runtime 对外孵化的一切子进程的 env 从「白名单准入后隐式携带产品内部状态」升级为「显式出站契约——deny-by-default 剥除进程自身状态标志、只放行有下游消费证据的功能契约变量」，并以单一构建器模块收编全部 spawn 点 + constraints.json 登记 + pre-commit 静态守卫形成治理闭环；全程 pi 层零改动。

---

## 1. 背景（SCQA）与目标

### 1.1 SCQA

- **S（情境）**：xyz-agent 是多进程体系：Electron main（打包判定用原生 `app.isPackaged`）→ runtime（纯 Node sidecar，打包判定只能靠 env）→ pi（上游仓 RPC 子进程）→ pi 的无数后代（bash 工具、git hooks、subagent、用户终端）。env 是这条链上唯一的「打包与否」传递介质。
- **C（冲突）**：「是否打包」这类**进程生命周期自身状态**没有出站概念——runtime 拿到 `XYZ_AGENT_PACKAGED=1` 后，经既有的入站白名单放行给了所有子进程及其后代。这些标志离开产品边界后在无关进程里改道行为分支。
- **Q（问题）**：谁来决定一个产品 env 变量可以穿越哪条进程边界？现状答案是「没人决定」——每一处 spawn 各自为政，边界契约是隐式的。
- **A（答案）**：建立**双向显式 env 契约**：入站（谁可以进来）沿用既有 `ENV_WHITELIST_PREFIXES` SSOT；出站（谁可以出去）新增小型 deny 清单 + 显式 forward 依据 + 单一构建器收编全部 spawn 点，并登记约束 + 守卫防回归。

### 1.2 受害案例（2026-08 实录，行为已由探针复现）

在打包版太极.app 的 agent 会话里，对本仓库 worktree 执行 `git commit`：

1. pre-commit hook 运行 `scripts/validate-runtime-bundle.sh`；
2. 该脚本 [6/6] 步骤以 `node apps/electron/dist/runtime/index.cjs --port=<port>` 启动隔离 runtime；
3. 这个 runtime **继承了会话进程链上的 `XYZ_AGENT_PACKAGED=1`**；
4. runtime 启动时 `RelayRegistry` 构造器急切解析 pi 命令（`packages/runtime/src/infra/relay/relay-registry.ts:190`），`findPiExecutable` 命中打包分支（`packages/runtime/src/infra/pi/find-pi-executable.ts:26`），要求 cwd 下存在捆绑二进制；
5. 开发目录没有 `<root>/pi/pi-darwin-arm64` → `findPackagedPi` 抛错（`find-pi-executable.ts:45-54`）→ `[runtime] fatal: relay server init failed` → 健康检查失败 → **commit 被自家构建校验挡住**。

临时绕法是 hook 触发前 `env -u XYZ_AGENT_PACKAGED`。绕法的存在说明缺陷已知但没有收敛机制，下一个新变量必然重演。已有反例先例：`terminal-service.ts` 曾因 `ELECTRON_RUN_AS_NODE` 泄漏污染用户终端，PR #105 做了点位删除，但同类思路没有推广到其他边界。

### 1.3 设计目标

| 编号 | 目标 | 判定方式 |
|------|------|----------|
| G1 | 产品内开发操作不再被产品自身 env 标志干扰 | 会话内 `git commit` 全绿，无需 `env -u` |
| G2 | 最小暴露面：进程自身状态标志与凭证不出产品边界 | 会话 bash `printenv` 与契约快照比对，无 `XYZ_AGENT_PACKAGED` / `XYZ_RUNTIME_TOKEN` |
| G3 | 未来新增任何产品 env 变量不再重蹈覆辙（防复发） | 新 spawn 点写漏构建器时 pre-commit 报错；透传必须有消费证据 |
| G4 | 反向边界（用户 shell → dev 链）既有防线不回归 | `XYZ_AGENT_PACKAGED=1 pnpm run dev` 行为与现状一致 |
| G5 | `ENV_WHITELIST_PREFIXES` SSOT 单一权威地位不被破坏 | `check_env_whitelist_sync.py` 通过；SSOT 定义点唯一 |

### 1.4 Scope

- **In**：runtime 及 Electron main 全部子进程 spawn 点的 env 出站契约；出站清单 SSOT；守卫与约束登记；与入站白名单 SSOT 的关系界定。
- **Out**：pi 上游仓任何改动（[MANDATORY] 红线）；`ENV_WHITELIST_PREFIXES` 本体内容调整（D2 论证为何不动）；pi/bash 工具内部继承实现（不可控面，只做上游边界收口）；文中点名之外的 shell 脚本改造。

---

## 2. 现状与问题分析

### 2.1 关键术语（首次出现，绑实例）

- **入站白名单（inbound allowlist）**：子进程**能从父进程继承什么**。现行实现 `ENV_WHITELIST_PREFIXES`（`packages/shared/src/constants.ts:72-81`）。例：runtime 能继承 `NODE_*`、`PATH`、以及整个 `XYZ_*` 前缀。
- **出站契约（outbound contract)**：runtime **孵化子进程时主动给什么 / 不给什么**。现状各 spawn 点自行组装，无统一契约——本案要建的就是它。
- **进程自身状态标志（lifecycle-state flag）**：描述「我这个进程是怎么被拉起来的」的变量，如 `XYZ_AGENT_PACKAGED`。只对持有它的进程有意义，穿越边界即为噪声。
- **功能契约变量（functional contract var）**：为下游功能服务的变量，如 `XYZ_AGENT_DATA_DIR`（runtime 与 pi 内 extensions 必须同源数据目录）。

### 2.2 物理数据流：env 如何穿过进程边界

```
[TaiJi.app 打包版]                        [pnpm run dev]
 LaunchServices 最小 env                    开发 shell（任意导出全量继承）
      │                                          │
      ▼                                          ▼
 ┌─ Electron main ◀───────────────────────────────┘（dev 链：无过滤直达 main）
 │   app.isPackaged ← 原生 API，与 env 无关
 │   buildSafeEnv(extras)                supervisor/process-control.ts:258
 │     入站：process.env × 白名单（SSOT + 'ELECTRON_' 扩展，safe-env.ts:18）
 │     extras：PACKAGED/DATA_DIR/PORT_OFFSET/RUNTIME_TOKEN/RUN_AS_NODE (:259-266)
 │     extras 值 undefined ⇒ 删除（反向残留清除）           safe-env.ts:36-40
 ▼
 ┌─ runtime（纯 Node sidecar）
 │   isPackaged() ≡ process.env.XYZ_AGENT_PACKAGED==='1'   utils/runtime-env.ts:12
 │   【红线】以下 6 处消费点全部读本进程 env，本体动不得：
 │     find-pi-executable.ts:26 · pi-maintenance.ts:108 · relay-paths.ts:58
 │     logger.ts:119 · process-manager.ts:132 · extension-service.ts:131
 │
 │ ① 主会话 spawn：infra/pi/rpc-client.ts:162（调用）、:15-29（私有第二份 buildSafeEnv）
 │     入站：process.env × 白名单 —— 白名单含裸前缀 'XYZ_' ⇒ 所有 XYZ_* 放行 ★真实泄道★
 │     extras：DATA_DIR/PATH 补齐/relay 三件套              process-manager.ts:104-124
 │     追加：PI_CODING_AGENT_DIR                            rpc-client.ts:168
 │     spawn 即整体替换 env                                 rpc-client.ts:255-258
 ▼
 ┌─ pi --mode rpc（上游仓，⛔ [MANDATORY] 不修改源码）
 │   之后的一切（bash 工具、git hooks、subagent…）都是 pi 自己孵化的后代，
 │   继承什么由 pi 决定 —— 我们不可治理，只能在边界①收口。
 └─▶ …（bash → pre-commit hook → validate-runtime-bundle.sh → 又一个 runtime…）
```

**根因定谳（修正任务原始假设）**：泄漏不是「pi 子进程默认全量继承」。rpc-client 存在 deny-by-default 的白名单过滤，真正的泄道是**白名单里的裸前缀 `'XYZ_'`（`constants.ts:74`）把 runtime env 中全部 `XYZ_*` 当作合法透传物整段放行**——包括只在 runtime 自身有意义的生命周期标志。治理对象因此不是「补全过滤」，而是「给出站面立契约」。

### 2.3 审计 A：进程边界 × env 形态总表

盘点方法见 §2.5，共 **8 类边界**：

| # | 边界 | 调用点（已核实行号） | env 组装形态 | 问题定性 |
|---|------|---------------------|--------------|----------|
| B1 | 开发 shell → Electron main（dev 链） | `apps/electron/package.json:14-17` | 无任何过滤，全量继承 | 反向入口；prod 由 LaunchServices 最小 env 天然防护 |
| B2 | main → runtime | `supervisor/process-control.ts:258`（extras :259-266） | 入站白名单（SSOT+`ELECTRON_`）+ extras + undefined⇒删除 | **健康**（本项目唯一完备的双向契约样板） |
| B3 | runtime → 主会话 pi | `infra/pi/rpc-client.ts:162,:168,:255` | 第二份私有 buildSafeEnv（:15-29，不支持 undefined 删除语义，与 main 版行为已漂移）+ 裸 `'XYZ_'` 整段放行 | **本案泄道**；两份 buildSafeEnv 即重复实现漂移的既成证据 |
| B4 | pi → 全部后代 | pi 上游实现 | 全量/近似继承（本会话 bash 实测携带 4 个 XYZ_/PI_* 变量） | 不可治理（红线），倒逼必须在 B3 收口 |
| B5 | runtime → 嵌套 pi（relay 受托 spawn） | `infra/relay/relay-registry.ts:314`（buildChildEnv :173-182） | 握手帧透传，仅剥 5 个 relay 定位键，不再过白名单 | 泄漏沿嵌套链传播；无二次收口 |
| B6 | runtime → plugin 宿主/沙箱 | `plugin-host-process.ts:392,:394,:397` | `{...process.env}` 全量 + 强制 `ELECTRON_RUN_AS_NODE=1`（sandbox 另注 `XYZ_PLUGIN_SANDBOX_DIR`） | 产品标志一并漏入三方插件进程 |
| B7 | runtime → 用户终端 PTY | `terminal-service.ts:93`（buildEnv :229-250） | 全量副本，仅删 ELECTRON_ 三键（PR #105 先例） | PACKAGED/TOKEN 仍漏入用户 shell |
| B8 | runtime → 自有脚本/git | `shell-runner.ts:63`、`git-executor.ts:40-47`、`reap-orphan-pi.ts:225`(ps 只读无害) | 未提供 env ⇒ **隐式全量继承**（含 `ELECTRON_RUN_AS_NODE=1`） | 与 PR #105 同病未治：worktree 脚本内再起 node/electron 会退化为 Electron GUI 语义 |

无害特例一处：`infra/relay/relay-env.ts:68` 探针 spawn（手工 env、stdio ignore、不触达下游），进守卫豁免名单（U7）。

### 2.4 审计 B：产品 env 变量流向表

**审计方法（可复核）**：`rg -o 'XYZ_[A-Z0-9_]+' -g '!node_modules' -g '!dist'`（branch `fix-add-session-to-project`，2026-08-27）得 **41 个候选名**；逐一回查生产代码赋值/读取锚点，剔除文本误报后得 **28 个真实 env 变量**（A-E 组）+ **13 个非 env 归类**（F 组）。`TAIJI_` 前缀：**0 命中**（仅 CSS token 命名）。以下行号均为本次会话 grep/read 复核值。

#### A 组：main ↔ runtime 启动契约（核心争议面）

| 变量 | 设置点 | 穿越 | 消费点 | 泄露危害判定 |
|------|--------|------|--------|---------------|
| `XYZ_AGENT_PACKAGED` | main 注入（`process-control.ts:260`；dev 下 undefined 清残留 `safe-env.ts:36-40`） | B2 合规；B3/B4/B5/B6/B7/B8 无合规依据 | runtime 六处（§2.2 图）；**生产代码消费者全部位于 runtime 进程自身**，pi 子树零消费（grep 证实） | **有害**（本案元凶，探针 P1/P2 实锤）。出站应为零 |
| `XYZ_AGENT_DATA_DIR` | 用户 shell；dev 缺省 `~/.xyz-agent-dev`（`main.ts:123`） | B2 extras(:262)；B3 **显式注入**（`process-manager.ts:124`，与白名单双保险） | runtime `shared getDataDir()`（`shared/src/paths.ts:40-42`）；pi 内 extensions（`subagent-workflow/src/execution/engine/common/data-dir.ts:45`） | **合法跨界功能契约**，应显式 forward，不应靠前缀侥幸 |
| `XYZ_AGENT_PORT_OFFSET` | 用户 shell；dev 缺省（`main.ts:125`） | B2 extras(:263)；随白名单漏入 B3 后 | main/runtime 端口计算；pi 子树零消费 | 无害但违反最小暴露；观察名单（D3） |
| `XYZ_RUNTIME_TOKEN` | main 注入（`:266`，WS 鉴权令牌） | B2 extras；白名单漏入 B3/B4…（P2 活体取证） | renderer 经 IPC 读 supervisor；pi 子树零消费 | **有害（安全级）**：任意 hook/npm 脚本可读 WS 凭证。出站应为零 |
| `ELECTRON_RUN_AS_NODE` | main(:259)；relay 探针；plugin-host 强制('1') | B2 extras；漏入 B7/B8 | sidecar/node 语义切换 | 半有害（B8 内 node 退化 GUI）；B7 已删、B8 未删 |

#### B 组：pi 进程内 extensions 的合法跨界功能开关（forward 依据）

| 变量 | 进入 pi 的途径 | pi 子树内消费锚点 |
|------|---------------|-------------------|
| `PI_CODING_AGENT_DIR`（非 XYZ_ 前缀，产品自有契约） | B3 显式追加（`rpc-client.ts:168`） | 数据隔离根目录约定（`shared/src/paths.ts:50-52` 同源推导）＋extensions fallback 读 |
| `XYZ_AGENT_DEBUG` | B3 白名单放行 | extension-logger、subagent-workflow 引擎（extensions 内 4 处生产读取） |
| `XYZ_GLOBAL_AGENTS_DIR` | B3 白名单放行 | `extensions/taiji/system-prompt/src/index.ts:91`（全局 agents 目录 override） |
| `XYZ_SUBAGENT_RELAY_SOCKET/_NODE/_SCRIPT` | B3 经 `getRelaySpawnEnv()` **显式注入**（`process-manager.ts:123`；常量定义 `subagent-workflow/src/execution/relay-env.ts:13-15`，构建 `runtime/infra/relay/relay-env.ts:107-126`，「全有或全无」降级 :110-112） | 代理链路三基础设施；嵌套 spawn 时五键被剥防旧值误导（`relay-registry.ts:177-178`） |
| `XYZ_ZCODE_CLI` | B3 白名单放行 | `packages/zcode-subagent-cli/src/registration.ts:40`（zcode CLI 路径 override，引擎孵化外部 CLI；[W11 终态] core 内建 engines/zcode 已删，core 侧等价通道 = d8-compat `createZcodeEngine` 的 `deps.cliPath`） |

#### C 组：plugin 子进程域

| 变量 | 设置点 | 消费点 |
|------|--------|--------|
| `XYZ_PLUGIN_SANDBOX_DIR` | `plugin-host-process.ts:394`（fork 时注入） | sandbox bootstrap 插件定位 |

#### D 组：dev / mock / e2e / 测试专用

| 变量 | 锚点 |
|------|------|
| `XYZ_MOCK` | `apps/electron/package.json:15`（dev:mock 设置 → vite WS mock） |
| `XYZ_E2E` | `window-factory.ts:68` |
| `XYZ_DEVTOOLS` | `window-factory.ts:78` |
| `XYZ_DEV_ELECTRON_VERBOSE` | `apps/electron/scripts/dev-electron.mjs:160` |
| `XYZ_DEV_BUNDLE_ICON` | `main.ts:239` |
| `XYZ_DEV_MOCK_UPDATE` | `apps/electron/main/dev/mock-release-checker.ts` |
| `XYZ_SKIP_REAL_PI` / `XYZ_TEST_SIGTERM_MARKER` / `XYZ_TEST_ENV_DUMP` | 测试基建（仅测试/脚本引用） |
| `XYZ_SETTINGS_CLI` | `runtime/src/cli/resolver.ts:19`（settings 路径 override，测试/CI） |

#### E 组：runtime 自身行为开关（单点消费为主）

| 变量 | 锚点 |
|------|------|
| `XYZ_LOG_LEVEL` / `XYZ_LOG_MAX_BYTES` / `XYZ_LOG_KEEP_DAYS` | `infra/logger.ts:119` 起 |
| `XYZ_DEBUG_PI_EVENTS` | `infra/pi/event-adapter.ts:1102` |
| `XYZ_EXTENSION_PATHS` | `extension-service.ts:169` + pi 内 `resource-discovery.ts:502`（**双端读取**：跨 B3 两侧都有消费者） |
| `XYZ_AGENT_API_KEY` | `cli/commands.ts:143,:193`（CLI 域凭证透传） |

> E 组多数不必进 pi 子树，但部分存在双端消费且无实证危害——首轮不做全量甄别，统一进观察名单（D3）。

#### F 组：候选名剔除明细（13 项，佐证审计严谨性）

`XYZ_GUI_WIDGET` / `XYZ_ASK_USER` / `XYZ_SESSION_MANAGER` / `XYZ_AGENT_SUBAGENT`：流内协议 marker（`extension-protocol/src/core/markers.ts` 等，`\x00` 前缀 stdout 协议），非 env；`XYZ_AGENT_VERSION`：tsup 构建期 define（`packages/runtime/tsup.config.ts:53`）；`XYZ_DATA_DIR_ENV`：常量名持有者（值即 `'XYZ_AGENT_DATA_DIR'`）；`XYZ_SUBAGENT_RELAY_`：动态拼接前缀痕迹；`XYZ_STREAMING_TIMEOUT_MS`：仅注释提及（`packages/core/src/domain/chat/store.ts:212`）；`XYZ_BUNDLED_PI_BIN` / `XYZ_DEPS` / `XYZ_AGENT` 碎片：无生产消费命中（测试/文档残留）。

### 2.5 审计方法与命中数汇总

```bash
# ① 候选名枚举（去重）
rg -o 'XYZ_[A-Z0-9_]+' -g '!node_modules' -g '!dist' --no-filename . | sort | uniq -c | sort -rn
# ② TAIJI_ 前缀核查 → env 0 命中
# ③ 边界盘点
rg -n 'spawn\(|execFile\(|fork\(|pty\.spawn' packages/runtime/src apps/electron/main \
  -g '!*__tests__*' -g '!*.spec.*'
# ④ 关键行为断言 → 本文全部行号由此复核；探针 P1-P3 见附录
```

数字：候选名 41 → 真实 env 28（A-E 组明细可数）+ 非 env 13（F 组可数）；进程边界 8 类；runtime 自身 `isPackaged()` 消费点 6 处；**实证受害变量 2 个**：`XYZ_AGENT_PACKAGED`、`XYZ_RUNTIME_TOKEN`。

### 2.6 反向边界现状复述与漏网检查（G4）

`safe-env.ts` 已具备「undefined = 显式清除」语义（:36-40，注释点名 `XYZ_AGENT_PACKAGED` 残留场景）——开发者 shell 导出的陈旧标志不会穿透 B2 进 runtime。**漏网评估**：白名单同样含裸 `'XYZ_'`，shell 里任意 `XYZ_FOO=bar` 会经 B1（无过滤）→ B2（放行）→ B3（放行）抵达 pi。危害低于正向（GUI 打包态接触不到用户 shell），且属「来路变量无法甄别意图」的固有问题；本轮不动（守住 G4），「入站白名单管准入、不管来路合法性」写进出站契约文件头注释（§5-U1）。

---

## 3. 解决方案

### 3.1 前提：pi 零改动红线决定收口位置

[MANDATORY] 不修改 pi 源码、不提 PR、不 fork（AGENTS.md 顶部强约束）。B4 及其后代链的继承实现因此是不可治理面。推论：**治理只能在 B2/B3 这两个我们自己拥有的边界上做**，主战场是 B3（B2 已是完备样板）。由此得出正向需求第一原则：

> **一个变量能否出站，取决于它在 pi 子树内有没有消费证据；没有任何消费证据的产品变量，默认不许出站。**

### 3.2 双向边界契约（首版定稿摘要）

| 方向 | 维度 | 内容 | 归属 SSOT |
|------|------|------|-----------|
| 反向（shell→main→runtime） | 入站必传基座 | PATH/HOME/USER/LANG/TERM/NODE_/NVM_/XDG_ 等 + main extras 五件（PACKAGED/DATA_DIR/PORT_OFFSET/RUNTIME_TOKEN/RUN_AS_NODE）+ undefined=删除语义 | `safe-env.ts`（现状保留，G4 不回归） |
| 正向（runtime→pi） | 必传白名单 | 白名单过滤后的父 env 基座 + `XYZ_AGENT_DATA_DIR`、`PI_CODING_AGENT_DIR`、PATH 补齐、relay 三件套（活动时显式注入）；forward 参考 = B 组五项（附 pi 子树内消费锚点） | 本文 U1/U2 新建 |
| 正向（runtime→pi 及一切自有子进程） | 边界剥除清单 | 首版 `['XYZ_AGENT_PACKAGED','XYZ_RUNTIME_TOKEN']`；扩展须补消费/危害证据入档 | U1 `spawn-env-contract.ts` |
| 红线 | 上游不可控面 | B4 及其后代零改动——全部治理压缩在 B3 收口 | [MANDATORY] pi 零改动 |

实施载体即 §5 的 U1（清单）+ U2（构建器）。

### 3.3 终态（使用者视角）

**成功路径**：用户在打包版太极.app 的 agent 会话里说「把这个 bug 修了提交」→ agent 执行 `git commit` → pre-commit 全套检查照常执行 → validate-runtime-bundle 健康检查启动的隔离 runtime 拿到干净 env → `findPackagedPi` 不被错误触发 → 全绿，commit 完成。全程无需知道 `env -u` 的存在。

**契约验证路径**（随时自查）：会话 bash 里跑 `printenv | grep '^XYZ_'`：

| | 修复前（现状实测） | 修复后（契约期望） |
|---|---|---|
| dev 模式 | 无 PACKAGED/TOKEN；有 DATA_DIR/PI_CODING_AGENT_DIR 等 | 同左（不回归） |
| 打包模式 | 含 `XYZ_AGENT_PACKAGED=1`、`XYZ_RUNTIME_TOKEN=<hex>` | **两者消失**；`XYZ_AGENT_DATA_DIR`、`PI_CODING_AGENT_DIR` 及 relay 三件套（活动时）仍在 |

**失败路径与恢复指引**：未来某 extension 需要 pi 子树内的新 env 时，开发者在出站契约清单加一行 forward 条目并附消费锚点注释；若守卫/测试红了，按报错指引回到 `packages/shared/src/spawn-env-contract.ts` 补充证据链——而不是在各 spawn 点手抄变量名。

### 3.4 方案对比

| 维度 | A 最小止血 | B 结构收敛 | C 治理闭环（=B+守卫） |
|------|-----------|-----------|----------------------|
| 做法 | rpc-client env 组装处对 `XYZ_AGENT_PACKAGED`、`XYZ_RUNTIME_TOKEN` 做 `delete`（约 10 行） | 新建单一出站构建器模块收编 B3-B8 全部接线：deny-by-default（状态标志清单剥除）+ 显式 forward + 入站白名单过滤合一 | B 全部内容 + `docs/constraints.json` 登记边界契约 + pre-commit 静态守卫扫裸 spawn + 回归守卫测试常驻 |
| 长期架构合理性 | **低**：下一个生命周期标志自动重演；修正依赖人的记忆；两份 buildSafeEnv 漂移继续恶化；B5-B8 同类洞全留着 | **高**：唯一 choke point，出站语义一处定义；新 spawn 点接入即安全；重复实现消灭 | **最高**：与本项目 constraints.json SSOT 登记制 + pre-commit 守卫文化的既有制度咬合；「防复发」从纪律变成机器强制 |
| 短期成本 | 半小时，当天上线 | 约 1 天（含等价性回归） | 再 +0.5~1 天（守卫脚本 + 登记 + 演练） |
| 风险 | 低但假阴性：钩子链之外的场景（terminal/插件/shell-runner/嵌套 subagent）带病运行 | 中：B8 把隐式继承改显式构建，理论上可能丢白名单外的系统变量——以「白名单基座 + 逐边界等价性测试」控制 | 同 B，另加守卫误报摩擦（豁免清单化管理缓解） |
| 若采用它，§1.2 案例变成什么样 | commit 场景治愈 | 同左，且 terminal / worktree 脚本 / 嵌套 subagent 同时治愈 | 同左，且下次有人裸写 spawn 时 CI 挡住而不是用户挡住 |

**推荐：C 档，按 B → C 分两次 commit 落地**（行为收敛先行、绿灯后上守卫）。A 不是被否决而是被吸收——它的两个 delete 就是 deny 清单的首批成员。单独采用 A 违背长期合理性：三个月后再看，会有五个散落的 `delete XYZ_X` 和一个新的泄密案例。

### 3.5 关键决策与权衡

- **D1 出站模型：deny-by-default，否决严格 allowlist-only。**
  出站面真正危险的变量极少（实证 2 个），而合法系统变量集合巨大且随 OS 变化；逐个 allow 会让每次工具故障排查都先怀疑「是不是又少传了哪个」，运维摩擦不成比例。deny 清单从 2 个实证害项起步，只增不减、增删须过评审（消费证据/危害证据入档）。

- **D2 与 `ENV_WHITELIST_PREFIXES` SSOT 的关系（G5）：共存正交，不动本体。**
  入站白名单回答「外部环境哪些东西准许进来」（策略层：防宿主污染、防凭证串台；constants.ts:76-80 云凭证 ambient 变量的细粒度豁免展示了它的立法精密性）。出站契约回答「我自己身上的东西哪些允许跟随 spawn 出去」。两问不同维度。曾考虑把 `'XYZ_'` 改精细枚举一次性解决：否决。因为入站环节不知道哪个下游消费 `XYZ_GLOBAL_AGENTS_DIR`（那是 pi 子树里 system-prompt extension 的事）——把业务变量生死塞进白名单会让 SSOT 职责膨胀成变量注册表，每次加变量都得动共享常量（guard 摩擦、churn），且依然回答不了「哪些该进 pi」——只有出站契约能答。互引关系登记进 constraints.json（U6）；`check_env_whitelist_sync.py:43` 的 `LOCAL_DEF_RE = const\s+ENV_WHITELIST_PREFIXES` 为精确名匹配，新常量命名 `SPAWN_ENV_OUTBOUND_DENY_LIST` 规避该字面量即可零冲突共存。

- **D3 出站 deny 清单首版只收 2 个实证项，其余进观察名单。**
  进入：`XYZ_AGENT_PACKAGED`（pi 子树零消费 + 行为危害探针实锤）、`XYZ_RUNTIME_TOKEN`（零消费 + 凭证暴露活体取证）。不进的：`PORT_OFFSET`/`MOCK`/`LOG_*` 等——有的双端可读（如 `XYZ_EXTENSION_PATHS` 两侧消费）、有的「似乎该剥但消费面未穷尽」。一次性大面积剥离违反最小变更原则，且每个变量都需独立消费证据——契约清单化之后这类增量恰好变容易。

- **D4 relay 显式注入与继承剥除的等价性。**
  担心「剥掉继承来的 relay 三件套会弄坏实时通道」不成立：三件套本就有显式注入通路（`process-manager.ts:123`）；relay 未激活时返回空对象（`relay-env.ts:110-112`「全有或全无」），继承值从未承担独立职责。嵌套方向 `buildChildEnv`（:173-182）已剥五键防旧值误导，叠加 deny 过滤后不多不少。AC7 用真实 subagent 链验证此等价性。

- **D5 用户终端（B7）：跟随最小剥离。**
  terminal 身份是「用户的 shell」，比 pi 更外部——连 `PI_CODING_AGENT_DIR` 都不该有。首版仅加 deny 两项 + 保持 PR #105 三项删除不变；扩独立 TERMINAL_DENY 属过度设计信号，等实证需求。

- **D6 plugin 宿主（B6）只做增量叠加。**
  `{...process.env}` 全量拷贝对 trusted/sandbox 插件的兼容性属有意设计，无实证受害前不改拓扑，仅叠加 deny 两项删除。诚实标注：plugin 域消费面未逐一审计（无 blocker，超 MVP 范围）。

- **待验证集（实施期核实，如实标注）：**
  ① `XYZ_SUBAGENT_IDLE_TIMEOUT_MS` 进入主 pi 的真实通道（extension 设置进嵌套 frame.env，还是依赖 B3 白名单继承；15 处命中多为测试）；② `XYZ_LOG_LEVEL` 族是否同时被 `extensions/shared/extension-logger` 读取（若是则须并入 forward，否则 extension 日志静默变级）；③ `RELAY_ENV_SESSION_ID/_RECORD_ID` 常量定义文件定位。三项动作各为一次 rg，嵌入 U0/U2。

### 3.6 红线陷阱（实现必读）

- **R1 只操作传给子进程的 env 副本，绝不修改 `process.env` 本体。**
  runtime 自身有 6 处消费点读本进程 env 判定打包态（§2.2 图）。错误示范：

  ```ts
  // ⛔ 禁止：这会让 runtime 自己下一刻的 isPackaged() 返回 false，
  // findPackagedPi→findDevResourcesPi 改道，打包态直接瘫痪
  delete process.env.XYZ_AGENT_PACKAGED
  ```

  正确形态一律是「spread 出副本后在副本上删」（既有正确范式见 relay-registry `buildChildEnv` :174-180）。探针 P1 是反向教材：子进程拿到错标志都会 fatal，本体污染是全局事故。

- **R2 Node spawn 的 env 是整体替换语义。**
  options 提供了 `env`，子进程就得到且仅得到这份对象。构建器输出必须以「白名单过滤后的父 env」为基座（不能从空对象起拼），否则 `PATH/HOME` 静默丢失，故障形态是 hooks 里 `git: command not found` 类远距离爆炸。B8（shell-runner/git-executor 未传 env＝隐式继承）改造成显式构建时最易踩此条。

- **R3 CJS bundle 约束（AGENTS.md #12，validate-runtime-bundle.sh §3 源码级强制）。**
  新增模块位于 `packages/runtime/src/`，禁止 `import.meta`、`fileURLToPath(import.meta…)`、`globalThis.__dirname`（合规范本：plugin-host.ts 的 `typeof __dirname !== 'undefined' ? __dirname : undefined` 兼容层）。新代码均为纯函数/常量，理应自然满足，守卫全量扫描兜底。单元测试禁止直接读写真实 `process.env`（DI 注入或 `vi.stubEnv`），否则测试间互相污染制造假绿/假红。

- **R4 githook 改动的唯一权威入口是 `.githooks/install-hooks.sh`。**
  该脚本以 heredoc 重写 `.git/hooks/pre-commit`（:43-48 生成、:1036 chmod）。任何 pre-commit 检查的增删必须落在 install-hooks.sh 内，然后重跑 `cd .githooks && ./install-hooks.sh` 生效；直接编辑 `.git/hooks/pre-commit` 无效（重装即覆盖）也不进版本库。

- **R5 与既有守卫脚本共存。**
  新检查脚本按 `.githooks/check_*.py` 命名法并在 install-hooks.sh 与其他检查同构注册；豁免名单硬编码在脚本内逐条注明理由（reap-orphan-pi ps 只读、relay-env 探针特殊 env、构建器自身实现处）。
  豁免增量登记（后台任务收殓 `services/session/background-task-reaper.ts` 三调用点）：① `spawnSync('ps')` 进程 start time 只读探测——pid 复用防御（判定逻辑移植自 extension reaper），数组参数不经 shell、显式 timeout，仅读系统进程表、不向下游传递任何数据，与 reap-orphan-pi ps 探测先例同构；② `spawnSync('pgrep')` 收殓补杀的子孙 pid 只读枚举（kill 树兜底残留清理）——数组参数不经 shell，仅读进程表，无 env 出站面，同 reap-orphan-pi 先例；③ `taskkill` Windows 进程树终止（孤儿任务补杀）——数组参数不经 shell、stdio ignore，kill 处置无数据回流通路，同 supervisor/windows-process.ts taskkill.exe 先例。
  豁免增量登记（进程 start time 按需现测 `services/background-task/process-probe.ts`）：`execFileAsync(`（`promisify(execFile)` 产物，powershell Get-Process / ps -o lstart 两调用点）——D6 pid 复用防御的只读探测，数组参数不经 shell、显式 1s timeout，仅读系统进程表回读 stdout，无 env 出站面，与 reap-orphan-pi / background-task-reaper ps 探测先例同构；powershell 分支调用参数跨行，豁免 snippet 只能锚定产物名本身，该产物在该文件的全部调用均属此条裁决范围。同批堵 hook 形态逃逸口：checker 补 promisify 产物名追踪（`const X = promisify(<child_process API>)` 绑定且该 API 确已 import 时，`X(...)` 调用点注册为等价检测模式）——此前 `execFileAsync(` 不命中裸 API 名正则，调用点完全游离于裁决视野外。

---

### 3.7 引擎子进程 env 契约（`buildEngineChildEnv`，W12 迁移期中间态）

子代理引擎协议化（`docs/design/subagent-engine-protocolization.impl-plan.md` §2.12，约束登记 C-proc-12）引入引擎 CLI 子进程形态后，出站契约新增引擎面分支——与 §3.5 D2/D3 的 runtime/main 面共用治理原则（deny-by-default + 消费证据），但**SSOT 落在 `@zhushanwen/subagent-engine-sdk`**（F9：SDK 消费面 zsw 宿主/引擎 CLI 不可依赖 `@xyz-agent/shared`，SDK 是跨宿主 SSOT）：

- **`buildEngineChildEnv(baseEnv, opts)` 三层**（高者覆盖低者，次序写死 = 先过滤后 L0 显式注入）：
  - **L0 基础设施键**（core 过滤之后显式注入，不受放行/剥除约束）：`XYZ_AGENT_DATA_DIR` / `XYZ_AGENT_ENGINE_NODE` / `ELECTRON_RUN_AS_NODE`（执行器为 Electron 二进制时）/ `XYZ_AGENT_SUBAGENT=1`（nesting guard）/ relay 三键 `XYZ_SUBAGENT_RELAY_{SOCKET,NODE,SCRIPT}`（必经 L0——L1 拒绝 `XYZ_SUBAGENT_` 前缀、L2 是 manifest 面，两层都到不了）/ 引擎侧身份 env（`PI_SUBAGENT_ROOT_SESSION_ID` 等）；
  - **L1 deny + 显式剥除**（恒高于 manifest 放行）：`ENGINE_ENV_DENY_LIST` = deny 两键（`XYZ_AGENT_PACKAGED` / `XYZ_RUNTIME_TOKEN`，与 `SPAWN_ENV_OUTBOUND_DENY_LIST` 同成员）+ 凭证键 `XYZ_AGENT_API_KEY` + 父身份键 `XYZ_SUBAGENT_RELAY_{SESSION_ID,RECORD_ID}`（引擎按 `run.params.ctx` 重写，防父身份误归属）+ 防御性剥除三死名 `XYZ_SUBAGENT_RELAY_{STDIN,STDOUT,STDERR}`（全仓零生产写入方，workspace 纪律登记）；
  - **L2 manifest 放行**：manifest `envPrefixes` 声明前缀的引擎私有 env；保留前缀拒绝表 `XYZ_` / `XYZ_AGENT_` / `XYZ_SUBAGENT_`；形态校验 `^[A-Za-z0-9_]+$`（大小写不敏感）；非法条目丢弃 + warn（包继续可用）。
- **常量单源**：`ENGINE_ENV_PREFIXES` / `ENGINE_ENV_DENY_LIST` SSOT 在 `packages/shared/src/constants.ts`，SDK `src/env.ts` 内联镜像（构建期生成物），逐项相等由 `check_env_whitelist_sync.py` 断言，两处改动同批提交；守卫断言 L0 键集合 ∩ L1 deny/剥除集合 = ∅（SDK vitest）。
- **通用出站构建器 SDK 版**：SDK 同时导出 `buildOutboundChildEnv`（deny 剥离终态，供非引擎 spawn 面）。与 shared 版的刻意差异：**缺省不做白名单过滤**（prefixes 省略 = 全量继承父 env + deny 剥除）——SDK 不可 import `ENV_WHITELIST_PREFIXES`，引擎 base 已先经 core 过滤，ambient 面（worktree git 需要 GIT_*/proxy/ssh）必须保留继承面。`packages/subagent-core/src/execution/worktree-{manager,git-ops}.ts` 的两处 git `execFile` 已采纳（R3 MF-C：deny 键不进 git 子进程，git hooks 后代不再可能消费 deny 键）。
- **守卫扩展**：`check_spawn_env_boundary.py` 的 `SCAN_ROOTS` 已含 SDK（`packages/subagent-engine-sdk/src`）与两个引擎 CLI 包（`packages/zcode-subagent-cli`、`packages/pi-subagent-cli`，创建前 WARN 跳过）；`buildEngineChildEnv` 与 `buildOutboundChildEnv` / `composeChildEnvBase` 并列进 `CONTRACT_BUILDER_SYMBOLS`。
- **引擎侧自灭**（SDK `armEngineSelfDestruct`）：主判据 stdio EOF；辅助判据未 ack 反向请求计时超时（缺省 30s，env `XYZ_ENGINE_HOST_REQUEST_TIMEOUT_MS`）；排除面 = 已 ack 的 host/askUser 与两阶段 ack 的长运行 `HostBridge.executeAndAwait`。配套 `spawnEngineChild`（任务子进程唯一 spawn 入口）：硬编码 `detached:false` + `windowsHide:true`，子进程 stdin 恒自有 pipe、绝不继承引擎自身 stdin fd（R9-4②，否则 EOF 主判据失效）。

**【W11 收口终态（原 W12 拖尾四项核对完毕，2026-09-09）】**：① 本文档 B3 条目与 `packages/shared/src/spawn-env-contract.ts` 的 `XYZ_ZCODE_CLI` `piConsumerAnchors` 已回写引擎包新路径（`packages/zcode-subagent-cli/src/registration.ts:40` + core d8-compat `deps.cliPath` 等价通道）；② `check_spawn_env_boundary.py` SCAN_ROOTS 已含 SDK 与两个引擎 CLI 包（W12 主时点落地）且 `packages/subagent-core/src` 已加入（本收口批；**迁移期临时豁免清零，现存 6 条 core 侧永久类豁免**——pid-file/reaper/pi-engine/session-runner×2/worker-host 的只读探测/kill/Worker 场景，EXEMPT_CALLSITES 逐条附理由，语义合理非泄漏面）；③ pi 侧 `buildChildEnv` 5 键剥离已落 `packages/pi-subagent-cli/src/spawn-runner.ts`（`buildOutboundChildEnv` deny 清单承载，SDK `ENGINE_ENV_DENY_LIST` 含 ①`XYZ_AGENT_PACKAGED` ②`XYZ_RUNTIME_TOKEN` ③`XYZ_SUBAGENT_RELAY_SESSION_ID` ④`XYZ_SUBAGENT_RELAY_RECORD_ID` ⑤`XYZ_AGENT_API_KEY`，relay 身份两键在 buildChildEnv 内按 run ctx 显式重写——次序 = 先过滤后注入，与 §2.12 规格一致）；④ 见 ②。

## 4. 验收（真实场景，非单测堆砌）

每条 = 场景步骤 + 通过标准 + 回溯目标。全部为可执行命令或可观察断言，不含「应该没问题」类表述。

### AC1 产品内 agent 会话 git commit 全绿（G1/G3）

- **步骤**：① 构建并安装修复后的打包版 TaiJi.app；② 在 app 会话中对 xyz-agent 任一 worktree 创建临时分支、做一次微改动并 `git commit`（触发全套 pre-commit 含 validate-runtime-bundle）；③ 观察 hook 输出与退出码。
- **通过标准**：commit exit 0；hook 日志出现 `[OK] Runtime Bundle 验证全部通过`；全文无 `Bundled pi binary not found`；未使用任何 `env -u` 或 `SKIP_*`。

### AC2 会话 env 契约快照比对（G1/G2/G3）

- **步骤**：会话 bash 工具内执行 `printenv | sort | grep -E '^(XYZ_|PI_CODING|ELECTRON_)'`；打包版与 dev（`pnpm run dev`）各采样一次，与 §3.3 期望表逐行比对。
- **通过标准**：两种模式下 `XYZ_AGENT_PACKAGED` 与 `XYZ_RUNTIME_TOKEN` 均不出现（diff 计数 0）；`XYZ_AGENT_DATA_DIR`、`PI_CODING_AGENT_DIR` 始终出现；打包模式额外出现的条目不多于 §3.3 表所列。

### AC3 runtime 自身打包判定行为不变（G1 护栏 / R1 正证）

- **步骤**：① 打包版冷启动开新会话发一条消息；② 日志确认 `[process-manager] using bundled pi:` 指向 Resources 布局二进制（`find-pi-executable.ts:56` 日志锚点）；③ 确认日志级别为 info（`logger.ts:119` 打包缺省生效）。
- **通过标准**：会话正常往返；三条日志锚点全部符合打包语义；dev 启动同一代码时三处全走 dev 分支。

### AC4 dev 反向残留保护不回归（G4）

- **步骤**：干净终端执行 `XYZ_AGENT_PACKAGED=1 pnpm run dev` → 应用就绪后做 AC2-dev 的 printenv 采样。
- **通过标准**：应用正常启动可用；采样结果与正常 dev 完全一致（undefined 删除语义 + deny 剥除双保险叠加行为不变）；日志无 fatal。

### AC5 既有守卫与 SSOT 完好（G5）

- **步骤**：① `python3 .githooks/check_env_whitelist_sync.py`；② `bash scripts/validate-runtime-bundle.sh`；③ 确认仓库内 `const ENV_WHITELIST_PREFIXES` 定义仅存于 `packages/shared/src/constants.ts:72`。
- **通过标准**：① exit 0；② exit 0 且七步全 OK；③ 定义点唯一。

### AC6 用户终端净化（G2，PR #105 先例延长线）

- **步骤**：打包版打开内置 terminal → `printenv | grep -E '^(XYZ_|ELECTRON_)' | sort` 与 `echo $TERM`。
- **通过标准**：输出不含 `XYZ_AGENT_PACKAGED`、`XYZ_RUNTIME_TOKEN`；`ELECTRON_RUN_AS_NODE` 缺席（现状保持）；TERM 为 xterm-256color 或继承值（渲染不损）。

### AC7 relay 实时通道与引擎 override 回归（G3 等价性保障）

- **步骤**：① 打包版会话发起一个 subagent 任务（走 relay 代理链），观察 renderer 是否实时收到增量事件（而非结束后一次性回放）；② 发起一个 zcode/codex 引擎任务验证 override 型变量不受剥除断供。
- **通过标准**：子任务完成且过程有实时事件到达；zcode 任务正常执行。

### AC8 守卫负样本演练（G3 机器强制力证明）

- **步骤**：工作区临时添加绕过构建器的裸 spawn（如任一 service 里直接 `spawn('bash', ..., { env: process.env })`，未提交状态）→ 手动运行 U7 守卫脚本 → 移除临时改动后再跑。
- **通过标准**：带裸 spawn 时脚本 exit 非 0 且报出行号与修复指引（指向构建器 import）；移除后 exit 0；演练产物不留存（`git status` 干净）。

---

## 5. 下一层拆分

依赖顺序：U1 → U2 → (U3 ∥ U4) → U5 → U6 → U7 → U8；U0 在 U2 内消化其结论。每个 unit 可独立验收并回溯 AC。

| Unit | 内容与文件级落点 | 为什么这么拆 | 完成条件（可检查） | 验收对应 |
|------|------------------|--------------|---------------------|----------|
| U0 待验证核实 | 对 D3 待验证集 ①②③ 各跑一次定位 rg（idle-timeout 主 pi 通道 / extension-logger 是否读 LOG_LEVEL 族 / RELAY_ENV_SESSION_ID 定义文件）；结论以 JSDoc 注入 U1 清单文件 | 设计期如实标注的缺口先行消歧，防 U1 内容返工 | 三个问题的证据锚点写入 deny/forward 清单注释（或维持原判的说明） | 支撑 AC7 |
| U1 出站契约 SSOT | 新建 `packages/shared/src/spawn-env-contract.ts`：导出 `SPAWN_ENV_OUTBOUND_DENY_LIST`（首版两项，逐项 JSDoc 写危害证据锚点）+ forward 参考清单（B 组五项，标注消费锚点）+ 文件头「入站白名单管准入／出站契约管出站」关系说明；配套 `packages/shared/src/__tests__/spawn-env-contract.test.ts`（断言：常量名规避 guard 字面量、成员最小性=首版恰为 2） | deny 清单需被 U2 构建器与 U3-U4 五个消费端共享，放 shared 与入站 SSOT 同居一仓才是单一权威 | 两文件存在；`cd packages/shared && npx vitest run spawn-env-contract` 绿 | AC5 |
| U2 出站构建器 | 新建 `packages/runtime/src/infra/spawn-env.ts`：`buildOutboundChildEnv({ parentEnv, extras?, prefixes? }): Record<string,string>`——语义＝prefixes 过滤（缺省 SSOT）→ merge extras（保留 undefined=删除语义）→ apply DENY_LIST；纯函数 env 全 DI；配套测试覆盖：deny 键剔除 / PATH·HOME 基座完整 / extras undefined 删除 / 不 mutate 入参（R1）/ 大输入幂等 | 出站语义唯一实现点；DI 是 R3 的结构性保证 | 模块与测试存在且绿；R1/R2 两个红线用例在测试清单中显式可查 | AC2/AC4 基础 |
| U3 主链路接线（B2+B3） | `safe-env.ts` 改为 U2 薄封装（保留 ELECTRON_ 扩展入参，删本地循环体）；`rpc-client.ts:15-29` 私有 buildSafeEnv 删除改 import U2；`process-manager.ts:104-124` 组装迁至 U2 调用（PATH 补齐 / relayEnv / DATA_DIR 传参不变） | 重复实现消灭在此；等价范围最大的一步单拆便于精准回归 | runtime 相关既有 vitest 用例全绿 + 新增「RpcClient env 无 deny 键」用例；`cd packages/runtime && npx vitest run infra` 绿 | AC2/AC3 |
| U4 周边边界接线（B5-B8） | `shell-runner.ts:63`、`git-executor.ts:40` 显式传入构建器输出（不再隐式继承）；`terminal-service.ts:229` buildEnv 替换为构建器输出 + 原 TERM/ELECTRON_ 删除逻辑保留；`relay-registry.ts:173` buildChildEnv 叠加 deny 过滤；`plugin-host-process.ts:392` 叠加 deny 两键删除（拷贝拓扑不动，D6） | 五处接线互不依赖、每处是独立小 diff，出问题可单独 revert | 每处各配一个小单测（污染 env 输入 → 子进程 env 断言）；四个文件相关测试全绿 | AC6/AC7 |
| U5 回归守卫测试 | 在 `packages/runtime/src/infra/__tests__/spawn-env.test.ts` 内固化「契约快照」用例：给定模拟污染父 env（PACKAGED/TOKEN=1 + 正常系统变量）→ 断言输出无 deny 键、必备基座齐全 | 把本案永久钉进测试基线，防止未来重构悄悄放行 | 该测试文件入 CI 常跑集合并绿 | AC2 自动化层 |
| U6 constraints 登记 | `docs/constraints.json` 新增条目：「runtime 子进程 env 出站契约」scope=[rpc-client.ts, shell-runner.ts, git-executor.ts, terminal-service.ts, relay-registry.ts, plugin-host-process.ts]，执行方式指向 U7 守卫脚本；附「与 ENV_WHITELIST_PREFIXES 关系」说明段；随后 `node scripts/render-constraints.mjs` 再生成 constraints.md | 本项目约束治理的唯一登记处（AGENTS.md 文档索引行），先登记再写码制度 | json 校验过、md 已再生、两条目互引成立 | AC5 |
| U7 pre-commit 静态守卫 | 新建 `.githooks/check_spawn_env_boundary.py`：扫 `packages/runtime/src` 与 `apps/electron/main` 中 spawn/execFile/fork/pty.spawn/Worker( 调用点，要求相邻 ≤10 行出现 `buildOutboundChildEnv` 或命中脚本内置豁免名单（豁免逐条注释理由：reap-orphan-pi ps 只读、relay-env 探针 :68 手工 env、__tests__ 等）；报错信息给修复指引（import 路径 + U1 清单链接）；注册进 `.githooks/install-hooks.sh` heredoc 并重跑安装（R4） | G3 的机器强制力；静态检查成本低误报可控（豁免白名单兜底） | 带 U 临时文件跑 exit≠0 且输出含行号指引；清理后 exit 0；重装 hook 后对新文件生效 | AC8 |
| U8 文档收尾 | AGENTS.md「关键规则」补一行 outbound 契约指针（一句 + 文档链接）；`docs/troubleshooting.md` 追加受害案例与排查条目（症状：commit 被 Bundled pi binary not found 挡住） | 制度落地后的可发现性：下一个撞到同类问题的人能 30 秒找到本文档 | 两文档 diff 就位；文中无本对话上下文引用（自包含） | — |

交付顺序建议：U1+U2 一个 commit（新增模块零行为变化）→ U3+U4+U5 一个 commit（行为收敛，即 B 档完成，跑 AC2/AC4）→ U6+U7+U8 一个 commit（C 档守卫，跑 AC8）。AC1/AC3/AC6/AC7 需要打包产物，随 C 档合入后在打包版上完成闭环验证。

---

## 附 A：探针记录（2026-08-27，分支 fix-add-session-to-project，读完即删的临时产物已清理）

| # | 操作 | 结果 | 结论 |
|---|------|------|------|
| P1 | `XYZ_AGENT_PACKAGED=1 bash scripts/validate-runtime-bundle.sh` | exit 1；[6/6] `[runtime] fatal: relay server init failed: Error: Bundled pi binary not found at <root>/pi/pi-darwin-arm64`，栈顶 findPackagedPi ← RelayRegistry 构造器 | 受害链实证：污染标志使 runtime boot 即按打包态解析捆绑二进制 |
| P2 | 会话 bash 环境 `printenv \| grep -E '^XYZ_\|^PI_CODING\|^ELECTRON_'` | 命中 4 个：`XYZ_AGENT_PACKAGED=1`、`PI_CODING_AGENT=true`（pi 自设）、`PI_CODING_AGENT_DIR=~/.xyz-agent/pi/agent`、`XYZ_RUNTIME_TOKEN=<hex，此处脱敏>` | 泄漏活体取证：令牌级变量直达任意后代进程；亦证明 validate-runtime-bundle 从 agent 会话内天然被污染 |
| P3 | `env -u XYZ_AGENT_PACKAGED -u XYZ_RUNTIME_TOKEN bash scripts/validate-runtime-bundle.sh`（真基线对照） | exit 0；七步全 OK | 控制变量成立：唯一差异变量即缺陷元凶 |

注：P1 前 `packages/runtime && pnpm run build` 重建了 bundle 以保证探针对应当前分支源码（dist 为 gitignored 构建产物）。

## 附 B：关键事实源索引

- 注入点：`apps/electron/main/supervisor/process-control.ts:260`
- 入站白名单 SSOT（含 `'XYZ_'`）：`packages/shared/src/constants.ts:72-81`
- 反向清除语义：`apps/electron/main/supervisor/safe-env.ts:26-43`
- 泄道（第二份 buildSafeEnv + spawn 整体替换）：`packages/runtime/src/infra/pi/rpc-client.ts:15-29,:162-164,:168,:255-258`
- runtime isPackaged 消费六处：`find-pi-executable.ts:26` · `pi-maintenance.ts:108` · `relay-paths.ts:58` · `logger.ts:119` · `process-manager.ts:132` · `extension-service.ts:131`
- 嵌套剥离范式：`relay-registry.ts:173-182`；终端净化先例：`terminal-service.ts:229-250`
- guard 兼容依据：`.githooks/check_env_whitelist_sync.py:43`（`LOCAL_DEF_RE` 精确名匹配，已核）；hook 安装源：`.githooks/install-hooks.sh:43-48,:1036`
