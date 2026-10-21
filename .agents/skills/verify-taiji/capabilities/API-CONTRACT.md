# 能力原语层接口契约（v1，冻结）

本文件是 `scripts/lib/**`、`scripts/vp.mjs`、`scripts/run.mjs`、`capabilities/*.md`、`scenarios/*.mjs`
**并行开发的唯一接口事实源**。任何一方要改接口，先改本文件（同批），否则视为违约。

## 0. 命名与职责边界

| 层 | 路径 | 职责 | 禁止 |
|----|------|------|------|
| lib | `scripts/lib/*.mjs` | 驱动 + 断言 + 取证的原语实现（**有状态**，一次进程内串联多步） | 实现任何产品语义（模型解析、归属判定、业务规则） |
| vp | `scripts/vp.mjs` | 原语 CLI，**单步 / 无状态 / --json**，连已有实例 | 长事务、跨步状态 |
| runner | `scripts/run.mjs` | 组合 scenario（多步），产 `summary.jsonl` + `verdict.json` | 定义业务断言 |
| capability | `capabilities/*.md` | 人读契约：入口 / 驱动 / 断言 / 证据 / 证不了 / 坑 | 复制 `docs/testing/` 的 testid 清单（引用不复制） |
| scenario | `scenarios/*.mjs` | 能力组合 = 一条验收剧本，可被 dev-flow L3 引用 | 出现新的产品语义假设（必须回落到 capability） |

通道三角（每个断言必须标通道）：
- **A** = UI（CDP/Playwright，用户可见终态）
- **B** = runtime 协议（WS RPC / broadcast）
- **C** = 进程·磁盘（`ext-sessions/` 树、`logs/`、`git status`、`lsof`）

## 1. 模块导出

```js
// scripts/lib/index.mjs
export { resolveRepo, createInstance } from './instance.mjs'
export { createMockLlm } from './mock-llm.mjs'
export { createProtocol } from './protocol.mjs'
export { createUI } from './ui.mjs'
export { createEvidence } from './evidence.mjs'
```

所有模块 **零第三方依赖**，仅 `node:*`。唯一例外：`ui.mjs` 需要 Playwright —— 用
`createRequire(path.join(repo, 'package.json'))` 解析（脚本不在 repo 内，裸 `import 'playwright'` 会失败），
解析失败给明确指引（`cd <repo> && pnpm install`）。

### 1.1 `createInstance(options)`

```js
const inst = createInstance({
  repo,                    // 必填：worktree 根绝对路径
  name,                    // 可选：TAIJI_DEV_INSTANCE_NAME（独立端口段；并行验收必给）
  dataDir,                 // 可选：~/.taiji-dev/ 树内；省略 = 自动 mkdtemp 到 ~/.taiji-dev/verify-<runId>
  faux: {                  // 可选：faux 装配（内部调 seed-faux 逻辑，不重复实现）
    responses,             // FauxStep[] 或 { [modelRef]: FauxStep[] }（model-keyed，多演员）
    tps,                   // 可选：TAIJI_FAUX_TPS
    force,                 // 可选：覆盖已有预置
  },
  llm: {                   // 可选：mock-http 装配（与 faux 互斥，两条通道同时给会抛错）
    responses,             // FauxStep[] 或 { [modelRef]: FauxStep[] }（与 faux 同一 step 形态）
    tps,                   // 可选：内容按字符切块节流（对齐 TAIJI_FAUX_TPS 语义）
    providerId: 'mockllm', // 可选：models.json 里的 provider id
    mainModel: 'mock-1',   // 可选：主会话模型（settings.json defaultModel）
    subModel: 'mock-sub-a',// 可选：孙进程缺省模型（subagents/config.json engineDefaults.pi）
    models: ['mock-1', 'mock-sub-a', 'mock-sub-b'], // 可选：写进 models.json 的模型清单
  },
  env: {},                 // 可选：额外 env
  background: true,        // 默认 true（TAIJI_DEV_BACKGROUND=1）
})
```

