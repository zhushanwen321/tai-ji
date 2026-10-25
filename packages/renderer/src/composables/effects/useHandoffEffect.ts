/**
 * useHandoffEffect —— fast-handoff 全局订阅（agent-driven 模式 wave2 简化版）。
 *
 * 职责（仅刷新 + 跳转）：
 * - 订阅 session.handoffComplete：刷新列表 + 跳转新 session。
 *
 * [chat-flow-consistency §6 裁决表「状态机｜交接在途状态归属」行] handingOff 复位职责已退役：前端 handingOffSessions Set
 * 平行存储删除，进行中状态 = occupancy.handingOff 派生（runtime handoff-service 经
 * 'handingOff-end' 原语在 cleanupInflight 统一复位并广播 session.occupancy 帧）——本效果
 * 不再写任何状态。session.handoffAborted 订阅随之移除（唯一副作用是 Set 复位，广播本体
 * 与 runtime 语义保留，前端零消费）。
 *
 * agent-driven 模式下 doc 注入归 runtime（wave1 HandoffService.runHandoff 已用
 * newClient.prompt(doc) 把 handoff 文档发给新 session pi 触发新 turn）。前端不再负责
 * ensureStreamSubscription / hydrate / appendUser / chatApi.send / segments / 回滚等
 * 时序敏感的注入逻辑——这些都由 runtime + selectSession 内部的 hydrate + 订阅兜底
 * （命令 / 上下文 / subagent / workflow 拉取）承担。广播 payload 因此移除了 doc / reply 字段。
 *
 * 生命周期：App.vue onMounted 调 bindHandoffEffect() 注册全局订阅（单实例），
 * onScopeDispose 随 App 卸载退订。订阅 onGlobalType 返回 off，用数组在
 * onScopeDispose 时全部调用（对齐 bindForkNoticeEffect 范式）。
 */
import { onScopeDispose } from 'vue'
import type { ServerMessage } from '@taiji/shared'
import * as events from '@taiji/core/transport/api'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'

/**
 * 注册全局 handoff 效果（handoffComplete）。
 * 在 App.vue onMounted 调用一次（单实例），onScopeDispose 随 App 卸载退订。
 * 返回 void（对齐 bindForkNoticeEffect 范式，不依赖返回值做退订）。
 */
export function bindHandoffEffect(): void {
  const { loadSessions, selectSession } = useSidebar()

  const offs: Array<() => void> = []

  // handoffComplete：runtime 已 create 新 session + 注入 doc 触发新 turn。
  // 前端只刷新列表 + 跳转新 session（订阅/历史由 selectSession 内部处理）。
  offs.push(events.onGlobalType('session.handoffComplete', (msg) => {
    const payload = (msg as ServerMessage<'session.handoffComplete'>).payload
    const { newSessionId } = payload
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

  onScopeDispose(() => { for (const off of offs) off() })
}
