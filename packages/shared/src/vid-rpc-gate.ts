/**
 * vid RPC 门 —— renderer/mobile 发往 runtime 的 RPC 在 command 入口统一拦截虚拟会话 id。
 *
 * 现行契约（vid 契约 SSOT 与虚拟 id 工厂同族，见 virtual-session-id.ts）：
 * - vid（subagent:/agentcall:）只做前端路由 key（chatStore 分区 / 组件 prop / 事件分发），
 *   runtime 全部 RPC 零方法认 vid——认 subagent 的通道一律是「拆 vid 后显式双参数」形态
 *   （subagentAction(mainSid, action, {subagentId})、getSubagentHistory(mainSid, subId)、
 *   getAgentCallHistory(mainSid, acsId)）。
 * - 收 vid 的查询类 RPC（清单 VID_RESOLVABLE_RPC）：门内自动解析为归属真实会话 id 后放行
 *   ——调用方（CommandPopover / useFileSearch / 文件树 / git 状态等）无须各自记得解析，
 *   新增数据链自动获得防护。
 * - 其余 RPC（动作/生命周期/历史类）收到 vid 一律 fail-fast 拒绝：解析放行会造成跨视图
 *   语义错位（如 vid 视图点撤回 → 撤回了主会话的消息；getHistory 拉主会话历史前插进
 *   vid 分区跨分区污染），这些动作的调用方应按视图形态禁用入口，而非静默解析。
 *
 * 拒绝的意义：runtime 侧 vid 直传的失败表现为 session_not_found / not active，与
 * 「会话真的已删除」不可区分，会被降级逻辑吞成普通噪音。门把契约违规前置为专用错误，
 * 调用方 catch 后的 warn 即携带可归因信息。
 */
import { isAgentCallVirtualId, isSubagentVirtualId, resolveVirtualSessionId } from './virtual-session-id'

/**
 * vid 可自动解析放行的查询类 RPC（wire 方法名，与 ClientMessageMap key 对齐）。
 *
 * 登记语义前提：该查询按「归属真实会话」执行语义无歧义（subagent 与主会话同 cwd、
 * 命令/文件/git 状态同源）。动作类、历史类、生命周期类不登记（默认拒绝）——
 * 新增方法拿不准时先不登记，运行期显式报错后再按语义裁决补登。
 */
export const VID_RESOLVABLE_RPC: ReadonlySet<string> = new Set([
  // `#` 文件候选（file.search 经 composer 域）、文件读取、文件树（按 cwd）
  'file.read',
  'file.search',
  'file.search.cwd',
  'file.tree',
  'file.tree.expand',
  // git 状态/暂存/提交/分支（按 cwd；subagent 与主会话同 cwd）
  'git.status',
  'git.diff',
  'git.stage',
  'git.unstage',
  'git.commit',
  'git.create',
  'git.checkout',
  // `/` slash 命令候选（pi getCommands，宿主进程同源）
  'session.getCommands',
  // `@` subagent 候选（列主会话名下 subagent）
  'session.getSubagents',
])

/** vid RPC 门的专用错误码（错误消息含恢复动作，见 VidRpcRejectedError）。 */
export const VID_RPC_REJECTED_CODE = 'session_vid_rejected'

/**
 * 门拒绝错误。code 供程序化判别（调用方降级 catch 可识别契约违规与普通失败）；
 * message 面向排障：指明方法、vid 与恢复路径。
 */
export class VidRpcRejectedError extends Error {
  readonly code = VID_RPC_REJECTED_CODE
  constructor(method: string, vid: string, reason: 'unregistered' | 'unresolvable') {
    super(
      reason === 'unregistered'
        ? `RPC ${method} 收到虚拟会话 id ${vid}：该方法未登记为 vid 可解析查询。查询类（按归属会话执行语义无歧义）登记进 shared VID_RESOLVABLE_RPC；动作类应在调用方按视图形态禁用入口`
        : `RPC ${method} 收到虚拟会话 id ${vid} 且无法解析归属真实会话（agentcall 两段式无归属命名空间，owner 注册表未命中）——检查 registerVidOwnerResolver 注册链`,
    )
    this.name = 'VidRpcRejectedError'
  }
}

/**
 * agentcall vid → 归属主会话 id 的反查注入。
 *
 * agentcall 两段式 vid 无归属命名空间（与 subagent 三段式不同），解析依赖运行侧登记的
 * mainSessionId → Set<agentcallVirtualId> 映射（renderer workflow store M7 D6）。该映射在
 * pinia store 内，shared/core 不可达，故经本注入口由 renderer boot 装配时注册。
 * 注入的函数在 RPC 调用时执行（app 已挂载，pinia 必已激活）。
 */
let vidOwnerResolver: ((vid: string) => string | undefined) | undefined

/** 注册 agentcall 归属反查（renderer boot 一次性调用；重复注册以最后一次为准）。 */
export function registerVidOwnerResolver(fn: (vid: string) => string | undefined): void {
  vidOwnerResolver = fn
}

/** 测试隔离钩子：清 owner 注入（生产代码禁止调用）。 */
export function __clearVidOwnerResolverForTest(): void {
  vidOwnerResolver = undefined
}

/**
 * 对 RPC 的 sessionId 参数执行 vid 门。
 *
 * @param method wire 方法名（command type）
 * @param sessionId payload.sessionId 原值（非 string / 真实 id 原样返回——门对非 vid 零干预）
 * @returns 应写入 payload 的 sessionId（可解析查询类 = 归属真实会话 id）
 * @throws VidRpcRejectedError vid 到达未登记方法，或可解析但归属不可得
 */
export function gateVidRpcSessionId(method: string, sessionId: unknown): unknown {
  if (typeof sessionId !== 'string') return sessionId
  const isVid = isSubagentVirtualId(sessionId) || isAgentCallVirtualId(sessionId)
  if (!isVid) return sessionId
  if (!VID_RESOLVABLE_RPC.has(method)) {
    throw new VidRpcRejectedError(method, sessionId, 'unregistered')
  }
  const real = resolveVirtualSessionId(sessionId, vidOwnerResolver?.(sessionId))
  if (real === undefined) {
    throw new VidRpcRejectedError(method, sessionId, 'unresolvable')
  }
  return real
}
