/**
 * useHandoffEffect —— fast-handoff 全局订阅（agent-driven 模式 wave2 简化版）。
 *
 * 职责（仅复位 + 跳转）：
 * - 订阅 session.handoffComplete：复位源 session handingOff + 刷新列表 + 跳转新 session。
 * - 订阅 session.handoffAborted：复位源 session handingOff（用户取消或 abort 兜底）。
 *
 * agent-driven 模式下 doc 注入归 runtime（wave1 HandoffService.runHandoff 已用
 * newClient.prompt(doc) 把 handoff 文档发给新 session pi 触发新 turn）。前端不再负责
 * ensureStreamSubscription / hydrate / appendUser / chatApi.send / segments / 回滚等
 * 时序敏感的注入逻辑——这些都由 runtime + selectSession 内部的 hydrate + 订阅兜底
 * （命令 / 上下文 / subagent / workflow 拉取）承担。广播 payload 因此移除了 doc / reply 字段。
 *
 * 生命周期：App.vue onMounted 调 bindHandoffEffect() 注册全局订阅（单实例），
 * onScopeDispose 随 App 卸载退订。两个订阅各自 onGlobalType 返回 off，用数组在
 * onScopeDispose 时全部调用（对齐 bindForkNoticeEffect 范式）。
 */
import { onScopeDispose } from 'vue'
import type { ServerMessage } from '@taiji/shared'
import * as events from '@taiji/core/transport/api'
import { useChatStore } from '@/stores/chat'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'

/**
 * 注册全局 handoff 效果（handoffComplete + handoffAborted）。
 * 在 App.vue onMounted 调用一次（单实例），onScopeDispose 随 App 卸载退订。
 * 返回 void（对齐 bindForkNoticeEffect 范式，不依赖返回值做退订）。
 */
export function bindHandoffEffect(): void {
  const chat = useChatStore()
  const { loadSessions, selectSession } = useSidebar()

  const offs: Array<() => void> = []

  // handoffComplete：runtime 已 create 新 session + 注入 doc 触发新 turn。
  // 前端只复位源 session handingOff + 刷新列表 + 跳转新 session（订阅/历史由 selectSession 内部处理）。
  offs.push(events.onGlobalType('session.handoffComplete', (msg) => {
    const payload = (msg as ServerMessage<'session.handoffComplete'>).payload
    const { srcSessionId, newSessionId } = payload
    chat.setHandingOff(srcSessionId, false)
    // loadSessions 内部已有 try/catch 不会 reject，无需外层 .catch（死代码）。
    // selectSession 可能 reject（switchSession 网络抖动），保留 .catch 兜底。
    void loadSessions().then(() => {
      // return（非 void）：让 selectSession 的 rejection 传播到 .catch 兜底，
      // 否则 void 会吞掉被 reject 的 promise → unhandledRejection（wave2 回归修复）。
      return selectSession(newSessionId)
    }).catch((e) => {
      console.warn('[handoff-effect] selectSession failed:', e)
    })
  }))

  // handoffAborted：用户取消或 abort 失败兜底，复位源 session handingOff。
  offs.push(events.onGlobalType('session.handoffAborted', (msg) => {
    const payload = (msg as ServerMessage<'session.handoffAborted'>).payload
    chat.setHandingOff(payload.srcSessionId, false)
  }))

  onScopeDispose(() => { for (const off of offs) off() })
}
