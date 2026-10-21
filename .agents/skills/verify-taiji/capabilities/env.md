# env.launch · 启动隔离实例

- **通道**：C（进程 / 磁盘）+ B（启动后由 env.ready 接管）
- **前置**：`requires: none`；无其他 capability 依赖
- **用于**：所有 scenario（runner 在 `run(ctx)` 之前无条件调用）；`covers` 含 `env.launch` 的剧本

## 入口（用户 POV / 协议 / 副作用点）

- 用户 POV ≈ `pnpm dev`，但验收必须用**独立实例名 + 独立数据目录**（避免与他人 dev 实例撞端口）：
  ```bash
  node apps/electron/scripts/dev-instance.mjs --data-dir ~/.taiji-dev/verify-<runId> --name verify-<runId>
  ```
- 程序入口：`createInstance({ repo, name, dataDir, faux, env, background }).launch()`（`scripts/lib/instance.mjs`）。
- 副作用点：
  - `dev-instance.mjs --print`（launch 前先跑一次）会从只读模板 `~/.taiji-dev.template/` 种子实例目录（幂等）；
  - `faux` 预置走 `scripts/seed-faux.mjs`（写 `agent/settings.json|models.json|extensions/faux-llm-ext.ts|subagents/config.json|faux-responses.json` + `recent-workspaces.json`）；
  - spawn 用 `detached` + 文件 stdio（`<dataDir>/verify-launch.log`），不阻塞调用方。

## 驱动

1. `resolveRepo(repo)`：校验 worktree 根含 `apps/electron/scripts/dev-instance.mjs`（否则立即失败）。
2. `printInstance({ repo, name, dataDir })`：跑 `--print` 解析 banner（`parseBanner`），拿权威 `vitePort / cdpPort / runtimePortRange / dataDir / instanceName`。**不自行推导端口**。
3. faux 装配（可选）：先 seed 再 `--print`（顺序反了会被模板种子的 `settings.json` 挡住）；faux 模式额外删除 `agent/auto-rename-enabled`（防自动标题消耗 faux 队列）。
4. spawn：`node apps/electron/scripts/dev-instance.mjs --data-dir <dir> --name <name>`，env 至少含 `TAIJI_DEV_BACKGROUND=1`；faux 模式加 `TAIJI_FAUX_SCRIPT` + `TAIJI_EXTENSION_PATHS=<repo>/e2e/fixtures/faux-provider-ext`。
5. 返回 `{ pid, vitePort, cdpPort, runtimePort?, runtimePortRange, dataDir, instanceName }`。

## 断言（期望终态 / 失败信号）

- 期望终态：spawn 返回 PID；`--print` 的三元组非空；实例名 ≠ worktree 默认名（独立端口段）。
- 失败信号：
  - `dev-instance.mjs --print` 非 0（pi stage 版本劈叉 / 数据目录越界 / 端口派生失败）→ `InstanceError` 带 stderr；
  - spawn 失败或 banner 解析失败 → 抛错并留 `evidence.stdout`；
  - 后续 `waitReady` 超时会带 `logTail`（装配前链 `prepare-builtin-plugins` / `bundle-extensions` / `electron-ensure` 的失败输出就在这里）。
- 幂等：同一 handle 重复 `launch()` 返回首次参数，不重复 spawn。

## 证据（A/B/C 各抓什么）

- **C（主）**：`<dataDir>/verify-launch.log`（装配器 banner + 前链输出 + 退出信息）；`summary.jsonl` 的 `instance.launch` 行（含端口/PID/耗时）。
- **B**：launch 本身不产协议帧；由 `env.ready` 的 auth 握手与 RPC 往返接续。
- **A**：不适用（launch 不驱动 UI）。

## 证不了

- 应用窗口可见 / 前台焦点行为（`TAIJI_DEV_BACKGROUND=1` 只声明 showInactive，不证明 OS 层不抢焦点）。
- 打包态（`TaiJi.app`）行为——本原语只走 dev 装配器。
- 端口未被他人占用：由 `env.doctor` / `env.ports` 证明；launch 自己不做互斥检查（Vite strictPort 会在 ready 阶段暴露）。

## Gotchas

