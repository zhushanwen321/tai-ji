# ADR-0029: 领域类型 SSOT 归 lib 层（非 mock）

- 状态：Accepted

> **性质**：架构 D-不可逆决策（类型归位）。本文档定义架构约束。
> **关联**：[ADR-0028 搜索编排归 composable](0028-search-orchestration-in-composable.md)。
> **溯源**：`[from: 2026-06-30-search-modal §code, decisions D-028]`

## 上下文

v1 搜索功能全在 mock 目录实现，`SearchItem`/`SearchType` 类型定义埋在 `api/mock/search-data.ts`。v2 重写搜索编排时（useSearch.ts），生产代码（useSearch/useSearchJump/lib/search-types）从 `@/api/mock/search-data` 直穿 mock 内部获取领域类型——架构倒置：mock 是可选测试/开发依赖，不该持有生产领域类型。而 SearchModal.vue 却走 `@/api` 门面 re-export，两路矛盾。

## 决策

**领域类型定义归 `lib/` 层（与领域逻辑同处），mock 反向依赖领域类型。**

- `SearchType`/`SearchItem` 定义迁至 `lib/search-types.ts`（与 Section/SearchCtx/AppCommand 等搜索领域类型同处，Tier 0 SSOT）
- `api/mock/search-data.ts` 反向 `import type { SearchItem, SearchType } from '@/lib/search-types'`（mock 依赖领域类型，方向正确）
- `api/index.ts` 门面 re-export 改指 lib（非 mock）
- 7 个消费方（4 生产 + 3 测试）统一从 `@/lib/search-types` 导入

## 备选方案

**方案 A：统一走 api 门面 re-export**（不改定义源，只统一导入路径）。
- 取舍：类型 SSOT 仍埋在 mock 目录，门面 re-export 只是掩盖。
- 否决理由：不改根因，删 mock 仍破坏类型来源。三个月后看会想骂。

**方案 B：类型 SSOT 归 lib**（采用）。
- 取舍：7 个消费方改导入路径 + mock 反向 import。
- 优势：领域类型在领域层，mock 是可选依赖（方向正确），删除 mock 不破坏生产构建。

## 后果

- **正面**：mock 目录可整体删除而不破坏生产构建（类型/数据/逻辑都在正确的层）。
- **跨主题影响**：未来任何「类型埋在 mock」的历史遗留都应迁出到 lib/domain 层。mock 永远反向依赖生产代码，不持有生产类型定义。

> 本决策在 `[2026-06-30-search-modal]` 编码实施期由 commit 前 grep 审查发现，立即修复。
