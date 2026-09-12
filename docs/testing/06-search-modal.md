# 06 · 搜索浮层测试流程

> 覆盖：⌘K 全局搜索浮层（SearchModal）—— 唤起 / 空查询 recents / 四类分组查询 / 键盘导航 / Tab 切类 / 选中跳转 / loading·error 态 / WS 超时容错
>
> 先读 [00-test-strategy-overview.md](./00-test-strategy-overview.md) 理解双轨制和公共前置。
>
> **迁移说明（2026-09-11）**：本功能实现已迁至 `packages/core/src/domain/new-task-search/`，浮层组件为 `packages/ui/src/overlays/SearchModal.vue`。renderer 侧同名 composable（`useSearch` / `useSearchJump` / `useRecents` / `useCommandRegistry`）是迁移后的历史死代码，已于 2026-09-11 随 renderer 过度设计清理删除。本文档中的实现路径与测试路径均按迁移后的 core/ui 位置书写；行为场景（唤起 / 空查询 recents / 四类分组 / 键盘导航 / Tab 切类 / 选中跳转 / loading·error / WS 超时）与设计约束不变。

## 1. 功能概述

SearchModal 是 ⌘K 唤起的跨项目全局搜索浮层，四类分组（命令/文件/符号/会话）：

```
⌘K 唤起 → 空查询显 recents（localStorage）+ 建议命令
输入查询（debounce 120ms）→ useSearch 编排 4 源（命令内存/file WS/session WS/recents）
  → matchFilter 子串过滤 → 四类分组渲染（符号占位 D-001）
↑↓ 键盘导航 / Tab 切类（P2）/ Enter 选中 → useSearchJump 跳转（命令执行/文件预览/会话切换）
跳转成功关浮层 + 写 recents；失败 toast + 浮层保持打开（AC-6.7）
Esc / 再按⌘K / 点遮罩关闭
```

**架构分层**（D-026：编排归 composable，非 domain；2026-09-11 起实现在 core `new-task-search` 域）：
- `packages/core/src/domain/new-task-search/match-engine.ts`（纯函数：matchFilter 过滤 + segments 高亮）
- `packages/core/src/domain/new-task-search/search.ts`（`useSearch`：编排 4 源 + loadSeq 守卫 + WS 超时 race #17）
- `packages/core/src/domain/new-task-search/search-jump.ts`（`useSearchJump`：跳转 type switch 分发）
- `packages/core/src/domain/new-task-search/recents.ts`（`useRecents`：localStorage + FIFO）
- `packages/core/src/domain/new-task-search/command-registry.ts` + `command-store.ts`（`useCommandRegistry` 应用命令 + slash 聚合 / pendingSlash 通道）
- `packages/ui/src/overlays/SearchModal.vue`（UI 交互 + 键盘导航 + 渲染；SearchDeps 端口注入，壳组装在 `packages/renderer/src/composables/features/search/useSearchModalDeps.ts`）

## 2. 组件结构概述

`SearchModal.vue`（`packages/ui/src/overlays/`，容器 `data-testid="search-modal-root"`，reka-ui Dialog portal 到 body）分输入区与结果区。输入区为 `search-input`（v-model=query + keydown 导航）；结果区按状态切换：loading 态（`search-loading`，查询 >200ms 才显示，AC-8.1 防闪烁）、分组渲染（`search-section-{label}` 内 `search-item-{idx}`，item 带 role=option + aria-selected，含类型图标、title + `<mark>` 高亮（segments 命中段）、sub 副文本、Clock 图标仅空查询 recents 项）、空态（`search-empty`，分「recents 库空」与「查询无结果」两种文案）。

## 3. data-testid 清单

testid 以组件 template 内 data-testid 属性为准（均在 `packages/ui/src/overlays/SearchModal.vue`，已核实有效）。

