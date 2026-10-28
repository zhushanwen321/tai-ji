// @vitest-environment node
import { useChat, resetChatModuleState } from '@/composables/features/chat/useChat';
import { triggerSessionCleanups, __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState';
import { useTurnExpansionStore } from '@/stores/turn-expansion';
import { providePlatform, WS_READY_STATE, type PlatformPort, type WebSocketLike } from '@taiji/core';
import { connect, disconnect, send } from '@taiji/core/transport/ws-client';
import type { ServerMessage, ClientMessage } from '@taiji/shared';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// wave3 簇 [renderer/node] 3 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/composables/useChat-bash.test.ts
 * - __tests__/ws-client-send-boolean.test.ts
 * - stores/__tests__/turn-expansion.test.ts
 */

// ======================================================================
// ← __tests__/composables/useChat-bash.test.ts
// ======================================================================

// ── api mock（holder 捕获 streamSubscribe 的 handler，注入 bash 帧用）──
const apiMock = vi.hoisted(() => {
  const holder: { handler: ((msg: ServerMessage) => void) | null } = { handler: null }
  return {
    holder,
    // bash 回执契约（dmg-r1-2）：默认 = 已执行并收尾
    bash: vi.fn(() => Promise.resolve({ status: 'settled' as const })),
    abortBash: vi.fn(() => Promise.resolve()),
    streamSubscribe: vi.fn((_sid: string, handler: (msg: ServerMessage) => void) => {
      holder.handler = handler
      return () => {
        holder.handler = null
      }
    }),
  }
})

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }) },
  chat: {
    bash: apiMock.bash,
    abortBash: apiMock.abortBash,
    streamSubscribe: apiMock.streamSubscribe,
  },
  // w5：useChat 薄包装 import session.writeSegments（写 segments sidecar），测试 mock 补全
  session: {
    writeSegments: vi.fn().mockResolvedValue(undefined),
  },
}))

// ── useToast mock：捕获 error 调用 ──
const toastError = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  resetChatModuleState()
  vi.clearAllMocks()
  apiMock.holder.handler = null
})

/** 向被测 useChat 订阅的 handler 注入一条 ServerMessage */
function emit(msg: ServerMessage): void {
  if (apiMock.holder.handler) apiMock.holder.handler(msg)
}

/** bashStart 帧（bash-effects executingBash 置位） */
function emitBashStart(sid: string, command: string): void {
  emit({ type: 'message.bashStart', payload: { sessionId: sid, command, excludeFromContext: false, timestamp: 1724000000000 } })
}

/** bashResult 真实终态帧（abortBash 兜底终态已独立为 message.bashAborted 帧，msg-pipeline-debloat D4-3） */
function emitBashResult(sid: string, command: string, output: string): void {
  emit({
    type: 'message.bashResult',
    payload: { sessionId: sid, command, output, exitCode: null, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 1724000000001 },
  })
}

