# xyz-agent 编码规范与架构标准

> 本文档是项目开发的权威规范参考，只留「原则 + 入口 + 指针」：机器已强制的规则不重复转述，局部细节指向代码与配置。AGENTS.md 中包含核心规则的摘要。

---

## 1. 外部系统对接规范

### 1.1 对接前先写验证脚本

在写任何业务代码之前，先用独立 Node 脚本验证外部系统的接口行为：输入参数的精确字段名和格式、输出响应的结构（哪个字段在哪个层级）、事件流的时序和嵌套、错误时的响应格式（`success: false` 还是 throw）。

**脚本存放位置**: 项目根或临时目录下的 `verify-<system>.cjs`（如 `verify-pi-rpc.cjs`）。验证使命完成后移除，不长期保留。

### 1.2 为外部协议建类型定义文件

外部系统的消息类型必须集中定义在一个文件中，不要散落在各处用 `as any` 或内联类型。

**文件位置**: `runtime/src/<system>-types.ts`

类型定义必须和验证脚本的输出保持同步。升级外部系统版本时，先跑验证脚本，再更新类型。

### 1.3 适配层隔离

与外部系统的所有通信必须通过适配层，业务代码不直接处理外部格式：

```
外部系统 → 适配层（翻译）→ 内部协议 → 业务代码
```

适配层职责：
- 字段名映射（外部字段名 → 内部字段名）
- 格式转换（外部数据结构 → 内部数据结构）
- 错误检查（检查 `success` 字段，reject 而非静默 resolve）

---

## 2. Vue 事件与组件规范

### 2.1 emit 只传单个 payload 对象

**禁止**多参数 emit（`emit('confirm-rename', sessionId, newName)`），一律传单个 payload 对象：`emit('confirm-rename', { sessionId, newName })`——多参数在 handler 中极易混淆顺序。

机器强制：ESLint 规则 `taste/no-multi-arg-emit`（实现在 `taste-lint/rules/no-multi-arg-emit.mjs`，经 `eslint.config.mjs` 引入 tasteConfig 生效，warn 级）。

### 2.2 Event Bus listener 必须防重复注册

当组件可能被多次挂载（split mode、keep-alive）时，listener 必须用模块级引用计数保护：

```ts
let listenerRefCount = 0

onMounted(() => {
  if (listenerRefCount === 0) {
    for (const [evt, handler] of Object.entries(eventMap)) {
      on(evt, handler)
    }
  }
  listenerRefCount++
})

onUnmounted(() => {
  listenerRefCount--
  if (listenerRefCount === 0) {
    for (const [evt, handler] of Object.entries(eventMap)) {
      off(evt, handler)
    }
  }
})
```

### 2.3 错误必须收口生成状态

任何错误处理路径都必须收口生成状态，否则 UI 会卡在 "思考中"。`setStreaming` / `streamingMessage` 符号已消亡（chat 域绞杀迁移 @xyz-agent/core），现行统一收口单一入口：`finalizeSession` + `clearPendingSend`（正常/异常收口）与 `markSessionError`（session 级错误——追加 error assistant 消息 + finalize，见 `packages/core/src/domain/chat/effect-types.ts`）：

```ts
// 错误处理的标准模式（收口 + 错误入聊天流，不要用顶部 banner）
function onError(sessionId: string, errorText: string) {
  chat.markSessionError(sessionId, errorText)
  // 有 streaming entity → finalizeSession('error')；否则追加 error assistant 消息
  // 两条路径都连带 clearPendingSend，UI 活跃态（isActive）随之复位
}
```

---

## 3. 聊天 UI 布局范式

### 3.1 消息列表滚动容器

消息列表用常规文档流布局（flex column + 纵向滚动），**禁止**在消息列表内对 item 使用 `position: absolute`——新消息会出现在视口顶部而非底部。（对话流主列表例外：已迁移 virtua `Virtualizer`，item 定位由 virtua 接管，见 §3.2；本节约束针对自写滚动容器。）

### 3.2 自动滚动

