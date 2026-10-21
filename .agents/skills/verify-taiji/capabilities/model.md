# model · 模型与 thinking 能力原语（list / switch / thinking / subagent-switch）

> 骨架遵循 [API-CONTRACT §4](API-CONTRACT.md)：H2 即 capability id。
> 本域横跨三个数据面，先分清再断言：
> 1. **模型目录** = `config.providers`（含 `models[].supportedLevels`）+ `model.list`（扁平聚合）；
> 2. **会话生效值** = `model.switched` / `session.state_changed` / `session.thinkingLevelSet` 回执与广播；
> 3. **执行域覆盖**（subagent / workflow run）= `subagent.setModel` + record/journal 记账 + badge。
> 相关约定：[ADR-0065](../../../../dev-0.11.11/docs/adr/decisions.md)（mutation reply 生效值）、
> [ADR-0129](../../../../dev-0.11.11/docs/adr/decisions.md)（subagent 执行模型切换）、
> C-pi-13（生效回执）。组件：`components/panel/{ModelSelectPopover,ThinkingLevelPopover,
> ModelPickerPanel,ModelThinkingAggregate,SubagentTab}.vue`。

## 通用前置

- `env.ready` + `env.doctor`；**faux 实例自带 4 个演员模型**（`faux-1` / `faux-1-reasoning` /
  `faux-1-b` / `faux-1-c`，`seed-faux.mjs` 写入 `agent/models.json` 与 `settings.enabledModels`）。
  这是验模型切换最省事的环境：切换目标恒存在、零凭据。
- 能力面真相：**某模型支持哪些思考档** = runtime 注册表下发的 `models[].supportedLevels`
  （`ProviderInfo.models[]`）。前端不本地推算（`packages/core/src/domain/new-task-search/supported-levels.ts`
  的 `supportedLevelsOf` 读 `providers`）。`faux-1`（reasoning:false）只有 `off`；
  `faux-1-reasoning` 有 `off..high`（`packages/runtime/src/__tests__/fixtures/faux-llm-ext.ts` 头注）。

---

## model.list · 模型目录

- **通道**：B（`model.list` reply + 连接期首推）+ A（模型弹层列表）+ C（`agent/models.json` /
  `agent/settings.json`）
- **前置**：`requires` = none（不消费 LLM）；依赖 `env.ready` `protocol.rpc` `protocol.events`
- **用于**：`p0-model-switch`（前置）、`p0-provider-live-sync`（目录可见性）、`p0-settings-provider`

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：composer 右簇模型触发器（title = `切换模型`，`panel.modelSelect.switchModel`）→
  弹层 `model-picker-panel`（搜索 `model-picker-search` / 列表 `model-picker-list` /
  行 `model-picker-item-<modelId>` / 默认标记 `model-picker-default-tag` / 空态 `model-picker-empty`）；
  聚合形态（窄宽度）为 `composer-model-thinking-aggregate`（title `模型 · 思考等级`）。
- **协议**：`model.list {}` → `model.list { models: ModelInfo[] }`
  （`packages/shared/src/protocol.ts` `ServerMessageMap['model.list']`；
  handler = `packages/runtime/src/transport/model-message-handler.ts` `handleModelList`，
  数据源 = `modelService.aggregateModels(configService.listProviders())`）。
  另有**连接期首推**：`sendInitialState` 推一条 `model.list`（`packages/core/src/domain/settings/
  settings-lifecycle.ts` 注释记录过「注册晚于首推会丢」的历史坑）。
- **副作用点**：无（纯读）。设置页开着时会 `config.setProviderCatalogWatch` 感知 `models-store.json` 变化。

### 驱动

```js
const { models } = await p.call('model.list', {}, { replyType: 'model.list' })
```

```
click  title="切换模型"
expect testid=model-picker-panel visible
expect testid=model-picker-item-faux-1 visible
```

### 断言（期望终态 / 失败信号）

