# workspace · 外设面（文件树 / 右抽屉 / 全局搜索 / 终端 / 会话导入）

本文件覆盖五个 capability id：

- `workspace.filetree`（P1）
- `workspace.drawer`（P2）
- `workspace.search`（P2）
- `workspace.terminal`（P2，多实例）
- `workspace.import`（P2）

> **复用优先纪律**：文件树与终端**已有 e2e spec 覆盖**（`e2e/file-tree.spec.ts` /
> `e2e/terminal-multi-instance.spec.ts`）。本层不重造断言，只写「e2e 已覆盖什么 +
> 真机验收补什么」。真正的新增价值 = **跨通道证据**（UI + 协议 + 磁盘/进程）。

---

## workspace.filetree · 文件树（懒加载 / 过滤 / git 角标 / 虚拟滚动）

- **通道**：A（`file-view-root` 内行 DOM）/ B（`file.tree` / `file.tree.expand` / `file.search` / `git.status`）/ C（真实目录树、`git status --porcelain`、展开态持久化）
- **前置**：`requires: none`（纯 UI + 文件系统）；依赖 `session.create`（需要活跃 session 才有 cwd）
- **用于**：`p1-filetree`（矩阵口径；covers: `workspace.filetree`, `workspace.drawer`, `session.history`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：侧栏 segmented tab 切到「文件」（`role=tab` + `title="文件"`；容器
  `sidebar-view-tablist`，**tab 无独立 testid**）→ `file-view-root`。
- 协议：`file.tree`（顶层 + 一级，D-009 懒加载）/ `file.tree.expand`（单层）/
  `file.search`（全量递归，ignore + 深度 8 + DoS 5000）/ `git.status`（角标）；
  出处 `packages/shared/src/protocol.ts` 的 ClientMessageMap。
- 副作用点：展开态存 store（`expandedPaths`），切 session 再切回恢复；文件改动后
  `chatStore.messages` 的 `fileChanges` 触发 `store.invalidate(path)`（**只标记**，
  下次 expand 重拉，不清空树）。
- **testid 权威 = `docs/testing/02-panels-sidebar.md` §3**（`file-view-root` /
  `file-filter-input` / `file-loading` / `file-error` / `file-retry` / `file-empty` /
  `file-tree-dir-<path>` / `file-tree-file-<path>` / `file-tree-loading-<path>` /
  `file-tree-error-<path>` / `file-tree-empty-<path>` / `chevron-slot` / `file-view-no-session`，
  外加目录徽标 `file-tree-dir-badge-<path>`）。本文件不复刻该表。

### 驱动

两步：① **先跑/读机器资产**（`e2e/file-tree.spec.ts`，覆盖渲染与交互逻辑）；
② **再做真机增量**（真实 git 仓库 + 虚拟滚动行数 + git 角标 + 失败面）。
两个子节按此顺序展开。

#### e2e 已覆盖什么（**不要重复造**）

`e2e/file-tree.spec.ts`（mock 轨 + `VITE_MOCK`，**10 个 test**；文档说 11 个，实测 10，
见报告）覆盖：

| 用例 | 覆盖点 | 本层是否再验 |
|------|--------|--------------|
| `E2E-1 (T1.8)` | 切「文件」tab → 顶层节点 DOM 可见（@p0-smoke） | 否（CI 已跑） |
| `E2E-2 (UC-1+2)` | 点目录展开 → 子节点出现 + 目录徽标渲染 | 否 |
| `E2E-3a (T6.2)` | 点文件 → SideDrawer detail 打开 + 内容显示 | 否（但抽屉的跨通道证据本层补） |
| `E2E-3c (T6.12)` | drawer 已开点新文件 → 新增 tab；已开文件再点仅激活 | 否 |
| `E2E-4 (AC-3.5)` | 切 session 再切回 → 展开态恢复 | 部分（见「补什么」） |
| `T4.1 / T4.2 / T4.5` | 过滤命中 / 无匹配空态 / 清空恢复 | 否 |
| `D-020` | ignored 节点恒显 + 未跟踪/跟踪态双色 | 否 |
| `harness smoke` | app 加载首窗口 | 否 |

**e2e 用 mock 数据**（`MOCK_TREE`：src / README.md / package.json / untracked.log /
node_modules(ignored)），所以它证明的是**渲染与交互逻辑**，不证明「真实文件系统 + 真 git」。

#### 真机验收补什么（本 capability 的增量）

1. **真实 cwd 的树**：在**真实 git 仓库**（默认 `<repo>` 或 `e2e/fixtures/sample-project`）
   建 session → 断言 `file-tree-dir-<真实目录>` 存在，且行的 `path` 与
   `ls <cwd>` 的真实子集一致（抽样 2~3 个）。
2. **虚拟滚动的 DOM 行数约束（关键）**：`docs/testing/02-panels-sidebar.md` §2 明写
   「万级目录展开只挂载视口 ± 缓冲的行（DOM 行数 < 200）」。
   → 在 `node_modules` 这类大目录展开后，断言
   `document.querySelectorAll('[data-testid^="file-tree-"]').length < 200`，
   而**不是**断言「所有子项都在 DOM」。
   **这一条 e2e 没覆盖**（mock 树太小），是虚拟滚动类回归的唯一真机防线。
