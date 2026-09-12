# xyz-agent 编码规范与架构标准

> 本文档是项目开发的权威规范参考。AGENTS.md 中包含核心规则的摘要。

---

## 1. 外部系统对接规范

### 1.1 对接前先写验证脚本

在写任何业务代码之前，先用独立 Node 脚本验证外部系统的接口行为：

- 输入参数的精确字段名和格式
- 输出响应的结构（哪个字段在哪个层级）
- 事件流的时序和嵌套结构
- 错误时的响应格式（`success: false` 还是 throw）

**脚本存放位置**: 项目根或临时目录下的 `verify-<system>.cjs`（如 `verify-pi-rpc.cjs`）。验证使命完成后移除,不长期保留。

**示例**：验证 pi RPC 的 prompt 和事件流

```js
// verify-pi-rpc.cjs
// 用法: node verify-pi-rpc.cjs
// 验证: prompt 命令格式、事件嵌套结构、tool_execution 字段名
```

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

**禁止**：`emit('confirm-rename', sessionId, newName)` — 多参数在 handler 中极易混淆顺序。

**必须**：`emit('confirm-rename', { sessionId, newName })`

```vue
<!-- 禁止 -->
<EmittingComponent @confirm-rename="(id, name) => handler(id, name)" />

<!-- 必须 -->
<EmittingComponent @confirm-rename="(payload) => handler(payload.sessionId, payload.newName)" />
```

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

### 3.1 消息列表用 flex column + overflow

```css
.chat-msgs {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
```

**禁止**在消息列表内使用 `position: absolute`——这会导致新消息出现在视口顶部而非底部。（对话流主列表例外：已迁移 virtua `Virtualizer`，item 定位由 virtua 接管，见 §3.2；本节约束针对自写滚动容器。）

### 3.2 自动滚动

对话流渲染载体已是 virtua `Virtualizer` 虚拟滚动：**单一 scrollTop owner**——滚动测量/窗口化/视口锚定补偿全交 virtua，跟随态由 stickToBottom 脱离信号集 + 收敛抑制窗管理（chat-pin-bottom-fix / use-virtua-follow）。**直接操作 `el.scrollTop` 会破坏 virtua 所有权，禁止**。

[HISTORICAL] 迁移 virtua 前的 watch + scrollTop 范式（非对话流的自写滚动列表仍可参考）：

```ts
watch(
  () => [messages.length, streamingMessage?.content],
  () => nextTick(() => {
    const el = chatMsgsRef.value
    if (el) el.scrollTop = el.scrollHeight
  }),
)
```

### 3.3 Streaming message 生命周期

pi 的一次 agent 调用会产生多个 message（thinking 段、tool call 段、文字回复段）。每个 `message_start` 应完成前一个 streaming message，开始新的：

```
message_start → 完成 current streaming → 创建新 streaming
text_delta × N → appendToStreaming
message.tool_call_start → addToolCall to streaming
message.tool_call_end → updateToolCall in streaming
message_start → 完成 current streaming → 创建新 streaming
text_delta × N → appendToStreaming
agent_end → 最终 completeStreaming
```

---

## 4. Session 管理规范

### 4.1 活跃 vs 非活跃 session

- **活跃 session**: 有运行中的 pi 进程，可实时通信（prompt, get_messages）
- **非活跃 session**: 只有 `.jsonl` 文件，需要从文件解析历史，需要 restore 后才能发送消息

**所有 session 操作都必须处理两种状态**：先检查是否活跃，不活跃时走文件路径。

### 4.2 Session 文件格式

xyz-agent 的 session 文件存储在 `~/.xyz-agent/sessions/`（通过 pi 的 `--session-dir` 参数隔离）。

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

pi 的消息 content 是数组，xyz-agent 的 Message.content 是字符串。转换规则：

| pi content part | xyz-agent 字段 |
|-----------------|---------------|
| `{type: "text", text: "..."}` | `content`（拼接为字符串） |
| `{type: "thinking", thinking: "..."}` | `thinking: [{content: "..."}]` |
| `{type: "toolCall", name, arguments}` | `toolCalls: [{toolName, input}]` |
| `role: "toolResult"` | 合并到前一条 assistant 消息的对应 `toolCall.output` |

