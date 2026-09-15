/**
 * agentSettled 多播分发（sd-u5/sd-u6 装配的可测提取，PR #189 review）。
 *
 * 组合根 main() 的 agentSettledListeners 是 delivery 内核 settled 边沿唤醒（U5 send
 * 排队）与完成回流检测（U6）共用的订阅列表。分发逻辑原先内联在 createAdapter 的
 * onAgentSettled 注入点闭包里——index.ts import 即执行 main()，闭包不可直测——
 * 提取为本模块承载「单订阅者异常隔离不阻断其余腿」语义。
 */
export function fanOutSettled(
  subscribers: ReadonlySet<(sessionId: string) => void>,
  sessionId: string,
): void {
  for (const listener of subscribers) {
    try {
      listener(sessionId)
    } catch (e) {
      // 降级策略（best-effort）：单订阅者异常仅 warn 隔离，不阻断其余腿（bash flush /
      // delivery 唤醒 / 回流检测各自独立）也不让 interpret 批次崩溃（事件流主链优先）。
      // console 经 initLogger monkey-patch 自动落盘（组合根最早期初始化）。
      console.warn('[runtime] agentSettled listener failed:', e)
    }
  }
}