3. **真实 git 角标**：`git -C <cwd> status --porcelain` 造 A/M/D/U 四态（改一个、删一个、
   加一个、造冲突）→ 角标 `data-*`/文本与 git 逐条对照（工作区改动是真实事实源）。
4. **跨 session 展开态持久**：A 展开 `src` → 切 B → 切回 A → `file-tree-dir-src` 的
   子行仍在（B 通道：`file.tree.expand` 未重复发；C 通道：无重复请求日志）。
5. **失败面**：把 cwd 指向一个被删掉的目录（session 记录的 cwd 不存在）→ `file-error` +
   `file-retry`（e2e 的 mock 不模拟失败）。
6. **性能边界**：大目录（>5000 项）`file.search` 的 `truncated` 语义（协议明确 5000 上限）。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | A | 顶层行集合 ⊆ 真实目录子集，且包含已知文件 | 行 path 与真实不符 = cwd 取错（session cwd） |
| 2 | A | 大目录展开后 `file-tree-*` 节点数 < 200 | 上千行 = 虚拟滚动退化（内存/卡顿事故前兆） |
| 3 | A | A/M/D/U 角标与 git 四态一致 | 全无角标 = `git.status` 未拉/未合流 |
| 4 | B | 展开只发一次 `file.tree.expand`（缓存复用） | 反复发 = 缓存失效逻辑坏了（`invalidate` 过度） |
| 5 | C | 切回 session 后展开态恢复，且无重复 expand 请求 | 恢复失败 = `expandedPaths` 未持久 |
| 6 | A | cwd 不存在 → `file-error` + `file-retry` 可点 | 白屏/空树 = 错误态缺失 |

### 证据（A/B/C 各抓什么）

- **A**：`filetree-large-dir.png` + `nodes: <count>` 采样（`querySelectorAll` 计数）+
  角标表（path → A/M/D/U）。
- **B**：`file.tree` / `file.tree.expand` 的 reply 条数（证明懒加载/缓存）；
  `git.status` reply 的 `files[]`。
- **C**：`ls -la <cwd>`（顶层抽样）+ `git -C <cwd> status --porcelain` 全文。

### 证不了

- **超大目录（>10 万项）的真实性能**：`file.search` 有 5000 DoS 上限，树展开只单层；
  极端规模需构造合成目录（会污染工作区）→ 不做。
- **符号链接循环**：runtime 侧有防护但无稳定断言锚点 → `weak-anchor`。
- **文件内容预览的语法高亮**：归 `render.*`（抽屉 detail 的 `CodeBlock`/`DiffView`）。
- **移动壳的文件树**：本层只覆盖桌面。

### Gotchas

- **不要断言「所有子节点都在 DOM」**：virtua 只挂视口 ± 缓冲。滚动后再断言可见性。
- tab 切换没有 per-tab testid，用 `role=tab` + `name`/`title`（e2e 里用
  `button[title="会话"]` 的历史写法，原因是 icon-only 会盖 accessible name）。
- `chevron-slot` 无 path 后缀，必须限定到父节点再查（`02-panels-sidebar.md` §3 的查询示例）。
- ignored 节点**恒显**（2026-10-15 裁决），不再被过滤掉；用「看不到 node_modules」
  判断过滤生效是旧语义。
- 目录徽标 = 可见直接子项数（`childCount`），不是递归总数。

---

## workspace.drawer · 右侧抽屉（7 tab：git/doc/detail/subagent/bashTask/plan/btw/trace）

> 事实更正（2026-10-21）：`workflow` tab 已于 2026-10-19 删除（`packages/core/src/domain/drawer/types.ts` 的
> `RightDrawerTab` 实际域 = `'git' | 'doc' | 'detail' | 'subagent' | 'bashTask' | 'plan' | 'btw' | 'trace'`）。
> workflow 唯一入口 = 全屏 overlay；overlay 不可用时**没有 drawer 回落载体**（回落 = toast + 重开重试）。
> 本文档此前按 `docs/testing/02-panels-sidebar.md` §3 与 `FEATURE-PRIORITIES.md §2` 的旧口径写，属既有文档漂移。

- **通道**：A（`drawer-panel` + `drawer-tab-<key>` + 各 tab 内容）/ B（`git.status` / `git.diff` / `plan` 状态 / subagent RPC）/ C（文件内容、git 状态、plan 产物）
- **前置**：`requires: none`（git/detail）；plan/subagent/trace/btw tab 需对应会话状态；
  依赖 `workspace.filetree`（detail 入口）
- **用于**：`p2-workspace-drawer`（矩阵伞形 `p0-display-containers`；covers: `workspace.drawer`, `workspace.filetree`, `interaction.plan-review`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：
  - 顶栏抽屉按钮 `drawer-toggle`（`PanelHeader.vue`，always-visible）→ 默认打开 **git** tab；
  - 文件树点文件 → 自动打开 **detail** tab；
  - 计划审批「评论计数」点击 → 打开 **plan** tab（`openDrawerTab('plan')`）；
  - 关闭按钮 `drawer-close`；宽度可拖 `drawer-resize-handle`（`PanelContainer.vue`）。
