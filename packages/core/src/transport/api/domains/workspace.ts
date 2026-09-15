/**
 * Workspace 域 —— 最近工作区记录查询 + 仓库模式检测。
 *
 * 依赖方向：command（类型化原语，统一 pending.createCommandId + register + transport.send）。
 *
 * 注：ServerMessage(id) → pending.resolve 的回灌由 features 层 dispatcher 串联（W3）。
 *      mock 模式下不走本域（api/index 切到 mock 门面）。
 */
import type { RecentWorkspaceRecord, ServerMessageMap } from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'

/** workspace.detect reply 类型（三态模式检测）。 */
export type WorkspaceDetectReply = ServerMessageMap['workspace.detected']

/**
 * 获取最近工作区记录（runtime workspace.listRecent → workspace.recentList reply）。
 *
 * reply payload 形状是 `{ records: RecentWorkspaceRecord[] }`（workspace-message-handler.ts），
 * 解包 `.records` 返 RecentWorkspaceRecord[]。
 */
export async function listRecent(): Promise<RecentWorkspaceRecord[]> {
  const reply = await command('workspace.listRecent', {}, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.records
}

/**
 * 记录一次工作区使用并返回最新列表（runtime workspace.record → workspace.recentList reply）。
 *
 * 用于选目录后热更新：selectWorkspace/openDirDialog 选中目录后调用，runtime 写入记录后
 * 回传刷新后的 records，前端据此直接更新 store（一次往返完成写入+刷新，无需二次 listRecent）。
 */
export async function record(cwd: string): Promise<RecentWorkspaceRecord[]> {
  const reply = await command('workspace.record', { cwd }, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.records
}

/**
 * 检测 cwd 所在 git 仓库模式（bare-workspace / plain-repo / not-repo）。
 *
 * 返回三态 { mode, wsRoot, barePath, repoRoot, defaultBranch }。
 * workspace.detectBare 为此接口的向后兼容别名（仅返 isBare/wsRoot/barePath）。
 */
export async function detect(cwd: string): Promise<WorkspaceDetectReply> {
  return command('workspace.detect', { cwd }, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 检测 cwd 是否位于 bare repo + worktree 结构（向后兼容别名）。
 *
 * 映射到 workspace.detect，提取 isBare/wsRoot/barePath 三个字段。
 * 新代码应优先使用 detect() 获取完整三态信息。
 */
export async function detectBare(cwd: string): Promise<{ isBare: boolean; wsRoot: string; barePath: string }> {
  const result = await detect(cwd)
  return {
    isBare: result.mode === 'bare-workspace',
    wsRoot: result.wsRoot,
    barePath: result.barePath,
  }
}
