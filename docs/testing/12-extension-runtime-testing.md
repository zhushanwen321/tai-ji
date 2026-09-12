# 12 · extension 层运行时测试体系（worker harness → real LLM E2E）

> [STALE 2026-09-13] 本文撰写于 subagent-workflow 重构前：档位 A 的 L1 harness（`worker-script-builder.ts` + `worker-script-builder-runtime.test.ts`）已随重构并入 host/injectors 而删除，同名等价物不存在（现行源码见 `extensions/universal/subagent-workflow/src/{host,injectors}/`）。仅保留仍然有效的章节：§2 断言价值层级方法论、§3 档位 C real E2E 结论、§4 pi-mono 参考模式、§5 决策树；现存测试覆盖 = `extensions/universal/subagent-workflow/src/__tests__/workflows-e2e.test.ts`（L1.5）+ `e2e/workflow-thinkinglevel-real.spec.ts`（L2/L3）。
>
> **定位**：[TEST-STRATEGY.md](../../TEST-STRATEGY.md) 的分层 SSOT 覆盖「单元/集成/E2E mock 轨/dev 冒烟」，[11-real-e2e-specs.md](./11-real-e2e-specs.md) 覆盖「app 级 real-mode Playwright E2E」。本文补两者之间的空白——**extension（尤其 `extensions/universal/subagent-workflow`）层如何做运行时断言**：从源码字符串断言（L0）一路到真实 LLM（L3）。
>
> **读者**：给 subagent-workflow（或同类 extension）写测试、想把「降级断言」升级为运行时断言、或要做 real LLM 验证的开发者。

---

## 1. 为什么需要这套体系

`extensions/subagent-workflow` 的 workflow 执行走 worker_threads 子进程：主线程 `actionRun` → `RunSpec` → `workerHost.start`（spawn worker）→ worker 内 `buildWorkerScript` 产物执行 → `agent()` 经 `postMessage(agent-call)` 请求主线程 → 主线程 `resolveIdentity`/`resolveModel` → spawn pi 子进程 → 真实 LLM。

这条链路跨 3 个执行域（主线程 / worker 线程 / pi 子进程），每一域都有自己的失败模式。**只在一个域做断言，会漏掉跨域的注入/序列化/作用域 bug**。典型教训：

- `_safePost` 作用域 bug（定义在 async IIFE 内、IIFE 外的 `.then()/.catch()` 里使用）→ 源码字符串断言全绿，但真实 Worker 每次 return 都 `ReferenceError` → exit code 1 → 所有 workflow 100% 失败。由 `worker-script-builder-runtime.test.ts` 抓住。
- `$MODEL` 注入写成源码字符串断言（`expect(script).toContain('const $MODEL = ...')`）→ 只证明「生成的源码含这行」，不证明「真实 Worker 拿到 `workerData.model=X` 后产出的 `agent-call.opts.model=X`」。由本次 P3/P4 runtime 升级解决。

**核心原则**：断言越靠近「真实产物」，价值越高；越靠近「源码字符串」，越只能防拼写错误。下文的「价值层级」量化这个梯度。

---

## 2. 断言价值层级（L0–L3）