- tab 集合（终态 8 员，权威出处 = `packages/core/src/domain/drawer/types.ts` 的 `RightDrawerTab`；
  ui 渲染 = `packages/ui/src/features/drawer/DrawerPanel.vue` 的 `drawer-tab-${tab.key}`；
  renderer 内容注入 = `packages/renderer/src/components/workspace/PanelContainer.vue` 的 v-if 链）：
  `git` / `doc` / `detail` / `subagent` / `bashTask` / `plan` / `btw` / `trace`。
  **workflow tab 已删**（2026-10-19，见上方事实更正）；`trace` = 会话 trace 条目详情（`TraceInspector`）。
  **terminal 已迁底抽屉**（见 `workspace.terminal`），browser 已迁浮层。
- testid 权威：`02-panels-sidebar.md` §3（`drawer-panel` / `drawer-close` /
  `drawer-tab-{key}` / `detail-pane` / `detail-view-toggle` / `detail-loading` /
  `detail-error` / `detail-empty` / `detail-binary` / `detail-content` / `detail-truncated` /
  `detail-tab-strip` / `detail-tab` / `detail-tab-close`）、§3「Drawer 详情」段的
  `bash-task-*` 家族（`packages/renderer/src/components/extension/BackgroundTaskDetailPanel.vue`）。
- 副作用点：detail tab 是**多文件 tab 条**（开序 + activePath）；重复点同一文件只激活
  不新增；>1MB 截断（`detail-truncated`）；二进制走 `detail-binary`。

### 驱动

1. 点 `drawer-toggle` → `expectVisible(testid=drawer-panel)`；
   默认 `drawer-tab-git` 为选中态（`aria-selected`）。
2. 遍历 tab：点 `drawer-tab-detail` / `-plan` / `-btw` / `-bashTask` → 对应内容根出现
   （`detail-pane` / `plan-docs-panel` / `drawer-btw-tab` / `bash-task-detail`）。
3. detail 多文件：文件树点 A → 点 B → `detail-tab` 数 = 2；再点 A → 仍 2，A 为 active
   （`data-active`）。
4. diff 切换：对有 git 改动的文件开 detail → `detail-view-toggle` 出现 → 切 diff →
   `detail-content` 变结构化 hunk（`@@ … @@`，不是 raw `diff --git`）。
5. 关闭：`drawer-close` → `drawer-panel` 消失；再开时恢复上次 tab（若实现如此，按实测）。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | A | `drawer-panel` 开合与 `drawer-toggle` 状态一致 | 开了但按钮 aria-pressed 未变 = 状态分叉 |
| 2 | A | `drawer-tab-<key>` 8 个键齐全（按实装） | 出现 `drawer-tab-terminal` = 旧实现复活（terminal 已迁） |
| 3 | A | detail 多文件：tab 数 = 打开的文件数，重复点不新增 | 每次点都新增 = 注入语义坏了 |
| 4 | A | 有 git 改动才出现 `detail-view-toggle` | 无改动也出现 = gitOverlay 判定错 |
| 5 | C | `detail-content` 文本 = 磁盘文件内容（前 200 行对照） | 内容不符 = 读错文件/缓存串台 |
| 6 | A | >1MB 文件 → `detail-truncated`，二进制 → `detail-binary` | 卡死/白屏 = 未走截断/二进制分支 |

### 证据（A/B/C 各抓什么）

- **A**：`drawer-git.png` / `drawer-detail-multitab.png` / `drawer-detail-diff.png`；
  DOM 抓 `detail-tab` 的 `data-path` 列表 + active 标记。
- **B**：`git.status` / `git.diff` reply（有改动场景）。
- **C**：被打开文件的 `head -200` + `stat` 大小（对照截断阈值）。

### 证不了

- **`subagent` / `trace` tab 的完整内容**：依赖 subagent record / trace 选中态；
  faux 下孙进程不可达（见 `capabilities/env.md` 与报告）→ 只验「tab 存在 + 空态」。
- **`doc` tab（命令/skill 文档）**：`CommandDocPanel` **无 testid**（`02-panels-sidebar.md` §3
  注），只能文本锚点 → `weak-anchor`。
- **git 面板的暂存/提交交互**：`GitPanel` 只有 `git-inject-file` 一个 testid
  （同上），提交链只能靠文本锚点 + C 通道 `git log` 反证。
- **btw tab 的完整线流程**：归 btw 设计（capability id 未在 v1 清单）。

### Gotchas

- 抽屉是**右抽屉**，terminal 在**底抽屉**——两者 testid 前缀完全不同
  （`drawer-*` vs `terminal-*` / `bottom-drawer`）。