| 成员 | 签名 | 说明 |
|------|------|------|
| `launch()` | `async () => { pid, vitePort, cdpPort, runtimePort, runtimePortRange, dataDir, instanceName, logFile }` | 起 `dev-instance.mjs`（**必须 detached/background**，不得前台阻塞）。端口用 `dev-instance.mjs --print` 权威解析，不自行推导。**⚠️ `runtimePort` 在 launch 返回时通常为 0**（`<dataDir>/runtime.port` 尚未写出）——要等 `waitReady()` 的 `runtimePort`，别信 launch 的这个字段 |
| `waitReady(opts?)` | `async ({ timeoutMs=180_000 }) => ReadyReport` | 三条就绪判据（runtime.port / CDP 页面 URL 归属 / 扩展装载 N≥8）；返回三项明细与耗时。超时抛带 hint 的错 |
| `doctor()` | `async () => { ok, checks: [{name,status,detail,action?}] }` | 委托 `scripts/doctor.mjs --json`（**不重复实现**） |
| `page()` | `async () => Page` | CDP 连接，幂等；用 `chromium.connectOverCDP`，**核对页面 URL 属于本实例 vitePort**，否则抛「连错实例」 |
| `protocol()` | `async () => Protocol` | 见 1.2 |
| `mockLlm` | `{ port, baseUrl, requests, close } | null` | **llm 通道专用**：mock HTTP 服务句柄（`lib/mock-llm.mjs` 实例）；`requests` 里带每次请求的 `model` / `messages`——这是「孙进程真的打到 mock」的铁证面。faux 通道为 `null` |
| `llm` | `{ providerId, mainRef, subRef, models, baseUrl, port, mock } | null` | **llm 通道专用**：装配拓扑（探针断言用）；faux 通道为 `null` |
| `stop()` | `async () => void` | `kill <pid>`（SIGTERM），等端口释放，超时给残留 PID 明细。**禁 pkill 宽匹配**。llm 通道同时 `close()` mock 服务 |
| `dispose()` | `async () => void` | `stop()` + 删除**自建** dataDir（`verify-*` 前缀才删；传入的 dataDir 不删） |
| `screenshot(name)` | `async (name) => path` | 便捷法，内部转 `ui.screenshot` |

**生命周期纪律**：`launch` 失败也必须能 `dispose`；`dispose` 幂等；不吞错（失败留原始输出）。

### 1.1b `createMockLlm({ port?, script, tps?, name? })`

本地 OpenAI chat-completions 兼容 mock 服务（零第三方依赖）。语义移植自 `main/scripts/verify-provider-live-sync.mjs`
的 createServer 段（**不 import** 那个仓库脚本，因为技能要能从任意 cwd 用）。

| 成员 | 说明 |
|------|------|
| `port` / `host` / `baseUrl` | 实际监听值（`port:0` = OS 分配）；`baseUrl` 已含 `/v1`，可直接写进 models.json |
| `requests` | 每次请求的请求体记录（`model` / `messages` / `summary` / `status` / `stepIndex`） |
| `pending()` | 各 model-keyed 队列已消费的步数 |
| `reset()` | 游标与 requests 归零（同实例复用剧本） |
| `close()` | 真正关掉 server + 所有 keep-alive 连接（否则进程不退出） |

> **剧本 `model` 匹配的硬事实**：pi-ai 发到 HTTP 的 `model` 字段是**裸 id**（`mock-1`），
> 不是 `provider/model`。`createMockLlm` 同时兼容两种 key 写法（`'mock-1'` 与 `'mockllm/mock-1'`）。
> 未知模型 / 剧本耗尽 → HTTP 404 + 结构化 body（pi 侧报错可读），不伪造回复。

### 1.2 `createProtocol(options)`

```js
const p = await createProtocol({ dataDir, runtimePort })   // 自动读 <dataDir>/runtime-token
```

