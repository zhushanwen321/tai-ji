/**
 * chat store 截断窗口 interrupted 位链路测试（U8 重启中断标记·方向 A，前端半边）。
 *
 * 锁定「重开显示中断提示」的数据链：runtime getHistory 离线判定（尾部形态测试在
 * runtime session-entry-interrupted-tail.test.ts）→ session.history reply interrupted →
 * core historyWindowFromReply 归一 → chat store hydrate/reconcileHistory 写 window 分区 →
 * MessageStream 尾部提示条渲染条件源（getHistoryWindow(sid)?.interrupted === true）。
 * 组件 v-if 断言不在此（MessageStream 无既有 mount 基建、条件源单点在此锁定）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/chat-interrupted-window.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { historyWindowFromReply } from '@taiji/core/domain/chat/truncated-window'
import { useChatStore } from '@/stores/chat'
import type { Message } from '@taiji/shared'

function userMsg(id: string): Message {
  return { id, role: 'user', content: '被打断前的提问', status: 'complete', timestamp: 0 }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('chat store window.interrupted 链路（U8）', () => {
  it('historyWindowFromReply：interrupted 出场透传、缺省不出场（归一单点）', () => {
    expect(historyWindowFromReply({ truncated: false, loadedTurns: 1, totalTurnsEstimate: 1, interrupted: true }))
      .toEqual({ truncated: false, loadedTurns: 1, totalTurnsEstimate: 1, interrupted: true })
    // 活跃路径 / 游标翻页 / 旧 runtime：无 interrupted 字段 → window 无该键（「无判定」语义）
    const noMark = historyWindowFromReply({ truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
    expect('interrupted' in noMark).toBe(false)
  })

  it('hydrate 带 interrupted window：getHistoryWindow 读回置位（重开 hydrate 链渲染条件源）', () => {
    const chat = useChatStore()
    chat.hydrate('int-sid', [userMsg('u1')], historyWindowFromReply({ truncated: false, loadedTurns: 1, totalTurnsEstimate: 1, interrupted: true }))
    expect(chat.getHistoryWindow('int-sid')?.interrupted).toBe(true)
  })

  it('无判定 window：interrupted 不出场，消费方按 undefined（不渲染提示条）处理', () => {
    const chat = useChatStore()
    chat.hydrate('plain-sid', [userMsg('u1')], historyWindowFromReply({ truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 }))
    // MessageStream 派生同款判定：interrupted === true 才渲染
    expect(chat.getHistoryWindow('plain-sid')?.interrupted === true).toBe(false)
  })

  it('reconcileHistory 覆盖语义：中断标记随最新响应整体覆盖（重新切入后以最新判定为准）', () => {
    const chat = useChatStore()
    chat.hydrate('rc-sid', [userMsg('u1')], historyWindowFromReply({ truncated: false, loadedTurns: 1, totalTurnsEstimate: 1, interrupted: true }))
    expect(chat.getHistoryWindow('rc-sid')?.interrupted).toBe(true)
    // 后续响应无中断（如会话被重新落盘收尾）→ 覆盖为无判定
    chat.reconcileHistory('rc-sid', [userMsg('u1')], historyWindowFromReply({ truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 }))
    expect(chat.getHistoryWindow('rc-sid')?.interrupted).toBeUndefined()
  })
})
