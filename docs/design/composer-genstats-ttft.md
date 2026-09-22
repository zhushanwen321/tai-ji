# Composer TTFT 首字延迟展示 设计

## 1 背景 / 目标

composer 右下工具带（`Composer.vue` composer-bar）已展示生成指标双触发器：TOKEN 速度（t/s）+ 缓存命中率（%）。速度窗口口径**刻意排除了 provider 首包延迟段**（`event-interpreter-gen-stats.ts` D1 注释：锚点选 assistant `message_start` 到达，不把 TTFT 敏感度引入速度语义）——被剥掉的「请求发出 → 首个 token」正是用户体感最敏感的一段。

**目标**：在 TOKEN 速度触发器**左侧**新增 TTFT 触发器，展示「请求发出 → 首个输出 token 到达」的延迟，补齐速度指标让出的那一段。与速度互补、不重复。

**非目标（Out-of-scope）**：
- 不改速度 / 缓存命中率现有口径与展示
- 不做 TTFT 告警 / 趋势图 / 导出
- 不测 pi 进程内部耗时细分（DNS / 排队 / 首包各段拆解）

## 2 现状问题

- 数据管道已成熟：`LlmWindowSampler`（采样）→ `GenStatsSample` → `GenStatsService`（落盘 + 聚合）→ `GenStatsFrame`（`session.stats_update` / `session.getGenStats`）→ `useGenStats` → `GenStatsTriggers`（展示）。TTFT 只需沿此管道平推一层，无新管道。
- 缺口 ①：pi 原生 `turn_start` 事件（每 LLM 请求前发出，agent-loop.js 内层循环逐请求 emit）被 `event-adapter.ts` 的 `NULL_EVENTS` 丢弃，runtime 无「请求起算」锚点。
- 缺口 ②：adapter 把 `text_start` / `toolcall_start` 等首输出子类型转 noop，interpreter 收不到「首个 token」信号（纯 tool_call 响应无 text_delta）。
- 缺口 ③：`GenStatsSample` / 存储 / `GenStatsFrame` / 展示层均无 ttft 字段。

## 3 终态与机制

### 3.1 展示（renderer）

- `GenStatsTriggers.vue` 在现有速度触发器**左侧**插入 TTFT 触发器（组件内顺序：TTFT · 速度 · 缓存），沿用同一条 `v-if="sessionId"` landing 隐藏判据、同一套 HoverCard 结构。
- 触发器文本：`ttftMs < 1000` → `820ms`；`≥ 1000` → `1.2s`（1 位小数，去尾 0）；null → `—`（灰）。等宽数字，不加图标。
- 三档语义色（延迟反向指标）：`< 1500ms` success · `1500–3000ms` warn · `> 3000ms` danger；null 恒中性灰。阈值为**初值**（有 cacheRatio 三档色先例，无历史校准源），重审触发 = 用户反馈显示档位与体感系统性不符（同速度口径 D1 重审模式）。
- 浮层（hover，与速度浮层同构）：head = 「首字延迟 TTFT」+ 模型名；2×2 四行 = 本次 / 今日 p50 / 近 7 天 p50 / 近 30 天 p50；无帧显「暂无数据」；底部口径 note。
- i18n：zh/en 双侧新增 `panel.context.genStatsTtftTitle` / `genStatsTtftNote` / `genStatsTtftDay`（「今日 p50（此模型）」）/ `genStatsTtftD7` / `genStatsTtftD30`——**不复用** `genStatsDay`（「今日均值」与 p50 中位数语义矛盾）。
- testid：`genstats-ttft-value`（触发器）、`genstats-ttft-popover`（浮层）。

### 3.2 锚点与采样（runtime）