| 成员 | 签名 | 说明 |
|------|------|------|
| `call(type, payload, opts?)` | `async (type, payload, { replyType?, id?, timeoutMs=60_000 }) => replyPayload` | 发 RPC 等匹配 reply。**`replyType` 省略时不能假设「与 type 同名」**——协议里大量异名对（如 `message.send`→`message.status`、`session.create`→`session.created`、`plugin.list`→`config.plugins`、`session.getCommands`→`session.commands`、`session.getContext`→`context.update`、`extension.list`→`config.extensions`）。`lib/protocol.mjs` 内置异名映射表（`REPLY_OF`），未登记的 type 才回落同名。**注意 `config.get` 不存在**（协议无此 RPC；连通性探针用 `ping`→`pong`，配置读取用 `config.sessions` 等具体 RPC）。超时抛含 type 的错 |
| `subscribe(sessionId, opts?)` | `async (sid, { fromSeq? }) => { snapshot, stateSnapshot, lastSeq }` | `session.subscribe`；返回快照 |
| `events` | `Array` | 收到的**广播帧**（无 id 的 message），带 `type/payload/receivedAt` |
| `waitFor(predicate, opts?)` | `async ((evt)=>bool, { timeoutMs=30_000, since? }) => evt` | 轮询事件队列（**条件等待，禁固定 sleep**）。超时抛时附最近 20 帧类型摘要（区分「慢」与「死」） |
| `send(sessionId, text, opts?)` | `async (sid, text, { clientUuid?, deliver? }) => void` | 走 `delivery.submit`（D1 统一入口）；`deliver:false` 时可退化 `message.send` |
| `waitTurnEnd(sessionId, opts?)` | `async (sid, { timeoutMs }) => void` | 等 `message.complete` 或 `message.error`（**两态都算结束**，error 要能区分返出） |
| `history(sessionId, opts?)` | `async (sid, { limitTurns? }) => payload` | `session.history` |
| `close()` | `async () => void` | 关 WS（带 keepalive 定时器清理） |

**纪律**：所有事件消费**必须按 sessionId 过滤**（多 session 并行不许串）；keepalive 必须清理，
否则进程不退出。

### 1.3 `createUI({ page, evidence?, repo })`

选择器语法（与 `pw.js` 一致）：`testid=<id>` / `role=<role>[name="<n>"]` / `text=<文本>` / `css=<sel>`（默认当 css）。

| 成员 | 说明 |
|------|------|
| `click(sel, { button?, timeoutMs? })` | 自动等待可见可点 |
| `type(sel, text)` | **`pressSequentially`**（contenteditable 必须逐字，禁用 fill） |
| `fill(sel, text)` | 仅用于真 `<input>`（原生表单区；先确认不是 contenteditable） |
| `press(key)` | 全局按键 |
| `hover(sel)` | hover 态按钮（会话行操作按钮依赖 hover） |
| `expectVisible(sel, { timeoutMs=15_000 })` | 失败抛含「当前可见 testid 摘要」的错 |
| `expectGone(sel, { timeoutMs })` | 消失断言 |
| `expectText(sel, expected, { exact? })` | string 或 RegExp；失败给实际文本 |
| `expectCount(sel, n)` | 计数断言 |
| `text(sel)` / `attr(sel, name)` / `html(sel)` | 读值 |
| `screenshot(name, { selector? })` | 委托 evidence（有 evidence 时）；返回路径 |
| `waitForEvent` | 不在此层——事件等待归 protocol |

**纪律**：全部走自动等待 + 超时断言，**禁止 `sleep` 后断言**（pre-commit `check-test-blind-wait` 会拦）。

### 1.4 `createEvidence({ runDir, feature, meta? })`

目录约定：`~/.agents/skill-data/verify-taiji/<worktree>/<runId>/<feature>/`（runDir 由调用方给）。

| 成员 | 说明 |
|------|------|
| `step({ step, command?, exitCode, stats?, channel? })` | **追加**一行到 `<runDir>/summary.jsonl`（JSONL，字段名冻结：`step/command/exitCode/stats/channel/at`） |
| `assert(name, ok, { channel, expected, actual })` | 记录断言结果（内存 + 落 `assertions.jsonl`） |
| `shot(page, name, { selector? })` | 截图落 `<runDir>/<name>.png`，返回路径 |
| `attach(name, content)` | 落文本附件（DOM 片段 / 日志 grep 行 / 目录树） |
| `report({ title, steps, uncovered, gotchas })` | 写 `report.md`（人读：期望 vs 实际 + 未覆盖项 + 坑） |
| `verdict({ verdict, deviations?, blockers?, notProvable? })` | 写 `verdict.json`，`verdict ∈ pass\|fail\|degraded`（dev-flow 契约，禁写 `status`） |
| `ok` | 累计是否有失败断言 |