- 期望：`models` 含 `{ id, name, providerId, providerName, reasoning?, contextWindow?,
  thinkingLevelMap?, enabled? }`；每个启用 provider 的模型都在；`model-picker-list` 行数与
  `models.filter(m => m.enabled !== false)` 一致（分组按 provider）。
- **失败信号**：`model-picker-empty` 文本 = 「暂无可用模型，请先在设置中导入凭据或配置供应商」
  （`panel.modelSelect.noModel`）→ 目录空（models.json 没写成功 / provider 全禁用）；
  搜索无结果显示「无匹配模型」（`noMatch`，与空池区分）。
- **目录漂移信号**：`model.list` 有该模型但弹层没有 → 前端 `settingsStore.models` 未刷新
  （首推丢失 / 广播未消费）；反之弹层有而 `model.list` 无 → 缓存陈旧。

### 证据（A/B/C 各抓什么）

- A：模型弹层截图（含目标行与默认标记）。
- B：`model.list` reply 的模型清单（id/providerId/enabled）；连接期的首推帧是否收到。
- C：`cat <dataDir>/agent/models.json`（providers/models 定义）、`agent/settings.json`
  （`defaultProvider` / `defaultModel` / `enabledModels`）。

### 证不了

- 模型是否**真的可调用**（要 `model.switch` + 一轮回复；`model.list` 只证明「目录里有」）。
- catalog（pi.dev overlay）与 remote-config 的合并细节（属 provider-live-sync / settings 域）。

### Gotchas

1. **`model.list` 是「首推 + 按需拉」，不是订阅流**：新增 provider 后模型**不会**自动出现在
   `model.list` 推送里（`packages/core/src/transport/mock/index.ts` 同款注释：`setScopedModels`
   不主动广播模型列表）。要新鲜数据就重新拉一次；`provider-live-sync` 负责「运行中可见」的另一半。
2. **`model-picker-item-<id>` 只带裸 modelId，不带 provider**：不同 provider 同名模型会撞 testid
   （DOM 上多行同 testid）。断言时用 `model-picker-list` 内按分组文本限定，或改用行文本。
3. **`ModelInfo` 里没有 `supportedLevels`**（只有 `thinkingLevelMap`）：档位可用集读
   `config.providers` 的 `models[].supportedLevels`，别在 `model.list` 里找。
4. **faux 演员名容易误读**：`faux-1` 的 name 是「Faux 1 (reasoning off)」，模型 id 才是
   `faux-1`；断言用 `model-picker-item-faux-1`，不要用 name 文本。

---

## model.switch · 主会话切换模型（热切 + 生效回执）

- **通道**：A（composer 模型名变化）+ B（`model.switched` 回执生效值 + `session.state_changed` 广播）
  + C（pi JSONL 的 `model_change` entry）
- **前置**：`requires` = faux（推荐，切到 `faux-1-reasoning` 等演员）；依赖 `session.create`
  `model.list` `chat.wait`（验证「切完能用」要发一轮）
- **用于**：`p0-model-switch`（主）、`p0-session-isolation`（两会话不同模型可选手法）、
  `p0-provider-live-sync`（新 provider 后直接切）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：对话态 composer 右簇点模型名 → `model-picker-panel` → 点目标行（`model-picker-item-<id>`）。
  切换中触发器显示转圈并**忽略重复开合/点选**（`switching` 单飞锁，`ModelSelectPopover` props 注释）。
- **协议**：`model.switch { sessionId, provider, modelId }` → `model.switched { sessionId, provider, modelId }`，
  **值 = pi 实际生效模型**（runtime `set_model` 后 `get_state` 读回，pattern 引擎静默换模时 ≠ 请求值；
  `packages/runtime/src/services/session/session-model-control.ts` `switchModel`）。
  失败经 `error` envelope，code ∈
  `SESSION_NOT_FOUND` / `SESSION_ACTIVATE_FAILED` / `MODEL_NOT_FOUND` /
  `PROVIDER_CREDENTIAL_MISSING` / `ENGINE_MODEL_MISSING`（`packages/runtime/src/utils/errors.ts`）。