- **起算锚点 = pi `turn_start` 到达时刻**（runtime 本地时钟）。将 `turn_start` 移出 `NULL_EVENTS`，adapter 新增 handler 产出新中间事件 `{ kind: 'llm-request-start' }` → interpreter 挂 `LlmWindowSampler.onRequestStart()`：记 `requestStartedAt = Date.now()`，同步清 `ttftMs = null`、清 `firstOutputAt`（重锚清除不变量，与现有窗口锚一致——残留生命周期严格限本请求）。
  - **窗口构成（pi 0.84.4 实装时序，agent-loop.js:101-109 核实）**：`turn_start` 在 `prepareNextTurn` **之后** emit——**原生 auto-compaction 运行在 `prepareNextTurn` 内、先于锚点，不含在窗口**；窗口内只剩：turn_start 后的 steering 注入段（通常毫秒级，计入并接受）+ extension `transformContext` 链 + HTTP 请求 + provider 排队 + 首 token。**不含**原生压缩、不含工具执行（工具后下一轮 turn_start 重新起算）。[HISTORICAL] 初稿「含 transformContext 内 compaction、压缩轮偏大」与实装时序相反，经三审 P0-11/P0-12 修正。
  - **pi 语义依赖登记**：「`turn_start` 逐 LLM 请求 emit」与「`*_start` 先于 delta」两条是本指标前提，随 U2 落地登记进 `scripts/check-pi-semantics.mjs` 探针族（pi bump 门禁复验，防升级静默漂移）。
- **首输出结算**：本请求窗口内首个输出信号到达 → `onFirstOutput()`（幂等 first-wins，已有 firstOutputAt 直接 return）→ `ttftMs = firstOutputAt - requestStartedAt`。信号来源（单点收，无 interpreter 兜底）：adapter 对 `text_start` / `thinking_start` / `toolcall_start` 三个子类型产 `{ kind: 'llm-first-output' }`（原 noop / 既有 `message.thinking_start` 帧行为保留，追加此内部事件——adapter 单事件可产多 translated event）。[HISTORICAL] 初稿另有 interpreter 侧 `text_delta`/`thinking_delta`/`tool-call-index` 三点兜底钩，存在理由「防 provider 缺 start 子类型」经简洁审 P0-22 证伪：pi-ai 0.84.4 全部流式 api 实现（openai / anthropic / google / bedrock / mistral / responses 全族）凡产 delta 必先产对应 `*_start`——兜底钩删除，高频快速路径零新增开销。
- **interpreter 分发守卫**：新 kind 若漏注册 case 是**静默失败**（handle 分发无 default warn）——U2 落地时 `llm-request-start` / `llm-first-output` 未识别须 warn（既有结构无守卫则显式加），入 U2 验收条款。
- **消费**：`turn-usage` 挂点 `consume()`（现有一次性消费语义）组装样本时追加 `ttftMs`（读取后置 null）。`message_end` 不清 ttft（窗口闭合结算归 durationMs；ttft 生命周期 = 锚点重锚 / consume 消费两处）。
- 无值路径（一律 null，禁 `?? 0`）：无配对 `llm-request-start`（runtime 中途启动）、窗口内无任何输出信号即结束（错误 / 断连）、`llm-request-start` 后异常无 consume。

### 3.3 存储与聚合（runtime）

