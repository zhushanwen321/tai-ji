/**
 * u8-pi-respawn core 消费链测试（crash-resilience §3.3 D7）：
 * ① route-inbound 的 session.restored / session.restoreFailed 条目 → InboundEffects 回调
 *   （session.exited 兜底同款契约：dispatchSession 后触发、payload 透传）；
 * ② chat store appendRespawnNotice：提示条消息形态（customType = PI_RESPAWN_NOTICE_CUSTOM_TYPE、
 *   details.variant、liveOnly、display:true、fallback 文本入 content）；
 * ③ 提示条 reconcile 保留（mergeBaselineWithLive 拣回重插修复）：truncated=true 窗口合并
 *   后提示条仍在（锚位/更早历史/幂等）、TTL 过期消退、非 respawn liveOnly 不受影响。
 *
 * 三个消费面共置一文件（同一 u8 消费链，且避免与并行单元同文件冲突）。纯内存，不触 fs。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope } from 'vue'
import { configureRouteInbound } from '../../../coordination/route-inbound'
import type { TransportPorts, InboundEffects } from '../../../coordination/route-inbound'
import { resetSubscriptionStates } from '../../../coordination/subscription-state'
import { PI_RESPAWN_NOTICE_CUSTOM_TYPE } from '@taiji/shared'
import type { Message, ServerMessage } from '@taiji/shared'
import { createChatStore } from '../store'
import type { ChatStoreInstance } from '../store'

function makePorts(): TransportPorts {
  return {
    pending: {
      resolve: vi.fn(),
      reject: vi.fn(),
      rejectAll: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      resolveEnvelope: vi.fn(),
    },
    events: {
      dispatchSession: vi.fn(),
      dispatchGlobal: vi.fn(),
      dispatchCrossSession: vi.fn(),
    },
    subscribe: vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0, gap: false }),
  }
}

function sessionMsg(type: string, payload: Record<string, unknown>): ServerMessage {
  return { type: type as ServerMessage['type'], payload: { sessionId: 's1', ...payload } } as ServerMessage
}

describe('route-inbound：session.restored / session.restoreFailed 条目（u8 D7）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
  })

  it('session.restored → onSessionRestored 回调（sid + payload 透传），dispatchSession 照常', () => {
    const ports = makePorts()
    const effects: InboundEffects = {
      onSessionRestored: vi.fn(),
    }
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher(sessionMsg('session.restored', { attempts: 1 }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(effects.onSessionRestored).toHaveBeenCalledWith('s1', { sessionId: 's1', attempts: 1 })
  })

  it('session.restoreFailed → onSessionRestoreFailed 回调（willRetry/reason 透传）', () => {
    const ports = makePorts()
    const effects: InboundEffects = {
      onSessionRestoreFailed: vi.fn(),
    }
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher(sessionMsg('session.restoreFailed', { attempts: 2, willRetry: false, reason: 'attach hard-fail' }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(effects.onSessionRestoreFailed).toHaveBeenCalledWith('s1', {
      sessionId: 's1',
      attempts: 2,
      willRetry: false,
      reason: 'attach hard-fail',
    })
  })

  it('未注册 effects 时条目无害（分发照常、无回调）', () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    expect(() => dispatcher(sessionMsg('session.restored', { attempts: 1 }))).not.toThrow()
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
  })
})

describe('chat store appendRespawnNotice（u8 提示条写入点）', () => {
  /** store 实例（effectScope 包裹 onScopeDispose 注册，store.test.ts makeStore 同款） */
  let store: ChatStoreInstance
  let dispose: () => void

  beforeEach(() => {
    const scope = effectScope(true)
    store = scope.run(() => createChatStore())!
    dispose = () => scope.stop()
  })

  afterEach(() => {
    dispose()
  })

  it('restored 形态：customType/variant/liveOnly/display/fallback 文本齐备，追加到消息流', () => {
    store.appendRespawnNotice('s1', 'restored', 'fallback restored text')
    const messages = store.getMessages('s1')
    expect(messages).toHaveLength(1)
    const notice = messages[0]
    expect(notice.role).toBe('system')
    expect(notice.customType).toBe(PI_RESPAWN_NOTICE_CUSTOM_TYPE)
    expect(notice.details).toEqual({ variant: 'restored' })
    expect(notice.liveOnly).toBe(true)
    expect(notice.display).toBe(true)
    expect(notice.content).toBe('fallback restored text')
    expect(notice.status).toBe('complete')
    expect(notice.id.startsWith('sys-')).toBe(true)
  })

  it('restoreFailed 形态：variant 透传（渲染方据此切失败态 + 重试按钮）', () => {
    store.appendRespawnNotice('s1', 'restoreFailed', 'fallback failed text')
    const notice = store.getMessages('s1')[0]
    expect(notice.details).toEqual({ variant: 'restoreFailed' })
    expect(notice.content).toBe('fallback failed text')
  })

  it('追加不覆盖既有消息（append 语义，与 appendSystemNotice 同款）', () => {
    store.appendRespawnNotice('s1', 'restored', 'first')
    store.appendRespawnNotice('s1', 'restoreFailed', 'second')
    const messages = store.getMessages('s1')
    expect(messages).toHaveLength(2)
    expect(messages[1].content).toBe('second')
  })
})