- **副作用点**：`ensureActive`（停止态/回收态先拉活，1–2s）→ pi `set_model` → 读回生效值 →
  三实例 `markDirty`（modelId/usage/thinkingLevel）→ 快照收敛后广播 `session.state_changed`
  `{ sessionId, modelId, thinkingLevel? }` → 直写内存 summary；**持久化唯一写方 = pi**
  （JSONL `model_change` entry）。
- **Landing 例外**：landing 态（无 session）切模型**不发** `model.switch`，只记 `pendingModel`，
  create 时作为 `modelOverride` 快照透传（`packages/core/src/domain/composer/model-thinking.ts`）。

### 驱动

```
click  title="切换模型"
click  testid=model-picker-item-faux-1-reasoning
expect title="切换模型" 内文本 = faux-1-reasoning 的 name   # 回执到达后更新（禁乐观写）
```

```js
const r = await p.call('model.switch',
  { sessionId: sid, provider: 'faux', modelId: 'faux-1-reasoning' },
  { replyType: 'model.switched' })
// r.provider / r.modelId = 生效值
```

### 断言（期望终态 / 失败信号）

- 期望：
  - reply `{provider, modelId}` = 生效值（与请求相同或 pi 静默替换后的同族值）；
  - 收到 `session.state_changed`，`modelId` 与 reply 一致；
  - A：composer 模型名变为该模型（1s 内，走快照防抖）；
  - C：`<sessionFile>` 追加 `model_change` entry（`{"type":"model_change", ... provider/modelId}`）；
  - 发下一轮：`message.complete.responseModel` = 新模型（真正生效的最终证据）。
- **失败信号（具体形态）**：
  - `error` `MODEL_NOT_FOUND`：目录里没有该 `provider/modelId`（大小写/拼写）；
  - `PROVIDER_CREDENTIAL_MISSING`：provider 没凭据（pi 报 not found 但凭据也缺时优先报这个）；
  - `ENGINE_MODEL_MISSING`：pi 快照还没识别该模型（新增 provider 后未 refresh）；
  - `SESSION_NOT_FOUND` / `SESSION_ACTIVATE_FAILED`：会话不在册 / 拉活失败；
  - **假成功形态**：reply 成功但 composer 名未变 → 前端未消费回执（历史事故：乐观写 + 广播竞态）；
  - reply 成功但下一轮 `responseModel` 还是旧模型 → 只改了缓存没改 pi（`set_model` 未真正生效）；
  - C 无 `model_change` entry → 持久层未写（重启后回落旧模型）。
- **对照断言（强弱）**：只断言「composer 名变了」是弱证据（可能乐观写）；必须至少叠
  reply 生效值 **或** JSONL entry 之一。

### 证据（A/B/C 各抓什么）

- A：切换前后 composer 右簇截图（模型名）；切换中 spinner 截图（可选）。
- B：`model.switched` reply 原文 + `session.state_changed` 帧（含 thinkingLevel）。
- C：`grep -n '"type":"model_change"' <sessionFile> | tail -3`；如需断言全局默认，读
  `agent/settings.json` 的 `defaultModel`——但注意 `model.switch` **不写**该字段
  （`DefaultModelSource` 里虽登记过 `'model-switch'`，当前 handler 无该分支；写默认走
  `config.setDefaultModel`）。

### 证不了

- 真实 provider 的模型可用性/鉴权/限流；真实模型「智能水平」差异。
- pattern 引擎的静默换模（只有特定模型族才有；faux 不会触发）——这条只能看回执与请求不等时记录。

### Gotchas

