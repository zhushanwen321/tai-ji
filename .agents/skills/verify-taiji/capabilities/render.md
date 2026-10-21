# render · 消息渲染面（markdown / shiki / html-preview / 变更集 / 图片）

本文件覆盖五个 capability id：

- `render.markdown`（P1）
- `render.shiki`（P2）
- `render.html-preview`（P1）
- `render.changeset`（P1）
- `render.image`（P2）

共同形态：**pi 侧产出一条消息 entry → runtime 转帧 → renderer/core reducer → 对话流 DOM**。
断言纪律：**必须是用户可见 DOM + 布局量/节点形态**，不能只断言「数据里有这个字段」。
testid 权威：`docs/testing/01-chat-panel-composer.md` §3（对话流锚点）、§10.5（表格列宽地板）。

---

## render.markdown · markdown 渲染与安全净化

- **通道**：A（`block-text` 内的 `.md-render` DOM）/ B（`session.history` 原文）/ C（pi jsonl 的 assistant 消息）
- **前置**：`requires: faux`（让 agent 吐 markdown）；依赖 `chat.send` / `chat.wait`
- **用于**：`p0-markdown-render`（矩阵口径；covers: `render.markdown`, `render.shiki`, `chat.stream`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：任何 assistant 文本消息里的 markdown 都会渲染（标题/列表/表格/代码块/链接/
  KaTeX/图片）。
- 渲染管线（**安全模型必读**，出处 `packages/ui/src/features/chat/markdown-sanitize.ts` 文件头）：
  `markdown-it({html:true})` → **可信段摘出**（shiki / KaTeX / md-* 契约：fence / math /
  code_inline / filepath）存进 per-call nonce 哨兵 → **DOMPurify 两级白名单**净化用户 HTML
  （标签表 = hast `defaultSchema`，`class`/`style`/`data-*` **构造性全剥**）→ 哨兵单遍回填。
  - 唯一出口：`renderMarkdown`（`packages/ui/src/features/chat/markdown.ts`）；
  - 禁止绕过它直调 `md.render`（会把不可信 HTML 直接塞进 DOM）。
- 相对资源两条通道（都靠 `resourceBaseDir`）：
  - **图片 `src`**：净化 hook 里按 `resourceBaseDir` 重写成 `local-file:///…`
    （`toLocalFileUrl`，出处 `packages/shared/src/local-file-url.ts`）；
  - **相对链接 `href`**：保持原样，点击时由 `MarkdownRenderer` ④路按
    `props.resourceBaseDir ?? deps.sessionCwdOf(sessionId)` resolve。
  - 对话流基准 = **session cwd**；抽屉（DetailPane）基准 = **文件所在目录**（props 通道）。
- 锚点：文本块根 `block-text`（出处 `packages/ui/src/features/chat/TextRow.vue`），
  渲染容器 `.md-render`（class，非 testid）；流式代码块占位 `md-streaming-fence` /
  `md-streaming-fence-lang`（出处 `MarkdownRenderer.vue`）。

### 驱动

用 `fixtures/faux-responses/markdown-kitchen-sink.json`（表格 + 代码块 + 行内/块级 KaTeX +
相对图片 + html-preview 块 + 链接）发一轮，然后逐形态断言：

1. `expectVisible(testid=block-text)`；等 `role` 结束（停止按钮消失或 turn 完成）。
2. 表格：`block-text table` 可见；按 `01-chat-panel-composer.md` §10.5 的**列宽地板**断言
   （`th` 宽度 ≥ 4em、表头行数 = 1、`table.scrollWidth ≤ hostW+1`）。
3. 链接：外链 `a` 有 `target`/`rel` 兜底；相对链接点击 → 打开 DetailPane（`detail-pane`）。
4. 相对图片：`block-text img` 的 `src` 以 `local-file:///` 开头，且 `naturalWidth > 0`
   （真的加载成功；只断言 src 不加载会漏「白名单 403」）。
5. 安全面（负向）：在同一条回复里带一个用户 HTML 片段
   `<span class="x" style="color:red" onclick="…">`，断言渲染后该 `span` **无 class/style/onclick**。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | A | `block-text .md-render` 内出现 `h1/h2/ul/table/code/pre/a/img` 期望集合 | 出现整段纯文本（`<p>` 里带 `#`） = markdown 降级为纯文本（shiki 初始化失败会走 catch 全文转义） |