---

## 5. 文件持久化与运行时状态同步

当系统同时存在**文件持久化**和**内存 Store** 时，两者必须保持同步。文件是 source of truth，内存是运行时缓存。

### 三条规则

**1. 启动时加载** — 初始化时从文件加载到 Pinia store
**2. 写后刷新** — 修改文件后立即更新 store 状态
**3. 防竞争** — 异步操作用队列串行化，避免并发写入丢失

---

## 6. Electron 架构约定

### 6.1 进程间通信

- 主进程管理 runtime 子进程生命周期和窗口
- Preload 暴露 `window.electronAPI` 给渲染进程
- 渲染进程通过 WebSocket 与 runtime 通信（不走 IPC）
- 禁止渲染进程直接使用 `ipcRenderer`

### 6.2 目录结构

```
packages/
  shared/src/      共享 TypeScript 类型
  core/src/        跨端 domain 层（domain: chat/composer/session 等；transport（含 mock/）/coordination/foundation）
  ui/src/          跨端组件库（features: chat/composer 等 / primitives / overlays）
  renderer/src/    Vue 前端（Electron 桌面壳：组件、composables、stores、lib）
  runtime/src/     Node.js Runtime 服务（三层架构 transport/services/infra）
apps/electron/
  main/            Electron 主进程
  preload/         Preload 脚本
```

---

## 7. 样式规范

### 7.1 Border-radius 约束（v3）

> **v3 更新（ADR-0019，2026-06）**：旧 Warm & Soft 时期的「仅 1px/2px」锐利几何规则已**推翻**。v3 冷蓝暗色采用三档圆角，权威 SSOT 为 [design-tokens.md](./page-design/design-tokens.md)。

| 场景 | 使用值 | Tailwind class |
|------|--------|----------------|
| 默认（按钮、输入框、卡片等） | 8px | `rounded`（DEFAULT）或 `rounded-md` |
| 小元素（chip、badge、指示点容器） | 3px | `rounded-sm` |
| 大容器（面板、modal、float-panel） | 12px | `rounded-lg` |
| 圆形指示器、头像（不受限） | 50% | `rounded-full` |
| 无圆角（强制） | 0 | `rounded-none` |

**Tailwind 配置（实际值，`tailwind.config.ts`）：**
```ts
borderRadius: {
  sm: '3px',
  DEFAULT: '8px',
  md: '8px',
  lg: '12px',
}
```

值变更时同步 `design-tokens.md`（CSS 变量层）与 `tailwind.config.ts`（Tailwind 映射层）。CSS 变量定义见 `packages/renderer/src/style.css`。

### 7.2 Markdown 文本元素样式规范

**适用于 `.msg__body`（聊天消息体、v-html 渲染的 markdown 容器）。** 参照 `@tailwindcss/typography` 和 `ChatGPT-Next-Web` 的主流范式。完整调研：`docs/research/markdown-list-styling-research.md`。

#### 7.2.1 v-html 包装陷阱（必读）

`<MessageBubble>` 的 markdown 容器结构是：

```html
<div class="msg__body">
  <span v-html="renderedContent">   <!-- 多了一层 <span> -->
    <ul>...</ul>
  </span>
</div>
```

**因此 `.msg__body > ul` 不匹配**，必须用后代选择器 `.msg__body ul`。这是其他 Chat UI（lobe-chat、shadcn）也普遍存在的结构。

#### 7.2.2 列表样式范式

```css
/* 主流选择: outside + padding-left，不用 inside */
.msg__body ul, .msg__body ol {
  margin-top: 0;
  margin-bottom: 12px;
  padding-left: 1.5em;   /* 12px 聊天气泡下 = 18px，介于 GitHub (2em) 和 typography (1.625em) 之间 */
}
.msg__body ol { list-style-type: decimal; }  /* Tailwind preflight 重置了 list-style: none，需显式恢复 */
.msg__body ul { list-style-type: disc; }
.msg__body li { margin-top: 0.15em; margin-bottom: 0.15em; }
.msg__body li + li { margin-top: 0.25em; }
.msg__body li > p { margin-top: 0; margin-bottom: 0; }  /* 关键: li 内的 p (markdown-it 输出) 不撑开间距 */
.msg__body li ul, .msg__body li ol { margin-top: 0.25em; margin-bottom: 0.25em; }
```

