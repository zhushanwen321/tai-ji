/**
 * terminal 域 —— drawer 集成终端的 PTY 控制 RPC 封装（Phase 3）。
 *
 * 数据流：renderer TerminalView → terminalApi.spawn/write/resize/kill →
 * runtime TerminalMessageHandler → TerminalService → node-pty。
 *
 * terminal.data/exit/alive 是 service 主动广播（不经此 API），前端经 useSessionEvents 订阅。
 *
 * 依赖方向：api/request（command）+ shared（协议类型 ClientMessageMap）。
 */
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'
import type { ClientMessageMap } from '@taiji/shared'

export type TerminalSpawnParams = ClientMessageMap['terminal.spawn']

/**
 * terminal 域 API。
 *
 * - spawn：创建 PTY（lazy，首次打开 terminal tab）。成功后 runtime 广播 terminal.alive。
 * - write：写入字节（用户输入 / 联动 2 填命令）。不带 \n 则 shell 不提交。
 * - resize：调整 PTY 尺寸（xterm fit addon 触发）。
 * - kill：主动销毁 PTY（工具栏 kill 按钮）。
 * - attach：通知 runtime 该 session terminal 活跃（预留流量控制，当前 no-op）。
 *
 * 都是 ack 型（reply terminal.ack，空 payload）。前端 command() 按 id 匹配 resolve，
 * 不读 reply payload。PTY 输出/退出经广播（terminal.data/exit）驱动。
 */
export const terminalApi = {
  spawn(params: TerminalSpawnParams) {
    return command('terminal.spawn', params, RPC_BACKSTOP_TIMEOUT_MS)
  },
  write(sessionId: string, data: string) {
    return command('terminal.write', { sessionId, data }, RPC_BACKSTOP_TIMEOUT_MS)
  },
  resize(sessionId: string, cols: number, rows: number) {
    return command('terminal.resize', { sessionId, cols, rows }, RPC_BACKSTOP_TIMEOUT_MS)
  },
  kill(sessionId: string) {
    return command('terminal.kill', { sessionId }, RPC_BACKSTOP_TIMEOUT_MS)
  },
  attach(sessionId: string) {
    return command('terminal.attach', { sessionId }, RPC_BACKSTOP_TIMEOUT_MS)
  },
}
