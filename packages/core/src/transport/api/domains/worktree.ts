/**
 * worktree 域 —— worktree RPC 封装。
 *
 * 数据流：renderer → worktreeApi.* → command('worktree.*') →
 * runtime WorktreeMessageHandler → WorktreeService.* → git 操作。
 *
 * 错误契约：runtime 失败经统一 error envelope reject，错误对象带 code 字段
 * （NOT_BARE_REPO / WORKTREE_EXISTS / SETUP_FAILED / GIT_FAILED）+ detail（exitCode/stderr 等）。
 * 前端 catch 拿到的就是带 code 的 Error（envelope 透传，见 request.ts 的 error 通道）。
 *
 * 依赖方向：api/request（command）+ shared（协议类型 ReplyPayloadMap）。
 */
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'

/**
 * worktree.create 专用 RPC 超时（10 分钟）。
 *
 * 不复用 RPC_BACKSTOP_TIMEOUT_MS（65s，控制面单请求量级）：create 是长任务，runtime 侧
 * 最坏耗时 = git worktree add 60s（整树 checkout）+ setup 脚本 worktreeTimeout（默认 300s，
 * 可配到 3600s）+ setup 失败回滚 2×60s。65s 兜底会在 setup 超时/慢安装时先于 runtime 的
 * 真实结果（含回滚结局）触发——前端拿到超时错误、runtime 还在回滚，状态分裂。600s 覆盖
 * 默认配置（300+180）加余量；用户把 worktreeTimeout 调到 ~400s 以上时兜底仍可能先触发，
 * 根本解是进度事件 + 取消模型（worktree.setupOutput / worktree.cancel，未落地前以此常量兜底）。
 */
const WORKTREE_CREATE_RPC_TIMEOUT_MS = 600_000
import { command } from '../request'
import type { ClientMessageMap, ServerMessageMap } from '@taiji/shared'

// 从 shared 契约派生，消除本地手写定义的漂移风险。
// 形状与原手写一致：WorktreeCreateParams = { branch, baseBranch?, workspaceHint? }，
// WorktreeCreateReply = { cwd, branch }。
export type WorktreeCreateParams = ClientMessageMap['worktree.create']
export type WorktreeCreateReply = ServerMessageMap['worktree.created']
/** worktree.listBranches reply 类型。 */
export type WorktreeBranchesReply = ServerMessageMap['worktree.branches']
/** worktree.list reply 类型。 */
export type WorktreeListReply = ServerMessageMap['worktree.list:result']

/**
 * worktree 域 API。
 *
 * - create：在 bare repo + worktree 结构中创建隔离的工作目录
 * - listBranches：列出 cwd 所在仓库的本地和远程分支
 * - list：列出 cwd 所在 workspace 的所有 worktree
 *
 * 失败 → reject 带 code 的 Error（SETUP_FAILED / WORKTREE_EXISTS / NOT_BARE_REPO / GIT_FAILED）
 *   前端按 code 切换到 error / exists 态。
 */
export const worktreeApi = {
  async create(params: WorktreeCreateParams): Promise<WorktreeCreateReply> {
    // command 的泛型 K 由 type 字面量 'worktree.create' 推导，reply 类型由 ReplyPayloadMap['worktree.create']
    // 推导为 { cwd: string; branch: string }（与 WorktreeCreateReply 结构一致）。不显式传 K 避免约束冲突。
    return command('worktree.create', params, WORKTREE_CREATE_RPC_TIMEOUT_MS)
  },

  /** 列出 cwd 所在仓库的本地和远程分支 + 默认分支名。 */
  async listBranches(cwd: string): Promise<WorktreeBranchesReply> {
    return command('worktree.listBranches', { cwd }, RPC_BACKSTOP_TIMEOUT_MS)
  },

  /** 列出 cwd 所在 workspace 的所有 worktree。 */
  async list(cwd: string): Promise<WorktreeListReply> {
    return command('worktree.list', { cwd }, RPC_BACKSTOP_TIMEOUT_MS)
  },
}
