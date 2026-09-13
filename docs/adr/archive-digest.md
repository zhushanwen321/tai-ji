# ADR 档案摘要（archive digest）

本文件是被压缩的**非载荷 ADR 档案**：原文件已删除，每号保留一行结论 + 去向，逐号可查。全文见 git 历史（`git log --diff-filter=D -- docs/adr/` 或对应编号文件名）。

在册 ADR 见 [README.md](README.md) 索引；extensions 子系统另见 [../extensions/adr/archive-digest.md](../extensions/adr/archive-digest.md)。

<a id="adr-0002"></a>
### ADR-0002：SessionPool 整体删除，职责拆分到 SessionService + message-converter（已接受）
- 结论：删除 472 行上帝类 SessionPool（含死代码 WS 客户端管理），session 生命周期 + EventAdapter 管理归 SessionService，convertPiHistory 提取为独立纯函数；Server↔Service 循环依赖用 `setServices()` setter 注入打破。
- 去向：已实现——`packages/runtime/src/services/session/session-service.ts`、`packages/runtime/src/infra/pi/message-converter.ts`（路径随后续重构有位移）。

<a id="adr-0003"></a>
### ADR-0003：event-adapter translate() 不严格绑定 PiEvent 联合类型（已推翻）
- 结论：translate() 入参用 `Record<string, unknown>` 宽类型以容忍 pi 运行时超集事件（compaction_* 等）；运行时安全优先于编译期 exhaustive check。
- 去向：被 [ADR-0037](0037-pi-protocol-real-contract.md) 推翻取代（pi-protocol 深化为真契约）。

<a id="adr-0007"></a>
### ADR-0007：Git submodule 管理 extension/skill 依赖（Superseded）
- 结论：vendor/ 下 git submodule 引入 extension/skill 依赖、构建时拷入 resources——版本可钉死但增加 CI 复杂度。
- 去向：被 [ADR-0011](0011-bundled-extensions-direct-copy.md) 取代（bundled extensions 直接拷贝）。

<a id="adr-0014"></a>
### ADR-0014：SessionData 本地文件持久化（Accepted）
- 结论：plugin 系统 sessionData 弃用 pi.appendEntry 通路（当时 API 不可用），改本地 JSON 文件持久化——atomic write + 启动恢复 + 单文件 10MB 上限。
- 去向：已实现——`packages/runtime/src/services/plugin-service/session-data-store.ts`。

<a id="adr-0017"></a>
### ADR-0017：macOS Traffic Light Safe Zone + Sidebar Expand Button（Superseded）
- 结论：v2 方案（PanelBar `padding-left:78px` safe-zone + 左缘 floating pill expand button）已全部废弃；traffic light 改由主进程 `titleBarStyle:'hidden'` + `trafficLightPosition:{8,8}` 精确控位，唤回走 ⌘B + header chrome 按钮。
- 去向：被 v6 shell spec（`docs/page-design/v6-spec-shell.html`）+ 折叠态 chrome 落位取代；现行数值 SSOT 见 `docs/DESIGN.md` §11。

<a id="adr-0020"></a>
### ADR-0020：核心 User Flow 范围（Accepted）
- 结论：demo 聚焦 5 条核心 flow——深度编织 Flow 2（单 Agent 对话→代码变更审查）+ Flow 3（SubAgent 并行→监控→介入），其余 3 条（冷启动/回退/多任务收尾）入口级轻量展示。
- 去向：已实现，flow spec 归档于 `docs/architecture/v3-specs/flow-2-code-review/spec.md`、`docs/architecture/v3-specs/flow-3-subagent/spec.md`。

<a id="adr-0030"></a>
### ADR-0030：文件匹配算法单一管线复用（composer # 与 SearchModal）（Accepted）
- 结论：文件搜索单一管线 `FileNode[] → toFileCandidates → filterAndSortFileCandidates`，两处复用；command/session 源保留 matchFilter 纯子串（按类型分治——file 有 basename 概念，其余没有）。
- 去向：已实现——`packages/core/src/domain/new-task-search/file-match.ts`（原 lib/file-match.ts 随 dom-core 重构迁移）。

<a id="adr-0031"></a>
### ADR-0031：跨组件 slash 命令注入用 store 驱动的一次性消息通道（Accepted）
- 结论：`commandStore.pendingSlash` ref 作一次性通道（写→消费→清），SearchModal 跨组件树注入 Composer slash chip；约束：watch 非 immediate、sessionId 过滤、先注入后清、ts 字段触发引用变化。
- 去向：已实现——`packages/renderer/src/composables/features/command/useCommandStore.ts`。

<a id="adr-0033"></a>
### ADR-0033：recent-workspaces 采用三层架构（不引入 DDD4）（Accepted）
- 结论：workspace-message-handler（RPC 路由零业务）→ workspace-service（写入时机编排 + 守卫）→ recent-workspaces-store（LRU/去重/排序纯算法 + 持久化）三层足矣，DDD4 属过度设计。
- 去向：已实现——`packages/runtime/src/services/workspace/workspace-service.ts`、`packages/runtime/src/services/workspace/recent-workspaces-store.ts`。

<a id="adr-0052"></a>
### ADR-0052：Landing 态 isBare 检测改用独立 RPC（Proposed，已实施）
- 结论：统一延迟 create 架构下 landing 态 `currentSession` 恒 null，寄生其上的 `isBareWorkspace` 恒 false、「新建 worktree」按钮永不显示；新增 `workspace.detectBare({cwd})` RPC 基于 pendingCwd 查询，与 gitInfo 数据源并存。
- 去向：已实现——`packages/runtime/src/transport/workspace-message-handler.ts`（`workspace.detectBare` case）+ `packages/runtime/src/services/worktree/workspace-detector.ts`。

<a id="adr-0061"></a>
### ADR-0061：cw store 键控基准改为 repo 级（git common dir）（Superseded）
- 结论：「store 应 repo 级共享、git-common-dir 作 repo 标识」方向正确，但「cw-tool 调用层探测 + `--workspace` 透传」实现被推翻——dirname 多余、单一 `--workspace` 兼任双角色在 bare repo 结构性不可行、归一化应在引擎层而非调用层。
- 去向：被引擎层方案 A 取代——SSOT 在 coding-workflow 仓库 `fix-cw-cwd-worktree/docs/cw-store-workspace-decoupling.md`（commit aa4949b）；本仓差异文档已删（原 `docs/architecture/cw-store-workspace-decoupling.md`，git 历史可追溯）。