describe('chat store respawnPending 过渡态分区（crash-resilience T4 回流修复）', () => {
  /** store 实例（effectScope 包裹，上方 describe 同款） */
  let store: ChatStoreInstance
  let dispose: () => void

  beforeEach(() => {
    const scope = effectScope(true)
    store = scope.run(() => createChatStore())!
    dispose = () => scope.stop()
  })

  afterEach(() => {
    dispose()
  })

  it('mark/clear/is 三件套：默认 false → mark 后 true → clear 后 false', () => {
    expect(store.isRespawnPending('s1')).toBe(false)
    store.markRespawnPending('s1')
    expect(store.isRespawnPending('s1')).toBe(true)
    store.clearRespawnPending('s1')
    expect(store.isRespawnPending('s1')).toBe(false)
  })

  it('mark 幂等（重复 exited 不破坏恢复窗口单语义），clear 对未 pending session no-op', () => {
    store.markRespawnPending('s1')
    store.markRespawnPending('s1')
    expect(store.isRespawnPending('s1')).toBe(true)
    expect(() => store.clearRespawnPending('s-other')).not.toThrow()
    expect(store.isRespawnPending('s1')).toBe(true)
  })

  it('per-session 隔离：A session pending 不影响 B session（Map/Set 分区范式）', () => {
    store.markRespawnPending('s1')
    expect(store.isRespawnPending('s1')).toBe(true)
    expect(store.isRespawnPending('s2')).toBe(false)
  })

  it('disposeSession 同点清理过渡态分区（session 删除后不留恢复窗口残留）', () => {
    store.markRespawnPending('s1')
    expect(store.isRespawnPending('s1')).toBe(true)
    store.disposeSession('s1')
    expect(store.isRespawnPending('s1')).toBe(false)
  })
})

