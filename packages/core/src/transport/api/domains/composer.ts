/**
 * Composer 域 —— `$` 文件候选 WS 封装（composer 工具区）。
 *
 * real 模式下（VITE_MOCK !== 'true'）由 api/index 注入，替代 mock 静态 fixture。
 * 例外：getFileCandidatesByCwd 由 open-fetch（command-popover-open-fetch）直接 import
 * （绕过门面注入），mock 模式下走 real command 失败降级空候选（见 impl-plan §5 u4 偏差）。
 *
 * 请求-响应形态（对称 file.ts）：
 * - getFileCandidates → file.search → 'file.search:result' 同步 reply，返回 FileNode[]
 *
 * 依赖方向：command（类型化原语，统一 pending.createCommandId + register + transport.send）。
 * 失败走 error envelope（routeInbound 对 type==='error' 走 pending.reject，code 透传到 Error.code）。
 *
 * 注意：domain 返回原始 FileNode[]（保持真实数据语义）；FileNode → CommandPopover
 * 候选形状（中文 kind / 目录补斜杠）的 DTO 映射在消费侧 lib/file-candidates.ts，
 * 不在 domain 层做（domain 层不应感知 UI 形状）。
 *
 * getMentionCandidates：`@` 候选已废弃（技能走 slash 命令、符号无 LSP），
 * 返回空数组保留签名，避免 CommandPopover 大改。mock 侧仍返回 fixture（mock 模式不受影响）。
 */
import type { FileNode } from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'

/**
 * 拉 `$` 文件候选（全量递归当前 cwd，受 ignore + 深度上限 + 结果数上限）。
 * @param sessionId 当前 session（取其 cwd 作为搜索根）
 * @returns FileNode[]（扁平，path 相对 cwd 无前导斜杠）
 */
export async function getFileCandidates(sessionId: string): Promise<FileNode[]> {
  const reply = await command('file.search', { sessionId }, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.files
}

/**
 * 拉 `$` 文件候选（landing 态 composer 专用：cwd 通道，无 session）。
 * landing 态尚无 session，无法走 file.search 的 session 键控路，改按用户当前选定目录
 * 全量递归搜索（与 file.search 同约束：ignore 过滤 + 深度上限 + 结果数上限）。
 * 相对路径语义与 session 路一致：FileNode.path 相对 cwd 无前导斜杠，
 * 首条消息发送建 session（cwd 即该目录）后 chip 相对路径始终可解析。
 * @param cwd 当前选定目录（landing 态 pendingCwd）
 * @returns files：FileNode[]（扁平，path 相对 cwd 无前导斜杠）；truncated：DoS 上限
 *   5000 截止（D7，adversarial-review-fixes §3.4——截断事实来自 runtime，浮层条件提示）
 */
export async function getFileCandidatesByCwd(cwd: string): Promise<{ files: FileNode[]; truncated: boolean }> {
  const reply = await command('file.search.cwd', { cwd }, RPC_BACKSTOP_TIMEOUT_MS)
  return { files: reply.files, truncated: reply.truncated }
}

/**
 * `@` 提及候选（已废弃）。技能候选由 slash 命令实现、符号候选无 LSP 能力，
 * 故 real 模式返回空数组。保留签名避免 CommandPopover 调用点改动。
 */
export function getMentionCandidates(): Promise<[]> {
  return Promise.resolve([])
}