- `drawer-pin` 已随 docked 死状态删除；不要找「钉住」按钮。
- detail 的 diff 视图是**结构化 hunk**（`@@`），不是 raw patch；断言 `diff --git` 文本会红
  （HISTORICAL：E2E-3b 因此退役）。
- 文件 >1MB 走截断、二进制走 `detail-binary`，两者都不会渲染正文；不要断言内容。

---

## workspace.search · 全局搜索浮层（⌘K）

- **通道**：A（`search-modal-root` 内分组/条目）/ B（`file.search` / `session.list` / `session.getCommands`）/ C（`localStorage` 的 recents）
- **前置**：`requires: none`；依赖 `session.create`（文件/会话源需要 session）
- **用于**：`p2-workspace-search`（covers: `workspace.search`, `workspace.filetree`, `session.list`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：`⌘K`（或侧栏搜索按钮，按钮 `title` = `搜索 · ⌘K`，**无 testid**）→ 浮层 →
  输入 → ↑↓/Tab/Enter → 跳转；Esc / 再按 ⌘K / 点遮罩关闭。
- 协议：四源编排（`docs/testing/02-panels-sidebar.md` §1）：
  命令（内存 `commandStore`）/ 文件（`file.search`，`{sessionId, showIgnored?}`）/
  会话（`session.list` 数据）/ 符号（占位 D-001）/ recents（`localStorage`）。
- testid（权威 = `02-panels-sidebar.md` §3，全部在 `packages/ui/src/overlays/SearchModal.vue`）：
  `search-modal-root` / `search-modal-overlay` / `search-input` / `search-loading`（>200ms 才显）/
  `search-section-<label>` / `search-item-<idx>` / `search-empty`。
- 副作用点：跳转成功 → 关浮层 + 写 recents；失败 → toast + 浮层保持打开（AC-6.7）。
  **recents 是 localStorage**（不是磁盘文件）。

### 驱动

1. `press('Meta+k')`（Linux/Windows 用 `Control+k`）→ `expectVisible(testid=search-modal-root)`。
2. 空查询：应出现 recents/建议命令分组（首用可能为空 → `search-empty`，两种文案不同）。
3. 输入文件关键词 → 等 `search-section-文件` 出现 → `search-item-<idx>` 可见；断言
   高亮 `<mark>` 段存在（`segments` 命中）。
4. Enter → 浮层关闭 + 目标动作发生（命令执行 / 文件预览 `detail-pane` / 会话切换）。
5. 失败跳转：输入一个能命中但目标已失效的会话（先删会话再搜）→ 应 toast + 浮层保持。
6. Esc → 关闭；再按 ⌘K → 重开（幂等）。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | A | ⌘K 后 `search-modal-root` 可见且 `search-input` 聚焦 | 不出现 = 快捷键被别的表面吞了（栈序） |
| 2 | A | 输入后有 `search-section-<label>` 分组，条目带 `<mark>` | 只有 `search-empty` = 源无数据/请求失败 |
| 3 | A | 查询 >200ms 时出现 `search-loading`（防闪烁契约） | 一直 loading = 源超时/WS 未连 |
| 4 | A | Enter 后浮层关闭（成功）或保持打开 + toast（失败） | 关闭但无动作 = 跳转分发丢了 |
| 5 | B | `file.search` reply 的 `files[]` 与浮层文件分组条目对应 | 条目凭空出现 = 前端 mock 数据 |
| 6 | C | recents 写入 `localStorage`（跳转成功后） | 未写 = recents 通道断（下次空查询无历史） |

### 证据（A/B/C 各抓什么）

- **A**：`search-empty-query.png`、`search-file-hits.png`、`search-loading.png`。
- **B**：`file.search` reply（仅文件路径前 20 条）。
- **C**：`localStorage.getItem(<recents key>)`（键名以 `useRecents` 源码为准；
  出处 `packages/core/src/domain/new-task-search/recents.ts`）。

### 证不了

- **符号搜索**：`D-001` 明确是占位（`符号` 分组不产真实结果）→ 只验分组占位/空。
- **⌘K 与其它 ⌘ 键的冲突矩阵**：归键盘栈序单测（`key-orchestrator`）。
- **跨项目（无 session）搜索**：`file.search` 需要 `sessionId`；landing 态只能搜命令/recents。
- **recents 的 FIFO 上限/淘汰**：需构造多次跳转；未验。

### Gotchas

- 浮层经 reka Dialog **portal 到 `<body>`**，查询不要限定在 Sidebar 容器。
- run 在 Linux/CI 上 `Meta` 不生效，用 `Control`；本层真机是 macOS dev 实例。
- `search-loading` 只在查询 >200ms 出现（防闪烁），快源下**永远看不到**——不要等它。
- 侧栏搜索按钮无 testid，只有 `title` 文案；文案会随 i18n 变。
- 跳转失败时浮层**保持打开**是契约（AC-6.7），别把「没关」判成 bug。

---

## workspace.terminal · 底抽屉终端（多实例 / 实例级生命周期 / 世代恢复）