> **设计裁决（`.md-render` 用户气泡）**：上面 `1.5em` 是 `.msg__body`（assistant 消息体）的默认缩进。用户气泡（`.md-render`，见 `MarkdownRenderer.vue`）使用更紧凑的 `padding-left: 1.2em`——仅留编号/符号位，让列表在视觉上接近普通正文行。这是对默认 `1.5em` 的有意裁决：用户气泡里手打的编号列表不该被当成大间距结构化块，紧凑缩进避免了「像多一个空行」的视觉割裂。两者共存，按容器语义取值，勿全局统一。

#### 7.2.3 为什么不用 `list-style-position: inside`

| 模式 | 多行换行后表现 | 主流选择 |
|------|----------------|---------|
| `outside`（默认） | 换行后文字左对齐 li 容器边缘 | typography / NextChat / GitHub |
| `inside` | 换行后文字缩进到标记下方（看起来像两层缩进） | **仅** streamdown（Vercel 流式聊天） |

聊天场景消息宽度窄，文字经常换行，**必须用 `outside`**。仅流式渲染 + li 极短时可考虑 `inside`。

#### 7.2.4 调试陷阱

CSS 改了看不出效果时，按顺序检查：

1. **选择器对了吗？** `document.querySelectorAll('.msg__body > ul').length === 0` 说明 `>` 没匹配（v-html 包装陷阱）
2. **CSS 规则被覆盖？** 遍历 `document.styleSheets` 找所有匹配规则
3. **Vite HMR 重载了？** `style.css` 改了之后需要等 HMR 推送，computed style 才会更新
4. **DOM 实际值？** `getComputedStyle(el).listStylePosition` 看真实生效值（不是源码写的值）

#### 7.2.5 不要引入 @tailwindcss/typography

- 增加 ~20KB CSS 产出
- 带来大量不需要的样式（h1-h6、figure、video 等 chat 场景不需要）
- 与现有 CSS 变量主题系统冲突

聊天 markdown 样式**手写**优于引入 prose 类。

#### 7.2.6 [HISTORICAL] Skill 展开内容必须强制使用 dark Shiki 主题

**这条规则来自 2026-06 的视觉 bug：用户反馈 skill-header 展开时代码块"line 1 占了 2 行"。**

**根因**：

`MessageBubble.vue` 渲染 skill 展开内容时调 `renderFull(payload.content, theme, { codeTheme: theme })` —— `codeTheme` 直接用 app 主题。当 app 是 light 主题时，Shiki 用 `github-light` 主题（黑字白底）。

但 skill 内容**渲染到 `--user-bubble-bg`（深色）容器**里（`MessageBubble.vue:148`）：

```html
<div class="... leading-[1.6] text-xs text-fg ..." 
     style="background:var(--user-bubble-bg); border:1px solid var(--user-bubble-border); border-left:2px solid var(--accent);">
```

Shiki 给的 token 颜色 `#24292E`（黑）在 `--user-bubble-bg`（深色）背景上**几乎不可见**。

**视觉后果**：
- `---` 等带语义颜色的 token 仍然可见（`#005CC5` 蓝色对深色背景有对比度）
- 普通文本 token (`#24292E` 黑字) 不可见
- 眼睛只能看到 `---` 等有颜色的行，line 1 `---` 到下一个有颜色的行（line 4 `---`）之间"看起来空了两行" → 视觉上"line 1 占了 2 行"

**为什么"有时候 2 行有时候 1 行"**：
- **流式阶段**（`renderLightweight`）：markdown-it 默认无 Shiki 高亮 → 文字用 `.msg__body` 的 `text-fg` 变量（深色背景下浅色）→ 文字可见 → 视觉正常
- **完整阶段**（`renderFull`）：Shiki 用 light theme → 黑字 → 不可见 → 视觉异常

切流式↔完整渲染就切视觉。

**修复**：

`MessageBubble.vue:340` skill 渲染调用必须强制 dark codeTheme（与 444 行 user 消息判断的逻辑一致）：