| testid | 触发/可见条件 |
|--------|--------------|
| `search-modal-root` | 恒显（open=true 时，Dialog portal 到 body） |
| `search-modal-overlay` | 恒显（遮罩层） |
| `search-input` | open=true 时（Dialog 默认聚焦） |
| `search-loading` | 查询耗时 >200ms 时（AC-8.1 防闪烁） |
| `search-section-{label}` | 分组渲染时（label=命令/文件/符号/会话/最近/建议命令） |
| `search-item-{idx}` | 分组项渲染时（idx=跨组扁平序号） |
| `search-empty` | total=0 时（recents 库空 或 查询无结果） |

> **Portal 注意**：reka-ui Dialog 通过 `DialogPortal` teleport 到 `<body>`，脱离 Sidebar 的 stacking context。E2E/集成测试查询不要限定在 Sidebar 容器内，用 `document.body.querySelector` 或 `new DOMWrapper(document.body)`（参考 [00 §6.4](./00-test-strategy-overview.md)）。

## 4. 调用链

### 唤起 + 空查询（功能1）
```
Sidebar keydown ⌘K → searchOpen toggle（AC-7.1）
  → SearchModal watch(open=true) → loadResults('') → useSearch.query('', ctx)
    → useRecents.read()（localStorage 'xyz-agent:search-recents'）
    → useCommandRegistry.list()（应用命令 + slash）
    → 返回 [最近, 建议命令] 分组
  → 渲染 segments(title, '')（空查询不高亮，Clock 图标标 recents）
```

### 查询四类分组（功能2，核心编排）
```
Input 输入 → watch(query) debounce 120ms（AC-7.15）→ loadResults(q)
  → useSearch.query(q, ctx)
    → seq = ++loadSeq（BC-9 守卫）
    → Promise.allSettled([
        queryCommandSource(),          // 内存：useCommandRegistry.list()
        queryFileSource(sid),          // WS：缓存优先，未命中 composer.getFileCandidates + #17 超时 race
        querySessionSource(),          // WS：session.list + #17 超时 race
      ])
    → seq !== loadSeq → 丢弃旧响应（BC-9）
    → matchFilter(合并候选, q) → groupByType（符号占位 D-001）
  → 渲染 segments(title, q)（命中段 <mark> 高亮）
```

### 选中跳转（功能3）
```
Enter / click → confirmSel → useSearchJump.confirm(item, ctx)
  → type switch:
      command → AppCommand.action() 或 injectSlash（slash 注入 composer）
      file → fileApi.read（AC-6.9 直调不经吞错层）→ 成功后 fileTreeStore.selectFile 触发 useDetailPane watch
      session → sessionApi.list 反查 id → useSidebar.selectSession
      symbol → 占位不跳转（D-001）
  → 成功：{ok:true} → 关浮层 + useRecents.write
  → 失败：{ok:false} → toast + 浮层保持打开（AC-6.7）
```

### 生命周期 + 并发守卫（功能4）
```
watch(open=false) → 清 query/selIdx/errorMsg + clearTimeout(debounce/loading)（AC-7.14, MR-7.1 孤儿查询守卫）
close 触发 query='' → watch(query) debounce → loadResults，但 open flag 已 false → 实际不发 WS（useSearch 内 loadSeq 守卫 + SearchModal 已卸载）
组件卸载 → onUnmounted clearTimeout（AC-8.4）
```

## 5. MOCK 模式测试（vitest 集成）

**运行命令**（分包运行，cwd 敏感）：
```bash
cd packages/ui && npx vitest run src/overlays/__tests__/search-modal.test.ts   # 浮层集成（mount SearchModal，mock SearchDeps）
cd packages/core && npx vitest run src/domain/new-task-search/__tests__        # 搜索域单测（search/search-jump/recents/command-registry/command-store/file-match/match-engine）
cd packages/renderer && npx vitest run src/__tests__/lib/match-engine.test.ts  # renderer 侧仍保留：core 纯函数导出契约（import from @xyz-agent/core）
```