- **通道**：A（`bottom-drawer` / `terminal-instance-bar` / `terminal-view`）/ B（`terminal.spawn` / `write` / `resize` / `kill` / `attach` / `list` + `terminal.data/exit/alive`）/ C（PTY 子进程、`<dataDir>/run/*` 无终端持久化）
- **前置**：`requires: none`；依赖 `session.create`（终端按 session 分区）
- **用于**：`p2-workspace-terminal`（covers: `workspace.terminal`, `session.switch`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV（**双入口 + 收起态**）：
  1. 顶栏终端按钮 `terminal-toggle-button`（`PanelHeader.vue` 右簇）；
  2. 键盘 `⌃\``（主进程 `before-input-event` → `shortcut type='toggle-bottom-drawer'` →
     `handleToggleBottomDrawerShortcut`，出处
     `packages/renderer/src/composables/features/app/key-orchestrator/orchestrator.ts`）；
  3. 实例条右簇「收起」`terminal-collapse`（收起 ≠ 销毁，实例保留）。
- 结构：
  - `bottom-drawer`（壳，高度百分比，拖动 `bottom-drawer-resize-handle`）→
    `TerminalView`（`terminal-view`）；
  - 头部实例条 `terminal-instance-bar`：实例 tab `terminal-instance-item`（`data-alive` 透传）、
    关闭叉 `terminal-instance-close`（最后实例关闭禁用）、新建 `terminal-instance-create`、
    空态 `terminal-instance-empty`；
  - 终端本体 `terminal-xterm`（xterm 容器，`data-find-skip`）；spawn 失败 `terminal-spawn-error` +
    `terminal-spawn-retry`；「发送到 AI」`terminal-send-to-ai`。
- 实例模型（出处 `packages/renderer/src/composables/features/terminal/useTerminal.ts` 文件头）：
  - 主键 = `term:<sid>:<序号>`（`@taiji/shared` 的 terminal-id 单点）；
  - 三层生命周期：PTY（runtime，跟随实例）/ buffer 分区 + 广播订阅（renderer **模块级**，
    切 tab 不销毁）/ xterm（跟随可见性 + 当前实例）；
  - `terminal.list` **对账**三触发点：⌘R、会话激活、**世代变更重连**；
  - 世代判据 = `getCurrentToken()`（WS auth token 变化 = runtime 重生）→ 世代变更时
    `resetTerminalDomain()` 后按 `terminal.list` 重建（**新 runtime 清单为空 → 空态/新建
    `term:<sid>:1`**）；
  - 关闭沿 / 会话销毁 / 世代变更三路径解订阅。

### 驱动

两步：① **先读 real 轨 e2e 的覆盖表**（下）避免重复；② **再做真机增量**（刷新世代恢复、
双入口等价、收起 vs 关闭、多实例隔离）。

#### e2e 已覆盖什么（`e2e/terminal-multi-instance.spec.ts`，real 轨）

| 用例 | 覆盖点 |
|------|--------|
| `T1` | 双终端并行：⌃` / StatusBar 开底部抽屉 → 终端 1 → 「+」→ 两实例各自输出独立、切换历史在屏、**隐藏期输出切回回放** |
| `T2` | 关闭隔离：关第二实例 → 条目回 1、关闭按钮回禁用、**PTY shell 进程消失**、焦点落相邻实例、实例 1 仍可写 |
| `T4` | 会话级联：删会话 → runtime 实例清单空 + PTY 进程消失（无孤儿） |
| `T8` | 关最后一个再新建：序号**不复用**（终端 3），输出区空白 |
| `T9` | 最后实例自然退出（`exit`）：空态 + 「+」可用，新建得序号 2（不回落 1） |
| `T10` | runtime 重启边界：杀 runtime → 重生（token 变）→ 世代重置为 `term:<sid>:1`，回显正常、无串入 |
| `T13` | 跨会话不误清：A 双实例 → 切 B 对账 → 切回 A，条目/分区/历史保持 |

**明确未覆盖（spec 头注声明）**：`T3` 刷新恢复 / `T5` 单实例无感 → **L4 真机走查**
（本 capability 补）；`T6/T7/T11/T12` → L1 单测。

#### 真机验收补什么（本 capability 的增量）

1. **刷新世代恢复（T3，e2e 未覆盖）**：实例跑 `echo $$` 记住 PID → 刷新窗口（`⌘R`）→
   断言实例条仍在、`terminal.list` 对账拉回、历史输出回放、**PID 未变**（PTY 未重启）。
   → C 通道：`lsof`/`ps` 找该 shell PID。
2. **两个入口等价**：⌃` 与 `terminal-toggle-button` 各开关一次，`bottom-drawer` 的
   `height` 与 `data-find-surface` 状态一致。
3. **收起语义**：`terminal-collapse` → 抽屉高度 0 但实例条目仍在（再开可见）；
   对照「关闭叉」= 真正 kill PTY（`terminal-instance-close` 后 PID 消失）。
4. **多窗口/多实例隔离**：本 worktree 只一个实例；若同 worktree 已有他人实例，
   端口段不同 → 数据目录不同 → 终端互不可见（用 `doctor` 的 CDP 归属核对）。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | A | `bottom-drawer` 高度 >0 且 `terminal-view` 可见 | 高度 0 但有实例 = 收起态（不是失败） |
