/**
 * useCrashRecoveryNotice —— renderer 崩溃恢复一次性提示条状态（crash-resilience §3.1 T2 / §3.4）。
 *
 * 状态源 = main 侧 window-factory.ts reloadWindowAfterCrash 注入的 URL query
 * （recoveredFrom=crash + crashReason）。首次消费即读 query 并 history.replaceState
 * 剥离标志——「一次性」语义的构造实现：手动刷新（Cmd+R）或后续 reload 时 query 已不在，
 * 提示条不再重现。
 *
 * 窗口级单例状态（非 per-session，ADR-0049 Map 分区范式不适用），useToast 同款模块级
 * ref 范式；CrashRecoveredBar 组件负责渲染，App.vue 挂载。
 *
 * 与 T4 pi-respawn 提示条（RespawnNoticeBar）是两条独立状态链，禁止混用：T4 数据源 =
 * core chat store 的 ephemeral system 消息（对话流内，store respawnPending/restored）；
 * 本条 = URL query 一次性标志（窗口 chrome 层通知）。
 */
import { ref } from 'vue'

// 与 main 侧 window-factory.ts 的 CRASH_RECOVERY_QUERY_FLAG（值 'crash'）及
// reloadWindowAfterCrash 注入的 query key（recoveredFrom / crashReason）对应。
// main/renderer 分属两个 bundle，shared 包未登记这三个常量，本地镜像（值变更时两侧同步）。
const QUERY_FLAG_KEY = 'recoveredFrom'
const QUERY_REASON_KEY = 'crashReason'
const QUERY_FLAG_VALUE = 'crash'

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，已登记 §4 ⑧ 2026-09-12）：崩溃恢复提示条可见态（窗口级一次性通知 UI 状态）
const visible = ref(false)
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记 §4 ⑧ 2026-09-12）：崩溃原因原始值（query 透传字符串）
const reason = ref('')
let consumed = false

/**
 * 消费 URL query 恢复标志。存在 → 记录 reason + 置 visible + 立即剥离标志
 * （replaceState 同文档改写，不触发导航/reload）。不存在 → 零副作用。
 */
function consumeQueryFlag(): void {
  const params = new URLSearchParams(window.location.search)
  if (params.get(QUERY_FLAG_KEY) !== QUERY_FLAG_VALUE) return
  reason.value = params.get(QUERY_REASON_KEY) ?? 'unknown'
  visible.value = true
  params.delete(QUERY_FLAG_KEY)
  params.delete(QUERY_REASON_KEY)
  const qs = params.toString()
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`,
  )
}

/**
 * 窗口级一次性消费（幂等）：首次调用消费 query，后续调用只读状态。
 * 消费环节任何异常不阻断启动（D2 降级契约：恢复链 UI 状态源不得成为新崩溃源）。
 */
export function useCrashRecoveryNotice(): {
  visible: typeof visible
  reason: typeof reason
  dismiss: () => void
  } {
  if (!consumed) {
    consumed = true
    // 消费环节任何异常不阻断启动（D2 降级契约：恢复链 UI 状态源不得成为新崩溃源），
    // 降级 = 本次不展示提示条，与标志缺失行为等价
    try {
      consumeQueryFlag()
    } catch (e) {
      // 降级策略（best-effort）：仅告警不传播——本状态源属恢复链 UI 装饰层，抛错会让
      // 提示条成为新崩溃源（D2 降级契约），吞错代价 = 用户少看一条一次性提示
      console.warn(
        '[crash-recovery] 恢复标志 query 消费失败，本次不展示恢复提示条；' +
          '若持续出现请检查 window.history.replaceState 可用性（崩溃恢复 URL 注入链路）',
        e,
      )
    }
  }
  function dismiss(): void {
    visible.value = false
  }
  return { visible, reason, dismiss }
}

/** 测试钩子：清空模块级单例状态（对齐 __resetXxxForTest 模式），并假设调用方已复位 URL。 */
export function _resetCrashRecoveryNoticeForTest(): void {
  visible.value = false
  reason.value = ''
  consumed = false
}
