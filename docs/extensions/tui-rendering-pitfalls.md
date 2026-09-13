# Pi TUI 扩展开发避坑指南

> 基于 `@zhushanwen/pi-subagents` 扩展开发过程中 14 个 TUI 修复 commit 的实战总结，对照无 bug 的参考实现 `pi-subagents`（`~/GitApp/pi-ecosystem/pi-subagents`）及 Pi 渲染引擎源码（`pi-mono`）交叉验证。
>
> 本文档是 [Pi Extension 开发指南 §22 TUI 渲染系统](./development-guide.md#22-tui-渲染系统) 的深度展开，专注「场景 → 怎么做」的可操作经验。
>
> **校准基线**：机制断言（含 `tool-execution.ts` / `tui.ts` 行号引用）锚定 2026-06-17 时点的 pi 版本。pi 是外部依赖且持续演进（当前实装版本以根 `package.json` 为准，核对方式见 [extension-conventions.md](./extension-conventions.md)「SDK 接口契约」）——机制性经验（self shell 残影 / visibleWidth / streaming delta 三红线）跨版本有效，**行号级断言引用前须对实装 dist 核实**。
>
> 最后更新：2026-06-17（校准基线标注：2026-09-13）

---

## 目录

- [核心心法：三条红线](#核心心法三条红线)
- [第一部分：渲染管线与 Shell 策略](#第一部分渲染管线与-shell-策略)
- [第二部分：ANSI 样式、宽度计算与截断](#第二部分ansi-样式宽度计算与截断)
- [第三部分：键盘交互与自定义 Overlay](#第三部分键盘交互与自定义-overlay)
- [第四部分：流式更新、性能与状态生命周期](#第四部分流式更新性能与状态生命周期)
- [踩坑 commit 索引（全量）](#踩坑-commit-索引全量)
- [速查决策表](#速查决策表)

---

## 核心心法：三条红线

在进入具体场景前，先记住贯穿全文的三条原则。几乎所有 TUI 坑都源自违反其中之一：

1. **渲染组件只构建「裸 Container + `new Text(line, 0, 0)`」子组件树，背景色 / padding / title 全部交给 Pi default shell 的 `contentBox`。** 绝不使用 `renderShell: "self"`，除非你完全理解 diff-redraw 引擎的高度对齐契约。（[详见第一部分](#1-self-shell-的残影陷阱)）

2. **所有「长度 / 位置 / 切分」一律基于 `visibleWidth()` + `Intl.Segmenter`，不用 `.length` / `indexOf` / `slice`；不要把 pi-tui 的 `truncateToWidth` 用在自己管理背景色或需要列对齐的场景——它会塞游离 `\x1b[0m`。**（[详见第二部分](#第二部分ansi-样式宽度计算与截断)）

3. **streaming delta（`text_delta` / `thinking_delta`）只累积状态、绝不触发 `onUpdate`；只有离散边界事件（`tool_start` / `tool_end` / `message_end`）才触发 UI 重绘。** 否则 Pi 的 doRender 会把 viewport 锚到底部，用户无法滚动。（[详见第四部分](#1-streaming-delta-绝不应触发-onupdate)）

---

## 第一部分：渲染管线与 Shell 策略

### 1. self shell 的残影陷阱

**场景**：tool 的 `renderResult` 返回一个带背景色的 block（如 subagent 运行状态块）。

**坑（`a03ad68db` 引入，表现为 sync subagent 状态行重复）**：早期为了让整个 block 共享一个背景色，设了 `renderShell: "self"` + 用 `Box(bgFn)` 自己施加背景。结果 subagent 运行时**旧快照残留在新快照上方**——比如状态行从「4s/26.1k」更新到「10s/52.8k」，旧的 4s 行没被擦除。

**根因（Pi 引擎源码）**：`tool-execution.ts:221-251` 的 render 方法在 self shell 路径里，把 `selfRenderContainer.render(width)` 的结果前面**硬塞一个空字符串**（`lines.push("")`），然后直接返回裸 `string[]`：

```typescript
// tool-execution.ts:232-247 (self shell 路径)
const lines: string[] = [];
if (contentLines.length > 0) {
  lines.push("");                    // ← 硬塞空行
  lines.push(...contentLines);       // ← 裸 string[]，不经组件树
}
return lines;
```

Pi 的 diff-redraw 引擎（`tui.ts` 的 doRender，逐行 diff 在约 line 1230-1248）按 index 逐行 byte 对比 `previousLines` vs `newLines`（`oldLine !== newLine` 判脏），不检测中间插入偏移；行数增加时尾部按 append 处理，位置相同且内容未变的行不重写。self shell 路径返回的裸 `string[]` 未经 `contentBox` 的 `applyBg`（pad 到满 width + 背景填充），既没有稳定的「满行背景」让 diff 把整 block 判为脏，又被 line 234 那个硬编码空行打乱了 index 对齐——两者叠加才产生残影。

而 default shell 走 `super.render(width)` → Pi 标准 `contentBox`（`tool-execution.ts:68` 的 `Box(1, 1, bgFn)`）组件树：每行经 `applyBg` pad 到满 width，diff 引擎对背景色变化高度敏感（整 block 判脏重写），且组件树有成熟的 invalidate 机制。**因此残影的真正根因是 self shell 绕过了 contentBox 的背景填充契约，而非 Pi 引擎本身有缺陷**——引擎按其契约（输入是组件树渲染的、带背景的稳定行）工作正常。

**对比验证**：`pi-subagents`（`extension/index.ts:395-464`）**完全不设 `renderShell`** → 走 default shell → 背景色交给 `contentBox`，`renderResult` 只返回 `renderSingleCompact` 的裸 `Container`（`render.ts:1012-1046`，`new Container()` + `new Text(…,0,0)`）。**它从不残影。**

**正确做法**：

```typescript
// ✅ 不设 renderShell（默认 default）
{
  name: "subagent",
  renderCall(args, theme) {
    return new Text(`${theme.bold("subagent ")}${theme.fg("accent", agent)}`, 0, 0);
  },
  renderResult(result, options, theme, context) {
    return renderMyResult(result.details, theme);  // 返回裸 Container
  },
}
```

> ⚠️ **不要用 `renderShell: "self"`**，除非你完全理解 diff-redraw 引擎的高度对齐契约。Pi 的 default shell 已按 `isPartial`/`isError` 自动切换三态背景色（`toolPendingBg`/`toolSuccessBg`/`toolErrorBg`），扩展只需返回裸组件树。

---

### 2. Box / Container / Text 的正确用法

**核心原则：背景色只施加一次，且施加者唯一。**

| 组件 | 用途 | 何时用 |
|------|------|--------|
| **`Box(paddingX, paddingY, bgFn)`** | 给所有子行施加**统一背景色 + 内边距** | **仅当**你绕过了 default shell（self shell）需自己管背景时。default shell 下**不要**再包 Box——会双重背景 |
| **裸 `Container()`** | 垂直拼接子组件，**不施加背景色/padding** | **default shell 下返回的根组件**。背景色已由引擎的 `contentBox` 施加 |
| **`Text(line, 0, 0)`** | 单行内容，paddingX=0/paddingY=0 无额外填充 | 裸 Container 的叶子节点。**必须显式传 `(line, 0, 0)`**，否则默认 padding=1 会多出填充行 |
| **`Spacer(n)`** | 产生 n 行**空背景行**（`render → [""]`）| 需要稳定空行占位时。**不要用 `new Text("")` 代替**——空 Text 渲染返回空数组，导致高度不稳定 |

**坑（`6257814d7`）**：用 `new Text("")` 做空行填充，Text 空串 `render() → []`，Container 少一行 → 压缩视图行数随机变化。**改用 `new Spacer(1)`**（`render() → [""]`）。

**坑（`52bf85e11`）**：self shell 时代 `Box(1, 0, bgFn)` paddingY=0，文字紧贴 block 边界。改 paddingY=1 后视觉改善。**但最终方案走 default shell，`contentBox` 自带 `Box(1,1,...)`，扩展侧不再设 paddingY。**

---

### 3. renderCall 与 renderResult 的职责划分

**问题**：标题行该谁渲染？背景块如何统一？

**坑（`6257814d7` 之前）**：依赖 Pi default shell 默认的 `subagent` 标题行，但它和 result block 分属不同渲染调用，背景色不连续。一度用「`renderCall` 返回空 Container 隐藏标题 + 把 "subagent" 塞进 result 第一行」绕过，但 self shell 有残影。

**正确职责划分**：

```
renderCall  → new Text(`subagent {agent}`, 0, 0)   // 标题行，Pi 放进 contentBox
renderResult → new Container() + Text/Spacer        // 内容行，同样放进 contentBox
                                                       （同一 contentBox → 同一背景色）
```

- **renderCall**：返回**标题 Text**，格式参考 `pi-subagents`（`index.ts:427-455`，按 action/chain/parallel/single 多分支，单 agent 分支形如 `theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agent)`）。
- **renderResult**：返回**裸 Container + 内容行**，**不包 Box，不施加背景色**（引擎的 contentBox 已做）。
- **背景色施加者唯一**：Pi default shell 的 `contentBox = new Box(1,1,bgFn)`，按 `isPartial`/`isError` 自动切三态。

---

### 4. 组件高度管理：动态优先，删固定 pad

**坑（`98d983fc2`）**：`buildCompactLines` 强制 pad 到固定 6 行，即使无事件也输出 `[状态, "", "", "", "", footer]`，加上 paddingY=1 一开始就 8 行，底部大片空白。

**根因**：误以为「固定高度能避免重排」。但 default shell 的 Container 高度增长是引擎**原生支持**的成熟路径（`pi-subagents` 也是动态增长），固定高度反而制造视觉噪音。

**正确做法**：动态高度——`输出 = 状态行 + 最近 ≤4 条 eventLog，不预填空行`。增长：无事件 1 行，每事件 +1，上限 5 行。删 `COMPACT_LINES_TOTAL` 常量和 pad 循环。

**Ctrl+O footer：仅当本扩展未绑定 Ctrl+O overlay 时才删**（`98d983fc2`）：`Press Ctrl+O for live detail` footer 强制占最后一行，若本扩展**没有**对应的 Ctrl+O 展开 overlay，这个提示会误导用户（按键无反应），应当删掉。本项目删除即是此因——`extensions/subagents/src/` 全文无 `Ctrl+O` 绑定。

> ⚠️ **这不是普适规范**：参考实现 `pi-subagents` **恰恰保留了**这个 footer（`render.ts:1032` 等 7 处，含被本指南 §1.3 奉为范本的 `renderSingleCompact`），因为他们通过 `async-job-tracker.ts` 的 widget 轮询**真的绑定了 Ctrl+O 展开**。判别原则：footer 的存在以「按键有实际 overlay 响应」为前提。若你的扩展将来加了 Ctrl+O overlay（如 live detail 全屏视图），应**恢复**此 footer。
>
> 简言之：footer 跟着 overlay 走，有 overlay 才提示，无 overlay 别误导。

---

### 5. eventLog 行的图标语义

**坑（`414404f0d`）**：所有 eventLog 行统一用 `⎿ ` 前缀（pi-subagents 详情行惯例），但压缩视图里 thinking / tool / output 长一个样，杂乱难辨。

**正确做法**：按类型加图标（朴素符号，避免 emoji 感）：

| 图标 | 类型 | 说明 |
|------|------|------|
| `›` | tool_start / tool_end | 工具调用。tool_end 尾部追加 `✓`（success）/`✗`（error） |
| `>` | text_output | agent 输出文本片段 |
| `·` | thinking | 推理片段。图标 + 文本**整行 dim** |
| `──` | turn_end | turn 分隔线（仅 expanded view） |

图标后接 1 个空格再接内容。前缀宽度从 3（`⎿  `）改为 2（图标 + 空格）。

**压缩视图的连续分片折叠**：`execution-state.ts` 把一段连续 text/thinking 输出按 100 字符切成多个 eventLog 分片（streaming delta 累积达 `TEXT_OUTPUT_CHUNK`/`THINKING_CHUNK` 即 push 一条）。若压缩视图逐条展示，一段长输出会变成 N 个半句碎片（同一句话的前 50 字符重复 N 次），可读性极差。

正确做法（`foldEventLog`，对话流压缩视图 + list 分屏右列共用）：**相邻且同类型**的 `text_output`（或 `thinking`）分片折叠为 1 条代表行，label 取组首条按首个换行切出的首段（流的第一行几乎总落在组首 100 字符分片内）。被 tool 隔开的同类各自成组（`text, tool, text` → 3 条）。折叠纯在渲染层，**不改** `state.eventLog` 与 history 持久化（仍是细粒度）。list 全屏详情（`renderDetailView`）不折叠——那里用户想看完整内容、自动换行展开。

**running 态去重（方案 A）**：P1#3 的活动行（实时首行）已独占「正在输出」锚点。running 时若滚动区末条与 `currentActivity` 同类型（text/text_output 或 thinking/thinking），它展示的是同一段正在 streaming 的流——滚动区不再重复铺该代表行，避免两行近乎相同。done/failed/cancelled 无 `currentActivity`，不做去重。

---

## 第二部分：ANSI 样式、宽度计算与截断

### 1. visibleWidth vs string.length

**场景**：把一行 pad 到固定列宽、或用 `indexOf` 在渲染结果里定位某段字面文本。

**坑（`391b53070`）**：用 `stripAnsi(line).length` 算宽度，ANSI 转义码（`\x1b[31m`）是字符串里的真实字符但终端占 0 列，`.length` 把它们算进去 → padding 少 pad → 背景色填不满整行。

**根因**：`text.length`、`indexOf("✓")`、`slice(0, n)` 都按 UTF-16 code unit 算，会把 ANSI 码算进去。`theme.fg("error", "✗")` 可能是 `"\x1b[31m✗\x1b[0m"`，`.length` 翻几倍。

**正确做法**：所有宽度/列计算一律走 `visibleWidth()`（来自 `@earendil-works/pi-tui`，底层 `utils.ts:213` 会剥离 CSI/OSC/APC 全部转义、tab→3 空格、按 grapheme 求和）。padding 用 `padVisible()`：`return s + " ".repeat(width - visibleWidth(s))`。**不要用 `.length` 做 padding。**

---

### 2. truncateToWidth 的 ANSI 副作用

**场景**：给带背景色的 Box 行做超长截断。

**坑 A（`52bf85e11`）**：pi-tui 的 `truncateToWidth`（`utils.ts:884`）在 `finalizeTruncatedResult`（`utils.ts:138-157`）里固定输出 `${prefix}${reset}${ellipsis}${reset}`——省略号前后各插一个全局 `\x1b[0m`。后果：省略号之后半段失去 Box 背景色（被 reset 抹掉）。

**坑 B（`414404f0d`，flaky 根因）**：`/subagents list` 分屏右列用 `padVisible(truncVisible(raw), mainWidth-1)` 后，又依赖「字面位置 == 可见位置」去对齐列。但 `truncateToWidth` 末尾的游离 `\x1b[0m` 把字面长度撑大，`indexOf` 找到的列偏移和 `visibleWidth` 对不上，`formatRecordRow` 列对齐**跨文件运行 flaky**。

**根因**：`truncateToWidth` 的契约是「只截断、不保证后续 indexOf/对齐语义」。它为「防止样式泄漏到 padding」而塞 `\x1b[0m`，这对纯文本输出是对的，但对**自己管理背景色 + 自己做 padding**的调用方是灾难。

**正确做法（决策树）**：

| 输入特征 | 用什么 | 为什么 |
|---|---|---|
| 含 fg/bg 样式、嵌在 Box 背景里 | `truncLine`（自写） | 追踪 activeStyles，省略号前重应用 SGR，背景色不断裂 |
| 纯文本 / 仅图标 dim、需要后续 `padVisible` 列对齐 | `truncVisible`（grapheme 切） | 无游离 ANSI，indexOf 不错位 |
| 一次性输出、不自己 pad、不需要后续定位 | 可直接用 pi-tui `truncateToWidth` | 它会自行 reset 防泄漏 |

**自写 truncLine 核心逻辑**（移植自 `pi-subagents render.ts:44-89`）：

```typescript
function truncLine(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;
  const targetWidth = Math.max(0, maxWidth - 1);
  let result = "", currentWidth = 0;
  let activeStyles: string[] = [];   // 追踪当前生效的 SGR
  // ...遍历时：遇 \x1b[0m 清空 activeStyles，遇其他 \x1b[..m push
  // 截断时：return result + activeStyles.join("") + "…";  ← 省略号前重应用
}
```

**纯文本 truncVisible**（`subagents-view.ts`，不调用 `truncateToWidth`）：

```typescript
function truncVisible(s: string, maxWidth: number): string {
  if (visibleWidth(s) <= maxWidth) return s;
  const target = maxWidth - 1;
  let out = "", w = 0;
  for (const { segment } of segmenter.segment(s)) {   // Intl.Segmenter grapheme
    const sw = visibleWidth(segment);
    if (w + sw > target) break;
    out += segment; w += sw;
  }
  return out + "…";   // 无游离 ANSI
}
```

---

### 3. sanitize 的必要性

**场景**：`entry.label` 来自 LLM 的 `text_delta`/`thinking_delta`，天然带 `\r`、`\n`、`\t`。

**坑（`a03ad68db`）**：Pi TUI 把字符串数组里每个元素当一行。一个「逻辑单行」里夹了 `\n`，Pi 渲染时按 `\n` 拆，一条 eventLog **展开成 N 行** → 固定行数布局被撑爆 → 严重时 TUI 崩。

**正确做法**：在**进入渲染管线前**就压平，两层入口（重复防御）：

- `sanitizeLogLabel`（`format.ts`）：`label.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ")` —— 作用于每条 eventLog label。
- `sanitizeLine`（`subagent-render.ts`）：同样的正则 —— 作用于 `buildRenderLines` 里**每一行**输出。
- result/error 还要先 `.split("\n")` 再逐行 sanitize。

> 两层都做是因为 `formatEventLogLine` 可能被 list 视图直接调用（不经 `buildRenderLines`），`sanitizeLogLabel` 在最早入口兜底。

---

### 4. Intl.Segmenter grapheme 切分

**场景**：按可见宽度截断或换行时，对含 emoji（👨‍👩‍👧 = 5 个 code point + ZWJ）、CJK、组合字符的文本做切分。

**坑**：用 `for (let i=0; i<text.length; i++)` 或 `.slice(0, n)` 按 UTF-16 code unit 切——会把 emoji ZWJ 序列、代理对、grapheme cluster 劈成两半，产生乱码（半截 emoji）。

**正确做法**：统一用 `Intl.Segmenter(undefined, { granularity: "grapheme" })` 按 grapheme cluster 迭代。**共享实例**（模块顶层 `const segmenter = new Intl.Segmenter(...)` 复用，不要在热路径里每次 new）。pi-tui 底层 `utils.ts:4` 也是模块级共享。

---

## 第三部分：键盘交互与自定义 Overlay

### 1. matchesKey 的正确用法

**坑（`daedc74e3`）**：`category-confirm.ts` 写 `if (keyData === "\x1b[A") return "up"`，用户报告「不能上下选择」。

**根因**：方向键在终端里有 **4 套互不兼容的编码**，硬编码只命中其一：

| 编码族 | ↑ 的字节序列 | 何种终端 |
|---|---|---|
| Legacy CUU | `\x1b[A` | xterm 默认 |
| Application mode | `\x1bOA` | **Pi TUI 常启用** |
| Kitty CSI u | `\x1b[1;1A` / `\x1b[<cp>;<mod>u` | Kitty/Ghostty/WezTerm |

> 注：方向键的 `case "up"`（`keys.ts:1044-1057`）收口上述三族 + legacy 修饰序列（shift/ctrl），但**不调用 `matchesModifyOtherKeys`**（`modifyOtherKeys` 格式如 `\x1b[27;1;65~` 仅在 escape/enter/space 等键的分支处理）。对绝大多数终端三族已够用；若你的终端只发 modifyOtherKeys 格式的方向键，需额外补 fallback。

**另一个关键点**：`matchesKey` 对**无修饰的可打印字母**返回 **true**（`keys.ts:1200` `data === key`），并非 false。这意味着如果你用 `matchesKey(data, "k")` 做导航，字母 k 会命中——这正是 j/k 导航与 filter 冲突的根因（见 §3）。避免冲突的正确方式是导航**只用功能键**（`Key.up` 等非字母 keyId），让字母落到 printable 分支。

**正确做法**：

```typescript
// ✅ 导航、Esc、Enter、Backspace、Home/End/PgUp/PgDn 一律 matchesKey
matchesKey(data, Key.up);
matchesKey(data, Key.down);
matchesKey(data, "home");       // 或 Key.home（若 mock 已补）
matchesKey(data, "end");
matchesKey(data, "pageUp");
matchesKey(data, "pageDown");

// ❌ 永远不要硬编码
data === "\x1b[A"   // 只命中 4 族之一
```

`Key` 是类型安全的 helper 对象（`keys.ts:163`），优先用 `Key.up` 而非裸字符串 `"up"`，拼错编译期报错。**例外**：vitest mock 的 `Key` 可能缺 `home/end/pageUp/pageDown`（见 §5），此时用裸字符串 `"home"` 作为 `KeyId` 也能工作。

---

### 2. ctx.ui.custom overlay 契约

**契约四件套**：

| 方法 | 何时调 | 你要做什么 |
|---|---|---|
| `invalidate()` | 外部认为视图可能脏了 | 清渲染缓存（`cache.width=cache.lines=undefined`）|
| `render(width): string[]` | 每次 paint | 返回行数组；**必须缓存**（同 width 直接返回 cache.lines），否则 eventLog 一长就卡 |
| `handleInput(data)` | 用户按键 | 调 processKey → 改 state → 若 changed 则清缓存 + `tui.requestRender()` |
| `done()` | 退出信号 | 由 factory 第 4 参数提供；**你自己包一层 `wrappedDone`**（见 §4）|

**防 overlay 叠加（G-017）**：runtime 持有单例 `_activeView` 句柄。进 overlay 前 `const active = runtime.getActiveView(); if (active) active.close();`；factory 内立即 `runtime.setActiveView({ close: wrappedDone })`。否则用户连按两次快捷键触发两个 overlay，画面错乱。

**overlayOptions 经验**：`margin: 1`（上下各留 1 行）比 `margin: 0` 更稳——避免紧贴终端边缘导致边框被吞。全屏分屏用 `width: "100%"` + `maxHeight: "100%"`；居中弹窗按内容量选（如 `width: 84, maxHeight: "80%"`）。

---

### 3. Filter 输入与导航键的冲突

**坑（`b41db2933`）**：`detectKeyAction` 既硬编码 `keyData==="k"→up`，又查 `kb.matches(keyData,"tui.select.up")`。Pi 默认 keybinding 把 j/k 绑给 `select.up/down`，两条路都在 printable 分支前拦截，导致 filter 输入框打不出字母 j/k。

**根因**：自定义组件**同时**承担「列表导航」和「文本 filter 输入」两种交互，导航键和 filter 字母共用同一批键。

**正确做法**（已固化为 CLAUDE.md 规范）：

- ✅ 导航**只用方向键**，经 `matchesKey(data, Key.up)` 识别。因为 `Key.up` 是功能键 keyId（`"up"`），字母 "k"/"j" 不会匹配 `"up"`，自然落到 printable 分支进 filter。（注意：若误用 `matchesKey(data, "k")` 做导航，字母 k 会命中——因为 matchesKey 对字母 keyId 返回 true。）
- ✅ **刻意不查** `kb.matches(data,"tui.select.up/down")`——那会连带命中用户把 j/k 绑给 select 的自定义键位。
- ✅ confirm/cancel 仍走 `kb.matches("tui.select.confirm"/"cancel")`——这两个动作不会和 filter 抢字母键。
- ✅ 可打印字符直接 `state.filterText += data`，**无需进入「filter 模式」**。Backspace 删字符。
- ✅ filter 中按 Esc：先清 filter，再退上层（避免用户打错字想重输时一按 Esc 就整个退出）。

---

### 4. Overlay 退出的时序陷阱

**坑（`7c8e40000`，只改了 1 行）**：`/subagents list` 按 q/Esc 退出时崩溃或残留。原代码先 `state.disposed = true` 再调 `done()`。

**根因**：`done()` 是 pi 框架的 overlay 销毁回调，它内部会触发最后一次 `render()`。如果在调 `done()` **之前**就把 `state.disposed = true`，后续 `render` 里读 state 的代码路径（unsubscribe、clearActiveView）被 `if (state.disposed) return` 提前短路 → 内存泄漏 + `_activeView` 没清。

**正确顺序**（`wrappedDone`）：

```typescript
const wrappedDone = () => {
  if (state.disposed) return;   // 幂等：防 done 被调多次
  state.disposed = true;        // ① 标记
  unsubscribe();                // ② 解订 runtime 事件
  runtime.clearActiveView();    // ③ 清 G-017 句柄
  done();                       // ④ 最后才调框架 done（触发 overlay 销毁）
};
```

processKey 里直接调 `wrappedDone()`，**不在 processKey 里手动 set disposed**。配套防御：`handleInput` 开头查 disposed；`runtime.onChange` 回调里也查（防 overlay 关闭瞬间还有 in-flight 事件触发渲染）。

---

### 5. Vitest mock 的按键测试

**坑（`414404f0d`）**：生产代码改用 `matchesKey(data,"home")`，但 `mocks/pi-tui.ts` 的 `DATA_TO_KEY` 表里没有 home/end/pageUp/pageDown 的映射。测试 `matchesKey("\x1b[H","home")` 返回 false → 翻屏测试全红，但生产行为其实正确。

**根因**：mock 是简化实现（`DATA_TO_KEY` 静态表 + 单字符直匹配），不复刻 `keys.ts` 的 Kitty/modifyOtherKeys 正则解析。mock 漏一个键，测试就误报。

**正确做法**：每次在生产代码引入**新的 keyId**，**同步**往 mock 两处加：(1) `Key` 对象加常量；(2) `DATA_TO_KEY` 加该键的所有 legacy 序列映射。回归测试要**显式覆盖多种编码族**混合（如同会话既按 `\x1b[B` 又按 `\x1bOB`）。

---

## 第四部分：流式更新、性能与状态生命周期

### 1. streaming delta 绝不应触发 onUpdate

**场景**：sync subagent 流式输出时，每个 token 触发 `text_delta`/`thinking_delta`，经 event-bridge 到 `onEvent`。

**坑（`8160a5d13`，viewport snap-back）**：若 `onEvent` 无脑调 `onUpdate`，就是 ~60/s 的 `requestRender`。Pi 的 `doRender()` 末尾（`tui.ts:1445`）无条件执行 `previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1)`——**没有 isAtBottom 守卫**，任何对末尾 block 的 onUpdate 都会把用户已向上滚动的位置拽回底部，用户无法滚动。

**对比验证**：`pi-subagents` 的 `execution.ts` 的 `processLine` 只在离散边界调 `fireUpdate()`——`tool_execution_start`/`tool_execution_end`/`tool_result_end`/`message_end`，`message_update`（delta）从不调。**它没有 snap-back 不是因为用了更聪明的渲染路径，而纯粹是触发频率低。**

**正确做法**：在 `onEvent` 里加 `shouldTriggerUpdate(event)` 守卫：

```typescript
export function shouldTriggerUpdate(event: AgentEvent): boolean {
  switch (event.type) {
    case "tool_start": case "tool_end":
    case "turn_end":   case "message_end":
    case "error":      return true;    // 离散边界 → 触发重绘
    case "text_delta": case "thinking_delta":
    case "compaction": return false;   // streaming delta → 只累积状态
  }
}
```

delta 类事件只走 `updateStateFromEvent` 累积 eventLog 文本缓冲，不触发 onUpdate。sync 和 background 的 onEvent 回调、`notifyChange()` 都必须过这个守卫（`ba1c80327` P1b 专门补了 background 路径漏过滤）。

---

### 2. onUpdate 节流策略：leading + trailing + flush

**场景**：即便只在边界触发，密集 tool 调用（grep 一堆文件）也会在几十 ms 内连发多次 `tool_start`/`tool_end`。

**正确做法**：leading + trailing 节流，窗口默认 150ms（≈6/s 上限）：

- **leading**：窗口内首次调用立即执行，保证响应性。
- **trailing**：窗口内若有后续调用，窗口结束时补执行最后一次，保证最终态不丢。
- **flush()**：`done`/`failed`/`cancelled` 终态路径**必须**调 `flush()`，否则最终 block 状态可能被 trailing timer 拖到 150ms 后才渲染。

```typescript
// 终态路径
throttledPushUpdate.flush();
pushUpdateNow();   // flush 后再立即推一次，双保险
```

不要用纯 debounce（会丢 leading 响应）。想更顺可把 interval 调大（如 300ms），代价是边界事件视觉延迟更明显。

---

### 3. 状态快照 vs 可变引用

**坑（`ba1c80327` P2）**：`executionStateToDetails(state)` 投影出 details 传给 `onUpdate`，如果直接传 state 的 eventLog 引用，SDK 的 `tool_execution_update` 是异步消费（`process.nextTick`），消费时 state 可能已被下一个 event 继续 mutate；更糟的是 archive 时 `_completedAgents` 记录会和 `state.eventLog` 共享同一数组，后续 mutate 泄漏进归档。

**正确做法**：两层防御：

1. **投影层浅拷贝**：`details: { ...details }`，`executionStateToDetails` 内部 `eventLog: [...state.eventLog]`。
2. **归档层浅拷贝**：`scheduleSyncArchive` 传 `source.eventLog.slice()`。

**何时需要深拷贝**：eventLog 元素是不可变 record（只 push 新 entry，不 mutate 已有 entry），`.slice()` 一层浅拷贝足够。如果将来 entry 内部会被 mutate，才需要 `structuredClone`。**不要无脑深拷贝**——streaming 期间每个 onUpdate 都深拷贝整个 eventLog（ring buffer 可能几百条）是 CPU 浪费。

**对比 `pi-subagents`**：他们用独立子进程 + stdout JSONL 通信，`emitUpdateSnapshot`（`execution.ts:412-426`）里 `snapshotProgress`/`snapshotResult` 对数组字段做**一层浅拷贝 + 对象展开**（`recentTools.map(t => ({...t}))`、`[...recentOutput]`），切断与运行态 progress 对象的引用。因为子进程是独立的、渲染是异步的，传引用竞态风险更高。我们用 in-process SDK，同样浅拷贝足够。

---

### 4. 组件复用 lastComponent

**场景**：SDK 每次 `tool_execution_update` 都调 `renderResult()` 重建组件。streaming 期间每秒数次 new 组件 → GC 压力 + theme 引用闪烁（`ba1c80327` P1a）。

**正确做法**：SDK 通过 `context.lastComponent` 传回上一次返回的组件实例（参考内置工具 `ls.js:160`、`edit.js:65`）。类型匹配则调 `update()` 复用：

```typescript
if (context.lastComponent instanceof SubagentResultComponent) {
  const comp = context.lastComponent;
  comp.update(details, theme);     // 刷新 details + theme 引用
  comp.setExpanded(options.expanded);
  return comp;
}
return new SubagentResultComponent(details, theme);
```

**关键陷阱**：`update()` 必须同时接收 `theme`（可选），否则用户 `/theme` 切换后复用的实例还持有旧 theme 引用，显示错色。

---

### 5. 终态处理：throw vs return 的 SDK 陷阱

**坑（`daedc74e3`）**：subagent 被取消/失败时自然倾向 `throw new Error(...)`。但 SDK 的 `executePreparedToolCall` 会 catch 这个 throw，然后用 `createErrorToolResult` 重建一个 `details: {}` 空结果 → `tool_execution_end` 带空 details → `renderResult` 走 fallback 渲染成 `"✓ default"`，**整个 streaming 期间积累的 eventLog 全部丢失**。

**正确做法**：终态**返回正常 `AgentToolResult`** 而非 throw：

```typescript
return {
  content: [{ type: "text", text: failureMessage }],  // 失败原因，LLM 可见
  details: failureDetails,  // 携带 cancelled/failed 终态 + 完整 eventLog
};
```

**判别原则**：工具想给 LLM 传递「这是个失败」的语义，用 `content` 文本即可；**不要用 throw 来传递语义**——throw 是给 SDK 看的「重建空结果」信号。

---

### 6. background 完成通知的 display 策略

**坑（`4ecc9f5a1`）**：background subagent 完成时 `sendMessage({ display: true })` → 对话流渲染第二个彩色 block，和 tool result block 重复。

**正确做法**：改 `display: false`。通知仍然 `triggerTurn: true`（触发下一轮 LLM 推理）、仍然对 LLM 可见（进 message history），但**不渲染视觉 block**。

**判别原则**：`display` 控制的是「是否在对话流画一个 block」，不是「是否进 history / 是否触发下一轮」。需要 LLM 知道但不需要用户看到视觉冗余时，用 `display: false`。注意 notify 的多处调用都要改，漏一处仍有单 block 闪现。

---

### 7. eventLog 一致性：sync 与 background 路径必须统一

**坑（`1f0acc192`）**：早期 sync 模式手写了一套 eventLog 构建（只处理 `tool_start`/`tool_end`/`turn_end`，**不产出 `text_output`/`thinking` 切片 entry**）；background 模式走 `updateWidgetFromEvent`（产出完整切片）。结果：sync 的 tool block 看不到中间思考/输出，与 background 视觉不一致。

**正确做法**：sync 路径**复用** `updateWidgetFromEvent`，不再手写 switch。**任何在两个路径各自实现的状态构建逻辑，迟早会 drift**——找到唯一真源（single source of truth）并强制两条路径都调用它。

**配套教训（`c68ce754a`）**：删掉「widget 有自己的渲染轮询（200ms setInterval）+ 自己的状态镜像」这层（`AgentWidgetManager`），状态只在 runtime 一处维护，overlay 通过 `listRunningAgents()` 读快照。**不要让渲染层维护独立的状态镜像**——它和执行层的状态迟早不一致。

### 8. 区分 TUI 主进程 vs GUI 主进程（xyz-agent / RPC mode）

**坑（`f38e00fe0`）**：扩展想在 TUI / GUI 两种主进程下走不同分支（如 widget / sidecar channel）时，错误地用 `ctx.hasUI` 做判断。`hasUI` 在 TUI 和 RPC（GUI）模式下**都为 true**（types.ts:307），根本区分不开。结果：TUI 主进程下无条件启用了 streamSink 把 subagent 的 raw LLM text 推到 widget，变成噪音。

**正确做法**：用 `ctx.mode === "rpc"` 区分。

**为什么 `ctx.mode` 是正确的区分维度**：

| 维度 | TUI 主进程 | GUI 主进程（xyz-agent） | subagent 子进程 |
|---|---|---|---|
| `ctx.mode` | `"tui"` | `"rpc"` | `"rpc"`（spawn 时 `--mode rpc`）|
| `ctx.hasUI` | `true` | `true` | `true` |

- **进程边界**：`ctx` 是 `session_start` 回调参数，永远是**当前进程**的 ctx。streamSink 注入点（index.ts session_start）捕获的 ctx 是**主进程**的 ctx，跟子进程无关。
- **spawn 参数 vs 进程 mode**：`spawn pi --mode rpc` 决定子进程怎么输出 stdout（RPC mode JSON 流）；`ctx.mode` 是当前进程自己的 mode。两维度独立。

**识别 GUI 主进程的三种途径（按推荐度排序）**：

| 途径 | 可靠性 | 用法 |
|---|---|---|
| `ctx.mode === "rpc"` | ✓ SDK 标准字段 | `streamSink: ctx.mode === "rpc" ? { setWidget } : undefined` |
| `ctx.hasUI && ctx.mode === "rpc"` | ✓ 更精确（双保险） | 同上，但排除 print/json 误判 |
| 环境变量（如 `XYZ_AGENT=1`）| ✗ 不在 SDK | 子进程继承父环境，但 xyz-agent 是否设置未约定，不要依赖 |

**`ExtensionMode` 字面量定义**（types.ts:299）：

```ts
export type ExtensionMode = "tui" | "rpc" | "json" | "print";
```

4 个值。映射（main.ts:100 `resolveAppMode`）：

| CLI | stdin/stdout | AppMode | ExtensionMode |
|---|---|---|---|
| `pi`（默认）| TTY | `interactive` | `tui` |
| `pi --mode rpc` | 任意 | `rpc` | `rpc` |
| `pi --mode json` | 任意 | `json` | `json` |
| `pi --print` / 管道 | 非 TTY | `print` | `print` |

**修复示例**（subagent-workflow W1）：

```ts
// src/index.ts session_start 内
streamSink: ctx.mode === "rpc"
  ? { setWidget: (key, lines) => ctx.ui.setWidget(key, lines) }
  : undefined,
```

**TUI 主进程** → `streamSink === undefined` → subagent text_delta 不进 widget（无噪音）。
**GUI 主进程**（xyz-agent）→ streamSink 启用 → `ctx.ui.setWidget` → sidecar EventBus → GUI chatStore。

**streamSink API 不变**（保持 `SubagentStream.onDelta(delta)` 签名），只是 TUI 下 stream 不会被创建（`init.streamSink ?? null` 的 fallback 已支持）。

**反模式**：

- ❌ 用 `ctx.hasUI` 区分（永远 true，没区分度）
- ❌ 读 `process.argv.includes("--mode rpc")`（违反 abstraction，且 ctx 已有现成字段）
- ❌ 自定义 env var / config（增加 surface area，且 SDK 已有现成字段）
- ❌ 让 streamSink 在两种 mode 下都启用（TUI 下被噪音淹没）

---

## 踩坑 commit 索引（全量）

以下按类别分组，标注「坑 → 正确做法」：

### 渲染管线与 Shell 策略

| Commit | 坑 | 正确做法 |
|---|---|---|
| `a03ad68db` | 引入 `renderShell:"self"` + Box 自管背景 → 残影起点 | 不用 self shell，default shell 的 contentBox 统管背景 |
| `6257814d7` | 标题行与内容背景不连续；`new Text("")` 高度不稳定 | renderCall 返回标题 Text；空行用 `Spacer(1)` |
| `52bf85e11` | 文字紧贴 block 边界（paddingY=0） | paddingY=1（self shell 时代）；最终走 default shell 不需设 |
| `98d983fc2` | 固定 6 行 pad + Ctrl+O footer → 底部大片空白 | 动态高度，不预填空行，删 footer |
| `414404f0d` | 统一 `⎿` 前缀无类型区分 | 类型图标 `›`/`>`/`·`，prefixWidth 3→2 |

### ANSI / 宽度 / 截断

| Commit | 坑 | 正确做法 |
|---|---|---|
| `391b53070` | result 行超终端宽度（9917>119）→ TUI 崩溃 | `visibleWidth()`/`truncateToWidth` 截断，result 先 split 再逐行 |
| `52bf85e11` | `truncateToWidth` 省略号处背景色断裂 | 自写 `truncLine`（追踪 activeStyles，省略号前重应用） |
| `414404f0d` | `truncVisible` 游离 ANSI 导致列对齐 flaky | 重写 `truncVisible`（grapheme 切，无游离 ANSI） |

### 键盘交互与 Overlay

| Commit | 坑 | 正确做法 |
|---|---|---|
| `daedc74e3` | 硬编码 `\x1b[A` → application/Kitty 终端方向键失效 | `matchesKey(data, Key.up)` 覆盖全编码族 |
| `b41db2933` | j/k 导航误拦截 filter 输入 | 导航只用方向键，不查 kb up/down |
| `7c8e40000` | overlay 退出先 set disposed → unsubscribe 没执行 | `wrappedDone`：幂等 → unsubscribe → clearActiveView → done() |
| `414404f0d` | mock 缺 home/end/page 键 → 测试 false negative | 同步补 mock 的 Key 常量 + DATA_TO_KEY 序列 |

### 性能 / 流式 / 状态生命周期

| Commit | 坑 | 正确做法 |
|---|---|---|
| `8160a5d13` | streaming delta 触发 onUpdate → viewport snap-back | `shouldTriggerUpdate` 守卫，delta 只累积不触发 |
| `ba1c80327` P1a | 每秒 new 组件 → GC 压力 | 复用 `context.lastComponent`，调 `update(d, theme)` |
| `ba1c80327` P1b | background onEvent 每 token 触发 requestRender | background 也要过 `shouldTriggerUpdate` |
| `ba1c80327` P2 | eventLog 引用别名 → 归档被后续 mutate 污染 | `.slice()` 切断别名 |
| `daedc74e3` | 终态 throw → SDK 重建空 details 丢 eventLog | 终态 return 正常 AgentToolResult |
| `4ecc9f5a1` | background 完成双 block | `sendMessage` 用 `display:false` |
| `1f0acc192` | sync/background eventLog slicing 不一致 | 统一调 `updateWidgetFromEvent` |
| `c68ce754a` | widget 渲染层独立状态镜像 → drift | 删 `AgentWidgetManager`，runtime 唯一真源 |
| `f38e00fe0` | streamSink 无条件启用 → TUI 下 widget 被 raw text 淹没 | 守卫 `ctx.mode === 'rpc'`（`hasUI` 在 TUI 和 RPC 都为 true，不能区分） |

---

## 速查决策表

| 我要做什么 | 正确做法 | 关键陷阱 |
|---|---|---|
| 渲染带背景色的 tool block | 不设 `renderShell`，返回裸 Container + Text | ❌ `renderShell:"self"` → 残影 |
| 算行宽/padding | `visibleWidth()` | ❌ `.length`（ANSI 撑大）|
| 截断带样式的行 | 自写 `truncLine`（重应用 SGR） | ❌ `truncateToWidth`（省略号处背景断裂）|
| 截断需列对齐的纯文本 | 自写 `truncVisible`（grapheme 切） | ❌ `truncateToWidth`（游离 ANSI 错位）|
| 处理 LLM 输出文本 | `sanitizeLine`（`\r\n`→空格、`\t`→双空格）| ❌ 原样进 TUI（单行变多行，布局崩）|
| 切分 emoji/CJK 文本 | `Intl.Segmenter` grapheme | ❌ `.slice(0,n)`（劈半乱码）|
| 识别方向键/Esc/Home/End | `matchesKey(data, Key.up)` | ❌ `data==="\x1b[A"`（只命中 1/4 编码族）|
| 自定义 overlay 列表导航 | 只用方向键，不查 kb up/down | ❌ j/k 导航（误拦截 filter）|
| overlay 退出 | `wrappedDone`：幂等→unsubscribe→clearActiveView→done | ❌ 先 set disposed（unsubscribe 短路）|
| streaming 期间刷新 UI | 只在 tool/message 边界触发 onUpdate | ❌ delta 触发（viewport snap-back）|
| 终态（取消/失败）返回 | return 正常 AgentToolResult | ❌ throw（SDK 重建空 details 丢内容）|
| background 完成通知 | `display: false` | ❌ `display: true`（双 block）|
| 复用渲染组件 | `context.lastComponent` + `update(d, theme)` | ❌ 每次 new（GC + theme 闪烁）|
| 区分 TUI vs GUI 主进程 | `ctx.mode === "rpc"` | ❌ `ctx.hasUI`（TUI 和 RPC 都 true）|
| 引入新按键 | 同步补 mock Key + DATA_TO_KEY | ❌ 只改生产（测试 false negative）|
| 空行占位 | `new Spacer(1)` | ❌ `new Text("")`（高度不稳定）|

---

## 参考实现位置

- **pi-subagents（无 bug 参考）**：`~/GitApp/pi-ecosystem/pi-subagents/src/`
  - `extension/index.ts:395-464` — tool 注册（无 renderShell）
  - `tui/render.ts:44-89` — truncLine（ANSI-safe 截断）
  - `tui/render.ts:1012-1046` — renderSingleCompact（裸 Container）
  - `runs/foreground/execution.ts:412-432` — emitUpdateSnapshot（快照）
  - `runs/foreground/execution.ts:434-542` — processLine（只在边界 fireUpdate）
  - `runs/background/async-job-tracker.ts:117` — widget 轮询（`setInterval`，调用点在 line 117；`widgetRenderKey` 去重逻辑分散在 line 129/211/228/231，非一个连续块）
- **Pi 渲染引擎**：`~/Code/pi-mono-fix-workspace/main/packages/`
  - `coding-agent/src/modes/interactive/components/tool-execution.ts:221-251` — self vs default shell 分叉
  - `tui/src/tui.ts:1255-1299` — diff-redraw 引擎
  - `tui/src/tui.ts:1445` — viewport 锚底根因
  - `tui/src/keys.ts` — Key/matchesKey 全编码族
  - `tui/src/utils.ts:138-157,213,884` — visibleWidth/truncateToWidth + 游离 ANSI 源头
- **本项目 subagents**：`extensions/subagents/src/`
  - `tui/subagent-render.ts` — truncLine / sanitizeLine / SubagentResultComponent
  - `tui/subagents-view.ts` — truncVisible / wrapVisible / processKey / createSubagentsView
  - `tui/format.ts` — formatEventLogLine / sanitizeLogLabel
  - `tui/category-confirm.ts` — 自定义 overlay 组件范式
  - `tools/subagent-tool.ts` — renderShell 决策 / lastComponent 复用 / shouldTriggerUpdate / 终态 return
  - `utils/throttle.ts` — leading+trailing+flush
  - `state/execution-state.ts` — shouldTriggerUpdate 守卫
  - `mocks/pi-tui.ts` — vitest mock（Key/matchesKey/visibleWidth/truncateToWidth）