1. **`model.switch` 会先拉活会话**：停止态/被回收的会话切模型要 1–2s（`ensureActive`），
   断言要有耐心；期间按钮转圈且**点选被忽略**（并发两条 switch 会乱序回执）。
2. **禁乐观写**：显示值只认回执；测试里不要在看到 UI 变化前就去断言 store（会假绿）。
3. **landing 不发 RPC**：landing 切模型只改 pending，create 时才生效；在 landing 上断言
   `model.switched` 会超时。
4. **切换全局默认是另一个动作**：`config.setDefaultModel`（设置页）才写 `settings.json` 的
   `defaultModel`；`model.switch` 的持久化语义是「pi 会话内 `model_change`」。
5. **`thinkingLevel` 可能被联动**：切模型时 pi 若新模型档位与当前不同会 emit
   `thinking_level_changed`；`state_changed` 里可能带新的 `thinkingLevel`（别惊讶）。

---

## model.thinking · 思考档位（session 级）

- **通道**：A（档位触发器 label / 档位行选中勾）+ B（`session.thinkingLevelSet` 回执生效值 +
  `session.state_changed`）+ C（pi JSONL `thinking_level_change` entry）
- **前置**：`requires` = faux；**必须用支持多档的模型**（`faux-1-reasoning`，`faux-1` 只有 off）；
  依赖 `session.create` `model.switch` `model.list`
- **用于**：`p0-model-switch`（thinking 子项）、`p0-model-thinking`（独立 scenario）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：composer 右簇档位触发器（title = `思考级别`，`panel.thinkingLevel.title`；显示
  `关/极简/低/中/高/极高/最高` 之一）→ 弹层列出**当前模型可用档**（不可用档不渲染）→ 点一行。
- **协议**：`session.setThinkingLevel { sessionId, level }` →
  `session.thinkingLevelSet { sessionId, level }`，**`level` = pi 实际生效档**
  （pi 会把不支持的档钳制，如 mimo 族 `max → high`；`packages/runtime/src/transport/
  model-message-handler.ts` `handleSessionSetThinkingLevel`）。
  失败：`SESSION_ACTIVATE_FAILED` / `SESSION_NOT_FOUND`（拉活阶段）经中央 catch 成 error envelope。
  ⚠️ `model-message-handler.ts` 里「无活跃进程抛 `SESSION_NOT_ACTIVE`」的注释**已过时**：实装
  `setThinkingLevel` 与 `switchModel` 同一激活语义（先 `ensureActive` 再 set，
  `session-model-control.ts` 的 `activate` + 注释「U2/D7：与 switchModel 同一激活语义」）。
- **副作用点**：`activate`（停止态/回收态先拉活）→ pi `set_thinking_level` → 读回 `get_state` 生效档
  → `thinking_level_changed` → 广播 `session.thinkingLevelSet` + `session.state_changed`；
  持久化 = pi JSONL `thinking_level_change`；RPC 成功后 runtime 主动 `syncTraceEntries`。

### 驱动

```
click  title="思考级别"                     # ThinkingLevelPopover 触发器
click  text=/^高$/                          # 行是 Button，无 testid（见 Gotcha 2）
# 或窄宽度聚合形态：click testid=composer-model-thinking-aggregate → click testid=thinking-level-row-high
```

```js
const r = await p.call('session.setThinkingLevel', { sessionId: sid, level: 'high' },
  { replyType: 'session.thinkingLevelSet' })
```

### 断言（期望终态 / 失败信号）

- 期望：reply `level` = 生效档（请求档受支持时相同；被钳制时不同，**以 reply 为准**）；
  触发器 label 同步；C：JSONL 追加 `thinking_level_change`；下一轮 `message.complete` 的
  诊断/usage 反映档位（可选）。