### 测试矩阵（47 条，对应 execution-plan 验收清单）

**单元测试（composable/lib/store，mock 依赖）**：

| 用例 | 文件 | 测试执行层 | 覆盖点 |
|------|------|----------|--------|
| T1.8/T1.9/T1.16/T1.17/T1.18 | `packages/core/src/domain/new-task-search/__tests__/recents.test.ts`（8 测）| unit | recents 空库/持久化/脏数据降级/配额满/FIFO |
| T2.4/T2.5 | `packages/core/src/domain/new-task-search/__tests__/command-registry.test.ts`（4 测）+ `command-store.test.ts`（8 测）| unit | 命令注册表聚合/物理隔离/同名不撞/无 session |
| AC-1.1~1.4 | `packages/core/src/domain/new-task-search/__tests__/match-engine.test.ts`（10 测）| unit | matchFilter/segments 纯函数 + 边界 |
| T1.10/T1.12/T2.1/T3.1~3.5/T3.9/T4.1/T4.2/T4.4~4.9/T5.1/T5.2 | `packages/core/src/domain/new-task-search/__tests__/search.test.ts`（16 测）| unit | 编排/loadSeq/缓存/WS 超时 race/DTO 映射 |
| T2.2/T2.3/T2.6/T2.7/T3.4/T3.6/T4.3/T4.6/T4.7/T5.3 | `packages/core/src/domain/new-task-search/__tests__/search-jump.test.ts`（13 测）| unit | 跳转分发/异常恢复/AC-6.9 直调 |

**集成测试（mount SearchModal，mock composable，查 document.body）**：

| 用例 | 文件 | 覆盖点 |
|------|------|--------|
| T1.15 | `packages/ui/src/overlays/__tests__/search-modal.test.ts`（25 测）| 首屏冒烟（渲染 gate DoD）|
| T1.1/T1.2/T1.3/T1.4 | | 唤起/空查询/↑↓导航/选中态 |
| T1.6/T1.7/T1.11 | | 关闭/mark 高亮/未找到 |
| T1.13/T1.14/T3.7/T3.8/T5.4 | | open/close 竞态/孤儿守卫/loading 防闪烁/容错 |
| T1.5 | | Tab 切类（AC-9.1~9.4，P2）|

**live 等价覆盖合计 84 测**（8 + 12 + 10 + 16 + 13 + 25）；原 execution-plan 基线 86 测为迁移前 renderer 口径，已随实现迁移失效。**口径注**：84 仅合计上表矩阵映射的文件；搜索域另有 `file-match.test.ts`（12 测，TC-9 系列，见 TEST-STRATEGY 基线行）与 renderer 侧 `__tests__/lib/match-engine.test.ts`（15 测，core 纯函数导出契约测试，见上方运行命令）不在本合计内。

> 测数为 2026-09-11 各 live 文件实测 `it()` 计数（`packages/core/test-results/vitest-junit.xml` / `packages/ui` vitest 输出）。用例 ID（T#/AC-#）沿用 2026-06-30 execution-plan 编号作为验收追溯锚点；迁移后 core 侧按 `TC-#` 组织，ID 与 TC 编号的逐条映射未重建。

### 关键测试桩（高风险用例）

- **T4.8 WS 断连超时 race**：mock `composer.getFileCandidates` 返回 `new Promise(()=>{})`（永不 settle，模拟 WS 断连 pending），`vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(10001)` 推进 10s → withWsTimeout 触发 reject → allSettled settle → 不永久挂死。**禁止用立即 reject mock**（掩盖永不 settle 路径）
- **T1.12 loadSeq 守卫**：第一次 query 慢（永不 resolve），第二次快速 query → 第一次旧结果不覆盖
- **T3.9 stale cache**：断言 useSearch 初始化时 `useFileSearch().setupInvalidation` 被调用（AC-4.10 自绑失效）
- **T3.7/T3.8 loading 防闪烁**：fake timers 控制查询延迟 >200ms / <200ms