- `gen-stats-store.ts` 新增文件 `<dataDir>/gen-stats/ttft/<safe-model>.json`（与 `speed/` `cache-ratio/` 同款日文件布局、append-only、atomicWrite）。
- 记录类型 `TtftRecord = [ttftMs: number]`（单元素组，入 `GenStatsRecord` 联合）。**校验签名必须参数化**：`isValidRecord` / `readDayRecords` 现硬编码 `RECORD_TUPLE_LENGTH = 2`（gen-stats-store.ts:80,201-208），单元素组会被 `filter(isValidRecord)` 整批当畸形丢弃 → ttft 聚合恒空静默失效。改法 = 四处签名同步参数化/泛型化：① store 侧 `isValidRecord` / `readDayRecords` 加期望元组长度参数（speed/cache 传 2，**默认 2 校验强度对既有文件不变**；ttft 传 1）；② service 侧 `gen-stats-service.ts:121` `entriesSince` 返回 `Array<[number, number]>`（含内部 `as` 断言）与 `:252` `appendRecord(entry: [number, number])` 硬类型二元组——改**泛型 T 进 T 出**（`entriesSince<T>(...): T[]` 调用点显式 `<SpeedRecord>` / `<TtftRecord>`，避免联合→窄化把既有聚合调用点撞新编译错；`appendRecord(entry: GenStatsRecord)`），**禁止 `as` 绕过**（掩盖 ttft 单元素组类型冲突）。双向单测钉住：ttft 单元素组过校验不被丢 + speed/cache 单元素畸形条目仍被丢。[HISTORICAL] 初稿「读写共用通路无需改签名」经主审 P0-11 / 影响面审 P0-12 证伪。
- 聚合 `aggregateTtft(records): number | null` = **p50 中位数**（四舍五入整数 ms）。空记录 → null。不用均值：TTFT 重尾，偶发慢请求会拉飞均值；本管道既有加权均值口径（速度 tokens/duration、命中率 read/prompt）不适用于延迟。`current` = 本会话最近一次样本原值（不聚合）。
- `GenStatsService.recordSample`：`ttftMs != null` 才写 ttft 文件（逐字段独立判定，与 speed/cache 解耦——durationMs 缺失不影响 ttft 落盘，反之亦然）；per-session current 槽新增 `entry.ttft`（modelKey 校验同 speed 槽）；`composeFrame` 组装 `ttft: { current, day, d7, d30 }`（窗口 cutoff 复用 `rollingWindowCutoff` / `WINDOW_DAYS` 现有常量）。

### 3.4 协议（shared）

- `packages/shared/src/gen-stats.ts`：新增 `GenStatsTtft { current: number | null; day: number | null; d7: number | null; d30: number | null }`；`GenStatsFrame` 追加 `ttft: GenStatsTtft`。
- `session.stats_update` payload 与 `session.getGenStats` reply 均 = `GenStatsFrame`，自动携带；`gen-stats.test.ts` 编译期断言（AssertExact keys）同步增行。
- `GenStatsSample`（runtime types.ts）追加 `ttftMs: number | null`。

### 3.5 错误与边界

| 边界 | 行为 |
|------|------|
| runtime 中途启动丢 `llm-request-start` | ttftMs = null，speed/cache 照常 |
| turn 无 usage（`totalTokens` 缺失） | 不产样本（现有 gate 不变），锚点由下轮重锚清除 |
| 输出信号先于锚点（不可能序，防御） | `onFirstOutput` 无锚直接 return，不产值 |
| ttft 文件不存在（首装 / 升级） | `readDayRecords` 同款缺省空，聚合 null → 显 `—` |
| 模型切换 | modelKey 分桶同 speed；current 槽按 modelKey 校验丢弃异模型残留 |
| 多 content block（text + tool 混合） | first-wins 只取窗口首个信号 |
| steering 注入段（turn_start 后、请求前） | 计入窗口；量级通常毫秒级，接受并在 note 声明 |
| interpreter 新 kind 漏分发 | 未识别 kind warn（U2 加守卫），不静默 |

## 4 验收

### 4.1 场景表

