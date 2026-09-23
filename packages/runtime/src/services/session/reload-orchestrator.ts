/**
 * ReloadOrchestrator（W5）—— skill 变更触发的 session reload 编排。
 *
 * [定位] service 层单例。skill 文件变动（SkillRegistry 监听）后，对受影响的 session
 * 触发 pi reload（重扫 skill + 重建 runtime），无需重启进程。
 *
 * [编排策略]
 *   - idle session（!isGenerating 且进程存活）→ 立即 promptReload（发 `/__taiji_reload__`）
 *   - running session → 设 pendingReload flag，等该 session 的 message.complete
 *     （agent_end，生成完成）后再 promptReload，清 flag
 *   - best-effort：promptReload 抛错只记日志 + 清 flag，不重试、不阻塞（reload 失败
 *     下次 skill 变更仍可重试，因 flag 已清）
 *   - reload 成功（promptReload resolve）后触发 commands 快照失效
 *     handleSessionReloaded → markDirty 防抖重拉 get_commands → 自动广播
 *     session.commands（slash 列表动态刷新链路闭合点，设计 §3.3.5 / F8）
 *
 * [解耦] 不直接依赖 SkillRegistry / SessionService 具体类型，只依赖注入的窄接口
 * （isSessionIdle / promptReload / hasSession）。组合根 index.ts 绑定：
 *   - skillRegistry.onChange → orchestrator.onSkillChange
 *   - message.complete 广播包装 → orchestrator.onMessageComplete
 *
 * [内部命令] `/__taiji_reload__` 由 builtin npm 扩展 @zhushanwen/pi-agent-ext
 * （extensions/taiji/agent-ext/，打包经 scripts/bundle-extensions.mjs staging 到
 * apps/electron/resources/extensions/）注册，handler 调 pi ctx.reload()。
 * 前端 W4 已过滤 `/__` 前缀命令不显示给用户。
 */
/** Orchestrator 依赖的 SessionService 窄接口（组合根注入完整实现）。 */
export interface ReloadSessionService {
  /** session 是否处于可 reload 的空闲态（!isGenerating 且进程存活）。允许返回 Promise。 */
  isSessionIdle(sessionId: string): boolean | Promise<boolean>
  /** 向 session 发 `/__taiji_reload__` 触发 pi reload。失败抛错由 orchestrator 降级处理。 */
  promptReload(sessionId: string): Promise<void>
  /**
   * reload 成功后失效 commands 快照（slash 列表动态刷新）。仅在 promptReload resolve
   * 后调用（resolve = reload 完成时机，设计 F8）；失败路径不调（快照保留旧值）。
   */
  handleSessionReloaded(sessionId: string): void
  /** session 是否仍存活（进程未退出 / 未被 delete）。缺省时视为存活（不做删除检测）。 */
  hasSession?(sessionId: string): boolean
}

export interface ReloadOrchestratorOptions {
  sessionService: ReloadSessionService
}

export class ReloadOrchestrator {
  /** 待 reload 的 sessionId 集合（running session 在 message.complete 后消费）。 */
  private readonly pendingReload = new Set<string>()

  constructor(private readonly options: ReloadOrchestratorOptions) {}

  /**
   * SkillRegistry 变动回调。遍历受影响 session：
   *   - idle → 立即 promptReload（best-effort，失败清 flag 不重试）
   *   - running → 入 pendingReload 队，等 onMessageComplete 消费（已有 flag 跳过，不重复入队）
   */
  async onSkillChange(affectedSessionIds: string[]): Promise<void> {
    await Promise.allSettled(affectedSessionIds.map((sid) => this.handleSkillChangeForSession(sid)))
  }