源自 [11-real-e2e-specs §6](./11-real-e2e-specs.md#6-断言真实表面的价值层级)，本文按 extension 层重新表述并给出每层在本仓库的可执行方式：

| 层级 | 断言对象 | 能证明什么 | 抓不住什么 | 本仓库实现 |
|---|---|---|---|---|
| **L0** | 生成的源码字符串（`toContain`）| 「拼对字符串」「注入行存在」| 运行时语法错（转义坏）、作用域错、workerData 没传到、序列化失败 | 原 `worker-script-builder.test.ts`（已随重构移除）|
| **L1** | 真实 Worker 线程的**消息产物**（`agent-call.opts`）| 「`workerData.model` 真的流到 `agent()` 的 `opts.model`」「三分支 fallback 真生效」| pi 是否真用这个 model 调 LLM、RunSpec 构造是否对 | 原 `worker-script-builder-runtime.test.ts`（本文档原主角，已随重构移除，模式见 §3 档位 A）|
| **L1.5** | 真实 lifecycle + workerHost + RunSpec 全链路（mock 最终 runner）| 「`actionRun(params.model)` → `RunSpec.model` → `workerData.model` → `$MODEL`」完整生产链路 | pi 子进程 + LLM | `workflows-e2e.test.ts`（mock runner）|
| **L2** | pi 自己写的**产物文件**（session JSONL 的 `model_change`/`thinking_level_change` entry）| 「pi 收到 `--model p/m:level` 后真实拆字段落盘」「零 xyz-agent 代码介入」| LLM 是否跑完产出 | `e2e/workflow-thinkinglevel-real.spec.ts` TC2 |
| **L3** | 真实 provider 跑完产出（assistant 消息）| 「完整链路可跑通」「provider 真的接受这个 model」| —（最真实，但慢/flaky/花钱）| `e2e/workflow-thinkinglevel-real.spec.ts` TC3 |

**选择原则**：**能确定性地证到 L1，就不停在 L0**（L0 只作防御性补充，不替代 L1）。L1.5 覆盖 RunSpec 构造段（L1 不覆盖）。L2/L3 是 real-mode，留给「跨进程协议透传」「pi 对 CLI 参数的真实消费」这类 L1 无法触及的盲区——但触发依赖 LLM 决策，flaky-skip 容忍。

---

## 3. 三档测试模式

### 档位 A · worker-runtime（L1）[已随重构移除]

原模式：真实起 `node:worker_threads.Worker` 执行生成的 worker 脚本产物，主线程模拟 workflow runtime 回发 `agent-result`，断言 `agent-call` 消息的 `opts`——Worker 边界以内全真（`$MODEL`/`$THINKING_LEVEL` global 注入、`agent()` 三分支 fallback、`postMessage` 序列化），唯一 mock 是主线程回发，完全确定（毫秒级）。harness 为 `runWorker()` 扩展点（给 workerData 加 `model`/`thinkingLevel` 透传）。

**该 harness 及其测试文件已随 2026-09 重构删除**（orchestration 层并入 host/injectors），此处保留模式描述供未来重建参照：核心思想是「断言越靠近真实产物越好」——源码字符串断言（L0）只防拼写错误，真实 Worker 消息产物断言（L1）才能抓作用域/序列化/透传 bug（历史教训：`_safePost` 作用域 bug 源码断言全绿但真实 Worker 100% 失败）。若需要重建等价 harness，按现行 `host/` + `injectors/` 结构重新落地。

### 档位 B · workflow-E2E（L1.5）

**走真实 `actionRun` → `lifecycle.runWorkflow` → `workerHost` → Worker 全链路，唯一 mock 是 `deps.runner`（`AgentRunner` 接口）。**

- **真实程度**：覆盖「`actionRun` 把 `params.model` 塞进 `RunSpec.model`」+「`worker-host` 把 `spec.model` 透传到 workerData」这两段生产代码。
- **确定性**：✅ 完全确定（真 lifecycle + 真 JsonlRunStore temp dir，mock runner）。
- **现存实现**：[`extensions/universal/subagent-workflow/src/__tests__/workflows-e2e.test.ts`](../../extensions/universal/subagent-workflow/src/__tests__/workflows-e2e.test.ts) 的 `makeMockRunner()`——`runner.run` 是 `vi.fn`，`mock.calls[N][0]` 即 AgentCall 的 `opts`（含 `opts.model`）。
- **何时用**：改动涉及 model/thinkingLevel 字段在 actionRun → RunSpec → workerData 的流转时，本档位是回归防线。

---

### 档位 C · real LLM E2E（L2/L3）

**真 Electron + 真 runtime + 真 pi 子进程 + 真实 LLM provider。零 mock。** 详见 [11-real-e2e-specs.md](./11-real-e2e-specs.md)。

- **真实程度**：最真实。断言 pi 自己写的 session JSONL（L2）+ 真实 provider 产出（L3）。
- **确定性**：❌ flaky（触发依赖 LLM 决策调 tool，不调则 skip + diag 落盘）。
- **模板**：`e2e/workflow-thinkinglevel-real.spec.ts`（TC1 验 state 请求值 / TC2 验 pi JSONL `thinking_level_change` + `model_change` / TC3 验完整跑通）。

#### run-level override 的 real E2E 限制

现有 `workflow-thinkinglevel-real.spec.ts` 验证的是 **per-call** override（脚本内 `agent({model, thinkingLevel:"high"})` 显式传）。**run-level override（workflow tool 顶层 `model` 参数）的 real E2E 有固有困难**：

- run-level `model` 是**主 agent 的自主决策**（它在调 `workflow` tool 时决定是否带 `model` 字段）。强引导 prompt 只能保证「调 workflow」，不能保证「带特定 model 字段」——LLM 可能省略。
- 因此 run-level override 的 real E2E 触发**不可控**，flaky-skip 概率高。

**可行路径**：
1. **探针脚本读 `$MODEL`/`$THINKING_LEVEL` global 并 echo**（验证 global 被注入），但这是 worker 内行为，档位 A 已确定性覆盖，real E2E 价值低。
2. **预设 fixture 让主 agent 必须传 model**（如 workflow 脚本的 usage 文案强引导），但仍依赖 LLM 遵从。
3. **直接断言档位 A/B 已覆盖的链路**——run-level override 的核心代码（worker-script-builder 注入 + agent() fallback + RunSpec 透传）已被 L1/L1.5 确定性验证；real E2E 只能补「pi 真调 LLM」这最后一段，而那段是 pi 核心职责（非 extension 代码），由 pi 自己的测试 + 现有 thinkingLevel real spec 覆盖。

**结论**：**run-level override 不新增 real E2E spec**（ROI 低）。real E2E 留给 per-call override（已有 spec）和跨进程协议透传类盲区。如需用真实模型（如 `zhipu-coding-plan-router/glm-5.2`）做 smoke，直接复用现有 thinkingLevel spec 改 `PROBE_MODEL` 即可。

#### 用 glm-5.2 做 real smoke（可选）

`zhipu-coding-plan-router/glm-5.2`（reasoning=true，thinkingLevelMap: high→high, xhigh→max）可用于 real smoke。最小步骤：

```bash
# 1. real renderer bundle（与 mock bundle 输出冲突，分批 build）
# 2. 跑现有 thinkingLevel spec（它用 deepseek-router/ds-pro，可改 PROBE_MODEL）
PROBE_MODEL=zhipu-coding-plan-router/glm-5.2 npx playwright test e2e/workflow-thinkinglevel-real.spec.ts --grep TC2
# TC2 断言子进程 JSONL 含 model_change（provider=zhipu-coding-plan-router, modelId=glm-5.2）
```

> 注意：glm-5.2 的 thinkingLevelMap 无独立 `max` 键，传 `thinkingLevel:"max"` 会被 clamp 到 xhigh（映射 `"max"`）。测 thinkingLevel 用 `"high"` 或 `"xhigh"` 更直接。

---

## 4. pi-mono 参考模式（供未来借鉴）

调研 pi 源码（`~/GitApp/pi-ecosystem/pi-mono`）发现三套 real-mode 模式，xyz-agent 目前**未直接采用**，但未来若要做「真 pi 子进程 + 可控 LLM」的测试，这是最干净的参照：

### 4.1 faux provider（mock LLM 边界，agent loop 全真）

`packages/ai/src/providers/faux.ts` 的 `fauxProvider()` / `registerFauxProvider()`。声明式编排响应序列，**最关键的断言钩子**：响应工厂 `(context, options, state, model) => AssistantMessage` 拿到真实传给 provider 的 `model` + `options.reasoning`，可 capture 事后断言。

**对应 xyz-agent 场景**：若未来要在 extension 层验证「resolveModel 选对 model」而不仅「agent-call 带对 model」，可引 faux provider 模式（但 xyz-agent 经子进程调 pi，faux 需注入 pi 侧，跨进程复杂度高）。

### 4.2 AgentHarness（生产 agent 驱动器，可订阅事件 + 运行时切 model）

`packages/agent/src/harness/agent-harness.ts`。跑真实 `runAgentLoop`，只把 `Models` 换成含 faux provider 的实例。`setModel/setThinkingLevel` 在 save point（turn_end）刷新到下一个 turn——**「运行时模型切换生效」的断言范式**。

**黄金参照**：`packages/agent/test/harness/agent-harness.test.ts` 的 "refreshes model/thinkingLevel at save points"——faux 响应回调 capture model + reasoning，`subscribe(tool_execution_start)` 里切 model，断言第二个 provider 调用用了新 model。这正是「run-level override 运行时生效」在 pi 侧的等价测试。

### 4.3 RpcClient（真 spawn pi 子进程 + JSONL 通信）

`packages/coding-agent/src/modes/rpc/rpc-client.ts`。`spawn("node", [cliPath, "--mode","rpc", ...])` 起真实 pi CLI 子进程，typed API：`setModel/setThinkingLevel/promptAndWait/collectEvents/waitForIdle`。xyz-agent 自己就是 spawn pi + RPC 通信，`RpcClient` 模式可直接复用。

**real-LLM gated 模式**：`describe.skipIf(!process.env.ANTHROPIC_API_KEY)` 门控，无 key 自动 skip。xyz-agent 的 `packages/coding-agent/src/modes/rpc/rpc-mode.ts` 可复用此模式写 real-LLM 测试，断言 `model_change`/`thinking_level_change` JSONL entry（L2）。

---

## 5. 决策树：何时用哪档

```
要验证的代码在 worker 内（globals 注入 / agent() fallback / parallel/pipeline）?
├─ 是 → 档位 A（worker-runtime，L1）——原 harness 已移除，需按现行 host/injectors 结构重建。
│       L0 源码断言可作补充防线。
│
要验证 RunSpec 构造 / worker-host 透传 / actionRun 字段流转?
├─ 是 → 档位 B（workflow-E2E，L1.5）。makeMockRunner() 已就绪（workflows-e2e.test.ts）。
│
要验证跨进程协议透传 / pi 对 CLI 参数的真实消费 / pi 产物文件?
├─ 是 → 档位 C（real E2E，L2/L3）。参考 workflow-thinkinglevel-real.spec.ts。
│       注意：run-level override 触发不可控（§3 档位 C），per-call override 才适合。
│
要验证 pi 核心 RPC / spawn 链路（非 extension 代码）?
└─ 参考 pi-mono RpcClient 模式（§4.3），real-LLM gated。
```

**默认起点**：档位 A。绝大多数 extension 层逻辑（globals 注入、agent() 行为、parallel/pipeline）的最佳性价比都在 L1。只有跨进程/真实 LLM 的盲区才上 L2/L3。

---

## 6. 现存实证索引

| 验证目标 | 档位 | 文件 | 价值层级 |
|---|---|---|---|
| run-level 字段流转（actionRun → RunSpec → workerData → agent-call opts）| B | [`extensions/universal/subagent-workflow/src/__tests__/workflows-e2e.test.ts`](../../extensions/universal/subagent-workflow/src/__tests__/workflows-e2e.test.ts) | L1.5 |
| runSpawn（spawn pi 子进程的业务逻辑）| mock spawn | `run-spawn-integration.test.ts` 等（FakeChild）| L0.5（mock 边界 = spawn）|
| workflow agent() thinkingLevel 端到端（per-call）| C real | `e2e/workflow-thinkinglevel-real.spec.ts` | L2/L3 |

> 原 L1 档位（`worker-script-builder-runtime.test.ts`）已随重构删除，见文头 STALE 注。

---

## 附录：关键文件速查

| 文件 | 作用 |
|---|---|
| `extensions/universal/subagent-workflow/src/__tests__/workflows-e2e.test.ts` | L1.5 真 lifecycle + mock runner（现行 SSOT）|
| `e2e/workflow-thinkinglevel-real.spec.ts` | L2/L3 real LLM E2E 模板 |
| `e2e/fixtures/launch-app-real.ts` | real-mode Electron launch fixture |
| `~/GitApp/pi-ecosystem/pi-mono/packages/ai/src/providers/faux.ts` | pi faux provider（mock LLM 边界）|
| `~/GitApp/pi-ecosystem/pi-mono/packages/agent/src/harness/agent-harness.ts` | pi AgentHarness（生产 agent 驱动器）|
| `~/GitApp/pi-ecosystem/pi-mono/packages/coding-agent/src/modes/rpc/rpc-client.ts` | pi RpcClient（真 spawn pi 子进程）|