| # | 场景 | 真实流程 | 通过标准 |
|---|------|----------|----------|
| S1 | 真机首显 | `TAIJI_DEV_BACKGROUND=1 pnpm dev` 连本实例，真实 session 发一条 prompt 至首个 token 可见 | composer 工具带 TTFT 触发器位于速度左侧且显示非 `—` 的 `Nms`/`N.Ns`；值 > 0 且 < 30000 |
| S2 | 浮层四行 | hover TTFT 触发器 | 浮层出现：head 标题 + 模型名；四行（本次/今日/7天/30天）数值或 `—`；note 文案完整 |
| S3 | 无数据 / landing | 新 session 未发消息；主 landing 页 | 未发时显 `—`；landing（无 session）整个 gen-stats 组不渲染（与速度同判据） |
| S4 | 持久化恢复 | 发 1+ 条消息后重启 runtime，切入回该 session | 恢复腿 `session.getGenStats` 回填，TTFT 显示与重启前一致 |
| S5 | 分档语义色 | 单测覆盖阈值边界（1499/1500/3000/3001）+ 真机观察一次正常请求 | 边界用例 class 断言绿；真机正常请求呈 success 色（或与其实测值档位一致） |
| S6 | 回归：速度/缓存不受扰 | 跑 gen-stats 既有全套单测 + 真机发消息观察速度/命中率触发器 | 既有用例全绿；速度/缓存显示行为与改前一致 |
| S7 | 错误路径不产脏样本 | 单测：无锚 consume / 无输出信号即结束 / 异模型 current 残留 / **工具执行后下一轮重锚（TTFT 不含工具执行的契约钉）** | ttftMs=null 路径样本被 service 跳过，无 0 值污染；工具轮次间锚点重置、ttft 不跨轮；聚合与 current 均不受影响 |
| S8 | 存储校验双向 | 单测：ttft 单元素组经 readDayRecords 不被丢；speed/cache 单元素畸形条目仍被丢 | 两条断言均绿（gen-stats-store.test.ts） |

### 4.2 e2e 影响面评估

- **受影响登记资产**（按 `docs/testing/e2e-map.json` scope 人工预列，阶段 1 与 `select-affected-e2e.mjs --base <基线>` 机器对账、双向披露差异后落定）：
  - `E2E-ELECTRON-01`（scope 含 `packages/renderer/src/**`，L1 always，CI 固定）→ **跑**
  - `E2E-VISUAL-01`（scope 含 `packages/renderer/src/**`，L1 CI 像素轨，含 composer 视觉 spec）→ **跑**
  - `E2E-MOCK-01`（行为轨，scope 含 renderer 面时命中）→ **跑（以机器对账命中为准；命中则空载串行）**
  - `E2E-EQUIV-01`（等价性双轨，scope 含 runtime 事件管道时命中）→ **跑（同上以命中为准，只跑受影响子集）**
- **不跑**：真实 LLM 自动化 e2e —— 本仓库无 TTFT 既有真机 e2e 资产；S1/S2 真机验收走阶段 5 人工/agent 端到端（L4），不建新真实 LLM 自动化轨（成本 > 收益，且 CI 门禁不跑真实 LLM）。
- CI / PR / merge 门禁只承担 unit 轨（项目 AGENTS.md 测试节口径）。

### 4.3 场景 → 实现回溯

S1/S2/S3 落 U4；S4 落 U1+U3（恢复腿协议 + 服务回填）；S5 落 U4；S6 落 U2/U3 回归；S7 落 U2/U3 单测；S8 落 U3。

## 5 下一层拆分

| Unit | 职责 | 领地 |
|------|------|------|
| U1 契约根 | shared `GenStatsTtft` + `GenStatsFrame.ttft` + runtime `GenStatsSample.ttftMs` + `PiTranslatedEvent` 两个新 kind（`llm-request-start` / `llm-first-output`）+ 协议断言测试 | `packages/shared/src/gen-stats.ts`、`packages/shared/src/__tests__/gen-stats.test.ts`、`packages/runtime/src/services/session/types.ts` |
| U2 采样 | adapter：`turn_start` 出 NULL_EVENTS + 首输出子类型产 `llm-first-output`；`LlmWindowSampler` 双锚 + first-wins；interpreter 挂点（`llm-request-start` / `llm-first-output` 分发 + 未识别 kind warn 守卫） | `packages/runtime/src/infra/pi/event-adapter.ts`、`packages/runtime/src/services/session/event-interpreter-gen-stats.ts`、`packages/runtime/src/services/session/event-interpreter.ts` + 各自测试 |
| U3 存储聚合 | `TtftRecord` + **校验签名参数化（元组长度入参，默认 2）+ service 侧 `appendRecord`/`entriesSince` 泛型化（禁 `as` 绕过）** + ttft 文件读写 + `aggregateTtft`（p50）+ service 逐字段判定 / current 槽 / composeFrame | `packages/runtime/src/services/session/gen-stats-store.ts`、`gen-stats-service.ts` + 测试 |
| U4 展示 | TTFT 触发器（速度左侧）+ 浮层 + 三档色 + 格式化 + i18n 双侧 + 挂载顺序断言 | `packages/renderer/src/components/panel/GenStatsTriggers.vue`、`packages/renderer/src/i18n/locales/{zh-CN,en-US}/panel.ts`、`packages/renderer/src/__tests__/panel/gen-stats-*` |