- **失败信号（具体形态）**：
  - reply `level ≠ 请求` 且请求档在 `supportedLevels` 内 → 钳制异常（记录为缺陷）；
  - 请求档不在 `supportedLevels` 内 → **UI 根本不该渲染该行**（渲染了 = 档位面与能力表分叉）；
  - `SESSION_ACTIVATE_FAILED` / `SESSION_NOT_FOUND` → 拉活失败（会话不在册 / pi 起不来）；
  - 触发器 label 与 reply 不一致 → 前端未用回执写显示态；
  - C 无 `thinking_level_change` → 只改了内存。

### 证据（A/B/C 各抓什么）

- A：档位弹层截图（可用档集）+ 切换后触发器文本。
- B：`session.thinkingLevelSet` reply；`session.state_changed`（若带 thinkingLevel）。
- C：`grep '"type":"thinking_level_change"' <sessionFile> | tail -3`。

### 证不了

- 「思考更深/更好」这类质量差异（faux 的 thinking 是脚本文本）。
- `thinkingLevelMap` 的 key→value 重映射语义（on/off 模型族）：只有特定模型有映射，
  faux 无 map；要验需真实 provider 模型。

### Gotchas

1. **`faux-1` 只有 `off`**：在它上面验「切 high」会看到弹层只有一行（或钳制回 off）——不是 bug。
   验多档必须先 `model.switch` 到 `faux-1-reasoning`。
2. **非聚合态档位行没有 testid**（`ThinkingLevelPopover` 的行是裸 `Button`，只按 label 文本可寻址）；
   聚合态才有 `thinking-level-row-<level>`（`ModelThinkingAggregate.vue`）。这是当前**锚点缺口**，
   已在 Gotchas 登记；要稳定驱动非聚合态需补 testid。
3. **不要用「发送前」的档位断定生效**：回执才是事实；pi 钳制会让请求≠生效。
4. **切档会先拉活**（与 `model.switch` 同语义）：停止态/被回收会话会先 `ensureActive`（1–2s），
   期间 `switching` 单飞锁生效；失败成 `SESSION_ACTIVATE_FAILED`。不要按「必须先发条消息」写剧本。
5. **建会话时的档位走 `thinkingOverride`**（`session.create`），不是本 RPC；两者别混。

---

## model.subagent-switch · 执行域模型热切（subagent / workflow run）

- **通道**：A（子代理详情/浮层标题栏的模型标签 + 「用户覆盖中」badge）+ B（`subagent.setModel`
  三形态回执）+ C（record 事件文件 `record-model-override` / run journal `model-override`）
- **前置**：`requires` = faux（主会话）/ **mock-http | live**（孙进程即执行域；孙进程 faux 不可达，见 `证不了`）；依赖 `session.create`
  依赖 `subagent.list` `subagent.model` `workflow.runs` `workflow.overlay`
- **用于**：`p0-model-switch`（执行域子项）、`p0-subagent-dispatch`（覆盖后重派）、
  `p0-workflow-run`（run 级全切）

### 入口（用户 POV / 协议 / 副作用点）

- **用户 POV**：
  - **单成员**：drawer subagent tab 头行右侧模型触发器 `subagent-model-trigger`（title 含当前模型/来源）
    → 选模型 → 标签更新；覆盖生效时出现 `subagent-override-badge`（「用户覆盖」）。
  - **run 级全切**：workflow overlay 标题栏模型触发器 `wfvz-overlay-model-trigger` → 选模型 →
    `wfvz-overlay-model-override-badge`。
- **协议**：`subagent.setModel { recordId?: string; runId?: string; provider: ProviderId;
  modelId: string; thinkingLevel?: string }`（**recordId 与 runId 二选一**）。
  回执 `subagent.modelSet`，三形态判别：
  - chat 域 `{ kind: 'effective', effectiveModel: {provider, modelId}, effectiveThinkingLevel }`
    （有活进程、回读到手）；
  - chat 域 `{ kind: 'recorded', note }`（无活进程/引擎不支持热切：已记账，下次执行生效，**不带档位**）；
  - run 级 `{ members: [{ runId, state: 'switched'|'not-active'|'not-applicable',
    effectiveModel?, effectiveThinkingLevel? }], failures: [{ runId, reason }], summary }`
    （恒三组件，无 kind）。
  错误：`invalid_payload`（双缺/双给目标）、`subagent_model_switch_unwired`（宿主网关未注入）+
  宿主分型码透传（`engine_model_not_in_snapshot` / `engine_credential_missing` /
  `engine_state_readback_failed` / `subagent_model_switch_failed`）。