| 2 | A | `terminal-instance-item` 数 = `terminal.list` 的实例数 | 数不等 = 对账未跑/分区串台 |
| 3 | A | 刷新后实例序号仍为原序号（不重置为 1） | 重置为 1 = 世代判据误判（token 未变却重置） |
| 4 | C | 刷新前后 shell PID 不变（T3） | PID 变 = 刷新把 PTY 重启了（buffer 恢复语义坏） |
| 5 | C | 关闭实例后该 PID 消失（`ps -p` 空） | 进程仍在 = 关闭沿泄漏（孤儿） |
| 6 | B | 世代变更后 `terminal.list` 为空（新 runtime 无实例）→ 自动新建 1 条 | 保留旧序号 = 世代重置未做 |

> 1/2/3 是 A，4/5/6 是 C/B。**终端是多实例 + 进程级资源**：任何「关闭/删除」断言都必须
> 落到进程（PID）层面，否则看不见泄漏。

### 证据（A/B/C 各抓什么）

- **A**：`terminal-two-instances.png` / `terminal-collapsed.png` / `terminal-empty.png`；
  DOM 抓 `terminal-instance-item` 的序号文本 + `data-alive`。
- **B**：`terminal.list` reply 前后对照；`terminal.ack` / `terminal.exit` 帧。
- **C**：`lsof -ti :<vitePort>`（收尾）；`ps -o pid,ppid,command -p <pid>` 的 shell 进程；
  `pgrep -P <runtime pid>` 看 PTY 子树。**注意**：终端实例**不落盘**（无持久化文件），
  所以「刷新恢复」只能靠进程存活 + 协议对账证明。

### 证不了

- **刷新恢复（T3）的自动化**：需要触发 renderer reload 并保留 runtime；
  CDP `page.reload()` 可行但会打断当前 CDP 会话（需要重连）→ 真机可做，脚本要处理重连。
  当前登记为「手工 L4 走查项」，脚本化待补。
- **「同世代闪断」（T11）/「非世代广播沿」（T12）**：属单测覆盖的时序细节，
  真机难以稳定构造。
- **终端内容的富文本/ANSI 颜色正确性**：xterm 画布内部渲染，DOM 断言只能到容器级。
- **多实例并发写入的字节级顺序**：`terminal-write-queue` 单测覆盖。

### Gotchas

- **终端不在右抽屉**：不要找 `drawer-tab-terminal`（已退役）。
- 收起（`terminal-collapse`）≠ 关闭（`terminal-instance-close`）：前者保留实例/PTY，
  后者 kill。断言进程存活时搞错会得出相反结论。
- 序号**永不复用**：关掉 2 再新建得 3；刷新/世代变更才回到 1。写「新建后是 2」的断言会红。
- 实例条最后一条的关闭叉是**禁用**态（UI 供养规则），不是隐藏。
- `⌃\`` 走主进程 `before-input-event`；用 CDP `page.keyboard.press('Control+Backquote')`
  不一定能触发（主进程层拦截），更稳的是点 `terminal-toggle-button`。
- 世代判据是 **auth token**（不是 runtime PID）；杀 runtime 后 supervisor 重生会换 token
  → 这是 T10 的可观测信号。

---

## workspace.import · 导入外部会话（pi / zcode 源）

- **通道**：A（`import-session-dialog` 两阶段）/ B（`session.importCandidates` / `session.import`）/ C（目标 session 目录新增 jsonl、去重标记、源库只读）
- **前置**：`requires: none`；pi 源需要一个可读的外部 pi session 目录；zcode 源需要 allowlist 内的 db
- **用于**：`p2-workspace-import`（covers: `workspace.import`, `session.list`）

### 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：侧栏「导入会话」按钮 `sidebar-import-session-btn` → 阶段一来源选择
  `import-source-picker` + `import-source-option-<kind>` → 阶段二候选列表
  （`import-session-dialog` / `import-back-btn` / `import-search-input` / `import-dir-chip` /
  `import-dir-menu` / `import-dir-option` / `import-choose-dir-btn` / `import-root-dir` /
  `import-count` / `import-path-bar` / `import-path-meta` / `import-path-import-btn` /
  `import-loading` / `import-load-error` / `import-retry-btn` / `import-empty` / `import-group` /
  `import-item` / `import-item-imported` / `import-item-import-btn` / `import-item-cwd-missing` /
  `import-error` / `import-project-select` / `import-cancel-btn` / `import-confirm-btn`）
  （出处：`packages/renderer/src/components/sidebar/ImportSessionDialog.vue` +
  `ImportSourcePicker.vue`，grep `data-testid`）。
- 协议（出处 `packages/shared/src/protocol.ts`）：
  - `session.importCandidates`（`ImportCandidatesRequest{ source?, dbPath?, ... }`）→
    `ImportCandidatesReply`；
  - `session.import`（`ImportRequest{ source?, sessionId?, dbPath?, projectId?, ... }`）→
    `ImportReply`（含 `warning: 'conversion_degraded'` 的知情降级通道）。
