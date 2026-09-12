# ADR-0030: 文件匹配算法单一管线复用（composer # 与 SearchModal）

- 状态：Accepted

> **性质**：架构 D-不可逆决策（DRY + 算法归位）。本文文档定义架构约束。
> **关联**：[ADR-0028 搜索编排归 composable](0028-search-orchestration-in-composable.md)。
> **溯源**：`[from: 2026-06-30-search-modal §code, decisions D-029]`

## 上下文

项目内有两处文件搜索场景：composer `#` 文件候选（CommandPopover）和 ⌘K 全局搜索浮层的文件分组（SearchModal）。v2 实现 SearchModal 时新建了 `lib/match-engine.ts`（matchFilter 纯子串匹配 + 不排序），而 composer `#` 已有 `lib/file-match.ts`（filterAndSortFileCandidates：basename 前缀 > path 子串 + 文件优先 + 路径浅优先 + 多级排序）。

同一个项目里文件搜索有两套算法，且 SearchModal 的劣于 composer——搜 `agents` 时 `AGENTS.md`（basename 前缀命中）不会排前，目标文件被埋没。

## 决策

**文件匹配单一管线：两处复用 `FileNode[] → toFileCandidates → filterAndSortFileCandidates`。**

- `lib/file-candidates.ts`（toFileCandidates：FileNode → FileCandidate DTO 映射）
- `lib/file-match.ts`（filterAndSortFileCandidates：分级匹配 + 排序）
- SearchModal 的 `useSearch.queryFileSource` 改走与 composer `#` 完全相同的管线，file 源在源内完成过滤+排序后映射成 SearchItem，不再进 matchFilter 二次过滤
- command/session 源仍用 matchFilter（纯子串，与 composer slash 命令同款——非 file 类型无 basename 概念，纯子串是正确的）

**语义差异保留**：SearchModal 只搜文件不搜目录（D-003，mapFileCandidatesToItems 过滤 `kind==='目录'`），composer `#` 允许目录。复用的是匹配+排序算法，不是全行为。

## 备选方案

**方案 A：全类型统一用 matchFilter**（拉齐到 SearchModal 的纯子串）。
- 取舍：丢失 composer `#` 已有的精细排序（basename 前缀优先），体验倒退。
- 否决理由：两套都劣不如两套都优。

**方案 B：file 类型复用 filterAndSortFileCandidates**（采用）。
- 取舍：command/session 仍用 matchFilter（两种算法并存，但按类型分治——file 有 basename 概念适合分级，其他类型无）。
- 优势：同一场景同一算法，最优体验，DRY。

## 后果

- **正面**：项目内文件搜索只有一套匹配算法，搜 `agents` 时 `AGENTS.md` 在两处都正确排前。
- **负面**：match-engine.ts 的 matchFilter 仍用于 command/session（非 file），两套算法按类型分治。这是合理的——file 有 basename 层级概念，command/session 没有。
- **跨主题影响**：未来任何文件搜索/匹配场景都应复用 `lib/file-candidates.ts` + `lib/file-match.ts`，不另起算法。

> 本决策在 `[2026-06-30-search-modal]` 编码实施后由用户审查发现两套算法不一致，立即修复。