| 2 | A | 表格 `th` 计算宽度 ≥ 4em，表头单行 | 首列 1 字宽竖排 = 列宽地板丢失（HISTORICAL 事故） |
| 3 | A | `img.src` 以 `local-file:///` 开头且 `naturalWidth>0` | 相对 src 原样保留（`src="img/x.png"`）= resourceBaseDir 未装配 |
| 4 | A | 用户 HTML 的 `class/style/onclick` 全被剥除 | 任一残留 = 净化白名单被放宽（安全回归，必须红） |
| 5 | B | `session.history` 原文含原始 markdown 源（`|` 表格、``` 围栏） | 历史丢格式 = reducer/持久化问题（不是渲染问题） |
| 6 | C | pi jsonl 该轮 assistant 消息的 text 与 history 一致 | 不一致 = 落盘/读取链劈叉 |

> 1~4 是 A（含布局量），5/6 是 B/C。**3 必须验 `naturalWidth`**：`img` 存在不代表能加载
> （`local-file` 白名单外一律 403，图片会破图但 DOM 在）。

### 证据（A/B/C 各抓什么）

- **A**：`md-kitchen-sink.png` 全窗截图 + 表格 `evaluate` 的量化结果
  （`firstColW/fontSize/headerLines/scrollW/hostW`，直接复用 §10.5 的采样表达式）+
  `<img>` 的 `{src, naturalWidth, complete}`。
- **B**：`session.history` 末条文本（截断 8KB，保留围栏与表格）。
- **C**：pi jsonl 末条 assistant entry（grep `"role":"assistant"`）。

### 证不了

- **渲染像素级一致性**（字体、行高、颜色）：归 `e2e-visual` 像素轨，不在本层。
- **KaTeX 公式的数学正确性**：只验 `.katex` / `.katex-display` 节点存在与不是源码文本；
  公式对错无客观断言。
- **`markdown-it` 插件全语法覆盖**：本层只取 kitchen-sink 的常见子集。
- **增量渲染（streaming）与全量渲染的 DOM 等价**：`markdown-incremental` 有单测
  （`markdown-incremental.test.ts`）；真机只验「流式结束后终态与重开 session 一致」
  （归 `chat.reload-equiv`）。

### Gotchas

- 流式期间 DOM 是**增量拼接**的：表格在流式中途行数不足、列宽未到峰值，
  **必须等 turn 结束再测布局**（§10.5 明确写了这条）。
- 用户 HTML 白名单不含 `class/style/data-*`，所以「给元素加 class 做样式」的 markdown
  一定失效——这是设计，不是 bug。验安全面时要**期望被剥**。
- 图片相对路径的基准是 session cwd（不是 markdown 文件所在目录）：对话流里引用
  `docs/a.png` 意味着 `<cwd>/docs/a.png`。
- 抽屉里的相对链接走 props 通道（文件所在目录），与对话流不同；同一段 markdown 在两处
  解析基准不同是预期。
- `renderMarkdown` 的 highlighter 首次初始化是异步的（`await` 一次后同步）；
  首帧可能出现 `md-streaming-fence` 占位，别当成渲染失败。

---

## render.shiki · 代码高亮（双主题 CSS 变量）

- **通道**：A（`.shiki` span + `--shiki-*` 计算样式）/ B（`session.history` 围栏语言标记）/ C（无独立落盘）
- **前置**：`requires: faux`；依赖 `render.markdown`
- **用于**：`p2-render-shiki`（矩阵伞形 `p0-markdown-render`；covers: `render.shiki`, `render.markdown`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：assistant 回复里的 ```ts / ```bash / ```json 等代码块显示语法高亮 + 语言标签 +
  复制按钮。
- 实现（出处 `packages/ui/src/features/chat/markdown.ts` 文件头）：
  - shiki `createHighlighterCore` + **JavaScript regex engine**（不用 Oniguruma WASM——
    CSP 曾因 WASM 拦死全部渲染，见 AGENTS.md「CSP 能力一致性检查」）；
  - 双主题 `min-dark` / `min-light` + `defaultColor:false` → 输出带
    `--shiki-dark` / `--shiki-light` CSS 变量的 span，由 `MarkdownRenderer.vue` 样式层按
    `<html data-theme>` 切换；
  - 语言白名单（显式 import，不全量打包）：**typescript / javascript / vue / json /
    shellscript / markdown / css / html / yaml / python / go / rust**
    （未在白名单的语言 → 纯文本块，不报错）；
  - mermaid 块单独走占位容器，由 `MermaidRenderer` 异步渲染（不调 shiki）。
