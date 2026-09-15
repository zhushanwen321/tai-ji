/**
 * ITerminalService port —— drawer 集成终端的 PTY 生命周期契约（Phase 2）。
 *
 * 🔒 三层架构：services 定义 port，services/terminal/terminal-service.ts 实现。
 * TerminalMessageHandler 经此 port 调用，不直接依赖具体 TerminalService。
 *
 * 编排职责（实现侧 TerminalService）：
 * 1. 经 node-pty spawn 交互式 shell（shell/shellArgs 从 IConfigService.getTerminalShell 读，
 *    fallback $SHELL → /bin/bash，win: powershell）
 * 2. 持有 per-session PTY 映射（ptyMap: Map<sessionId, IPty>），与 session-pool 同生命周期
 * 3. PTY 输出经 broadcast 推 terminal.data；退出推 terminal.exit；就绪推 terminal.alive
 *
 * 错误对象用 `Object.assign(new Error(msg), { code })` 扁平模式（仿 worktree-service）：
 * terminal 错误码只在本域消费，无需跨层 instanceof，扁平字段利于测试 toMatchObject。
 * 错误码联合见 shared TerminalEnvelopeCode（runtime ↔ renderer 契约 SSOT）。
 *
 * 生命周期挂钩：session 销毁（sessionService.onSessionDelete）→ destroyPty。
 * PTY 是 lazy spawn（首次打开 terminal tab 才创建），session 创建时不占进程。
 */

/**
 * terminal PTY 控制 port。
 *
 * 失败模式（实现抛 Object.assign 错误，code 为 TerminalErrorCode）：
 * - spawn_failed：pty.spawn 失败（shell 不存在/无执行权限）
 * - not_found：操作的 sessionId 无对应 PTY（write/resize/kill 时）
 * - resize_failed / kill_failed：对应 node-pty 操作失败
 *
 * 注意：write/resize/attach 对不存在的 sid 是 no-op（不抛 not_found）——
 * 这些是高频操作，PTY 尚未就绪或已退出的竞态下静默忽略比抛错更健壮。
 * 仅 spawn 主动失败时抛 spawn_failed。
 */
export interface ITerminalService {
  /**
   * 创建并启动 PTY（lazy：首次打开 terminal tab 调用）。
   * cwd 省略则用 process.cwd()（前端通常传 session.cwd）。
   * 成功后广播 terminal.alive；PTY 输出广播 terminal.data；退出广播 terminal.exit。
   * 若该 sid 已有 PTY，no-op（幂等，防重复 spawn）。
   */
  spawn(sid: string, cwd: string | undefined, cols: number, rows: number): Promise<void>
  /** 向 PTY 写入字节（用户输入或联动 2 填命令）。sid 无 PTY 时 no-op。 */
  write(sid: string, data: string): void
  /** 调整 PTY 尺寸（xterm fit addon 触发）。sid 无 PTY 时 no-op。 */
  resize(sid: string, cols: number, rows: number): void
  /** 主动 kill PTY（terminal 工具栏 kill 按钮）。sid 无 PTY 时 no-op。 */
  kill(sid: string): void
  /**
   * 通知 PTY 当前有活跃视图（terminal tab 打开）。
   * 预留给流量控制（高频 terminal.data 拥塞时仅推活跃 sid）。当前实现 no-op。
   */
  attach(sid: string): void
  /**
   * 销毁指定 session 的 PTY（session 销毁时调用）。
   * kill 进程 + 移除 ptyMap 条目。sid 无 PTY 时 no-op。
   */
  destroyPty(sid: string): void
}