  /**
   * message.complete 事件回调。若该 session 在 pendingReload 队中，
   * 说明 skill 变更发生在它 running 期间，现在生成完成，发 reload 清 flag。
   */
  async onMessageComplete(sessionId: string): Promise<void> {
    if (!this.pendingReload.has(sessionId)) return
    this.pendingReload.delete(sessionId)
    // [skill-reload D8-b] pending 队列消费点：queued 决策的兑现时刻（G4 归因——
    // 排队行与消费行按 sessionId 串成完整因果）。
    console.log(`[reload-orchestrator] sessionId=${sessionId} decision=queued-consumed (message.complete)`)
    await this.doReload(sessionId)
  }

  /**
   * R3：session 删除时清 pendingReload 残留。
   * running session 入队后被 delete（或进程异常退出），永不发 message.complete，
   * 不清则永久残留 Set。组合根绑 sessionService.setOnSessionDelete → 此方法。
   */
  clearPending(sessionId: string): void {
    // Set.delete 返回值 = 该 sid 是否确在队中：在队才留痕（普通删除 / 从未入队
    // 的 sid 走此路径是常态，不打 decision 行噪音）。
    const wasQueued = this.pendingReload.delete(sessionId)
    if (wasQueued) {
      // [skill-reload D8-b] queued 行的终态留痕：已落 decision=queued 的 session 被
      // 删除后永不进 onMessageComplete 消费点，仅静默 delete 会让归因链在
      // 「queued → 无下文」处断链（对照组：decision-time 已删有 skipped-deleted 行，
      // 同构场景须同待）。
      console.log(
        `[reload-orchestrator] sessionId=${sessionId} decision=skipped-deleted (session deleted while queued)`,
      )
    }
  }

  /** 单个 session 的 skill 变更处理。 */
  private async handleSkillChangeForSession(sessionId: string): Promise<void> {
    // 排队期 session 被删除（deleteSession）→ 跳过
    if (this.options.sessionService.hasSession && !this.options.sessionService.hasSession(sessionId)) {
      // [skill-reload D8-b] 假跳过归因：affected 集合取自变更时刻，消费时 session 已
      // 离开——必须留痕，否则 S4 归因链在「变更 → 无 reload 行」处断链。
      console.log(`[reload-orchestrator] sessionId=${sessionId} decision=skipped-deleted`)
      this.pendingReload.delete(sessionId)
      return
    }
    const idle = await this.options.sessionService.isSessionIdle(sessionId)
    if (idle) {
      // [skill-reload D8-b] idle 立即 reload（与 skill-registry 的 dir/event 行按
      // sessionId 串因果——console.log 对齐 reap-orphan-pi kill decision 先例）
      console.log(`[reload-orchestrator] sessionId=${sessionId} decision=immediate`)
      // idle：已无 flag（否则 isGenerating 还 true），直接 reload
      await this.doReload(sessionId)
    } else {
      // [skill-reload D8-b] running 入队（消费点见 onMessageComplete 的 queued-consumed 行）
      console.log(`[reload-orchestrator] sessionId=${sessionId} decision=queued`)
      // running：设 flag，等 message.complete
      this.pendingReload.add(sessionId)
    }
  }

  /**
   * 实际发 reload。best-effort：抛错只记日志 + 清 flag（防残留阻塞下次变更）。
   * 不重试（reload 失败多为 pi 进程异常，重试只会再抛）。
   */
  private async doReload(sessionId: string): Promise<void> {
    try {
      await this.options.sessionService.promptReload(sessionId)
      // promptReload resolve = pi reload 完成（F8：extension 命令被 await 执行；
      // session_start 事件 extension-only 不出 stdout，无事件可订阅）→ 此时失效
      // commands 快照才能重拉到 reload 后（含新 skill 命令）的列表。
      this.options.sessionService.handleSessionReloaded(sessionId)
    } catch (e) {
      console.error(`[reload-orchestrator] promptReload failed: sessionId=${sessionId}`, e)
      // 清 flag：下次 skill 变更可重新触发（U13 断言）。不失效快照：reload 未完成，
      // 旧 commands 列表仍有效，等下次 skill 变化重试成功再失效。
      this.pendingReload.delete(sessionId)
    }
  }
}