对话流渲染载体是 virtua `Virtualizer` 虚拟滚动：**单一 scrollTop owner**——滚动测量/窗口化/视口锚定补偿全交 virtua，跟随态由 stickToBottom 脱离信号集 + 收敛抑制窗管理（权威定义 INVAR-M4-2′ = `packages/renderer/src/composables/panel/useVirtuaFollow.ts` 文件头注释）。**直接操作 `el.scrollTop` 会破坏 virtua 所有权，禁止**；非对话流的自写滚动列表才用「数据变化后 `scrollTop = scrollHeight`」的常规范式。

### 3.3 Streaming message 生命周期

pi 的一次 agent 调用会产生多个 message（thinking 段、tool call 段、文字回复段），streaming 时序规则与 UI 载体无关：

- 每个新 `message_start` 到达时，**必须先完成当前 streaming message（complete），再开始新的**——漏掉「完成 current」步骤，前后 message 的内容会错乱合并进同一条消息。
- 单个 message 内部：`text_delta` 逐段追加内容；tool call start/end 增量更新对应工具调用块。
- `agent_end` 时对最后一个 streaming message 做最终 complete。

时序实现以 chat 域为准（`packages/core/src/domain/chat/`）。

---

## 4. Session 管理规范

### 4.1 活跃 vs 非活跃 session

- **活跃 session**: 有运行中的 pi 进程，可实时通信（prompt, get_messages）
- **非活跃 session**: 只有 `.jsonl` 文件，需要从文件解析历史，需要 restore 后才能发送消息

**所有 session 操作都必须处理两种状态**：先检查是否活跃，不活跃时走文件路径。

### 4.2 Session 文件格式

session 文件存储在 `<dataDir>/agent/sessions/`（路径从 `packages/shared/src/paths.ts` 动态推导，禁止写死；2026-09 pi 布局 v2 迁移后 `pi/` 层已退役）。权威口径以 paths.ts 与 `packages/runtime/src/infra/pi/session-file-utils.ts` 注释为准。

文件格式（`.jsonl`）：
```
{type: "session", id: "...", cwd: "...", timestamp: "..."}
{type: "model_change", ...}
{type: "message", message: {role: "user", content: [{type: "text", text: "..."}]}}
{type: "message", message: {role: "assistant", content: [{type: "thinking", ...}, {type: "toolCall", ...}]}}
{type: "message", message: {role: "toolResult", toolCallId: "...", content: [{type: "text", text: "..."}]}}
{type: "session_info", name: "用户自定义名称"}
```

**扁平文件结构**，不按 cwd 子目录组织。

### 4.3 消息格式转换

pi 的消息 content 是数组；xyz-agent 侧 `Message.content` 为 `string | Segment[]`（ADR-0043：user 消息富内容化为 Segment[]，`normalizeContent()` 归一化；类型 SSOT 在 `packages/shared/src/message.ts` 注释）。转换职责在 `packages/runtime/src/infra/pi/` 适配层（EventAdapter / session-entry-mapper），规则细节以适配层代码注释为准，本节不维护逐字段转换表。

---

## 5. 文件持久化与运行时状态同步

当系统同时存在**文件持久化**和**内存 Store** 时，两者必须保持同步。文件是 source of truth，内存是运行时缓存。

### 三条规则

**1. 启动时加载** — 初始化时从文件加载到 Pinia store
**2. 写后刷新** — 修改文件后立即更新 store 状态
**3. 防竞争** — 异步操作用队列串行化，避免并发写入丢失

---

## 6. Electron 架构约定

进程架构（进程拓扑、preload 边界、三层职责、目录结构）见 [architecture.md](./architecture.md)「进程架构」各节：渲染进程**禁直接使用 `ipcRenderer`**，经 preload 注入的 `window.electronAPI` 调主进程；前端与 runtime 通信走 WebSocket，不走 IPC。

---

## 7. 样式规范

### 7.1 Border-radius 约束

三档圆角：默认 8px / 小元素（chip、badge、指示点容器）3px / 大容器（面板、modal、float-panel）12px，圆形指示器与无圆角不受限。禁止硬编码 px，使用对应 Tailwind class（`rounded-sm` / `rounded` / `rounded-lg`）。数值权威见 [v6-tokens.css](./page-design/v6-tokens.css) 与 [v6-master-spec.md](./page-design/v6-master-spec.md)；style.css 的 CSS 变量与 v6-tokens.css 的 token 收录同步由 `.githooks/check_css_token_ssot.py` 机器守卫。