- 锚点：代码块结构是 **class**（`md-codeblock` / `md-codeblock__header` /
  `md-codeblock__lang` / `md-codeblock__copy`，出处 `markdown.ts` 的 fence 渲染段），
  **没有 testid**（这是本 capability 的锚点短板，见「证不了」）。

### 驱动

1. 发一条含 ```ts（带 `const x: number = 1`）与 ```bash（带 `echo hi`）的回复
   （kitchen-sink 剧本已含 ts 块）。
2. 断言 `.md-codeblock` 数量 = 围栏数；`.md-codeblock__lang` 文本 = 语言名。
3. 断言高亮生效：代码块内存在 `span[style*="--shiki"]`（双主题形态），且
   `getComputedStyle(span).color` 在暗/亮主题下不同。
4. 切主题（`settings.theme` 的 `appearance-mode-light`）后再取一次 `color`，应变化。
5. 未白名单语言（```brainfuck）→ 仍渲染代码块但无 shiki span（降级不报错）。
6. 复制按钮：点 `.md-codeblock__copy` 后剪贴板/提示（剪贴板断言可跳过，只验按钮存在且可点）。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | A | `.md-codeblock__lang` = 围栏语言（ts/bash/json…） | 语言标签为空 = info string 丢失 |
| 2 | A | 块内 `span[style*="--shiki"]` 数 > 0 | 0 个 = highlighter 未初始化/语言不在白名单（**先确认语言合法**） |
| 3 | A | 暗/亮主题下同一 token 的 computed color 不同 | 相同 = 双主题变量未生效（`defaultColor:false` 链路断） |
| 4 | A | 整段不是纯文本（`.md-render` 里有 `<pre>`/`<code>`） | 整段转义成文本 = `renderMarkdown` catch 兜底（highlighter 抛错） |
| 5 | B | history 原文含围栏与语言 | 语言丢失 = 上游消息拼接问题 |

> 全是 A + 一条 B。**注意 2 的失败信号有歧义**：语言不在白名单也会 0 span（合法降级），
> 所以必须配 1（标签正确）+ 5（原文语言）才能判「高亮坏了」。

### 证据（A/B/C 各抓什么）

- **A**：`shiki-dark.png` / `shiki-light.png`（同一条消息切主题前后）+ `evaluate` 采样
  （span 数、首个 token 的 computed color、`--shiki-dark/light` 原始值）。
- **B**：history 原文围栏段。
- **C**：无（渲染纯前端）。

### 证不了

- **没有 testid 的代码块**：只能靠 class 选择器（`.md-codeblock`），属结构性锚点，
  改样式类名会静默失效 → 标 `weak-anchor`。**建议补**
  `data-testid="md-codeblock"` / `md-codeblock-lang`（登记在此，等实现）。
- **语法 token 的正确性**（某关键字是否该着某色）：shiki 主题决定，不做逐 token 断言。
- **mermaid 图渲染**：属 `MermaidRenderer`（异步 + 可失败），本层只验占位容器出现；
  真图渲染需 `render.mermaid`（**capability id 未在 v1 清单内**，见报告）。

### Gotchas

- shiki 用 JS regex engine 而非 WASM：**不要**在验收里断言 `WebAssembly` 相关行为，
  也不要改 CSP 去「修」高亮（HISTORICAL 事故根因）。
- 语言白名单是**显式 import 的 12 种**；写 ` ```tsx ` 或 ` ```sql ` 会降级为纯文本块
  ——这是预期，不是 bug。剧本里用白名单内语言。
- 亮色主题有专用覆盖规则（`[data-theme="light"] .shiki span`，见 `UpdateButton.vue` /
  `DiffView.vue` 的 `:global` 段）；验亮色时必须真的切到 light 再取色。
- 代码块复制按钮的 `data-code` 是 base64（`markdown.ts` 的 fence 渲染），大代码块会让
  DOM 属性膨胀；断言时别整块 dump。

---

## render.html-preview · HTML 产物内联预览（sandbox iframe）

- **通道**：A（`html-preview-inline` / `html-preview-frame` / `html-preview-degraded`）/ B（`localFile:servable` 预检 IPC 结果——不进 WS 协议）/ C（`<dataDir>/ext-sessions/<sid>/artifacts/` 产物文件）
- **前置**：`requires: faux`（让 agent 写 HTML 并给出路径）+ 依赖 `render.markdown` / `chat.send`
- **用于**：`p1-render-html-preview`（矩阵伞形 `p0-markdown-render`；covers: `render.html-preview`, `render.markdown`, `evidence.tree`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：assistant 回复里出现一个 ` ```html-preview ` 围栏，内容是 HTML 文件路径
  → 消息流内**原位**渲染一个卡片：头部条（文件名 + 大小 + 「源码 | 预览」切换 + 刷新 +
  收起/展开）+ sandbox iframe（默认预览态）。