- **同实例名同时只能有一个实例**（Vite `strictPort`）：第二个实例静默失败并加载旧代码。并行验收必须给独立 `name`（runner 用 `verify-<runId>`）。
- **数据目录值域**：只允许 `~/.taiji-dev/` 树内、非保留目录；`dispose` 只删自建 `verify-*` 目录（传入的 dataDir 不删）。prod `~/.taiji` 永不触碰。
- **faux 装配是两个 env + 一份预置**：`TAIJI_FAUX_SCRIPT`（响应脚本）+ `TAIJI_EXTENSION_PATHS`（provider 壳）+ `<dataDir>/agent/*`。缺任一，主会话会报模型不可用。
- **faux 响应队列是 per-pi-进程的**：每个 session spawn 独立 pi，各自从同一脚本文件重新加载队首。多会话要不同回复 → 用 model-keyed 脚本（`{ "faux/faux-1": [...], "faux/faux-1-b": [...] }`）+ `session.create.modelOverride` 指定不同模型；不要假设队列跨 session 续接。
- **模板默认开 auto-rename**（`agent/auto-rename-enabled` 存在）：`lib` 的 faux 装配会删除该标志，否则标题生成经 `llm-shared` 消耗 faux step。
- **孙进程 faux 实测不可达（dev 装配）**：subagent 派发的 pi 孙进程由 `pi-subagent-cli` 以 `--no-extensions` spawn，扩展集只来自宿主白名单（`GRANDCHILD_EXTENSION_PKG_SEGMENTS` = structured-output）。e2e 专用放行门 `resolveE2eFauxExtensionPath` 要求 `TAIJI_E2E=1`（dev 装配不设该 env，且设了会破坏 dev 的 vite 加载路径）。实测量化证据：孙进程 stderr tee `<dataDir>/logs/pi-task-stderr-<pid>.log` 出现 `Error: Model "faux/faux-1-c" not found`，subagent record `stopReason: failed / error: pi child exited with code 1`。→ **faux 通道在孙进程不可达**（探针：`scripts/probes/faux-grandchild.mjs`）。
- **零 token 孙进程验收通道 = 本地 mock HTTP provider（不是 faux）[2026-10-21 实测可达]**：孙进程不需要任何 extension 也能跑 LLM——它继承 `PI_CODING_AGENT_DIR`（`packages/runtime/src/infra/subagent-control/engine-launch-env.ts` 显式注入），因此读同一份 `<dataDir>/agent/models.json`；只要其中有一个自定义 `openai-completions` provider 且 `baseUrl` 指向本机 mock 服务即可。
  - 装配：`createInstance({ llm: { responses, tps? } })`（`lib/instance.mjs`）→ 起 `lib/mock-llm.mjs` 的 HTTP 服务 → 写 `models.json`（provider `mockllm`，模型 `mock-1` / `mock-sub-a` / `mock-sub-b`）+ `settings.json`（`defaultProvider=mockllm`, `defaultModel=mock-1`, `enabledModels`）+ `agent/subagents/config.json` 的 `engineDefaults.pi = mockllm/mock-sub-a`；**不写** `agent/extensions/faux-llm-ext.ts`。
  - `responses` 用 **model-keyed 对象**区分主 agent（`mockllm/mock-1`）与孙进程（`mockllm/mock-sub-a`）——注意 pi 发到 HTTP 的 `model` 字段是**裸 id**（`mock-1`），`mock-llm.mjs` 的选队已按裸 id 兼容两种 key 写法。
  - 已实测结论：`mock-grandchild-reachable`（subagent 派发）/ `mock-workflow-reachable`（workflow fan-out 两成员 outcome=done）。探针：`scripts/probes/mock-llm-grandchild.mjs`、`scripts/probes/mock-llm-workflow.mjs`。
  - 边界：mock 回复无语义（模型行为、token 成本、真实耗时不可断言）；workflow 成员**必须**在终局调 `structured-output`（workflow 模式下它是单参数合成工具，parameters 即权威 schema），否则 `schema_deterministic` 失败。
- **`TAIJI_E2E` 不许设**：那是 e2e fixture 的产物加载形态；dev 路径下设它会跳过 vite 轮询、加载构建产物。

---

# env.doctor · 五项体检

- **通道**：C（端口 / 文件 / 日志）+ B（CDP `/json/list` HTTP）
- **前置**：`requires: none`；建议在 `env.launch` 之后调用（未启动时部分项按「实例未启动」PASS）
- **用于**：runner 每个 scenario 的固定步骤；`vp.mjs env.doctor` 单步复检

## 入口

```bash
node .agents/skills/verify-taiji/scripts/doctor.mjs <repo> [--data-dir <dir>] [--name <实例名>] [--json]
node .agents/skills/verify-taiji/scripts/vp.mjs env.doctor --repo <repo> --data-dir <dir>
```

## 驱动

委托 `scripts/doctor.mjs`（lib 不重复实现）：内部跑 `dev-instance.mjs --print` 取权威参数，然后五项判定——装配参数 / 端口归属（lsof + PID 命令行）/ CDP 指向（`/json/list` 页面 URL 属本实例 vitePort）/ runtime 健康（`runtime.port` + `runtime-token`）/ 扩展装载（末次 `resolved N extensions`，N≥8）。

## 断言

