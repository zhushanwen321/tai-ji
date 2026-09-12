# ADR-0027: FileService 三层架构 + ignore 纯函数范式

- 状态：Accepted

> **性质**：架构 D-不可逆决策（分层 + 范式）。本文档定义架构约束。
> **关联**：[ADR-0025 File View 语义](0025-file-view-full-project-tree.md)、[ADR-0026 懒加载](0026-file-tree-lazy-loading.md)、[ADR-0009 数据目录隔离](0009-xyz-agent-data-dir-isolation-from-pi.md)。
> **溯源**：`[from: 2026-06-28-sidebar-project-file-tree §6,§10, decisions D-008/D-013]`

## 上下文

文件树功能需要读取文件系统（listDir/stat/readFile）+ gitignore 解析。要决定这些 IO 和计算放在哪一层、用什么范式（port vs 纯函数 vs 内联）。

## 决策

### D-008：FileService 三层 + port

**沿用项目既有三层架构**（transport → services → infra）：

- **services 层 FileService**（编排深模块）：cwd 解析 / 越界统一守门 / 懒加载分层 / ignore 双模式 / readFile 截断。定义 `IFileExecutor` port（listDir/stat/readFile）
- **infra 层 FsExecutor**（adapter）：用 `node:fs/promises` 实现 IFileExecutor port + 超时 + symlink 处理
- **transport 层 FileMessageHandler**：路由 file.* 消息，委托 FileService

**约束**：FileService 不直接 import node:fs（经 port，AC-2 grep 验证）。与 GitService 的 IGitExecutor 范式对称。

### D-013：ignore 纯函数范式（revisit D-008）

D-008 原含 `IIgnoreReader` port，追踪发现**多余**——`git-status-parser` 是纯函数被 GitService 直接 import（不包 port），ignore 纯函数应对称。

**改为纯函数范式**：
- `shared/ignore-parser.ts` 导出 `compileIgnoreRules` / `matchPath` 纯函数（无 IO，放 shared 层）
- FileService 经 `IFileExecutor.readFile` 读 .gitignore 内容（IO 走 port），再调纯函数匹配（计算走 shared）

> **⚠️ 教训记录**：`isUnderOrEqual` 曾误迁到 shared（W1a），但 shared 是浏览器/runtime 共享层，`node:path` 在浏览器崩。已移回 runtime/path-utils.ts。**shared 层禁止 node 内置模块**（见 NFR.md）。

### ignore 双模式（D-020）

`matchPath` 支持 `showIgnored` 双模式：
- `showIgnored=false`（默认）：匹配 ignored 的节点**过滤掉**（隐藏 node_modules/dist 等）
- `showIgnored=true`：匹配的节点**保留并标 `ignored=true`**（前端灰斜体渲染）

## 被否方案

- **内联 fs**（FileService 直接 import node:fs）：不可测（无法 mock fs）
- **合入 GitService**：职责膨胀，违反单一变化轴
- **IIgnoreReader port**（D-008 原方案）：纯函数无 IO，port 多余（D-013 supersede）

## 落地证据

- `runtime/src/services/file-service.ts`（FileService 编排，import isUnderOrEqual 自 path-utils）
- `runtime/src/services/ports/file-executor.ts`（IFileExecutor port）
- `runtime/src/infra/fs-executor.ts`（FsExecutor adapter）
- `shared/src/ignore-parser.ts`（纯函数，无 node 内置依赖）
- `runtime/src/utils/path-utils.ts`（isUnderOrEqual 实现，**不在 shared**）