- 语法契约（出处 `packages/ui/src/features/chat/HtmlPreviewInline.vue` 文件头）：
  - 围栏 info 首词 = `html-preview`，**内容只是路径字符串**；
  - 绝对路径（含 `~`）直用；相对路径按 `resourceBaseDir ?? sessionCwdOf(sessionId)` 解析
    （与 markdown ④路同一矩阵，纯函数镜像在 `html-preview-path.ts`）。
- 安全不变量：
  - 容器 DOM 由 Vue 模板产出，**不经过 v-html / DOMPurify 信任槽**；
  - iframe `sandbox="allow-scripts"` **单权限**（opaque origin；不给 `allow-same-origin` /
    `allow-top-navigation` / `allow-popups` / `allow-forms`）；
  - 预检走主进程 `localFile:servable`（`{servable, reason, size}`），原因三值
    `not_found` / `is_dir` / `out_of_whitelist` → 降级占位。
- 高度：iframe 固定 480px（展开 720px），**不做内容自适应**（opaque origin 读不到
  `contentDocument`，无测高通道）。
- testid（同文件）：`html-preview-inline`（根）/ `html-preview-degraded`（降级容器）/
  `html-preview-name` / `html-preview-meta` / `html-preview-source`（源码态）/
  `html-preview-frame`（iframe）。

### 驱动

1. 让 agent 把 HTML 写到**会话产物目录**（`<dataDir>/ext-sessions/<sid>/artifacts/demo.html`；
   该路径在 capability 段每 turn 注入给 agent），然后回复一个 ` ```html-preview `
   围栏指向它（可用 faux 两条 step：写文件 → 文本回复）。
2. `expectVisible(testid=html-preview-inline)`。
3. 等预检完成：正常态出现 `html-preview-frame`；若 `html-preview-degraded` 出现，
   读 `html-preview-meta` 的原因（`not_found`/`is_dir`/白名单外）——这是**失败信号**，
   不是可以接受的降级。
4. 断言 `html-preview-name` = 文件名，`html-preview-meta` 含大小（预检 `size`）。
5. 切「源码」→ `html-preview-source` 可见（转义展示源码，不是 iframe）。
6. 负向：把围栏指向 `<dataDir>/agent/auth.json`（白名单外/敏感）→ 必须 `html-preview-degraded`
   + 原因 `out_of_whitelist`（**不得**真的渲染凭据）。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | A | `html-preview-inline` 出现且**不是** `html-preview-degraded` | 降级 = 路径解析/预检失败（先看 `html-preview-meta`） |
| 2 | A | `html-preview-frame` 的 `sandbox` 属性 = `allow-scripts`（不含 `allow-same-origin`） | 出现 `allow-same-origin` = **安全回归**（必须红） |
| 3 | A | `html-preview-name` = 文件名、meta 含大小 | meta 空 = 预检未跑（`probeArtifact` 未注入） |
| 4 | C | `<dataDir>/ext-sessions/<sid>/artifacts/demo.html` 存在且内容 = agent 写入 | 文件不在 = 写路径错（写到项目目录也能渲染，但证据要按实际路径取） |
| 5 | A | 白名单外路径 → `html-preview-degraded` + `out_of_whitelist` | 渲染成功 = 白名单被放宽（严重） |
| 6 | A | iframe 高度 480px（展开 720px），超内容内部滚动 | 高度 0 = 样式/布局失败 |

> 1/2/3/5/6 是 A，4 是 C。2 与 5 是**安全断言**，失败一律按缺陷处理，不得降级为「已知限制」。

### 证据（A/B/C 各抓什么）

- **A**：`html-preview-default.png`（卡片 + iframe 头）、`html-preview-degraded.png`（负向）、
  `html-preview-source.png`；DOM 抓 `html-preview-frame` 的 `sandbox` 属性 + iframe 尺寸。
- **B**：无（预检是 main 进程 IPC，不进 WS）。
- **C**：产物文件路径 + `ls -l` + 内容 sha256；若降级原因是 `out_of_whitelist`，
  附 `getAllowedLocalFilePrefixes` 的当前前缀清单（只读）。

### 证不了

- **iframe 内脚本执行结果的正确性**：opaque origin 下父页面读不到内容；
  只能验「iframe 挂载 + 无降级」。要验内容得用 `page.frameLocator`（CDP 可跨 frame 取 DOM），
  但脚本执行副作用（如写 localStorage）不可验。
- **`~` 家目录形态的实际展开**：展开在主进程 `expandLocalFilePath`，本层只验「能渲染」；
  家目录路径在验收机上不稳定，建议用绝对路径。
- **预检 pending 的加载态**：源码是「中性加载态，无墙钟超时」；没有独立 testid，
  只能通过「`html-preview-inline` 在场但既无 frame 也无 degraded」推断 → weak-anchor。
- **相对路径 `..` 折叠的边界**：三份镜像实现（`html-preview-path.ts` /
  `markdown-links.ts` / 旧 renderer 版）由脚本 `check-posix-resolve-mirror-sync.mjs` 机检；
  真机只验一条 `../` 相对路径。

### Gotchas

- 围栏内容**只是路径**，不是 HTML 源码；` ```html-preview ` 后面写 HTML 会被当路径解析
  → 降级 `not_found`（常见误用）。
