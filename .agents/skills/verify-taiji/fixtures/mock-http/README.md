# mock-http 剧本库（零 token · 孙进程可达）

本目录是 `verify-taiji` 的 **mock-http 通道**剧本库——与 `fixtures/faux-responses/` 并列的第二条
零 token 通道。剧本格式**与 faux 完全同构**（`{ text?, thinking?, toolCalls?: [{name,args}], stopReason? }`
的数组，或 model-keyed 对象），所以 faux 剧本可以直接搬过来用。

## 为什么需要第二条通道

| 通道 | 主会话 | subagent / workflow 孙进程 | 依赖 |
|------|--------|---------------------------|------|
| faux | 可用 | **不可达**（实测 `Model "faux/..." not found`） | pi extension 注册 `api:'faux'` provider |
| mock-http | 可用 | **可达**（已实测） | 只要 `<agentDir>/models.json` 有 `openai-completions` 自定义 provider |

断点细节与实测证据见 `capabilities/env.md` 的 Gotchas，探针 `scripts/probes/faux-grandchild.mjs`（faux）
与 `scripts/probes/mock-llm-grandchild.mjs` / `mock-llm-workflow.mjs`（mock-http）。

## 用法

```js
import { createInstance, resolveRepo } from '../scripts/lib/instance.mjs'

const instance = createInstance({
  repo: resolveRepo('/abs/path/to/worktree'),
  name: `verify-mock-${Date.now().toString(36)}`,   // 独立实例名（独立端口段）
  llm: {                                            // ← 与 faux 互斥
    responses: JSON.parse(fs.readFileSync('fixtures/mock-http/subagent-dispatch-mock.json', 'utf8')),
    // 可选：tps / providerId / mainModel / subModel / models / port
  },
  background: true,
})
await instance.launch()
// …断言…
console.log(instance.llm.baseUrl, instance.llm.mainRef, instance.llm.subRef)
console.log(instance.mockLlm.requests.map((r) => r.model))   // 铁证面
await instance.dispose()   // 同时关 mock server + 删自建数据目录
```

装配出的磁盘状态（`lib/instance.mjs` 的 `ensureLlm`）：

- `<dataDir>/agent/models.json` → provider `mockllm`（`api: 'openai-completions'`,
  `baseUrl: http://127.0.0.1:<port>/v1`, `apiKey` 恒字面量 `mock-key-not-needed`），
  模型 `mock-1` / `mock-sub-a` / `mock-sub-b`；
- `<dataDir>/agent/settings.json` → `defaultProvider=mockllm` / `defaultModel=mock-1` /
  `enabledModels` 追加三个 mock 模型 / `retry.enabled=false`；
- `<dataDir>/agent/subagents/config.json` → `engineDefaults.pi = mockllm/mock-sub-a`（孙进程缺省模型）；
- **不写** `agent/extensions/faux-llm-ext.ts`（这条通道不依赖 extension）。

## 剧本索引

| 文件 | 验什么 | 演员（model-keyed） | 已知限制 |
|------|--------|--------------------|----------|
| `subagent-dispatch-mock.json` | 子代理派发执行层：主派发 → 成员吐 canary | `mockllm/mock-1`（派发 + 收尾 + 通知后若干轮）、`mockllm/mock-sub-a`（canary） | 成员剧本只有 1 步，二次派发需补步 |
| `workflow-fanout-mock.json` | workflow fan-out 执行层：两成员各交 structured-output | `mockllm/mock-1`、`mockllm/mock-sub-a`（8 步**全部**是合法终局 structured-output） | `name` 必须替换成 `fixtures/workflows/fanout-canary.workflow.js` 的绝对路径；成员必须在终局调 `structured-output`；**不要**用「toolCall 步 + 收尾文本步」交替（见下文坑 4） |

配套 workflow 脚本：`fixtures/workflows/fanout-canary.workflow.js`（最小 fan-out，成员用 schema 收 summary）。

## 踩过的坑（1/3/6 已由 lib 处理，2/4/5 是剧本编写纪律）

1. **pi 发到 HTTP 的 `model` 是裸 id**（`mock-1`），不是 `provider/model`。`createMockLlm` 两种 key
   写法都兼容，但请求记录里的 `model` 字段永远是裸 id——断言要用裸 id。
2. **游标是 per-model、由 mock server 进程持有**（**不是** per-pi-进程——早期这里写错了，
   2026-10-22 实测纠正：多个 pi 打同一个 server 必然共享游标）。由此推两条纪律：
   - 不给 `workflow_run` / `subagent_start` 传 run 级或 task 级 `model` 时，成员继承主 agent 模型 →
     与主队**共享同一游标**（表现 = 成员拿到主队的 step，断言串味）；
   - **同一模型被两个 session 顺序使用时，第二个 session 的首轮会拿到第一个的后续 step**。
     多 session 互不污染的正确做法：① 每个 session 用不同模型（`session.create.modelOverride`）；
     ② 每组之前 `instance.mockLlm.reset()`；③ 每个 session 独立实例（独立 server）。
3. **完成通知会触发主 agent 再跑一轮**：主演员队列要备多步，否则命中「剧本耗尽 404」
   （不影响可达性结论，但会让 evidence 里出现 mock 404 噪音）。
4. **workflow 成员必须调 `structured-output`**：workflow 模式下它是单参数合成工具
   （parameters 即权威 schema），不调用 = `schema_deterministic` 失败。
5. **并发成员的队列必须「每一步都合法」**：同模型的多个成员进程**共享同一队**且并发推进
   （游标 per-model，见坑 2）——若剧本是「toolCall 步 + 收尾文本步」交替，交错消费会让某个成员
   拿到收尾文本那一步 → `schema_deterministic` 失败（2026-10-21 实测：1/2 成员失败）。
   修法 = 成员队列每步都是能独立收敛的终局调用（`workflow-fanout-mock.json` 即此形态）。
6. **auto-rename 必须关**（`agent/auto-rename-enabled` 删除）：标题生成会经 `llm-shared` 打 mock，
   消耗剧本 step；`ensureLlm` 已自动删除该标志。

## 维护

- JSON 里不能写注释；说明写在本文件。
- 新增剧本：同批更新上表 + （若踩到新坑）上面的「踩过的坑」节。
- `_note` 键只用于 model-keyed 剧本的头部提示，`selectQueue` 只按模型取队列，未知键被忽略。
