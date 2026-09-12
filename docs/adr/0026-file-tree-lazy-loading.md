# ADR-0026: 文件树懒加载策略

- 状态：Accepted

> **性质**：架构 D-不可逆决策（加载策略）。本文档定义策略，不含实现细节。
> **关联**：[ADR-0025 File View 语义](0025-file-view-full-project-tree.md)、[ADR-0027 FileService 三层](0027-fileservice-three-layer.md)。
> **溯源**：`[from: 2026-06-28-sidebar-project-file-tree §5,§7, decisions D-009]`

## 上下文

大项目（如 monorepo，几千文件 + node_modules 同级）全量加载文件树会导致首加载慢、内存占用大。需要决定加载粒度。

## 决策

**懒加载（分层数据获取）**：

1. **首加载**（`file.tree`）：返回**顶层 + 一级子目录**（1+M 次 listDir，M = 顶层目录数）
2. **展开目录**（`file.tree.expand`）：按需拉**单层子节点**（用户点展开才请求）
3. **前端每节点独立加载态**：`nodeStates: Map<sid, Map<path, NodeState>>`，NodeState = `{status, reason?}`（D-021 对象化）

### 加载态状态机（5 态）

```
unloaded → loading → loaded（终态，复用缓存）
                  → error（可重试，回到 loading）
loaded → invalidated（agent 改了文件，标记需重拉）→ loading
```

### 缓存复用规则（关键）

- **loaded 复用**：折叠再展开不重请求（T2.2）
- **首加载带的一级子**：expandNode 检测 node.children 已存在则视为 loaded，**不重发 expand 请求**（避免空响应覆盖 children，D-009）
- **loading 幂等**：在途请求去重（inFlight Map，T2.3）
- **error 重试**：error 态折叠再展开重发（T2.5）
- **invalidated**：agent_end / file_changes ready 后标记，下次展开重拉（D-017）

## 被否方案

- **全量加载**：大项目首加载慢/内存大
- **全量 + 虚拟滚动**：引入前端复杂度（虚拟滚动库），过度工程

## 残余风险

- 用户主动展开极深目录的体验卡顿：接受（懒加载下需逐层展开，非首加载问题）
- monorepo 顶层目录多（M 大）时首加载串行 51 次 readdir：P99 < 1s（懒加载缓解，并行化待后续评估）

## 落地证据

- `runtime/src/services/file-service.ts` listTree（顶层+一级子）/ expandDir（单层）
- `renderer/src/composables/features/useFileTree.ts` expandNode（5 态分支 + inFlight 幂等）
- `renderer/src/stores/fileTree.ts` nodeStates Map + setNodeState 原子入口（D-021）