### 三视角覆盖核验

| 视角 | 覆盖 | 用例 |
|------|------|------|
| 构建者（白盒）| composable 单测验 API 契约/状态机 | useSearch/useSearchJump/useRecents 全部 |
| 使用者（黑盒）| mount SearchModal 验用户旅程 DOM | search-modal 集成测（T1.1~T1.15）|
| 观察者（形态）| 首屏冒烟 + 渲染断言 | T1.15（search-modal-root/input 存在）|

## 6. 非 MOCK 模式测试（手工冒烟）

> **铁律**：MOCK 轨测试全绿 ≠ 功能可用。search 改了 SearchModal + 新增 5 个 composable/lib/store，必须手工 `pnpm run dev` 确认模块加载健康（[00 §1.3](./00-test-strategy-overview.md) dev 冒烟闸门）。

```bash
pnpm dev    # 非 MOCK 轨，起 runtime + pi
```

手工冒烟清单（dev 启动后）：
1. ⌘K 唤起浮层 → 输入框聚焦，显 recents（首次为空显引导文案）
2. 输入查询（如 'session'）→ 显四类分组，命中段高亮
3. ↑↓ 键盘导航 → 选中态转移
4. Enter 选中文件 → DetailPane 打开预览（验证 fileApi.read + selectFile 接线）
5. Enter 选中会话 → active session 切换（验证 sessionApi.list 反查 + selectSession）
6. Esc 关闭 → 浮层消失
7. 再按 ⌘K → toggle 关闭（AC-7.1 变更项）
8. **模块加载健康**：dev console 无 `node:path.relative` 类错误（test-strategy §1.1 MOCK 盲区）

## 7. Playwright E2E

**当前状态**：已落地 [`e2e/search-modal.spec.ts`](../../e2e/search-modal.spec.ts)（覆盖 ⌘K 唤起 / 空查询 recents / 四类分组 / 键盘导航 / slash 注入等，以 spec 实际内容为准）。

**E2E 价值**（test-strategy 双轨制要求）：验证「⌘K 唤起 → 输入 → 选中 → 跳转」全链路用户旅程，覆盖 composable 间接线完整性（useSearch→useSearchJump→useSidebar/selectFile）。

实现要点：search 是浮层（portal 到 body），查询不限定 Sidebar 容器；跳转验证依赖 DetailPane/DrawerPanel 的 testid（见 [05-side-drawer.md](./05-side-drawer.md)）。

## 8. 已知缺口（非阻断）

| 缺口 | 影响 | 缓解 | 优先级 |
|------|------|------|--------|
| `registerApp` 无调用方 | 应用命令区运行时为空，搜索「命令」分组只显 slash 命令 | 测试用 mock 覆盖；功能不崩溃；slash 命令源工作 | P3（需产品决策命令清单）|
| AC-10.1 未完全通用化 | Sidebar keydown 用本地 keymap 数组（未走 useCommandRegistry）| 硬编码 if/else 字面消除；⌘K toggle 已落地 | P3（需独立 keymap 注册表 + shortcut DSL）|
| dev 冒烟闸门待建 | MOCK 全绿≠可用（模块加载盲区）| 手工 `pnpm run dev` 冒烟（见 §6）| 待 scripts/dev-smoke.mjs |
| useSearch 单测 onScopeDispose warn | 测试输出不干净（harness 缺陷）| 生产无 warn（SearchModal setup 提供 scope）；测试全绿 | 低（测试 harness 优化）|

## 9. 设计文档溯源

- 完整设计：`.xyz-harness/2026-06-30-search-modal/`（6 阶段：requirements→architecture→issues→nfr→code-arch→execution）
- 执行计划：`.xyz-harness/2026-06-30-search-modal/execution-plan.md`（5 Wave + 47 条验收清单）
- 决策账本：`.xyz-harness/2026-06-30-search-modal/decisions.md`（D-001~D-027）