- 期望终态：`verdict === 'GREEN'`（`checks.every(status === 'PASS')`）。
- 失败信号（RED 明细，逐项带 `action` 恢复指引）：
  - CDP 页面 URL 不含本实例 vitePort = **连错实例**（旧 worktree / 打包版），禁止盲杀；
  - 端口被非本实例进程占用 = 换 worktree 或等；
  - `runtime-token` 缺失 = main↔runtime 装配断链；
  - 扩展装载 N<8 = 扩展解析不完整（此时建 session 会缺命令/工具）。
- RED 不抛异常：`instance.doctor()` 返回 `{ ok:false, checks }`，由 scenario 记断言失败。

## 证据

- **C**：`checks[]` 逐项 `{name,status,detail,action}`、`verdict`、`vitePort/cdpPort/dataDir/running`。
- **B**：doctor 内部 HTTP 访问 CDP（非 runtime WS）。
- **A**：不适用。

## 证不了

- 扩展能力可用性（只数装载条数）。
- 应用业务状态（doctor 不看 session / 对话 / 设置）。

## Gotchas

- doctor 底层 `--print` 对不存在的实例目录**会从模板创建目录**（幂等副作用）；不要把它当纯只读探测。
- doctor 从不杀进程；端口被占但 CDP 不属本实例时，按 PID + 命令行识别占用者。
- `--name` 必须与启动时一致，否则派生端口不同 → 误判「端口空闲」。

---

# env.ready · 三判据就绪

- **通道**：C（`runtime.port` / `runtime-token` / runtime 日志）+ B（CDP `/json/list`）
- **前置**：`env.launch` 已返回
- **用于**：所有需要 WS / UI 的 scenario（runner 固定步骤）

## 入口

`await instance.waitReady({ timeoutMs=180_000 })`（`scripts/lib/instance.mjs`）；失败抛 `InstanceError`（带 `conditions` + `logTail` + `exitInfo`）。

## 驱动

条件轮询（每轮重算三条判据，间隔 300ms，明确 deadline）：

1. `<dataDir>/runtime.port` 存在且 >0、`<dataDir>/runtime-token` 非空、TCP 可连 `127.0.0.1:<port>`；
2. CDP `/json/list` 中存在页面，且页面 URL 含本实例 `:<vitePort>`；
3. `<dataDir>/logs/runtime-*.log` 末次 `resolved N extensions from M sources` 且 N≥8。

返回 `{ ok, elapsedMs, conditions[3], runtimePort, extensions, pid }`。

## 断言

- 期望终态：三项 `ok:true`；`elapsedMs` 记录为「ready 耗时」证据。
- 失败信号：
  - 第 1 项超时 = runtime 未 spawn/健康检查未过（看 logs）；
  - 第 2 项超时 = CDP 端口被他人占 / 页面 URL 不属本实例（**连错实例**）；
  - 第 3 项超时 = 扩展装载未完成（端口在位但建 session 会缺工具）。
- 超时错误带 `hint`（换 --name / 看 runtime 日志）与 `evidence.logTail(80)`。

## 证据

- **C**：`summary.jsonl` 的 `instance.waitReady` 行（elapsedMs / runtimePort / extensions）+ `conditions` 断言三行。
- **B**：CDP 页面列表（URL 归属）。
- **A**：不适用（页面尚未驱动）。

## 证不了

- UI 已渲染出可交互内容（只证明页面 URL 在场，不证明 DOM 就绪）。
- 扩展健康（N 只数条数）。

## Gotchas

- **进程活着 ≠ 就绪**：三条判据全过才算可用。
- runtime `port` 文件在 health check 后写入，但扩展装载日志可能更晚；只等端口就建 session 会缺工具。
- 同一 worktree 第二个实例会因 `strictPort` 静默失败；ready 的第 2 项会暴露「页面 URL 指向旧实例」。

---

# env.cleanup · 收尾与证据幸存

- **通道**：C（PID / 端口 / 目录 / 证据文件）
- **前置**：`env.launch`（PID 由 handle 持有）
- **用于**：runner 收尾（`instance.dispose()`）；`vp` 不执行清理（无副作用约定）

## 入口

- `await instance.stop({ timeoutMs=45_000 })`：只 `kill <自己的 PID>`（SIGTERM），等端口释放（条件轮询）。
- `await instance.dispose()`：`stop()` + 关闭 CDP/WS + 删除**自建** `verify-*` 数据目录；幂等。
- 手工核对：
  ```bash
  lsof -ti :<vitePort> :<cdpPort>          # 应为空
  ls ~/.taiji-dev/verify-<runId>            # 应不存在（自建目录）
  ls ~/.agents/skill-data/verify-taiji/<worktree>/<runId>/
  ```

## 驱动