### 7.2 Markdown 文本元素样式规范

**适用于 `.msg__body`（聊天消息体、v-html 渲染的 markdown 容器）。** 参照 `@tailwindcss/typography` 和 `ChatGPT-Next-Web` 的主流范式。

#### 7.2.1 v-html 包装陷阱（必读）

v-html 渲染会在 `.msg__body` 内多包一层 `<span>`，**因此 `.msg__body > ul` 不匹配**，必须用后代选择器 `.msg__body ul`。这是其他 Chat UI（lobe-chat、shadcn）也普遍存在的结构。

#### 7.2.2 列表样式范式

用 `outside` + `padding-left: 1.5em` 的主流选择（具体规则见 `packages/renderer/src/style.css`）。设计裁决：用户气泡（`.md-render`，`MarkdownRenderer.vue`）使用更紧凑的 `padding-left: 1.2em`——仅留编号/符号位，手打的编号列表不该被当成大间距结构化块。两档缩进共存，按容器语义取值，勿全局统一。

#### 7.2.3 为什么不用 `list-style-position: inside`

`outside`（默认）换行后文字左对齐 li 容器边缘，是 typography / NextChat / GitHub 的主流选择；`inside` 换行后文字缩进到标记下方（看起来像两层缩进），仅 streamdown 使用。聊天场景消息宽度窄、文字经常换行，**必须用 `outside`**。

#### 7.2.4 调试陷阱

CSS 改了看不出效果时按序检查：选择器是否匹配（v-html 包装陷阱）→ 规则是否被覆盖（遍历 `document.styleSheets`）→ Vite HMR 是否推送 → `getComputedStyle(el)` 看真实生效值。

#### 7.2.5 不要引入 @tailwindcss/typography

增加 ~20KB CSS 产出、带来大量 chat 场景不需要的样式（h1-h6、figure、video 等）、与现有 CSS 变量主题系统冲突——聊天 markdown 样式**手写**优于引入 prose 类。

#### 7.2.6 [HISTORICAL] 容器底色与代码主题必须同暗同亮

Shiki 代码高亮主题与承载容器的底色必须同暗同亮，主题错配时 token 文字在背景上不可见（原 v3 时代 skill 展开案例的代码载体已消亡，教训留存于此）。

---

## 8. Mock 规范

### 8.1 核心原则：只 Mock 后端接口返回数据，禁止 Mock 页面数据

前端 mock 有且只有一个合法入口：**`packages/core/src/transport/mock/` 层**（@xyz-agent/core）。该层模拟 runtime WS 协议返回的数据（`session`、`chat`、`config`、`model`、`extension`、`plugin`、`settings`）。`api/index.ts` 通过 `VITE_MOCK` 环境变量切换 real/mock 实现（true 时直接 import `@xyz-agent/core/transport/mock`，不走 transport）。

**允许的 mock 方式**：`transport/mock/` 目录下的 fixture 与 domain 文件（会话/消息、providers/skills、composer 数据、搜索浮层、workflow fixture、git 状态、文件树、流式序列、订阅工厂、WS 生命周期等——清单以目录内文件为准，不在此枚举）。所有文件均通过 `api/index.ts` 门面统一接入，调用方只依赖 `@/api` 的接口，不感知底层是 real 还是 mock。

**禁止的 mock 方式：**
- **禁止在 Vue 组件（`.vue`）中内联硬编码 mock 数据** — 包括但不限于 `const MOCK = [...]`、`const RECENTS = [...]`、`const SUGGESTED = [...]` 等
- **禁止在 panel/composables/lib 中定义静态 fixture 数据供组件直接消费** — 所有 mock 数据必须流经 core 的 `transport/mock/` 层，走统一的 WS 协议模拟通路
- **禁止组件直接 `import` `@xyz-agent/core/transport/mock` 下的任何文件** — 组件应通过 `@/api` 或 `events` 获取数据

### 8.2 为什么禁止组件级 mock