- 产物目录 `<dataDir>/ext-sessions/<sid>/artifacts/` 在 `local-file` 全量白名单内；
  但**读/预检通道**只放行「会话产物子树」（`apps/electron/main/utils/local-file-prefixes.ts`
的 `computeLocalFileReadPrefixes`），
  其它 `<dataDir>` 下的文件会被 `out_of_whitelist` 拒绝——这是刻意的收窄。
- iframe 用 `allow-scripts` + **无** `allow-same-origin`：产物里的
  `localStorage`/`parent.document` 访问会抛错，这是 sandbox 语义，不是产物 bug。
- 高度自适应是**明确放弃**的（设计 §6.3 实施降级）；不要写「高度等于内容高度」的断言。
- HTML 产物写盘位置推荐 `artifacts/`；写到项目 cwd 也能渲染（白名单含 `<dataDir>` 前缀
  与项目路径？——按 `getAllowedLocalFilePrefixes` 实读为准），但证据路径要按实际写盘取。

---

## render.changeset · 变更集卡（git 基线 diff）

- **通道**：A（`change-set-card` / `change-set-file` + 工具块）/ B（`message.tool_call_end` 的 `fileChanges`）/ C（`git status --porcelain`、`git diff --numstat`）
- **前置**：`requires: faux`（让 agent 真的改文件）；依赖 `chat.send` / `chat.wait` / `render.markdown`
- **用于**：`p1-tool-call-render`（矩阵口径；covers: `render.changeset`, `chat.send`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：agent 用 `edit` / `write` 改了文件 → 该轮出现「变更集」卡：状态徽标
  （accumulating / ready / partially-reviewed / resolved / superseded）+ 文件行
  （每行 A/M/D/U 角标 + 行数）。
- 数据来源（出处 `packages/runtime/src/infra/pi/file-change-reconciler.ts` 文件头）：
  **git 是唯一真值源**——每个 assistant turn 起点采 `git status` 基线，turn 内写操作后
  再采一次，diff 出该轮变更；行数用 `git diff --numstat` 填充（不再从工具参数硬解析）。
  - 关键含义：**没有 git 仓库 = 没有变更集**；未跟踪文件算 `added`（`??` → added）。
  - 既有事故：只对比「status 变化的文件」会漏报 → 变更集卡不显示；现行按快照 diff。
- 锚点（`docs/testing/01-chat-panel-composer.md` §3）：`change-set-card` / `change-set-header` /
  `change-set-file`；工具块 `tool-block-header` / `block-tool-<id>`。
- 工具详情渲染器（右抽屉工具详情）：`tool-detail-edit` / `tool-detail-write` /
  `tool-detail-write-label` / `tool-detail-write-loading` / `tool-detail-read`
  （出处 `packages/renderer/src/components/panel/detail-renderers/ToolDetailRenderer.vue`）。

### 驱动

