/**
 * useSessionStreamSync —— session 全量事件订阅编排（对齐 bindHandoffEffect/bindForkNoticeEffect 范式）。
 *
 * 职责：session 全量事件订阅编排——watch sessionStore.list，added → ensureStreamSubscription，
 * removed → disposeSession。对齐派生态视野（isGenerating 由消息实体 per-session 惰性派生，D-3），
 * 消除惰性订阅盲区（非交互 session 收到终态事件 message.complete 时，因 ensureStreamSubscription 仅在
 * send/steer/fork/handoff 时惰性建立，未交互 session 无订阅者被 events.dispatchSession 静默丢弃 →
 * streaming assistant 永不收口 → 侧栏卡 running）。改为全量订阅：session 出现在 sessionStore.list
 * 时即建立订阅，从 list 消失时清理。
 *
 * 范式参照 bindHandoffEffect/bindForkNoticeEffect（onScopeDispose，单实例靠 App.vue setup 单次调用保证）。
 *
 * slice 决策：
 * - D1：独立 effect 而非嵌入 useSidebar——session 订阅生命周期与侧栏 UI 无关，独立 effect 解耦且
 *   在 App.vue 顶层注册保证单实例（与 bindHandoffEffect 同层）。
 * - D2：watch flush:'sync' 的时序硬约束——fork-ask 路径 appendSession 后紧接 send
 *   （useForkActions.ts:102→send），异步 flush 会让 send 早于订阅建立，回到原 per-send 时序竞争
 *   bug（pi message.* 事件因无订阅者被丢弃）。sync 保证 appendSession 同 tick 建订阅。
 *
 * 生命周期：App.vue setup 顶层调 bindSessionStreamSync() 注册 watch，onScopeDispose 随 App 卸载取消
 * watch（单实例，对齐 bindHandoffEffect 范式：返回 void，不依赖返回值做退订）。
 */
import { watch, onScopeDispose } from 'vue'
import { useSessionStore } from '@/stores/session'
import { useChatStore } from '@/stores/chat'
import { ensureStreamSubscription, useChat } from '@/composables/features/chat/useChat'
import type { SessionSummary } from '@taiji/shared'

/**
 * 计算新旧 session list 的 id 差集（纯函数，便于单元测试）。
 * added = newList 的 id 中不在 oldList 的；removed = oldList 的 id 中不在 newList 的。
 * 顺序按原数组遍历保留。不处理重复 id（由 sessionStore 保证唯一）。
 */
export function diffSessionList(
  newList: SessionSummary[],
  oldList: SessionSummary[],
): { added: string[]; removed: string[] } {
  const oldIds = new Set(oldList.map((s) => s.id))
  const newIds = new Set(newList.map((s) => s.id))
  const added: string[] = []
  for (const s of newList) {
    if (!oldIds.has(s.id)) added.push(s.id)
  }
  const removed: string[] = []
  for (const s of oldList) {
    if (!newIds.has(s.id)) removed.push(s.id)
  }
  return { added, removed }
}

/**
 * 注册 session 全量事件订阅编排 effect。
 * 在 App.vue setup 顶层调用一次（单实例），onScopeDispose 随 App 卸载取消 watch。
 * 返回 void（对齐 bindHandoffEffect/bindForkNoticeEffect 范式，不依赖返回值做退订）。
 *
 * watch flush:'sync' 是硬约束：fork-ask 路径 appendSession 后紧接 send（useForkActions.ts:102→send），
 * 异步 flush 会让 send 早于订阅建立，回到原 per-send 时序竞争 bug。sync 保证 appendSession 同 tick 建订阅。
 */
export function bindSessionStreamSync(): void {
  const chat = useChatStore()
  const session = useSessionStore()
  const { disposeSession } = useChat()

  const stopWatch = watch(
    () => session.list,
    (newList, oldList) => {
      // 最外层 try-catch：防 sync 回调异常冒泡到触发 list 变更的调用栈（如 appendSession 的调用方 fork-ask/handoff），中断业务流程
      try {
        const { added, removed } = diffSessionList(newList ?? [], oldList ?? [])
        // added：逐个建立订阅，单个失败不阻断其余（ensureStreamSubscription 已幂等，此处 try-catch 防外部异常）
        for (const sid of added) {
          try {
            ensureStreamSubscription(sid, chat, session)
          // eslint-disable-next-line taste/no-silent-catch -- 单 session 订阅失败不阻断其余，warn 记录便于诊断
          } catch (e) {
            console.warn('[session-stream-sync] ensureStreamSubscription failed for sid=' + sid, e)
          }
        }
        // removed：逐个清理（disposeSession 幂等，双重调用安全——chat.disposeSession 不触发 triggerSessionCleanups，自身 has 守卫）
        for (const sid of removed) {
          try {
            disposeSession(sid)
          // eslint-disable-next-line taste/no-silent-catch -- 同上
          } catch (e) {
            console.warn('[session-stream-sync] disposeSession failed for sid=' + sid, e)
          }
        }
      // 防御性后备：常规副作用异常已由内层 per-session try-catch 隔离，本层只兜 diffSessionList 纯函数 bug 或未来回归。
      // 无测试覆盖：diffSessionList 是同模块 export，ESM 模块绑定下 spy 无法覆盖源码内直接引用（详见 useSessionStreamSync.test.ts TC10 降级说明），保护的是纯函数 diffSessionList。
      // eslint-disable-next-line taste/no-silent-catch -- 见上，防御性后备 + console.warn 已记录
      } catch (e) {
        console.warn('[session-stream-sync] watch callback error:', e)
      }
    },
    { flush: 'sync' },
  )

  onScopeDispose(stopWatch)
}
