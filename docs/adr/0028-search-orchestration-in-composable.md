# ADR-0028: 搜索编排归 composable 层（非 domain）

- 状态：Accepted

> **性质**：架构 D-不可逆决策（分层归位）。本文档定义架构约束。
> **关联**：[ADR-0009 数据目录隔离](0009-xyz-agent-data-dir-isolation-from-pi.md)、约束登记 C-state-04（docs/constraints.json）「跨 store 编排在 composable 层」。
> **溯源**：`[from: 2026-06-30-search-modal §code-arch, decisions D-026]`

## 上下文

⌘K 全局搜索浮层需要聚合 4 个数据源：命令注册表（commandStore 内存）、文件树（fileSearchStore 缓存 + composer domain WS）、会话库（session domain WS）、recents（localStorage）。设计阶段最初方案是新建 `api/domains/search.ts` domain 编排这 4 源。

但审查发现：现有 10 个 domain（composer/file/session/...）严格只调 transport+pending（不 import store/composable）。search domain 若编排 3 源，必跨 commandStore + fileSearchStore + composer/session domain——破坏「domain 纯净」铁律。要么为 search 开「编排型 domain」特例，要么改归 composable 层。

## 决策

**search 编排归 composable（`composables/features/useSearch.ts`），不新建 api/domains/search.ts。**

- `useSearch.query()` 在 composable 层聚合 4 源：fileSearchStore 缓存命中直返 / 缓存未命中调 composer/session domain（WS）/ commandStore / useRecents
- DTO 映射（FileNode/SessionSummary/SessionCommand → SearchItem）+ matchFilter 过滤 + 分组在 composable 内
- domain 严格只调 transport+pending 的现有铁律不变
- `api/index.ts` 不再导出 search 门面（real 侧无 domain 可指）

与 `useSidebar`/`useFileSearch`（同层跨 store+domain 编排）模式 100% 一致。

## 备选方案

**方案 A：编排型 domain 特例**（新建 search domain，允许它 import store）。
- 取舍：破坏 domain 层纯净一致性，未来每个「编排型需求」都要争论是否算特例。
- 否决理由：一致性 > 品味。domain 层一旦开了「可 import store」的口子，铁律形同虚设。

**方案 B：编排归 composable**（采用）。
- 取舍：api/index.ts 门面 real 侧无 search domain，SearchModal 改调 useSearch.query（真实改动）。
- 优势：分层正确归位（编排逻辑在 composable 层，domain 层保持纯净），与现有 useSidebar/useFileSearch 模式一致，不引入特例。

## 后果

- **正面**：domain 层纯净铁律不破，跨 store 编排统一归 composable 层（与 NFR K-9 一致）。
- **负面**：search 没有 domain 门面，mock 模式需在 useSearch 内部判 `VITE_MOCK` 走 mockApi.search fixture（而非 api/index.ts 三元切换）。
- **跨主题影响**：未来任何「需要聚合多 store + 多 domain」的编排型需求，都应归 composable 层，不新建编排型 domain。

> 本决策由 `[2026-06-30-search-modal]` 设计阶段做出，经代码实施验证（useSearch.ts 已落地）。