1. 工作目录必须是 **git 仓库**（faux 装配默认把 `recent-workspaces.json` 指向 `<repo>`；
   用 `e2e/fixtures/sample-project` 也可以——确认它是 git 仓库或先 `git init`）。
2. 记录基线：`git -C <cwd> status --porcelain` 与 `git -C <cwd> stash list`（确认工作区干净）。
3. faux 剧本 `fixtures/faux-responses/tool-edit.json`：`edit` 改一个已跟踪文件 →
   （可选）`write` 新建一个文件 → 收尾文本。
4. 等 turn 结束 → `expectVisible(testid=change-set-card)`；
   断言 `change-set-file` 行数 = 实际改动文件数，行内角标 = `git status` 的 XY 映射
   （`??`→A、` M`→M、` D`→D、`UU`→U）。
5. C 通道对照：`git status --porcelain` + `git diff --numstat`（行数）。
6. 负向：在**非 git 目录**建 session 做同样操作 → 不应出现 `change-set-card`
   （不是「空卡」）。这是「git 是唯一真值源」的反证。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | A | `change-set-card` 出现，`change-set-file` 数 = 改动文件数 | 卡出现但 0 文件 = 快照 diff 退化 |
| 2 | A | 文件行角标与 git XY 映射一致（A/M/D/U 四态） | 新增文件显示 M = 未跟踪映射丢失 |
| 3 | A | 卡状态徽标从 `accumulating` → `ready`（turn 结束后） | 停在 accumulating = `message.complete` 未到（不是渲染 bug） |
| 4 | C | `git status --porcelain` 的文件集合 = 卡内文件集合 | 卡里有但 git 没有 = 伪造（不应发生） |
| 5 | C | `git diff --numstat` 的增删行数 = 卡内行数 | 行数全 0 = numstat 填充失败（回退 content 计数也没跑） |
| 6 | A | 非 git 目录不出现 `change-set-card` | 出现空卡 = 真值源判定错 |

> 1/2/3/6 是 A，4/5 是 C。**必须两边都验**：变更集是「git 派生视图」，
> 只验 A 会把「git 采集失败但 UI 有旧值」当成功。

### 证据（A/B/C 各抓什么）

- **A**：`changeset-card.png` + 期望/实际角标表（文件 → A/M/D/U）。
- **B**：该轮 `message.tool_call_end` 帧的 `fileChanges` 数组（截断）。
- **C**：`git status --porcelain=v1` 全文 + `git diff --numstat` 全文 + `git diff` 摘要
  （证明文件内容真的变了，不只是 status）。

### 证不了

- **`partially-reviewed` / `resolved` / `superseded` 三态**：需要用户在卡上做 Accept/Reject
  审查交互；当前卡**没有审查按钮 testid**（`01-chat-panel-composer.md` §11 backlog
  明确列为缺口）→ `verified-unreachable`，标注「需补 ChangeSetCard 审查交互锚点」。
- **超大 diff 的截断行为**：需要构造 >1MB diff；未验。
- **rename 的 `R` 映射**：`parseGitStatusPorcelain` 取 `->` 后的目标路径，但
  `FileChangeStatus` 是 4 态（无 renamed）→ rename 会落成 M/A 之一；具体映射未真机断言。

### Gotchas

- **非 git 目录没有变更集**（这是设计，不是 bug）。faux 装配默认 cwd = `<repo>`（git 仓库），
  所以默认路径是好的；换到 `/tmp` 目录验收会「什么都看不到」。
- 基线按 **turn** 采：如果上一轮留下了未提交改动，本轮卡会把它们算进来吗？——不会
  （基线在本轮起点，diff 只算本轮增量）。要验「干净增量」，先清空工作区。
- 图表/行数依赖 `git diff --numstat`：二进制文件是 `-`，行数显示可能为空（预期）。
- 变更集卡只挂 assistant 消息：user 消息里不会出现。
- 与 `git.status` RPC（文件树角标）是两条链：文件树角标来自 `git.status`，
  变更集卡来自 turn 快照 diff；两者短期可能不一致（文件树靠广播失效重拉收敛）。

---

## render.image · 工具结果图片（附件 / 截图回显）