依赖：U1 →（U2 ∥ U3 ∥ U4），深度 2。测试分层遵循 `docs/TEST-STRATEGY.md`；全部 vitest、经 `taijiTestConfig` 防线（fs-guard 白名单内 mkdtemp 自建自删）。

## 6 已否决方案

| 方案 | 内容 | 否决理由 |
|------|------|----------|
| B：锚 assistant `message_start` → 首输出 | 零协议改动 | `message_start` = provider 响应头到达时刻（pi-ai `stream.push({type:"start"})` 在 HTTP 响应返回后），测不到「请求发出 → 响应头」网络段，系统性偏小——而这段恰是 TTFT 体感的主要组成 |
| C：锚前端 dispatch 时刻 | 用户点发送 → 首输出 | 混入用户排队 / steering 注入段；工具循环轮次无 dispatch 锚点，口径不闭合 |
| D：TTFT 用均值聚合 | 与 speed 口径统一 | 延迟重尾，均值被偶发慢请求拉飞；p50 稳健且存储本就是样本数组、可直接算 |
| E：interpreter 侧 delta/tool-call 三点兜底钩 | 防 provider 缺 `*_start` | pi-ai 0.84.4 全部流式 api 实现凡产 delta 必先产对应 `*_start`（简洁审核实），兜底不存在服务对象，且挂在事件量最高频路径 |

## 7 审查修订记录

| 轮次 | 报告 | must_fix | 处置 |
|------|------|----------|------|
| R1 | 主审 / 影响面审 / 简洁审（2026-09-22，`.tmp/tech-design/design-review-20260922-181552*.md`） | 去重后 3 条，全部成立（源码逐条核实） | ① 压缩口径时序反向 → §3.2 重写窗口构成 + [HISTORICAL] 标注；② TtftRecord 单元素组被 isValidRecord 丢弃 → §3.3 校验参数化**（R2 扩至 service 侧 appendRecord/entriesSince 泛型化）** + S8 双向单测；③ interpreter 三点兜底钩冗余 → §3.2 删除 + 否决表 E |
| R1-suggestion | 3+3+1 条 | — | **采纳**：p50 行 label 不复用「今日均值」（§3.1 新 i18n key）、阈值初值 + 重审触发声明（§3.1）、interpreter 分发守卫（§3.5/U2）、e2e 预列补 MOCK-01/EQUIV-01 + 机器对账落定（§4.2）、pi 语义依赖登记探针（§3.2）、S7 补工具轮重锚契约钉；**登记不采纳**：ttft/durationMs 生命周期差异加一句理由（两者消费同点、差异已由 §3.2 重锚清除不变量覆盖，不另占篇幅） |
| R2/R2b 聚焦复审 | 主审 R2 报告 + 简洁审 R2/R3 + 影响面审 R2/R3（同时间戳 `-r2`/`-impact-r2`/`-impact-r3`） | 主审 0 / 简洁审 1→0 / 影响面审 2→0（终态三审均 0） | 简洁审 R2：§5 U2 悬空括注删，改分发守卫条款；影响面审 R2：§3.3 扩至 service 侧 `appendRecord`/`entriesSince` 签名面（泛型化禁 as）；硬编码计数「8 个」改族名（主审 INFO）。**终态三审均 0，过阶段 0 门** |