```ts
// skill 容器背景始终是深色（--user-bubble-bg），不论 app 主题都用 dark Shiki 主题
const codeTheme: 'light' | 'dark' | undefined = 'dark'
skillRenderedContent.value = await renderFull(payload.content, theme, { codeTheme })
```

**不要把 codeTheme 改成跟随 app theme** —— skill 容器背景是硬编码的深色，主题不一致必然导致文字不可见。

**未来重构时验证**：如果 skill 容器背景支持跟随 app theme 切换，本规则需要相应调整（dark bg → dark theme, light bg → light theme）。

---

## 8. Mock 规范

### 8.1 核心原则：只 Mock 后端接口返回数据，禁止 Mock 页面数据

前端 mock 有且只有一个合法入口：**`packages/core/src/transport/mock/` 层**（@xyz-agent/core）。该层模拟 runtime WS 协议返回的数据（`session`、`chat`、`config`、`model`、`extension`、`plugin`、`settings`）。`api/index.ts` 通过 `VITE_MOCK` 环境变量切换 real/mock 实现（true 时直接 import `@xyz-agent/core/transport/mock`，不走 transport）。

**允许的 mock 方式：**
- `transport/mock/data.ts` — 模拟 runtime 的 `session.list` / `chat.getHistory` 返回的会话和消息数据
- `transport/mock/index.ts` — 模拟 runtime WS 协议的全部 domain（`session`/`chat`/`config`/`model`/`extension`/`plugin`/`settings`）
- `transport/mock/settings-data.ts` — 模拟 `config.listProviders` 等返回的 providers/skills/agents 数据
- `transport/mock/composer-data.ts` — 模拟 runtime 推送的 models/mentions/files/slash-commands 数据
- `transport/mock/search-data.ts` — 模拟全局搜索浮层（⌘K）预制数据
- `transport/mock/workflow-data.ts` — 模拟 Workflow/subagent fixture（Flows/Agents tab）
- `transport/mock/git.ts` — 模拟 `git.status` 返回的仓库状态数据
- `transport/mock/file.ts` — 模拟 file domain（内存最小文件树 fixture）
- `transport/mock/run-send-stream.ts` — 模拟 `chat.send` 后的流式 ServerMessage 序列
- `transport/mock/run-send-stream-branches.ts` — mock 流式回复的 tool_call + widget 分支序列（read/todo/goal 按输入分发）
- `transport/mock/subscription.ts` — mock 订阅工厂（注册后微任务触发初始值）
- `transport/mock/mock-ws.ts` — 模拟 WebSocket 连接生命周期（connecting → connected）

上述文件均通过 `api/index.ts` 门面统一接入，调用方（composables/features）只依赖 `@/api` 的接口，不感知底层是 real 还是 mock。

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

```ts
// ✅ 正确：transport/mock/index.ts 中新增 domain 方法
export const search = {
  async query(q: string): Promise<SearchResult[]> {
    await sleep(TIMING.ack)
    return fixtureSearchResults.filter(r => r.title.includes(q))
  },
}

// ❌ 错误：组件中直接写死 mock 数据
const MOCK: SearchItem[] = [
  { type: 'command', title: '新建任务', sub: '创建一个新会话' },
]
```

### 8.4 例外

以下场景不视为 mock 违规：
- **UI 固定枚举常量**（如 `thinking-levels.ts` 的 6 级思考等级）— 后端不推送等级列表，前端自行定义
- **空占位函数** — 如 `function cycleThinking() { /* mock */ }` 仅作为未联调功能的骨架占位
- **`__tests__/` 中的测试 mock** — 测试文件独立于运行时，不参与页面渲染

---

## 9. 自动化检查

### 9.1 现有检查工具

| 工具 | 覆盖范围 | 触发时机 |
|------|---------|---------|
| taste-lint (ESLint) | 原生 HTML / emoji / v-model / 硬编码颜色 / 魔数间距 / 静默 catch / allSettled | `pnpm run lint` + pre-commit |
| vue_rules_checker.py | 行数上限 / CSS 选择器 / Tab 缩进 / 原生元素 / emoji / v-model | pre-commit |
| pre-commit hook | ESLint + vue_rules_checker | git commit |

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
