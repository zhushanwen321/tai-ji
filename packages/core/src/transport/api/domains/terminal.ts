/**
 * terminal 域 —— drawer 集成终端的 PTY 控制 RPC 封装（Phase 3 / 多实例 u2）。
 *
 * 数据流：renderer TerminalView → terminalApi.spawn/write/resize/kill/attach →
 * runtime TerminalMessageHandler → TerminalService → node-pty。
 *
 * terminal.data/exit/alive/writeFailed 是 service 主动广播（不经此 API），前端经
 * 模块级订阅（useTerminal）接收——多实例后按 payload.terminalId 路由到对应实例分区。
 *
 * 依赖方向：api/request（command）+ shared（协议类型 ClientMessageMap）。
 */
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'
import type { ClientMessageMap, ServerMessageMap, TerminalInstanceSummary } from '@taiji/shared'

export type TerminalSpawnParams = ClientMessageMap['terminal.spawn']

/**
 * terminal 域 API。
 *
 * - spawn：创建 PTY（lazy，首次打开 terminal tab / 点「+」新建）。**双形态**（设计 §3.3）：
 *   不带 terminalId = 新建（编号由 runtime 分配，经 ack 回包 `terminalId` 回传——renderer
 *   以 ack 为唯一编号来源建档）；带 terminalId = 指定形态（实例存活则幂等 no-op，
 *   不存在则 `unknown_terminal_id`）。
 * - write / resize / kill / attach：对**既有实例**操作，必须带 terminalId（缺编号被 runtime 拒）。
 * - list：查询被查询会话的存活实例清单（返回 `instances`；`terminal.list` 对账入口）。
 *
 * 都是 ack 型（reply terminal.ack）。PTY 输出/退出经广播（terminal.data/exit）驱动。
 */
export const terminalApi = {
  spawn(params: TerminalSpawnParams) {
    return command('terminal.spawn', params, RPC_BACKSTOP_TIMEOUT_MS)
  },
  write(sessionId: string, terminalId: string, data: string) {
    return command('terminal.write', { sessionId, terminalId, data }, RPC_BACKSTOP_TIMEOUT_MS)
  },
  resize(sessionId: string, terminalId: string, cols: number, rows: number) {
    return command('terminal.resize', { sessionId, terminalId, cols, rows }, RPC_BACKSTOP_TIMEOUT_MS)
  },
  kill(sessionId: string, terminalId: string) {
    return command('terminal.kill', { sessionId, terminalId }, RPC_BACKSTOP_TIMEOUT_MS)
  },
  attach(sessionId: string, terminalId: string) {
    return command('terminal.attach', { sessionId, terminalId }, RPC_BACKSTOP_TIMEOUT_MS)
  },
  /**
   * 查询被查询会话的存活实例清单（`terminal.list` 对账）。
   * 返回 ack 的 `instances` 字段（缺省空数组）；拉取失败的 reject 由调用方按触发点分腿处置
   * （世代变更重连腿静默、⌘R / 会话激活腿保留既有条目、下次触发自然重试）。
   */
  async list(sessionId: string): Promise<TerminalInstanceSummary[]> {
    const ack: ServerMessageMap['terminal.ack'] = await command('terminal.list', { sessionId }, RPC_BACKSTOP_TIMEOUT_MS)
    return ack.instances ?? []
  },
}