- **副作用点**（ADR-0129）：**持久化与热切必须同步落**——
  - chat 域：record 事件文件追加 `record-model-override` 帧（fold 取最新、替换不叠加）；
  - workflow 域：run journal 追加 `model-override` 事件；
  - runtime → pi 通道 = `client.prompt("/subagent-model <单行 JSON>")` 斜杠命令，结果经
    `<subagent 数据根>/model-switch/<requestId>.json` 原子回执（60s 超时 best-effort）。
  - 前端显示态 = **会话期回执态**（模块级 Map，`useSubagentModel`）；不写 record 字段
    （否则被下一帧 runtime 载荷冲掉）。

### 驱动

```
# 单成员（先要有 subagent 记录）
click  testid=tray-builtin-button[data-kind=subagent]        # 打开托盘 subagent 面板（有记录才渲染）
click  testid=tray-subagent-row                              # 进 drawer subagent tab
click  testid=subagent-model-trigger
click  testid=model-picker-item-faux-1-reasoning
expect testid=subagent-override-badge visible
```

```
# run 级全切
click  testid=tray-builtin-button[data-kind=workflow] ; click testid=tray-workflow-row
expect testid=wfvz-overlay visible
click  testid=wfvz-overlay-model-trigger
click  testid=model-picker-item-faux-1-reasoning
expect testid=wfvz-overlay-model-override-badge visible
```

```js
// recordId 形态
const r = await p.call('subagent.setModel',
  { recordId: recId, provider: 'faux', modelId: 'faux-1-reasoning' },
  { replyType: 'subagent.modelSet' })
// r.kind === 'effective' | 'recorded'
// runId 形态
const agg = await p.call('subagent.setModel',
  { runId, provider: 'faux', modelId: 'faux-1-reasoning' }, { replyType: 'subagent.modelSet' })
// agg.members / agg.failures / agg.summary
```

### 断言（期望终态 / 失败信号）

- 期望：
  - chat 域：`kind='effective'` 时 `effectiveModel` 与 `effectiveThinkingLevel` 在场；`kind='recorded'`
    时 `note` 可读且**没有**档位字段；A 侧标签更新 + `subagent-override-badge` 出现；
  - run 级：`members` 与 run 内成员一一对应（同一成员集合，`members ∪ failures` 互斥划分），
    `state='switched'` 成员带 `effectiveModel`；`not-active`（已退出）/ `not-applicable`
    （引擎不支持热切）是**合法态不是错误**；`summary` 非空；
  - C：record 事件文件/journal 新增 override 帧；**重派/续跑的下一轮 spawn 用新 `--model`**。
- **失败信号（具体形态）**：
  - `invalid_payload`（recordId/runId 双缺或双给）；
  - `subagent_model_switch_unwired` → 宿主编排未接线（组合根没注入 gateway，属装配缺陷）；
  - `engine_model_not_in_snapshot` / `engine_credential_missing` / `engine_state_readback_failed`；
  - **只热切不记账**：A 侧标签变了，但重派同一成员后又用旧模型（第 0 层覆盖没写）→
    违反 ADR-0129「两半必须同步」；
  - **只记账不热切**：A 侧 badge 亮了，但执行中的成员没换（`kind='effective'` 却没变）→ 同违规；
  - run 级：`failures` 非空但 UI 只显示一句总文案（不按成员分项）→ 呈现缺陷；
  - 覆盖后 `state='not-applicable'` 却被当失败报错（提示性应答被误判）。