- **通道**：A（`tool-image` / `tool-image-placeholder` / `tool-image-fallback`）/ B（`message.tool_call_end` 的 content 图片块）/ C（`<dataDir>/ext-sessions/<sid>/image-cache/`、`attachments/`）
- **前置**：`requires: faux`（让 agent 返回图片块或用工具产出图片）；依赖 `chat.send` / `render.markdown`
- **用于**：`p2-render-image`（矩阵伞形 `p1-tool-call-render`；covers: `render.image`, `chat.send`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：工具结果里带图片（截图 / 生成的图）→ 对话流工具块内显示缩略图；点开看大图
  （或占位/降级）。
- 实现：`ToolResultImages.vue` 三态——
  - `tool-image`：正常 `<img>`；
  - `tool-image-placeholder`：读取中/占位；
  - `tool-image-fallback`：加载失败/不可显示（无 src、协议不允许等）。
  （出处：`packages/ui/src/features/chat/ToolResultImages.vue`，grep `data-testid`）。
- 落盘：
  - 工具结果图片缓存 = `<dataDir>/ext-sessions/<sid>/image-cache/`
    （推导 `packages/shared/src/paths.ts` 的 `getImageCacheDir`）；
  - 用户附件 = `.../attachments/`（`getAttachmentsDir`）；
  - URL 构造单点 = `packages/shared/src/local-file-url.ts`（`local-file:///` + encodeURIComponent）；
    主进程白名单见 `apps/electron/main/gateway/local-file-handlers.ts` 与
`apps/electron/main/utils/local-file-prefixes.ts`。

### 驱动

1. faux 剧本让工具结果带图片块（当前仓内**没有**现成剧本，见「证不了」；
   最接近的做法是让 agent 用 `bash` 生成一张 PNG 并用支持图片的工具返回）。
2. 等 turn 结束 → 断言三态之一出现。
3. 正常态：`tool-image img` 的 `src` 以 `local-file:///` 开头，`naturalWidth > 0`。
4. 失败态：把图片路径指向白名单外/不存在的文件 → 应出现 `tool-image-fallback`（不是空白）。
5. C 通道：`ls <dataDir>/ext-sessions/<sid>/image-cache/`（有缓存文件）或
   `attachments/`（用户上传时）。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | A | `tool-image` 出现且 `naturalWidth>0` | 只有 `tool-image-placeholder` 常驻 = 加载悬挂 |
| 2 | A | `src` 为 `local-file:///` 形态（或 data URL，视来源） | 裸相对路径 = URL 构造点被绕过 |
| 3 | A | 坏路径 → `tool-image-fallback`（有可读文案） | 空白破图无 fallback = 降级链缺失 |
| 4 | C | `image-cache/` 有对应文件（缓存型来源） | 目录空 = 未落缓存（`imageCache` 语义，非必现） |

> 1/2/3 是 A，4 是 C。图片的「存在」比「像素正确」重要：`naturalWidth>0` 是能加载的
> 最小硬证据。

### 证据（A/B/C 各抓什么）

- **A**：`tool-image.png` + `{src, naturalWidth, complete}` 采样 + fallback 态截图。
- **B**：`message.tool_call_end` 的图片块（mimeType + 大小，base64 不入证据）。
- **C**：`ls -l ext-sessions/<sid>/image-cache/` / `attachments/`。

### 证不了

- **当前无图片夹具**：仓内 faux 剧本库没有「工具返回图片」的现成脚本
  （`grep -rn "type: 'image'" packages/runtime/src/__tests__/fixtures/` 无命中）。
  → 本 capability 在 v1 记 `verified-unreachable`，前置缺失 = **需补一个返回图片块的
  faux 剧本**。可行路径（未实测）：faux 让 agent 调 `read` 读一张仓内真实 PNG
  （如 `docs/assets/logo/assets/qianwen/logo-square.png`）——`read` 对图片返回 attachment
  块，正好落到 `ToolResultImages` 的三态渲染。补剧本时同批更新本文件与 README 索引。
- **大图/超限截断**：`local-file` 有大小限制（按白名单 handler 实读），未验边界。
- **图片 EXIF/方向**：浏览器行为，不做断言。
- **用户粘贴图片（剪贴板）**：CDP 不能可靠设剪贴板图片 → 不可驱动。

### Gotchas

- `tool-image` 是**工具结果**图片；assistant markdown 里的 `![](…)` 走 `render.markdown`
  的 `img` 重写通道（两套锚点，别混）。
- `local-file:///` 是 `path` 全量 encodeURIComponent（含 `/`），所以 URL 形态里没有裸 `/`
  分隔——不要用「路径包含 `image-cache/`」断言 src，用解码后路径或直接查文件。