`evidence.ok === false` 时 runner 必须最终 `verdict: fail`；`uncovered` 非空且无失败 → `degraded`。

## 2. `scripts/vp.mjs`（单步 CLI）

```bash
node .agents/skills/verify-taiji/scripts/vp.mjs <capability> [--data-dir <dir>] [--repo <repo>] [flags...] [--json]
```

约定：
- 输出**单行 JSON** 到 stdout：`{"ok":true,"capability":"<id>","observations":{...},"evidence":{...},"elapsedMs":n}`
- 失败：`exit 1` + `{"ok":false,"capability":"<id>","reason":"...","hint":"...","evidence":{...}}`
- `--repo` 省略 = `process.cwd()`；`--data-dir` 省略 = 从 `--name` 派生（否则报错，**不猜**）
- 无副作用（除 capability 自身声明的动作）；不杀进程、不建/删数据目录

v1 已实现的 capability id（**20 个 = 18 个主能力 + 2 个别名**；其余 52 个走 scenario/手工，
差距表见 [README §4.2](README.md)）：

```
env.doctor        env.ports        session.create     session.list      session.switch
session.history   session.delete   chat.send          chat.wait         chat.abort
model.list        model.switch     subagent.list      workflow.list      plugin.list
extension.list    evidence.tree    evidence.logs
evidence.grep     shell.grep       ← 同一实现的两个名字（契约 §6 要求并存）
```

**扩 vp 前先读**：只加「跨进程、只读或少状态、能单步自证」的能力。长事务（建实例 / 跑 turn /
观察流）与强 UI 依赖（点击 / 可见性断言）的留在 scenario——那是它们的正确形态。

## 3. `scripts/run.mjs`（scenario runner）

```bash
node .agents/skills/verify-taiji/scripts/run.mjs <scenario.mjs> --artifacts-dir <dir> [--json] [--keep] [--name <实例名>]
```

scenario 契约：

```js
export const meta = {
  id: 'p0-chat-stream',
  priority: 'P0',                    // P0|P1|P2|P3
  title: '...',
  covers: ['chat.send', 'chat.wait'],// capability id 数组（必须都能在 capabilities/ 找到）
  requires: ['faux'],                // faux | mock-http | live | custom-provider | none
  parallelGroup: 'chat',             // 同组 = 需互斥（独立实例名）
  estimateSec: 90,
  provable: ['...'],
  notProvable: ['...'],
  // 可选：faux 装配（runner 不读 global，只认这里；等价于 createInstance 的 faux 选项）
  faux: { responses: [...], tps: 20, force: true },
  // 可选：mock-http 装配（零 token、零外网、不需 extension；**孙进程可达**的唯一零 token 通道）
  // 与 faux 互斥（同时给会抛错）。responses 支持数组或 model-keyed 对象。
  // llm: { responses: { 'mockllm/mock-1': [...], 'mockllm/mock-sub-a': [...] }, tps: 20 },
}
export async function run(ctx) { /* ctx = { repo, instance, protocol, ui, ev, dataDir, log } */ }
```

> `meta.faux` 是 v1 的既定扩展位（`scripts/run.mjs` 已实装：`meta.faux ?? scenario.faux`）；
> 未声明则不启用 faux 装配。`meta.llm` 为同批新增的同位扩展位（同一条 `createInstance({ llm })` 装配链）。
>
> **`requires` 枚举语义（本批唯一改动）**：`faux` = pi extension 注册 `api:'faux'` provider，**主会话可用、孙进程不可达**；
> `mock-http` = 本机 mock OpenAI chat-completions 服务 + `models.json` 的 `openai-completions` 自定义 provider，
> **主会话与孙进程（subagent / workflow 成员）都可达**，零 token / 零外网 / 零 extension；
> `live` = 真实 LLM（有 token 成本）；`custom-provider` = 用户已配置的 provider；`none` = 不需要 LLM。

runner 职责（scenario 只写业务步骤）：
1. 分配 runId + runDir + 独立实例名（默认识 `meta.id`）；2. `instance.launch/waitReady/doctor`；
3. 逐 step 落 `summary.jsonl`；4. 收尾 `dispose()`；5. 写 `report.md` + `verdict.json`；
6. 退出码：pass=0 / degraded=0（带 `--strict` 时 2）/ fail=1。
7. **证据幸存核对**：dispose 后重新 stat `runDir`，缺失即判 fail。