describe('chat store respawn 提示条 reconcile 保留（crash-resilience D7 修复：mergeBaselineWithLive 拣回重插）', () => {
  /** store 实例（effectScope 包裹，上方 describe 同款） */
  let store: ChatStoreInstance
  let dispose: () => void

  beforeEach(() => {
    const scope = effectScope(true)
    store = scope.run(() => createChatStore())!
    dispose = () => scope.stop()
  })

  afterEach(() => {
    dispose()
  })

  /** 构造 complete user / assistant 消息（store.test.ts 同款形态，无 piEntryId） */
  const userMsg = (id: string, content = 'hi'): Message => ({ id, role: 'user', content, status: 'complete', timestamp: 1 })
  const completeAssistant = (id: string, content = '回复'): Message => ({ id, role: 'assistant', content, status: 'complete', timestamp: 1 })

  it('插入提示条 → 模拟切入 reconcile（truncated=true 窗口合并）→ 提示条仍在（锚定前驱消息之后）', () => {
    const sid = 's1'
    store.hydrate(sid, [userMsg('m1'), completeAssistant('a1')], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
    store.appendRespawnNotice(sid, 'restored', '会话引擎已从崩溃中恢复')
    expect(store.getMessages(sid)).toHaveLength(3)

    // 切入 reconcile：窗口响应覆盖全部分区（windowFirstId=m1 命中分区首位 → 整体合并路径）
    store.reconcileHistory(sid, [userMsg('m1', 'q'), completeAssistant('a1')], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(3)
    expect(msgs[2]!.id.startsWith('sys-')).toBe(true)
    expect(msgs[2]!.customType).toBe(PI_RESPAWN_NOTICE_CUSTOM_TYPE)
    expect(msgs[2]!.liveOnly).toBe(true)
    expect(msgs[2]!.content).toBe('会话引擎已从崩溃中恢复')

    // 再次切入 reconcile：仍恰好一条（拣回幂等，不产生副本）
    store.reconcileHistory(sid, [userMsg('m1', 'q'), completeAssistant('a1')], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
    expect(store.getMessages(sid).map((m) => m.id)).toEqual(msgs.map((m) => m.id))
  })

  it('truncated=true 且分区有更早历史（keptEarlier 分支）：提示条在窗口段被拣回，更早历史保留不动', () => {
    const sid = 's2'
    store.hydrate(sid, [userMsg('m1'), userMsg('m2')], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 4 })
    store.prependHistory(sid, [userMsg('m-early', '更早')])
    store.appendRespawnNotice(sid, 'restoreFailed', '引擎恢复失败')
    store.reconcileHistory(sid, [userMsg('m1'), userMsg('m2')], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 4 })
    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(4)
    expect(msgs[0]!.id).toBe('m-early')
    expect(msgs[0]!.content).toBe('更早')
    expect(msgs[3]!.content).toBe('引擎恢复失败')
  })

  it('提示条插入后有新消息（切走再切回、新消息已落盘进基线）：提示条仍锚在原时序位（前驱之后、新消息之前）', () => {
    const sid = 's3'
    store.hydrate(sid, [userMsg('m1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })
    store.appendRespawnNotice(sid, 'restored', '恢复横幅')
    // 提示条之后用户继续对话（live overlay），随后落盘、切入 reconcile 时已在基线内
    store.setMessages(sid, [...store.getMessages(sid), userMsg('u-1', '继续')])
    store.reconcileHistory(sid, [userMsg('m1'), userMsg('pi-u1', '继续')], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
    const msgs = store.getMessages(sid)
    // u-1 overlay 与基线 pi-u1 文本同源被去重；横幅锚定 m1 之后、pi-u1 之前（真实时序）
    expect(msgs.map((m) => m.id)).toEqual(['m1', msgs[1]!.id, 'pi-u1'])
    expect(msgs[1]!.content).toBe('恢复横幅')
  })

  it('前驱为 live-only overlay（reconcile 后被基线去重）：锚未命中 aIdx=-1 → 退化为尾部追加，仍恰好一条', () => {
    const sid = 's6'
    store.hydrate(sid, [userMsg('m1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })
    // 崩溃前用户已发消息（live overlay，尚未落盘），恢复横幅在其后追加（真实时序：overlay → notice）
    store.setMessages(sid, [userMsg('m1'), userMsg('u-1', '继续')])
    store.appendRespawnNotice(sid, 'restored', '恢复横幅')
    // reconcile：u-1 已落盘进基线（pi-u1 同文本）→ overlay 被文本判据去重；
    // 提示条前驱 u-1 不在合并结果 → 锚未命中（aIdx=-1）→ 尾部追加（可见性优先）
    store.reconcileHistory(sid, [userMsg('m1'), userMsg('pi-u1', '继续')], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(3)
    // id 序列锚定：u-1 被去重不在结果（前驱消失 → 锚未命中），提示条尾部追加
    expect(msgs.map((m) => m.id)).toEqual(['m1', 'pi-u1', msgs[2]!.id])
    expect(msgs[2]!.id.startsWith('sys-')).toBe(true)
    expect(msgs[2]!.customType).toBe(PI_RESPAWN_NOTICE_CUSTOM_TYPE)
    expect(msgs[2]!.liveOnly).toBe(true)
    expect(msgs[2]!.content).toBe('恢复横幅')
    // 再次 reconcile：仍恰好一条（拣回幂等，不产生副本）
    store.reconcileHistory(sid, [userMsg('m1'), userMsg('pi-u1', '继续')], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
    expect(store.getMessages(sid).filter((m) => m.customType === PI_RESPAWN_NOTICE_CUSTOM_TYPE)).toHaveLength(1)
  })

  it('过期提示条（超 5 分钟保留窗口）不再保留（liveOnly 一次性语义，不无限堆积）', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const sid = 's4'
      store.hydrate(sid, [userMsg('m1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 1 })
      store.appendRespawnNotice(sid, 'restored', '旧横幅')
      expect(store.getMessages(sid)).toHaveLength(2)
      vi.setSystemTime(1_000 + 5 * 60 * 1000 + 1)
      store.reconcileHistory(sid, [userMsg('m1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 1 })
      expect(store.getMessages(sid).map((m) => m.id)).toEqual(['m1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('保留范围收窄：非 respawn 的 liveOnly system 消息（stream_warn 形态）切入 reconcile 后仍消失', () => {
    const sid = 's5'
    store.hydrate(sid, [userMsg('m1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 1 })
    store.setMessages(sid, [
      userMsg('m1'),
      { id: 'sys-warn', role: 'system', content: 'stream 超时', status: 'complete', timestamp: Date.now(), liveOnly: true },
    ])
    store.reconcileHistory(sid, [userMsg('m1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 1 })
    expect(store.getMessages(sid).map((m) => m.id)).toEqual(['m1'])
  })
})
