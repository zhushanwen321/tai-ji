/**
 * Per-session streaming 超时 timer 管理（idle 无进展检测）。
 *
 * 从 chat.ts 提取以控制文件行数（max-lines 500 上限）。
 * 通过 initTimers() 闭包注入 finalizeSession 依赖，避免循环 import。
 *
 * [timeout-streaming-ui-idle u-s3] dormant bash timer 契约整链删除（设计 §5.4 D4，
 * 符号清单见该节）：W1 fix-chat-flow-order 起 zero 调用方（bashStart 改写 ephemeral
 * executingBash，不再有 streaming bash 消息可被 timer 收口），dormant + 公开暴露 =
 * 「复活即 5min 墙钟误杀正常 bash」的陷阱。bash 生命周期由 bashResultEffect /
 * markBashError 收口链独立管理，与本文件无关。
 */
// 相对路径直达定义处（store-types.ts）：经 '@xyz-agent/core' barrel 回引会成环，ESM 序隐患
import type { FinalizeReason } from './store-types'

/** 清除 per-session timer（export：store.ts 复用，消除本地双份副本——两版语义等价，clearTimeout(undefined) 是 no-op） */
export function clearSessionTimer(timers: Map<string, ReturnType<typeof setTimeout>>, sessionId: string): void {
  const t = timers.get(sessionId)
  if (t !== undefined) {
    clearTimeout(t)
    timers.delete(sessionId)
  }
}

/**
 * 初始化 timer 模块。在 chat.ts setup 阶段调用一次，返回 timer 操作函数。
 * 闭包捕获 finalizeSession 函数，不暴露到模块外部。
 *
 * [idle-refresh] streaming 阈值改为 getter 注入（docs/design/timeout-streaming-ui-idle.md §6）：
 * 每次挂载时读当前配置值（store 侧可变配置源，setStreamingIdleTimeoutMs 更新后新 arm/refresh
 * 生效），而非 factory 构造期定格的常量——配置链（u-s4）接入后无需重建 store。
 */
export function initTimers(
  finalizeSession: (sessionId: string, reason: FinalizeReason, errorText?: string) => void,
  getStreamingTimeoutMs: () => number,
) {
  /**
   * [ADR-0049 例外] 以下 Map 不套 useSessionScopedState。判据：initTimers() factory 由
   * createChatStore（renderer defineStore('chat') 包装，Pinia 按 id 缓存——见 renderer
   * stores/chat.ts）在 setup 内调用一次（store.ts），factory body 全应用只执行一次，Map
   * 实质单例。factory 体内非 Vue setup 上下文、无 sidRef: Ref<string|null>；Map 存的是 timer
   * handle（ReturnType<typeof setTimeout>，非 reactive 业务状态）。useSessionScopedState 是
   * setup-scoped 工厂（要求 sidRef + reactive 容器契约），factory 体内不适用——强套需把 factory
   * 改造成 setup composable（破坏 Pinia store 单例语义：每次 useStore() 重新执行会重建 Map
   * 丢失单例）+ reactive 容器语义错位（timer handle 不是响应式状态）。与 lru/coordination/
   * panel-orchestration 同属 ADR-0049 例外（单例性来源不同：那几处是模块级 ES module 单例，
   * 本处是 Pinia defineStore factory 单例）。session 销毁清理：disposeAllTimers() 由
   * createChatStore onScopeDispose 编排调用（store.ts）；测试隔离：factory 模式 per-instance
   * （测试直接调 initTimers() 构造新实例）。
   */
  const streamingTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // ── streaming timer（idle 无进展检测，[idle-refresh] docs/design/timeout-streaming-ui-idle.md D1）──

  /**
   * 挂载 streaming idle timer（防 message.complete 永不到的挂死流）。
   * 阈值挂载时读当前配置值（getter 注入，见 initTimers 注释）。
   */
  function armStreamingTimer(sessionId: string): void {
    clearSessionTimer(streamingTimers, sessionId)
    streamingTimers.set(sessionId, setTimeout(() => {
      // [timeout-streaming-ui-idle §5.6 D6] 到期只做 UI 收口，刻意不联动 abort pi：
      // ① idle 误判窗口收敛但非零（stream_delta 桥接外的残余静默窗），一旦 abort 就
      //    亲手杀掉健康长 turn，把「可自愈瞬态」（complete 迟到即恢复，见
      //    effects/complete-recovery.ts）变回 zcode 式不可逆误杀；
      // ② 真挂死的止损收益有限且分形态——工具死锁/进程挂起不烧 token，LLM 黑洞
      //    计费有界于单响应 max_tokens。有界计费代价 < 误杀健康 turn 的不可逆代价。
      //    用户确认死了可手动停止（人工判断补上自动 abort 缺的判断力）。
      finalizeSession(sessionId, 'timeout')
      streamingTimers.delete(sessionId)
    }, getStreamingTimeoutMs()))
  }

  /**
   * 纯活动刷新 idle 计时（D1）：**当前有 timer 才**清 + 重挂（读当前阈值）；
   * 无 timer 则 no-op——finalize 后迟到的活动帧（text_delta 等）不复活 timer
   * （P-H 构造性语义：计时 Map 已无该 sid，刷新即返回）。
   */
  function refreshStreamingTimer(sessionId: string): void {
    if (!streamingTimers.has(sessionId)) return
    armStreamingTimer(sessionId)
  }

  /** 取消 streaming 超时 timer */
  function clearStreamingTimer(sessionId: string): void {
    clearSessionTimer(streamingTimers, sessionId)
  }

  /** HMR / dispose / 测试 teardown 时清理所有 timer */
  function disposeAllTimers(): void {
    for (const t of streamingTimers.values()) clearTimeout(t)
    streamingTimers.clear()
  }

  return { armStreamingTimer, refreshStreamingTimer, clearStreamingTimer, disposeAllTimers }
}