## 4. capability 文档固定骨架

```md
# <capability-id> · <中文名>

- **通道**：A / B / C（列全）
- **前置**：`requires`（faux|mock-http|live|custom-provider|none）+ 依赖的其他 capability id
- **用于**：哪些 scenario 消费（covers 反向引用）

## 入口（用户 POV / 协议 / 副作用点）
## 驱动
## 断言（期望终态 / 失败信号）
## 证据（A/B/C 各抓什么）
## 证不了
## Gotchas
```

## 5. 硬性红线（违反即打回，不是建议）

1. **禁时间平抑**：不用 `sleep` 等状态；条件等待（`expectVisible` / `waitFor`）替代。
2. **禁宽泛杀进程**：只 `kill <自己起的 PID>`。已知他人实例 PID 不在本 worktree 端口段，勿动。
3. **禁数据目录越界**：只用 `~/.taiji-dev/` 树内；删除仅限 `verify-*` 自建目录。
4. **禁弱化剧本**：走不通 → 记 `verified-unreachable` + 前置缺失，禁止改断言凑绿。
5. **禁吞错**：所有 catch 必须留原始输出到 evidence；失败要能定位到一步。
6. **禁复制 e2e 资产**：复用 `e2e/fixtures/faux-provider-ext` 与 `packages/runtime/src/__tests__/fixtures/faux-llm-ext.ts`；
   不 import `@playwright/test` fixture（会 `_electron.launch` 抢焦点且走 mock 构建）。
7. **禁机读文件污染**：`summary.jsonl` / `verdict.json` 字段名冻结，不要加私有字段（可加 `meta` 子对象）。
   `summary.jsonl` 的六个键 **恒在**（`step/command/exitCode/stats/channel/at`；`command` 缺省回落为 step 名，
   不允许缺失——dev-flow inspect 靠它回答「这一步跑了什么」）。
   `verdict.json` 必含 `test_evidence`（string，引擎 `validateInspectResult` 必填）。
8. **禁把产品语义搬进 lib**：lib 只做「驱动 / 断言 / 取证」。

---

## 7. 已知限制与副作用（诚实登记，2026-10-22 对抗式审查后补）

| # | 限制 | 影响 | 规避 |
|---|------|------|------|
| L1 | **`vp --name`（不给 `--data-dir`）会触发装配器 `dev-instance --print` 的幂等种子**，创建 `~/.taiji-dev/instances/<name>/`（约 4MB） | 违反「vp 无副作用」的字面承诺 | 只查已有实例时**优先给 `--data-dir`**；用 `--name` 派生必然落盘。该目录是装配器行为，不是 vp 自建，`dispose` 也不删它 |
| L2 | **mock-http 剧本游标是 per-model 单游标**（server 进程持有），不是 per-pi-进程 | 同一模型被两个 session 使用时，第二个 session 首轮会拿到第一个的后续 step | ① 用 model-keyed 给每个 session 分配不同模型；② 每组之前 `instance.mockLlm.reset()`；③ 每个 session 独立实例 |
| L3 | **`session.list` 对未落盘的会话不可见** | 建 session 后立刻查列表可能 count=0（不是失败） | pi 首次落盘条件 = 有 user 或 assistant 消息；断言「会话已建」用 `session.created` reply 而非 list |
| L4 | **并发 run 会争抢仓内 staged 扩展目录**（`scripts/bundle-extensions.mjs` → `apps/electron/resources/extensions/`） | 两个 run 同秒启动时其中一方可能 `EEXIST` 失败（串行必绿、并行必红） | dev-flow 并行节点**必须**用不同 `--name` 且串行启动（间隔 ≥1 个 ready 周期），或在引擎层加跨 run 互斥 |
| L5 | **默认 runId 是秒级时间戳** | 同秒两个 run 会共享 dataDir（互踢真相被归因成「环境问题」） | 并发务必显式给 `--run-id` / `--name`（runner 已对 runId 做安全校验，但仍允许同名） |
| L6 | **`vp` 只实现 19 个 capability**（契约登记 72 个） | 其余 53 个只有文档，没有单步 CLI | 走 scenario（`run.mjs`）或按文档手工驱动；后续按需扩 vp |
| L7 | **`session.history` 的 `truncated` 语义** 以 runtime 为准 | 大历史下 messages 可能被截断 | 断言关键文本用 `--limit-turns` 收窄 + grep，不要假设全量 |

