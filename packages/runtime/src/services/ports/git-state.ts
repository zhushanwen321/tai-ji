/**
 * IGitStateService port —— git 状态统一读取服务的 seam（03-git-state-service D4-1，perf W16）。
 *
 * 动机：git 状态读取散在 git-service（面板聚合）与 file-change-reconciler（turn 内 diff）两处，
 * 各自直连 executor、无缓存无去重。本 port 收敛「状态读取」为一个入口，实现层提供：
 * - in-flight 单飞去重（同 key 并发请求共享一次执行，D4-2）
 * - 分层 TTL 缓存（getStatus 短 TTL 键 = sessionId+cwd；非仓库 cwd 级负缓存，D4-3）
 * - 写操作失效钩子（invalidate，D4-3）
 *
 * 🔒 三层架构：services 定义 port。实现（services/git/git-state-service.ts）经 IGitExecutor
 * port 执行 git、复用 infra 的纯函数解析器（与 git-service 同款纯函数豁免）。
 *
 * W16 阶段说明：本 port + 实现先行为基础设施（含单测），生产接线在 W17
 * （git-service.getStatus 收编）与 W18（reconciler 采集收编）——组合根暂不实例化。
 */
import type { FileChangeStatus, GitStatusResult } from '@taiji/shared'

/**
 * git status 快照（file_changes 基准）：filePath → 4 态 status。
 * null = 非 git 仓库 / git 不可用 / 超时（调用方按现状语义降级）。
 *
 * 类型裁决（W16 实施定案）：直接暴露具体 Map 形态而非 unknown 不透明句柄——
 * FileChangeStatus 来自 @taiji/shared（非 infra 类型），port 签名出现具体 Map 不违反
 * ADR-0027「services 不 import infra」；且同 port 的 numstat 返回具体 Map，快照用 unknown
 * 会造成同一接口风格割裂（本 port 先例 file-change-diff.ts 的 unknown 只封装跨层透传句柄，
 * 其 diffSnapshots/computeLineCounts 的具体数据形态同样直接暴露）。
 */
export type StatusSnapshot = Map<string, FileChangeStatus> | null

/**
 * numstat 单文件条目（path → add/del 行数）。
 * add/del 为 `number | undefined`：二进制文件 git 报告 `-`，解析为 undefined（lossless，调用方可区分）。
 *
 * 结构与 infra/git/git-status-parser.ts 的 NumstatEntry 一致（TS 结构类型兼容，实现返回值
 * 直接满足本类型）；在 port 层重新声明以避免 services → import infra 类型。
 */
export interface NumstatEntry {
  add: number | undefined
  del: number | undefined
  path: string
}

/** snapshotStatus 的可选参数。force=true 绕过非仓库负缓存强制重探（写操作后等场景）。 */
export interface SnapshotStatusOptions {
  force?: boolean
}

export interface IGitStateService {
  /**
   * 状态快照（file_changes diff 用）：`git status --porcelain`（裸参数——保持 untracked
   * 目录折叠语义与 reconciler 现有测试基线，与 getStatus 的 -uall 展开语义**有意区分**，D4-1）。
   * 不缓存结果（每次 diff 需当前真实状态，缓存会漏报变更），只做单飞去重；
   * 非仓库负缓存命中时返回 null 且零 spawn。
   */
  snapshotStatus(cwd: string, opts?: SnapshotStatusOptions): Promise<StatusSnapshot>
  /**
   * numstat 行数（file_changes 用）：`git diff --numstat HEAD` → path → 条目 Map（含二进制
   * undefined 条目，lossless）。失败 / 非仓库 → null（调用方走 writeContents 回退）。
   */
  numstat(cwd: string): Promise<Map<string, NumstatEntry> | null>
  /**
   * 前端 git.status 面板聚合：status 先行串行（非仓库判定依赖其退出码/文案），成功后 numstat
   * 与 branch 两路并发执行，返回形状与 git-service.getStatus 现状一致（W17 收编时
   * git-service 委托此方法）。
   *
   * 签名偏差说明（相对 03 文档 D4-1 的 getStatus(sessionId)）：增加显式 cwd 参数——服务不持有
   * ISessionService 依赖（保持只依赖 IGitExecutor 的纯状态服务；session→cwd 解析是调用方
   * git-service 已有的职责），缓存键内部仍按 sessionId+cwd 组合（D4-3，防跨 session 串扰）。
   */
  getStatus(sessionId: string, cwd: string): Promise<GitStatusResult>
  /**
   * 写操作后失效（stage/unstage/commit/checkout/branch/worktree 等调用方主动触发）：
   * 清除该 session 的 getStatus 缓存与在飞去重条目，下一次读取拿到新状态。
   */
  invalidate(sessionId: string): void
  /**
   * 按 cwd 维度失效（perf W17：git.checkoutCwd 等 session-less 写操作，payload 无 sessionId）。
   * 清除所有以该 cwd 结尾的 getStatus 缓存键（跨 session）与在飞条目——landing 态切分支
   * 会改变共享该 cwd 的任意 session 的 branch/branches 视图，需全量失效。
   */
  invalidateByCwd(cwd: string): void
}
