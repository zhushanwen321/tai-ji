/**
 * ITerminalService port —— drawer 集成终端的 PTY 生命周期契约（Phase 2）。
 *
 * 🔒 三层架构：services 定义 port，services/terminal/terminal-service.ts 实现。
 * TerminalMessageHandler 经此 port 调用，不直接依赖具体 TerminalService。
 *
 * 编排职责（实现侧 TerminalService）：
 * 1. 经 node-pty spawn 交互式 shell（shell/shellArgs 从 IConfigService.getTerminalShell 读，
 *    fallback $SHELL → /bin/bash，win: powershell）
 * 2. 持有实例注册表（ptyMap: Map<terminalId, IPty>，terminalId = `term:<sessionId>:<序号>`），
 *    与 session-pool 同生命周期；**键集即存活实例全集**（不另建平行注册结构）
 * 3. PTY 输出经 publish 推 terminal.data；退出推 terminal.exit；就绪推 terminal.alive；
 *    写失败推 terminal.writeFailed（四帧 payload 均带 sessionId + terminalId）
 * 4. 会话级序号计数器：单次 runtime 生命周期内单调递增、实例关闭后序号不回填（设计 §2.3 不变量①）
 *
 * 错误对象用 `Object.assign(new Error(msg), { code })` 扁平模式（仿 worktree-service）：
 * terminal 错误码只在本域消费，无需跨层 instanceof，扁平字段利于测试 toMatchObject。
 * 错误码联合见 shared TerminalEnvelopeCode（runtime ↔ renderer 契约 SSOT）。
 *
 * 生命周期挂钩：session 销毁（sessionService.onSessionDelete）→ destroyPty；
 * runtime shutdown → destroyAllPties。
 * PTY 是 lazy spawn（首次打开 terminal tab 才创建），session 创建时不占进程。
 */
import type { TerminalInstanceSummary } from '@taiji/shared'

/**
 * terminal PTY 控制 port（多实例主键 = terminalId）。
 *
 * 失败模式（实现抛 Object.assign 错误，code 为 TerminalErrorCode）：
 * - spawn_failed：pty.spawn 失败（shell 不存在/无执行权限）
 * - unknown_terminal_id：操作的 terminalId 不在实例注册表（否定回执；renderer 据此回收幽灵条目）
 * - terminal_id_session_mismatch：terminalId 的会话段与请求 sessionId 不一致（交叉校验拒绝）——
 *   与 unknown_terminal_id **必须不同码**：同码会把仍存活实例误判为幽灵并触发关闭沿回收
 * - resize_failed / kill_failed：对应 node-pty 操作失败（存量码保留）
 *
 * 注意：写/调尺寸/杀/attach 对**不存在的实例**抛 unknown_terminal_id（退役「静默 no-op」语义，
 * 静默丢失正是重启后向死实例敲命令、输入无反馈消失的事故形态）。缺 terminalId 属畸形请求，
 * 由 protocol 入口（TerminalMessageHandler）逐帧拒绝，唯一豁免 = spawn 新建形态。
 */
export interface ITerminalService {
  /**
   * 创建/复用 PTY（lazy：首次打开 terminal tab 调用）。cwd 省略则用 process.cwd()。
   *
   * 双形态（设计 §3.3「网络消息」）：
   * - **新建形态**（terminalId 省略）：以会话序号计数器分配 `term:<sid>:<n>` → spawn 新实例，
   *   返回分配的 terminalId（唯一编号来源 = runtime，renderer 以 ack 回传值为准建档）；
   * - **指定形态**（terminalId 给出）：实例存活则幂等 no-op 并原样返回 terminalId；
   *   不存在则抛 unknown_terminal_id；会话段与 sid 不一致抛 terminal_id_session_mismatch。
   *
   * 成功后广播 terminal.alive；PTY 输出广播 terminal.data；退出广播 terminal.exit。
   */
  spawn(sid: string, cwd: string | undefined, cols: number, rows: number, terminalId?: string): Promise<string>
  /** 向实例 PTY 写入字节（用户输入或联动 2 填命令）。实例不存在抛 unknown_terminal_id。 */
  write(sid: string, terminalId: string, data: string): void
  /** 调整 PTY 尺寸（xterm fit addon 触发）。实例不存在抛 unknown_terminal_id。 */
  resize(sid: string, terminalId: string, cols: number, rows: number): void
  /** 主动 kill 实例 PTY（terminal 工具栏 kill 按钮）。实例不存在抛 unknown_terminal_id。 */
  kill(sid: string, terminalId: string): void
  /**
   * 通知 PTY 当前有活跃视图（terminal tab 打开）。实例不存在抛 unknown_terminal_id
   *（该帧是幽灵条目回收的触发入口之一）。预留给流量控制，当前实现仅做成员资格校验。
   */
  attach(sid: string, terminalId: string): void
  /**
   * 查询会话实例清单（`terminal.list` 对账 reply）。
   * 范围钉死为「被查询会话」：枚举基准 = terminalId 键的**精确前缀** `term:<sid>:`
   * （禁按冒号切分取段，前提「sid 域不含冒号」见设计 §0.5 P7）；他会话实例不参与返回。
   * 清单来自注册表派生，条目 alive 恒 true（保留字段供 renderer 置 ptyAlive 镜像）。
   */
  listInstances(sid: string): TerminalInstanceSummary[]
  /**
   * 销毁指定 session 的**全部**实例（会话删除时调用）。kill 进程 + 移除注册表条目。
   * 保留 destroyPty 旧名的调用点（u4 切链前）——本方法是会话维度语义的权威实现。
   */
  destroySessionPties(sid: string): void
  /**
   * 销毁全部实例（runtime shutdown 链调用，对齐 server.stop→destroyAll 语义）。
   * 幂等：无实例时 no-op。
   */
  destroyAllPties(): void
  /**
   * 销毁指定 session 的 PTY（session 销毁时调用）。**等价 destroySessionPties(sid)**
   * ——多实例下语义升级为「该会话全实例杀」（u4 把组合根调用点切到 destroySessionPties 前保留本名可编译）。
   */
  destroyPty(sid: string): void
}