## 8. dev-flow D3 调用形态（唯一正确写法）

引擎只 `spawn(解释器, [script])`（零参数），因此 verify 节点的 `script` **必须**指向包装壳：

```bash
# verify 节点 script = <repo>/.agents/skills/verify-taiji/scripts/verify-run.sh
# 参数全部经 env 传入：
TAIJI_VERIFY_SCENARIO=scenarios/p0-env-smoke.mjs \
TAIJI_VERIFY_ARTIFACTS=<artifactsDir>/<node-id> \
TAIJI_VERIFY_NAME=verify-<node-id> \
bash .agents/skills/verify-taiji/scripts/verify-run.sh
```

**不要**把 `script` 直接写成 `scenarios/*.mjs`：ESM 顶层 export 在 node 下是空操作，
会 exit 0 且零断言（**静默假绿**，比失败更危险）。也不要直接写 `run.mjs`：零参数会 exit 2。

产物锚：`<artifactsDir>/verdict.json` 与 `<artifactsDir>/summary.jsonl` **会在 artifactsDir 根**
镜像一份（引擎的 `inspectVerdictAnchorOk` 读根），完整细节仍在 `<artifactsDir>/<runId>/<scenarioId>/`。

---

## 6. capability id 全量清单（v1 冻结，capability 文档 / scenario covers / 覆盖矩阵三处共用）

命名 `<域>.<动作>`。新增 id 先改本节。

### env（实例与环境）
`env.launch` · `env.doctor` · `env.ready` · `env.cleanup` · `env.isolation`

### protocol（WS 协议通道）
`protocol.auth` · `protocol.rpc` · `protocol.subscribe` · `protocol.events`

### session
`session.create` · `session.list` · `session.switch` · `session.history` · `session.delete`
`session.archive` · `session.restore` · `session.isolation` · `session.persistence`

### chat（对话主链）
`chat.send` · `chat.stream` · `chat.wait` · `chat.abort` · `chat.steer` · `chat.revoke` · `chat.reload-equiv`

### model（模型与 thinking）
`model.list` · `model.switch` · `model.thinking` · `model.subagent-switch`

### subagent
`subagent.dispatch` · `subagent.list` · `subagent.stream` · `subagent.cancel` · `subagent.model`

### workflow
`workflow.dispatch` · `workflow.runs` · `workflow.overlay` · `workflow.abort` · `workflow.reconnect`

### interaction（agent↔用户闭环）
`interaction.askuser` · `interaction.permission` · `interaction.plan-review` · `interaction.canvas`

### settings
`settings.provider` · `settings.system-prompt` · `settings.preset` · `settings.mcp`
`settings.network-proxy` · `settings.theme`

### plugin / extension
`plugin.list` · `plugin.toggle` · `plugin.statusbar` · `plugin.mountpoints` · `extension.load`

### render
`render.markdown` · `render.shiki` · `render.html-preview` · `render.changeset` · `render.image`

### workspace（外设面）
`workspace.filetree` · `workspace.drawer` · `workspace.search` · `workspace.terminal` · `workspace.import`

### evidence（取证原语）
`evidence.tree` · `evidence.logs` · `evidence.grep` · `evidence.screenshot`

### CLI 别名说明（`scripts/vp.mjs` 侧）
`vp.mjs` 的 `shell.grep` 是 `evidence.grep` 的**同名兼容别名**（早期草案值，两者必须同时存在）；
新增 capability id 时不要再引入第二套命名。

### 覆盖矩阵必备的衍生 id（v1.1 补登，2026-10-21）
以下四个 id 在覆盖矩阵里被标为「需要但缺失」，现补入清单：

`model.live-sync` · `ui.container` · `render.tool-call` · `subagent.session-observation`

doc 归属：`model.live-sync` → [model.md](model.md)；`ui.container` → [workspace.md](workspace.md)；
`render.tool-call` → [render.md](render.md)；`subagent.session-observation` → [subagent.md](subagent.md)。