- 分层（**必读**：`docs/architecture/session-import-sources.md`）：`ImportService` 公共编排
  （原子落盘 / 去重 / sidecar / 广播），源特有知识在 `import-<source>/` SPI 实现；
  **新增源 = 新增 source 模块 + 注册一行 + GUI 加一个选项卡**，编排层不动。
  当前源：`pi`（缺省）/ `zcode`。
- 安全边界：`dbPath` 经 wire 只接受 `zcodeImportDbAllowlist(dataDir)` 集合，
  集合外 → error `import_db_path_forbidden`（见同文档 §「RPC 契约」）。

### 驱动

1. `sidebar-import-session-btn` → `import-source-picker` 可见。
2. 选 `import-source-option-pi` → 阶段二：`import-loading` → 候选列表或 `import-empty`。
3. 用 `import-dir-chip` 切换扫描目录（`import-dir-option`），或用 `import-choose-dir-btn`
   （**OS 原生对话框 → 不可 CDP 驱动**，见「证不了」）。
4. 搜 `import-search-input`（名称 / session ID / 短 ID / 绝对路径；`/` 或 `~` 开头切路径模式）。
5. 选一个候选 → `import-project-select`（目标项目）→ `import-confirm-btn`。
6. 断言：`import-item-imported` 标记出现 / 对话框关闭 → 侧栏会话列表新增该会话
   （`session.list` 刷新）→ 打开它能看到历史消息。

### 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | A | 阶段一只有合法来源项；阶段二候选按 `import-group` 分组 | 阶段一空 = source 表未注册 |
| 2 | B | `session.importCandidates` reply 的候选数与 `import-count` 一致 | 数不等 = 过滤/分页不一致 |
| 3 | B | `session.import` reply 成功（或 `warning` ∈ `conversion_degraded`/`conversion_unclassified`/`sidecar_failed`） | error envelope 的 `code`（`import_*` 家族） |
| 4 | C | 目标 session 目录出现新 jsonl（`<dataDir>/agent/sessions/<encodeCwd>/`），内容 = 源会话消息 | 无文件 = 落盘失败（copy_failed） |
| 5 | C | 重复导入同一条目 → error `import_already_imported`（去重标记在源侧/sidecar） | 重复落成两份 = 去重失效 |
| 6 | A | `import-item-cwd-missing` 的条目不可导入（或要求选 cwd） | 导入成功但 cwd 不存在 = 会话打开即崩 |

> 2/3 是 B，1/6 是 A，4/5 是 C。**重复导入与 cwd 缺失是最高价值的两条**（真机常见）。

### 证据（A/B/C 各抓什么）

- **A**：`import-source-picker.png`、`import-candidates.png`、`import-done.png`。
- **B**：`session.importCandidates` reply（候选 id 列表）+ `session.import` reply 全文。
- **C**：导入前后 `ls <dataDir>/agent/sessions/<encodeCwd>/` 对照；新 jsonl 的头 5 行；
  源库/源文件的 `stat`（证明只读，未被改写）。

### 证不了

- **`import-choose-dir-btn`（OS 原生目录选择）**：Electron `dialog.showOpenDialog` 不可
  CDP 驱动 → `verified-unreachable`。替代：用 `import-dir-chip` 里已有的最近工作区项，
  或预置 `recent-workspaces.json`。
- **zcode 源的全链**：需要真实 zcode 会话库（sqlite）在 allowlist 路径内；
  仓内 fixture 只在单测（`mkdtempSync` 自建库）→ 真机 `verified-unreachable`
  （前置 = 一份 zcode 用户库，且不得触碰真实宿主库）。
- **转换语义正确性**（zcode 的可见性判据：`semantics/visibility/source/synthetic`）：
  设计文档 §6.1 有闭集与策略，但逐条真机断言需要源数据样本；当前只验「导入成功 + 条数合理」。
- **超大 session 导入**：未验。

### Gotchas

- **禁止触碰真实宿主 zcode 库**（测试防线纪律）：fixture 必须 `mkdtempSync` 自建；
  真机验收也只能用副本。
- 阶段一/阶段二是**同一个 Dialog 的两种 phase**；`import-back-btn` 回阶段一但候选数据保留。
- `import-search-input` 以 `/` 或 `~` 开头会切「路径模式」（`import-path-bar`），
  不是普通关键词——脚本里别用 `/` 开头的关键词。
- 去重判据按源不同（pi 源看 marker 文件名 / 已导入集合），错误码
  `import_already_imported` 属**拒绝**语义（不是故障），恢复指引见对话框内联文案。
- 导入完成后的会话在侧栏出现，但**不会自动激活**（需点击）；别等自动切会话。

---

## ui.container · 展示容器体系（右抽屉 / 底抽屉 / 浮层壳 + 键盘栈序）

