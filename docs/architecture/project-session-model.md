# Project – Session 关系模型（D14 语义修正，2026-08-04）

> **状态**：SSOT（单一权威源）。实现层：`packages/shared/src/project.ts`（模型注释）、
> `packages/shared/src/session.ts`（`SessionSummary.projectId`）、runtime `session-file-utils.ts`
>（`.project.json` sidecar）。
> **历史**：2026-08-04 之前存在 `Project → Workspace → Session` 三层模型（`Project.workspaces[]`
> 目录集合 + cwd 字符串匹配），按用户语义修正推翻。

## 关系模型（一句话）

**Project 直接关联 Session（`session.projectId`，创建时归属）；cwd 只是前端展示聚合，不是模型层级，不存在 Workspace 实体。**

```
Project（用户逻辑分组，跨任意多个目录）
  └── 直接关联 Session（session.projectId，创建时归属）

cwd（session 属性）→ 仅前端展示聚合（侧栏按目录分组 SessionGroup），与 Project 无层级关系
```

## 语义要点

1. **Project 是用户管理的逻辑实体**：一个 project 可以跨多个目录做很多事情。用户为了这个
   project 服务，可以在**任何目录**下开 session。
2. **Session 是关联主体**：session 创建时归属当前 activeProject（`create` 请求携带
   `projectId`），与 session 的 cwd 无关。
3. **cwd 不是层级**：侧栏 session 列表按 cwd 分组（`SessionGroup[]`）只是展示聚合。
   同一个 cwd 组内的 session 可以归属不同的 project（过滤粒度是 session 级，不是组级）。
4. **默认项目 = 未归类聚合**：无 `projectId` 的 session（历史数据）在展示层归入默认项目
   （`proj-default`，name 空）。孤儿 session（归属的 project 已被删除）同样落入默认项目，
   保证任何 session 至少在一个项目视图中可见。
5. **归属跟 session 走**：删除 session 归属自动消失；fork 继承父 session 的归属；
   session 移动/归档时归属不丢。

## 为什么是 session 直接关联（而非目录级）

| 维度 | session 直接关联（现模型） | 目录级关联（已废弃） |
|------|--------------------------|---------------------|
| 关联粒度 | 逐 session 精确归属 | 目录下所有 session 整体归组 |
| 跨目录 | project 天然跨任意目录 | 需要把多个目录挂进 project |
| 同目录多项目 | 同一目录的 session 可归不同 project | 做不到 |
| 删除 session | 归属自动消失（无清理链） | 无影响（目录还在） |
| fork | 继承父归属（runtime 写 sidecar） | 同目录自动可见 |

教训：**展示聚合概念不要物化成模型**。cwd 分组只是 UI 呈现方式，把它物化成
`Workspace` 实体并让 project 持有目录集合，导致关联粒度错误（目录级而非 session 级）、
且引入了 cwd 字符串匹配的脆弱关联（目录移动/重命名后失配）。

## 持久化

- **session 归属**：runtime sidecar `<sessionFile>.project.json`（磁盘权威），与
  `.preset.json`（launch preset）、`.meta.json`（终态）并列独立。
  - 写入：`persistProjectBinding(filePath, projectId)`（复制 preset binding 模式：
    原子写 + 缓存失效 + [规则 #6] JSONL 未落盘时 existsSync 守卫跳过；
    turn_end/agent_end 兜底补写，见 session-service.tryPersistProjectBinding）
  - 读取：`scanSessionMeta` 第五读（与 header/name/outcome/preset 同批次，共享
    `sessionMetaCache`）；active session 内存态兜底（`ManagedSession.projectId`）
  - 空 projectId 不写 sidecar（等价未归类，读取侧统一兑底默认项目）
- **project 列表**：runtime `<configDir>/projects.json`（2026-08-04 迁 runtime，
  ProjectStore 对齐 recent-workspaces.json 模式：WriteBackCache debounce 落盘，
  跨实例一致）。前端 deep watch 变化 → `project.save` RPC 全量写入；
  localStorage 仅作首启一次性迁移源（2026-08-04 前旧数据），迁移后废弃。

## 数据流

```
创建：前端 useNewTaskFlow（命名 project 时透传 activeProjectId）
  → create 请求 payload.projectId → runtime session-lifecycle.create
  → persistProjectBinding（.project.json sidecar）+ 内存态 → SessionSummary.projectId

扫描：scanSessionMeta 第五读 readProjectBinding → ScannedSessionMeta.projectId
  → session-scanner.scannedToSummary → SessionSummary.projectId
  → config.sessions 广播 → 前端 SessionList 按 activeProject 过滤

手动归类：SessionItem「归入项目」菜单 → session.setProject RPC
  → session-service.setProject（active 内存态同步 + sidecar 写入）
  → reply + config.sessions 全量广播（前端乐观更新 updateProjectId 幂等）

fork：runtime forkSession 读源归属（内存态 → 扫描值）→ 写 fork 的 .project.json
```

## 前端过滤规则（SessionList.visibleGroups）

- 命名 project：`session.projectId === activeProjectId`
- 默认项目（name 空）：`!session.projectId || projectId 不属于任何现存命名 project`（孤儿聚合）
- 过滤粒度 **session 级**：同 cwd 组内逐 session 匹配后重组分组（`SessionGroup[]` 形状保留）

## 关键代码位置

| 层 | 位置 |
|----|------|
| 模型 | `packages/shared/src/project.ts`、`packages/shared/src/session.ts` |
| 协议 | `packages/shared/src/protocol.ts`（`session.create.projectId` / `session.setProject`） |
| runtime sidecar | `packages/runtime/src/infra/pi/session-file-utils.ts`（projectSidecarPath/persistProjectBinding/readProjectBinding） |
| runtime 创建/继承 | `session-lifecycle.ts`（create 写绑定、fork 继承） |
| runtime 手动归类 | `session-service.ts`（setProject） |
| runtime project 持久化 | `services/project/project-store.ts` + `transport/project-message-handler.ts` |
| 前端过滤 | `packages/renderer/src/components/sidebar/SessionList.vue`（visibleGroups） |
| 前端归类菜单 | `packages/renderer/src/components/sidebar/SessionItem.vue`（Popover 归入项目） |
| project store | `packages/renderer/src/stores/project.ts` |