1. SIGTERM → 装配器把信号转发给整个子进程组（runtime stop → 销毁 pi → 应用退出）。
2. 轮询 `<vitePort>/<cdpPort>/<runtimePort>` 的 `lsof` 直到全空；超时抛错并附残留 `:port → PID` 明细。
3. `dispose` 关闭 Playwright CDP 连接与协议 WS（keepalive 定时器随 `close()` 清理）。
4. 仅当数据目录是自建且 basename 以 `verify-` 开头才 `rm -rf`；调用方传入的 dataDir 不删。
5. runner 在 dispose 后重新 stat `runDir`（`summary.jsonl` / `assertions.jsonl` / 截图），缺失即判 fail。

## 断言

- 期望终态：端口全空、自建 dataDir 不存在、证据目录文件齐全。
- 失败信号：
  - 端口未释放 → `InstanceError`（residual PID 列表 + `logTail`）；**按残留 PID 逐个核对命令行，禁 `pkill electron|vite`**；
  - dispose 失败时**不删数据目录**（保留现场）；
  - 证据幸存核对失败 → verdict fail（清理吃掉证据 = 本次验收作废）。

## 证据

- **C**：`summary.jsonl` 的 `instance.dispose` 行（elapsedMs / dataDir）；证据目录文件清单（report.md 的「附件」段）。
- **B**：不适用（WS 已关）。
- **A**：不适用。

## 证不了

- 应用优雅退出链内部的业务收尾（只证明 PID 退出 + 端口释放）。
- 他人残留进程的归属（只报 PID + 命令行，不处置）。

## Gotchas

- **禁宽泛杀进程**：只 kill 自己起的 PID。他人实例 PID 不在本 worktree 端口段，勿动。
- `--keep` 模式不会 dispose：report 里会记 `instance.keep`（PID + dataDir），收尾必须按 PID 手工 kill。
- 证据绝不落实例数据目录（dispose 会删）；统一落 `~/.agents/skill-data/verify-taiji/<worktree>/<runId>/`。
- 数据目录删除只对 `verify-*` 生效；传 `--data-dir` 的调用方自行管理。

---

# env.isolation · 实例与数据隔离

- **通道**：C（端口 / 数据目录 / 进程命令行）+ B（协议连接归属）
- **前置**：`env.launch` + `env.ready`
- **用于**：并行验收编排；所有需要「不污染他人实例 / prod 数据」的 scenario

## 入口

- 实例名：`name`（`TAIJI_DEV_INSTANCE_NAME` / `--name`）→ 端口段 hash 派生（Vite/C​DP/runtime offset 三者同源）。
- 数据目录：`--data-dir ~/.taiji-dev/verify-<runId>`（树内严格子路径）。
- 单步核对：`node .agents/skills/verify-taiji/scripts/vp.mjs env.ports --repo <repo> --name <实例名> --data-dir <dir>`。

## 驱动

- `env.ports`：`--print` 派生 + `lsof` 逐端口列占用者 PID，输出 `{ vitePort, cdpPort, runtimePortRange, runtimePort, owners, busy }`。
- 断言隔离的三条事实：
  1. `dataDir` 前缀 = `<homedir>/.taiji-dev/`（非 `~/.taiji`）；
  2. 实例名 ≠ worktree 默认名（独立端口段）；
  3. CDP 页面 URL 含本实例 `vitePort`（连接归属，不是「端口能连」）。

## 断言

- 期望终态：`busy` 只含本实例自己的端口（启动后）；`dataDir` 在 dev 树内；页面 URL 归属本实例。
- 失败信号：
  - 端口被非本实例 PID 占用 → 换实例名/等（doctor 会给 PID+命令行）；
  - 页面 URL 指向别的 vitePort → **连错实例**（旧 worktree / 打包版），立即失败；
  - `dataDir` 越界（`~/.taiji` / 保留目录）→ `dev-instance --print` 直接非 0。

## 证据

- **C**：`env.ports` observations（端口→PID 映射）；`instance-info` 附件（PID / dataDir / ready 明细）；`lsof` 输出。
- **B**：CDP 页面 URL（归属核对）；协议 `session.create` 后 `config.sessions` 只应看到本实例数据库的会话。
- **A**：不适用。

## 证不了

- 文件系统级强隔离（同一用户下所有实例共享 `~/.taiji-dev.template` 与 workspace 缓存，只隔离实例目录）。
- OS 进程组隔离之外的信号安全（同用户可互杀，靠纪律不靠内核）。

## Gotchas

- **同 worktree 同实例名互斥**（Vite strictPort 静默失败）——并行验收必须换名字。
- `runtime 端口段` 是 10 个连续端口的段（offset 步进 10），实例名不同则整段不同；但端口占用仍要用 `lsof` 实测，不要只信派生值。
- 打包版应用与 dev 实例可能并存（打包版占 3210 / CDP 9222 / Vite 1420）：**靠 CDP URL 归属区分，不靠端口号猜**。
- 首启种子来自只读模板；模板调整后需重建模板，禁止直改模板或 prod 数据目录。