- **「错误应答 = 记账已写」分型**：`engine_model_not_in_snapshot` / `engine_state_readback_failed`
  两码下，宿主**已经写了覆盖记账**（`SUBAGENT_SET_MODEL_ACCOUNTED_ERROR_CODES`），前端据此亮
  「用户覆盖中」badge；词表外的码（如 `engine_credential_missing`）不得亮 badge。

### 证据（A/B/C 各抓什么）

- A：subagent tab 头行截图（模型标签 + badge）；overlay 标题栏截图（run 级 badge）。
- B：`subagent.modelSet` 回执原文（三形态判别）；错误 envelope 的 code。
- C：`<dataDir>/ext-sessions/<rootSid>/subagents/records/<sa-id>.events` 里的
  `record-model-override` 帧（record 事件文件后缀 = `.events`，非 `.jsonl`）；
  `ext-sessions/<rootSid>/workflow/runs/<runId>.record.jsonl` 的 `model-override` 事件；
  重派后成员 pi 进程的 `--model` 参数（`ps -o command=`）。

### 证不了

- **孙进程 faux 不可达（已实测，SSOT = `capabilities/env.md`）**：`scripts/probes/faux-grandchild.mjs` 的结论
  为 `verified-unreachable` —— 孙进程 pi 以 `--no-extensions` spawn，扩展集只来自白名单
  （`GRANDCHILD_EXTENSION_PKG_SEGMENTS` = structured-output），e2e 专用放行门
  `resolveE2eFauxExtensionPath` 要求 `TAIJI_E2E=1`（dev 装配不设且设了会破坏 vite）。
  实测证据：`<dataDir>/logs/pi-task-stderr-<pid>.log` 出现 `Error: Model "faux/..." not found`。
  → 执行域（subagent / workflow 成员）的真实轮次**不能用 faux 验收**；
  **但可用 mock-http 通道**（`createInstance({ llm })`，孙进程经 `PI_CODING_AGENT_DIR` 读同一份 models.json，
  实测 `mock-grandchild-reachable` / `mock-workflow-reachable`，见 `scripts/probes/mock-llm-grandchild.mjs`
  与 `mock-llm-workflow.mjs`）；不愿用 mock-http 则走真实引擎/模型，或把该子项登记为 `verified-unreachable`。
  上述是对执行域而言；**主会话**的 faux 完全可用（argv 带 `--model`，可 model-keyed 选队）。
- 真实引擎（zcode 等）的热切能力差异（`not-applicable` 分支需要非 pi 引擎）。

### Gotchas

1. **recordId 与 runId 二选一**，双给/双缺都 `invalid_payload`；run 级全切不是「对每个 recordId
   循环调用」——它是聚合语义（三组件固定结构）。
2. **run 级聚合无 `kind` 字段**：判别靠 `members`/`failures`/`summary` 在场；别照 chat 域读 `kind`。
3. **`recorded` 不带档位**：无回读源，档位由下次解析按现役候选链推导；断言档位只在 `effective` 分支。
4. **显示态是会话期内存**：reload 后回执态丢失，标签回落 record 载荷字段（`resolveSubagentModelDisplay`
   的四分支）；跨 reload 断言请断言 C（记账）而不是 badge。
5. **触发前提**：subagent 详情要有 record（`switchRecord !== null`），否则 `subagent-model-trigger`
   不渲染（`SubagentTab` 的 `v-if`）；托盘 builtin 按钮也只在有记录时渲染（`total > 0`）。
6. **覆盖优先级最高**：覆盖后即使 agent frontmatter/脚本显式指定模型也会被覆盖（第 0 层），
   重派验证要断言「新模型」而不是「原 agent 模型」。

---

## model.live-sync · provider / 模型 / 凭据的运行中实时同步（P0 包）

