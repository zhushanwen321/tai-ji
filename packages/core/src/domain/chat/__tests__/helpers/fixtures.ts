/**
 * chat 域测试共享 fixture（范式同 transport / domain/settings 的 __tests__/helpers 先例）。
 *
 * 收敛各测试文件逐字重复的构造器（质量审查 C-2 测试脚手架重复收敛批）：
 * - ServerMessage 构造 msg（原 store / useChat / delta-coalescer / effects / entry-truncate 五处本地版）
 * - MessageEffectContext 构造 makeCtx（原 effects / entry-truncate 两处同构版：全 vi.fn 回调）
 * - PiMessageEntry 构造 msgEntry（原 apply-entry / apply-entry-convert /
 *   apply-entry-fold-equivalence 三处本地版）
 *
 * 有意不收敛（本地版有语义差异，保留各文件实现；此处登记差异防误合并）：
 * - effects-defer-confirmation.test.ts makeCtx：inflight 三键是真实计数语义（读写真实
 *   Map，非 vi.fn）且返回类型扩展 inflightOf()——命中回收断言读数值而非调用记录
 * - pending-drain-fifo.test.ts queueUpdate：store 编排内联帧构造（固定 type + sut 闭包），
 *   非通用 msg 形态
 * - Message 实体构造器（store.test.ts 的 userMsg/streamingAssistant/completeAssistant/
 *   baselineUser、chunk-processor.test.ts 的 msg(role)、truncate-tool-output.test.ts 的
 *   makeMessage）：各文件默认值不同（timestamp 0/1/1000、随机 id、toolCalls 预置），
 *   默认值参与断言语义，不强合并
 */
import { ref, shallowRef } from 'vue'
import { vi } from 'vitest'
import type { Message, ServerMessage } from '@taiji/shared'
import type { MessageEffectContext } from '../../effect-types'
import type { PiMessageEntry } from '../../apply-entry'

/** 构造 ServerMessage（payload 默认带 sessionId——各原本地版逐字同构）。 */
export function msg(sid: string, type: string, payload: Record<string, unknown> = {}): ServerMessage {
  return { type, payload: { sessionId: sid, ...payload } } as ServerMessage
}

/**
 * 构造 ctx：真实 vue ref + 回调 mock（D-1 容器：分区值为 ShallowRef<Message[]>）。
 * 默认 sid 's-test'（原 effects.test.ts 文件常量同值）；全回调 vi.fn 供调用断言。
 */
export function makeCtx(initial: Message[] = [], sid = 's-test'): MessageEffectContext {
  return {
    messages: ref(new Map([[sid, shallowRef(initial)]])),
    retryStates: ref(new Map()),
    queueStates: ref(new Map()),
    applyFileChanges: vi.fn(),
    markChangeSetsSuperseded: vi.fn(),
    finalizeSession: vi.fn(),
    clearPendingSend: vi.fn(),
    // m2→W14：queue_update drain 接线 drainN（计数 FIFO）+ appendUser + 深度对账 reconcilePending
    drainN: vi.fn(() => []),
    reconcilePending: vi.fn(),
    appendUser: vi.fn(),
    // w21：entry 载体帧喂 reducer 的接入点（store.applyEntryFrame 注入）
    applyEntryFrame: vi.fn(),
    // steer-bubble u1/D2：inflight 确认计数读写（message_end 腿 2 裁决输入，store 注入）
    getInflight: vi.fn(() => 0),
    incrementInflight: vi.fn(),
    decrementInflight: vi.fn(),
    clearInflight: vi.fn(),
  }
}

/**
 * 构造 PiMessageEntry（真实形态：ISO timestamp / parentId 链——原 apply-entry 族三处
 * 本地版逐字同构；默认 timestamp 取 apply-entry / fold 版 '2026-08-19T10:00:00.000Z'，
 * convert 版的 '2026-09-13' 默认值未被任何调用触达——其全部调用显式传 overrides）。
 */
export function msgEntry(
  id: string,
  body: Record<string, unknown>,
  overrides?: { parentId?: string | null; timestamp?: string },
): PiMessageEntry {
  return {
    type: 'message',
    id,
    parentId: overrides?.parentId ?? null,
    timestamp: overrides?.timestamp ?? '2026-08-19T10:00:00.000Z',
    message: body,
  }
}