- 图片加载是异步的：`expectVisible(tool-image)` 后还要等 `naturalWidth>0`
  （条件轮询，禁 sleep）。
- 附件目录（`attachments/`）与图片缓存（`image-cache/`）语义不同：
  前者是用户输入，后者是工具结果缓存；删除会话时整树回收（ADR-0151）。

---

## render.tool-call · 工具调用过程展示（工具块 + 结果 + 变更集联动）

- **通道**：A（工具块渲染态 / 强制展开 / 失败态）/ B（工具调用 entry 与 `tool_call` 索引）/ C（工具真实副作用：文件写入、git diff、后台任务登记）
- **前置**：`requires: faux`（faux 可编排 toolCalls，零 token）；依赖 `chat.send` `chat.wait`
- **用于**：覆盖矩阵 P1 行「工具调用过程展示」；被 `render.changeset` 复用

## 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：assistant 回合里出现工具块（工具名 + 输入 + 输出），running 态强制展开、完成可折叠、失败态红标；工具改了文件则追加变更集卡。
- 协议：`message.*` 事件流里的 tool 相关 entry；`session.history` 回读同样 entry（live ≡ reload）。
- 副作用点：`<dataDir>/ext-sessions/<sid>/logs/pi-<date>.jsonl` 的 tool 调用记录；工具自身副作用（写文件 / 后台任务登记）。

## 驱动

```bash
# faux 剧本：一回合内调 bash，再一回合收尾
node .agents/skills/verify-taiji/scripts/seed-faux.mjs <repo> ~/.taiji-dev/verify-<runId> \
  .agents/skills/verify-taiji/fixtures/faux-responses/tool-bash.json
# 变更集用它（需要 cwd 是 git 仓库）
# fixtures/faux-responses/tool-edit.json

PW="node ~/.agents/skills/browser-automation/scripts/pw.js http://localhost:<cdpPort>"
$PW wait "testid=chat-view"
$PW text "css=[data-testid^='trace-tool']"     # 工具块容器（.trace-tool）
$PW text "testid=bash-output"                   # bash 工具的输出块
$PW text "testid=bash-status-tag"               # 运行/完成/失败状态标签
```

变更集：

```bash
$PW wait "testid=change-set-card"
$PW text "testid=change-set-header"
$PW text "testid=change-set-file"
cd <repo> && git status --porcelain    # C 通道对照
```

## 断言（期望终态 / 失败信号）

- 期望终态：工具块在场且**工具名可从 DOM 取到**；running 态展开；完成后可折叠但 header 恒在；失败态有显式标记；变更集卡列出真实改动文件且状态与 `git status` 一致。
- 失败信号：
  - 只见「黑盒回合」（无工具块）→ 工具调用过程展示挂掉（P1 契约：挂了只见黑盒）；
  - 工具块 header 有但内容永久空白 → 输出通道断；
  - 变更集卡的文与 `git status` 不一致 → 变更集派生源错（以 git 为真）。

## 证据（A/B/C 各抓什么）

- **A（主）**：工具块 / 输出 / 状态标签 / 变更集卡的截图与 DOM 文本。
- **B**：`session.history` 里对应的 tool entry（证明 live 渲染不是前端造的）。
- **C**：pi jsonl 的 tool 调用行 + `git status` + 工具真实产物（新建的文件）。

## 证不了

- 工具**执行结果正确性**（那是工具本身的契约，由 `base-tool-enhance` 等包的单测承担）；本原语只证「过程被正确呈现」。
- 折叠态的动画质量（视觉轨归 e2e-visual）。

## Gotchas

- **工具块 header 是两个独立 span**（「工具」+ 工具名）→ 跨 span 的 `getByText` 不可靠；限定 `.trace-tool` 容器后取文本，或用 `bash-*` / `change-set-*` 家族 testid。
- **变更集依赖 git 基线**：cwd 不是 git 仓库时不会出现变更集卡（预期行为，不是失败）。
- **工具运行期间回合停在工具执行态**：不要把「没有文本流」误判为挂死（对照 `bash-status-tag` 是否在动）。
- **同一工具多次调用**：`trace-tool` 是 class 不是 testid，容器选择器要靠 `[data-testid^=...]` 或 class 组合；块级序号不稳定，断言用「至少 N 个」而不是「第 N 个」。