- **通道**：B（`model.list` 前后对照 + `model.switch` 回执）/ C（`agent/models.json`、`agent/auth.json` 的写盘时刻与内容）/ A（composer 模型选择器是否出现新条目）
- **前置**：`requires: mock-http`（推荐，零外网）或 `live`；依赖 `model.list` `model.switch`
- **用于**：覆盖矩阵 P0 行「provider-live-sync」（`docs/FEATURE-PRIORITIES.md §6` 标 P0 的扩展包）

## 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：设置页新增一个 provider / 新增一个模型 / 换 API key → **不重启应用**，composer 的模型选择器里就能选到并切过去。
- 协议：`model.list` 取当前可见清单；`model.switch { sessionId, provider, modelId }`。
- 副作用点：`<dataDir>/agent/models.json` 与 `<dataDir>/agent/auth.json`（写侧经 provider 写策略链）；pi 侧靠 `@zhushanwen/pi-provider-live-sync` 扩展每 2s 轮询内容比较 + `modelRegistry.refresh({ allowNetwork: false })` 热生效。

## 驱动

**脚本形态（首选，已有可复用资产）**：

```bash
cd <repo> && node scripts/verify-provider-live-sync.mjs
# E2E-MODELS-02（L2.5）：真实 pi CLI + 真扩展 + 隔离 PI_CODING_AGENT_DIR + 本地 mock LLM，约 30s，零外网
```

**UI 形态（真机验收）**：

1. `env.launch` + `env.ready`（mock-http 装配，已有一个可用 provider）
2. `settings.provider` 新建一个 provider（或直接改 `agent/models.json` 模拟外部写入）
3. `model.list` 断言新模型出现（≤3s，扩展轮询周期 2s）
4. `model.switch` 到新模型 → 断言 `model.switched` 回执 + 下轮 `session.history` 有 `model_change`
5. 反向：删除该 provider → 断言**另一个仍存在的模型**仍可切（无塌陷）

## 断言（期望终态 / 失败信号）

- 期望终态：新模型出现在 `model.list`；`model.switch` 成功且 `get_state.model.id` 为新 id；删除后旧模型不受影响。
- 失败信号：
  - `model.switch` 报 `Model not found` → **快照冻结未刷新**（扩展未装载 / 轮询未生效，这是该功能挂掉的本质症状）；
  - 新模型永远不出现 → 目录投喂（catalog overlay）失效；
  - 删除一个 provider 后其它模型也切不过去 → 「塌陷」（写侧把整表写坏了）。

## 证据（A/B/C 各抓什么）

- **B**：切换前后的 `model.list` 快照差异 + `model.switched` 回执原文。
- **C**：`agent/models.json` 写入前后 diff；`<dataDir>/logs/` 里 `pi-provider-live-sync` 的轮询日志（变化触发行）。
- **A**：composer 模型选择器 `model-picker-list` 里新条目可见 + 顶部聚合按钮文本更新。

## 证不了

- 扩展轮询在**网络代理 / 高负载**下的时延上界（2s 是轮询周期，不是保证）。
- zcode 引擎侧是否同步（该扩展只服务 pi 引擎）。

## Gotchas

- 这功能的设计前提是「pi 的模型快照冻结在 spawn 时刻」——**不要用 `model.list` 单次结果判断是否生效**，要「写盘 → 等 ≤3s → 再拉一次」形成前后对照。
- `modelRegistry.refresh({ allowNetwork: false })` **零网络**：目录投喂只写本地缓存，不会去拉远端。
- 覆盖矩阵里的 `reuse-e2e` 指的是仓库脚本资产；本 capability 的增量价值 = **把它接进本技能的证据链与失败归因**（脚本本身只报 exit code）。
- 缺失抑制规则：曾存在过的 provider 突然缺失 → 抑制（不当成删除）；读失败 → 跳过。断言「没塌陷」时要考虑这三态。