- **通道**：A（各容器的开合 testid + 内容可见性）/ B（`OverlayControlState` 与 `session.traceEntries` 等载荷源）/ C（容器态不落盘——**这是本原语的最大限制**）
- **前置**：`requires: none`；依赖 `env.ready`
- **用于**：覆盖矩阵 P0 行「展示容器体系」；被 `workspace.drawer` / `workspace.terminal` / `workflow.overlay` 共用

## 入口（用户 POV / 协议 / 副作用点）

- 用户 POV：
  - 右抽屉：顶栏 `drawer-toggle`（默认打开 git tab）→ 切 tab / 点 `drawer-close` 关闭；宽度可拖 `drawer-resize-handle`。
  - 底抽屉：`` ⌃` `` 或顶栏终端按钮（`terminal-toggle-button`）→ 全宽，横跨右抽屉下方。
  - 浮层壳：消息里点 localhost 链接（→ 浏览器浮层）、打开 workflow run（→ 可视化 overlay）、画布 / 调度器同壳。
  - 键盘栈序：`Esc` 逐层让位（后开的先关）。
- 协议：浮层状态在 `packages/core/src/domain/overlay/state.ts`（`overlayControl`，**纯渲染侧内存，无 RPC**）；右抽屉 tab 态在 `packages/core/src/domain/drawer`。
- 副作用点：**无磁盘副作用**——容器态是会话期内存（这正是「证不了」的根源）。

## 驱动

```bash
PW="node ~/.agents/skills/browser-automation/scripts/pw.js http://localhost:<cdpPort>"

# 右抽屉
$PW click "testid=drawer-toggle"
$PW wait "testid=drawer-panel"
$PW click "testid=drawer-tab-plan"
$PW click "testid=drawer-close"
$PW wait "testid=drawer-panel" hidden

# 底抽屉（注意：⌃` 走主进程 before-input-event，CDP 键盘事件不一定能触发 → 优先点按钮）
$PW click "testid=terminal-toggle-button"
$PW wait "testid=bottom-drawer"

# 浮层壳（workflow 场景）
$PW click "testid=wfvz-overlay"   # 实际入口经托盘 tab → 行 → 详情
```

## 断言（期望终态 / 失败信号）

- 期望终态：
  - 右抽屉：`drawer-panel` 可见 + `drawer-tab-<key>` 的 active 态与内容面板同时在场；
  - 底抽屉：`bottom-drawer` 高度从 0 变为 `displayPct%`（默认 35%），含 `TerminalView`；
  - 浮层壳：`wfvz-overlay` / 浏览器浮层根可见，且**同一时刻只有一个内容**（单例换内容：开新内容不闪断）；
  - Esc 层级序：后开的面先关，先开的面仍在。
- 失败信号：
  - 开 A 关 B / 两个浮层同时在场 → 单例换内容语义破坏；
  - Esc 一次全关 → 层级序失效（编排器未按栈序让位）；
  - 抽屉开着但内容面板空 → `v-if` 链与 `RightDrawerTab` 漂移（这是 2026-10-19 workflow tab 删除后的高风险区）。

## 证据（A/B/C 各抓什么）

- **A（主）**：每一步的截图 + 关键 testid 的可见性/DOM 断言输出（`drawer-panel` / `drawer-tab-*` / `bottom-drawer` / 浮层根）。
- **B**：浮层内容的载荷源（如 workflow run 的 `session.getWorkflowRunEvents`）确实存在——证明「浮层不是空壳」。
- **C**：**无法取证**（容器态不落盘）。这是本原语的诚实边界：容器的「关闭后重开是否恢复」只能靠 A 通道 + 会话内状态对照。

## 证不了

- 容器态**跨重启持久性**（内存态，重启必回默认）——若产品声称持久化，需另立 capability。
- Esc 栈序的**内部排序依据**（z 值 / 注册顺序）：只能验可观察的关闭顺序，不能验实现机制。
- 模态共存的几何判定（`shieldsView` / view 遮蔽）：那是 main 侧 display-gate 的事，属 `shell` 层，不在本原语。

## Gotchas

- **`⌃\`` 快捷键走主进程 `before-input-event`**：CDP 注入的键盘事件不一定触发 → 验证底抽屉优先点 `terminal-toggle-button`。
- **`workflow` tab 已删（2026-10-19）**：`RightDrawerTab` 现行 = `git/doc/detail/subagent/bashTask/plan/btw/trace`；`docs/testing/02` 与 `FEATURE-PRIORITIES §2` 仍写「drawer WorkflowTab 回落载体」= **文档漂移**，overlay 不可用时回落是 toast。
- **浮层是单例换内容**（`openOverlay` 开新内容时 `isOpen` 保持 true、只换 `current`）——断言「先关后开」会失败，正确断言是「内容变了、壳没闪」。
- **模态表面登记表**（`modal-surface-registry/manifest.ts`）是 z 基线 + Esc 让位旗标的单一事实源：新增表面不登记会被 `z-surface-baseline.test.ts` 拦（那是单测轨，本技能只做真机侧佐证）。
- 右抽屉的 `git` 数据由 `PanelContainer` provide；非 git 仓库时 `GitPanel` 自隐藏（走空态），不要断言「git tab 必有内容」。