describe('useChat.sendBash / abortBash', () => {
  it('T4: sendBash 透传参数给 chatApi.bash（含 excludeFromContext）', async () => {
    const { sendBash } = useChat()
    await sendBash('s1', 'git status', false)

    expect(apiMock.bash).toHaveBeenCalledOnce()
    expect(apiMock.bash).toHaveBeenCalledWith('s1', 'git status', false)
    // 失败时才 toast，成功路径不调
    expect(toastError).not.toHaveBeenCalled()
  })

  it('T5: 回执不可达且合成终态已收（bashStart→bashResult 已到达）→ toast 抑制 + sendBash resolve', async () => {
    // runtime 超时链路时序：bashStart 置位 → 合成终态帧（诚实文案）清 executingBash →
    // 回执不可达（无 reply 回来）触发本 catch。用户已在气泡看到
    // 终态（三步指引），「失败」toast 冗余且误导（命令可能仍在运行）→ ①b 抑制。
    let rejectBash: (e: unknown) => void = () => {}
    apiMock.bash.mockImplementation(() => new Promise((_resolve, reject) => { rejectBash = reject }))
    const { sendBash } = useChat()

    const sending = sendBash('s-term', 'sleep 3700', false)
    emitBashStart('s-term', 'sleep 3700')
    emitBashResult('s-term', 'sleep 3700', '命令执行超过 1 小时，已停止等待——命令可能仍在后台运行。……')
    rejectBash(new Error('Bash execution failed'))
    await expect(sending).resolves.toBe(true) // 不 throw（错误已消化）；② 终态已呈现 → 契约 true

    expect(apiMock.bash).toHaveBeenCalledOnce()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('T5b: 回执不可达且终态未到（仅 bashStart，executingBash 非空 = backstop 先到）→ toastError 被调', async () => {
    // env 逃生门形态：renderer backstop（3660s）先于 runtime 3600s 判死，气泡无终态，
    // toast 是唯一提示（D5 不变量收窄的已知接受行为）→ 不抑制；命令可能已执行 → 保守 true。
    let rejectBash: (e: unknown) => void = () => {}
    apiMock.bash.mockImplementation(() => new Promise((_resolve, reject) => { rejectBash = reject }))
    const { sendBash } = useChat()

    const sending = sendBash('s-inflight', 'sleep 3700', false)
    emitBashStart('s-inflight', 'sleep 3700')
    rejectBash(new Error('request timeout after 3660000ms'))
    await expect(sending).resolves.toBe(true) // ① 已开跑（瞬时执行行是恢复锚）→ 契约 true

    expect(apiMock.bash).toHaveBeenCalledOnce()
    expect(toastError).toHaveBeenCalledOnce()
    // 收尾：bashAborted 帧（abortBash 兜底终态独立帧，msg-pipeline-debloat D4-3）清 executingBash，
    // 防 bash-effects 模块级 Map 残留泄漏到后续用例（resetChatModuleState 不清该 Map）
    emit({ type: 'message.bashAborted', payload: { sessionId: 's-inflight', timestamp: 1724000000002 } })
  })

  it('T6: abortBash 透传参数给 chatApi.abortBash', async () => {
    const { abortBash } = useChat()
    await abortBash('s1')

    expect(apiMock.abortBash).toHaveBeenCalledOnce()
    expect(apiMock.abortBash).toHaveBeenCalledWith('s1')
  })
})

// ======================================================================
// ← __tests__/ws-client-send-boolean.test.ts
// ======================================================================

describe('ws-client.send 壳侧 import 冒烟（W4 fast-fail 主覆盖在 core invariants）', () => {
  afterEach(() => {
    disconnect()
    vi.restoreAllMocks()
  })

  it('壳侧可解析 connect/disconnect/send 且 send 可执行返回 boolean（import 链路未断）', () => {
    const ws: WebSocketLike = {
      readyState: WS_READY_STATE.CONNECTING,
      send: () => {},
      close: () => {},
      onopen: null,
      onclose: null,
      onmessage: null,
      onerror: null,
    }
    const platform: PlatformPort = {
      kind: 'mock',
      storage: { get: async () => null, set: async () => {}, remove: async () => {} },
      webSocket: { create: () => ws },
    }
    providePlatform(platform)
    connect('ws://test', { auth: 'skip' })

    const msg: ClientMessage = { type: 'ping', payload: {} }
    expect(typeof send(msg)).toBe('boolean')
  })
})

// ======================================================================
// ← stores/__tests__/turn-expansion.test.ts
// ======================================================================

beforeEach(() => {
  // 独立 Pinia 实例：每个 case 拿到全新 store（store 单例 per Pinia）
  setActivePinia(createPinia())
  // 重置模块级 cleanup registry，防上例注册残留污染下例（store 注册了 clearSession）
  __clearSessionCleanupRegistryForTest()
})

describe('turn-expansion store takeover API (window wave TC5/TC6/TC7, ADR-0049)', () => {
  it('TC5: isTakeover 默认 false（key 不存在）；setTakeover(true) 后 isTakeover=true', () => {
    const store = useTurnExpansionStore()
    expect(store.isTakeover('s1', 'turn-1')).toBe(false)
    store.setTakeover('s1', 'turn-1', true)
    expect(store.isTakeover('s1', 'turn-1')).toBe(true)
  })

  it('TC5: setTakeover(false) 显式归位（赋值不 delete，保响应式链，同 collapse 范式）', () => {
    const store = useTurnExpansionStore()
    store.setTakeover('s1', 'turn-1', true)
    store.setTakeover('s1', 'turn-1', false)
    expect(store.isTakeover('s1', 'turn-1')).toBe(false)
  })

  it('TC5: takeoverPartitions 暴露 + getTakeoverPartition 惰性创建（与 partitions 同构范式）', () => {
    const store = useTurnExpansionStore()
    expect(store.takeoverPartitions).toBeInstanceOf(Map)
    // 惰性创建：isTakeover 读时建空分区
    store.isTakeover('s1', 'turn-1')
    expect(store.takeoverPartitions.has('s1')).toBe(true)
    expect(store.getTakeoverPartition('s1')).toBeInstanceOf(Map)
  })

  it('TC5: takeover 与 isExpanded 独立（同 turn 可同时为 true，互不干扰——窗口级 vs turn 级语义分离）', () => {
    const store = useTurnExpansionStore()
    store.expand('s1', 'turn-1')
    store.setTakeover('s1', 'turn-1', true)
    expect(store.isExpanded('s1', 'turn-1')).toBe(true)
    expect(store.isTakeover('s1', 'turn-1')).toBe(true)
    // collapse isExpanded 不影响 takeover（两者独立分区）
    store.collapse('s1', 'turn-1')
    expect(store.isExpanded('s1', 'turn-1')).toBe(false)
    expect(store.isTakeover('s1', 'turn-1')).toBe(true)
  })

  it('TC7: per-session 隔离（s1 setTakeover 不影响 s2）', () => {
    const store = useTurnExpansionStore()
    store.setTakeover('s1', 'turn-1', true)
    expect(store.isTakeover('s1', 'turn-1')).toBe(true)
    // s2 独立分区，默认 false
    expect(store.isTakeover('s2', 'turn-1')).toBe(false)
  })

  it('TC6: clearSession 同时清 partitions + takeoverPartitions（ADR-0049 cleanup 对称）', () => {
    const store = useTurnExpansionStore()
    store.expand('s1', 'turn-1')
    store.setTakeover('s1', 'turn-1', true)
    store.setTakeover('s1', 'turn-2', true)
    expect(store.isExpanded('s1', 'turn-1')).toBe(true)
    expect(store.isTakeover('s1', 'turn-2')).toBe(true)

    // 触发 s1 的 cleanup（store 注册了 clearSession 到 cleanup registry）
    triggerSessionCleanups('s1')

    // clearSession 删除了 s1 分区 key（delete 生效，在后续惰性重建前可观测）
    expect(store.partitions.has('s1')).toBe(false)
    expect(store.takeoverPartitions.has('s1')).toBe(false)
    // 数据清空（后续惰性访问重建空分区，回默认 false）
    expect(store.isExpanded('s1', 'turn-1')).toBe(false)
    expect(store.isTakeover('s1', 'turn-1')).toBe(false)
    expect(store.isTakeover('s1', 'turn-2')).toBe(false)
  })

  it('TC6: clearSession(s1) 不影响 s2（cleanup 按 sid 精确清理）', () => {
    const store = useTurnExpansionStore()
    store.setTakeover('s1', 'turn-1', true)
    store.setTakeover('s2', 'turn-1', true)

    triggerSessionCleanups('s1')

    // s1 清空，s2 保留
    expect(store.isTakeover('s1', 'turn-1')).toBe(false)
    expect(store.isTakeover('s2', 'turn-1')).toBe(true)
  })
})

/**
 * [chat-flow-consistency C4 两段式契约] 手动展开态的清除边界（设计裁决：内存驻留期间保持、
 * 磁盘重载后重置）。两段各有明确依据：驻留期 turn 稳定 id（首条消息 id）不变，切走再切回
 * （LRU 未驱逐，走 reconcileHistory 增量刷新）展开保持；任何走盘重载（LRU 驱逐后切回 /
 * 首次切入）换 id 空间（live u-id 与盘上 entry 派生 id 不相交），接管点
 * （ChatHydratePort.reconcileHistory 适配层——未 hydrate 走盘重载门，内部走 hydrate
 * 全量基线接管；桌面 useSidebar / 移动壳 app-runtime，接线测试见
 * useSidebar-hydrate-turn-expansion.test.ts）显式调 clearSession 重置。
 */
describe('turn-expansion store 两段式契约（C4：驻留保持 / 重载重置）', () => {
  it('驻留保持：切走再切回（无清理动作）后手动展开态原样保留', () => {
    const store = useTurnExpansionStore()
    store.expand('s1', 'turn-live-id')
    // 模拟驻留期切走再切回：store 不发生任何清理（isHydrated 会话走 reconcileHistory 增量
    // 刷新，未 hydrate 走盘重载门不开）——分区与展开标记原样
    expect(store.isExpanded('s1', 'turn-live-id')).toBe(true)
  })

  it('重载重置：reconcileHistory 接管点调 clearSession 后展开态显式归零（同 takeover 一并清）', () => {
    const store = useTurnExpansionStore()
    store.expand('s1', 'turn-live-id')
    store.setTakeover('s1', 'turn-live-id', true)
    // 磁盘重载基线接管点的契约动作（与 session 销毁共用同一清理入口）
    store.clearSession('s1')
    expect(store.isExpanded('s1', 'turn-live-id')).toBe(false)
    expect(store.isTakeover('s1', 'turn-live-id')).toBe(false)
  })

  it('重载重置按 sid 精确：其他会话的驻留展开态不受影响', () => {
    const store = useTurnExpansionStore()
    store.expand('s1', 'turn-live-id')
    store.expand('s2', 'turn-live-id')
    store.clearSession('s1')
    expect(store.isExpanded('s1', 'turn-live-id')).toBe(false)
    expect(store.isExpanded('s2', 'turn-live-id')).toBe(true)
  })
})