| 问题 | 说明 |
|------|------|
| **真 runtime 联调时遗漏** | 组件内联 mock 数据在 `VITE_MOCK=false` 时仍存在，真联调时容易遗忘替换，导致上线后混入伪造数据 |
| **数据一致性无保证** | 组件级 mock 数据不与 runtime 协议对齐，真数据到达时字段/结构不一致会导致 UI 崩溃或静默丢失 |
| **mock/real 切换不彻底** | 整个应用的 mock 切换应通过 `VITE_MOCK` 一个开关完成。组件级 mock 绕过此机制，造成部分数据 mock、部分真实，调试困难 |
| **阻碍联调进度** | 同一数据源存在两套实现（core transport/mock 层 + 组件内联），联调时需要改多处，增加遗漏风险 |

### 8.3 正确的 mock 扩展方式

新增功能需要 mock 数据时：

1. 在 `packages/core/src/transport/mock/` 目录下定义 fixture 数据
2. 在 `transport/mock/index.ts` 中实现对应的 domain 方法（签名与 real domain 一致）
3. 组件通过 `@/api` 的 domain 接口获取数据（不感知 real/mock）

### 8.4 例外

以下场景不视为 mock 违规：
- **UI 固定枚举常量**（如 `thinking-levels.ts` 的 6 级思考等级）— 后端不推送等级列表，前端自行定义
- **空占位函数** — 如 `function cycleThinking() { /* mock */ }` 仅作为未联调功能的骨架占位
- **`__tests__/` 中的测试 mock** — 测试文件独立于运行时，不参与页面渲染

---

## 9. 自动化检查

### 9.1 检查工具清单以配置文件为准

本节不维护逐工具枚举（曾漂移）。工具与规则清单的权威源：

- ESLint（taste-lint：原生 HTML / emoji / v-model / 硬编码颜色 / 魔数间距 / 静默 catch / allSettled 等）：`eslint.config.mjs` + `taste-lint/`
- pre-commit 钩子（vue_rules_checker.py、CSS token SSOT 等）：`.githooks/`

触发时机 = `pnpm run lint` + pre-commit。

### 9.2 共享类型同步

`packages/shared/` 中的类型定义是前端与 runtime 的唯一协议源。修改协议类型时：

1. 先更新 `shared/src/protocol.ts` 中的类型定义
2. 确认前端和 runtime 的消费方都已适配
3. 运行 `pnpm --filter @xyz-agent/frontend run typecheck` 和 `pnpm --filter @xyz-agent/runtime run typecheck` 验证

---

## 10. 重构范式

### 10.1 深模块化三段式

深模块化是项目重构的统一范式（源：`07-cross-cutting-optimizations.md` 优化 4，已由 B4 Composer 验证）。三段式：

1. **逻辑归位**：按职责内聚到深模块（domain/store/state-machine），**非**「为绕 lint 行数限制拆 *Impl」——模块级 `*Impl` 函数拆分是反模式，必须用深模块化替代
2. **壳装配**：容器组件 / composable 退化为薄装配层，经 deps 注入或 facade 组装深模块
3. **facade 消费**：消费方只 import 1 个 facade（如 Composer.vue 只 import `useComposerShell`），不直接碰深模块内部

### 10.2 信号识别表（何时该深模块化）

| 信号 | 含义 | 案例 |
|---|---|---|
| `*Impl` 后缀函数为绕 max-lines | 模块级函数拆分反模式 | B6 store.ts 6 个 *Impl |
| 容器组件 > 400 行 + import 多个 composable | 上帝组件 | B5 前 Sidebar.vue 508 行 |
| 同类逻辑散落多处 | 缺内聚 | ⌘[⌘]⌘, 散落 AppShell + useGlobalShortcuts |
| 深模块有独立测试价值 | 可抽 | streaming-state-machine（B6） |

### 10.3 落地要求

1. 范式写入 `docs/standards.md` 的「重构」章节（本文档即固化产物）
2. 后续重构（B6 / ViewHost / Settings 拆分）统一遵循三段式
3. review 检查新代码：是否有上述信号 → 建议深模块化，而非继续拆 *Impl 或堆叠 import
