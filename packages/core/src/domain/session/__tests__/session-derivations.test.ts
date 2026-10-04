// session 派生谓词单测（remote-use U20：A13 排序谓词 + A14 状态派生谓词下沉）。
//
// 验收条款 → 用例映射：
//   1. core 导出谓词与桌面旧谓词行为等价
//      → describe A14「deriveSessionStatus ≡ deriveStatus 等价矩阵」：
//        桌面旧谓词 = useSessionDerivations 包装层的位置参数调用形态
//        deriveStatus(id, chat, isActive, isCompacting, hasBackgroundWork, meta, overlay)；
//        等价断言 = 同一 store 状态下新旧两入口产出逐场景相等（9 态关键分支全覆盖）。
//      → describe A13「sessionsInRuntimeGroupOrder 组序恒等」：
//        桌面旧行为 = SessionList 对 groups 直渲染零排序；谓词输出必须与输入展平原序恒等。
//   3. 移动列表状态点按参数化输入工作（core 侧半边 = 参数化输入契约可独立驱动各分支：
//      blockingOverlay 缺省 false 与显式 false 同输出——移动壳无 extensionUI store 的
//      D9③ 白名单语义在谓词层成立）
//
// 运行：cd packages/core && npx vitest run src/domain/session/__tests__/session-derivations.test.ts
import { describe, expect, it, beforeEach } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { Message, ServerMessage, SessionGroup } from '@taiji/shared'
import { createChatStore } from '../../chat/store'
import type { ChatStoreInstance } from '../../chat/store'
import { deriveStatus } from '../../chat/derive-status'
import { createSessionStore, deriveSessionStatus, sessionsInRuntimeGroupOrder } from '../store'

/** 构造独立 chat store 实例（effectScope 包裹 onScopeDispose 注册 + 测试隔离） */
function makeChatStore(): { store: ChatStoreInstance; dispose: () => void } {
  const scope = effectScope(true)
  const store = scope.run(() => createChatStore())!
  return { store, dispose: () => scope.stop() }
}

function assistantMsg(id: string, overrides: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content: 'ok', status: 'complete', timestamp: 1, ...overrides }
}

function session(id: string, lastActiveAt: number): SessionGroup['sessions'][number] {
  return { id, label: `会话-${id}`, cwd: '/tmp/project', status: 'idle', modelId: 'm', tokenCount: 0, lastActiveAt }
}

describe('A13 sessionsInRuntimeGroupOrder：组序恒等（runtime 权威序唯一定义点）', () => {
  it('多组多会话乱序输入 → 输出与输入展平原序恒等（组间序 + 组内序都不重排）', () => {
    const groups: SessionGroup[] = [
      { cwd: '/b', sessions: [session('b2', 3000), session('b1', 1000)] },
      { cwd: '/a', sessions: [session('a1', 2000)] },
    ]
    // 桌面旧行为 = SessionList 对 groups 直渲染（v-for g.sessions）零排序；
    // lastActiveAt 故意乱序——谓词若做任何客户端重排即与本断言红
    expect(sessionsInRuntimeGroupOrder(groups).map((s) => s.id)).toEqual(['b2', 'b1', 'a1'])
  })

  it('createSessionStore().list 经同一谓词派生（store 投影与谓词唯一定义点同源）', () => {
    const groups: SessionGroup[] = [
      { cwd: '/b', sessions: [session('b1', 1000), session('b2', 9000)] },
      { cwd: '/a', sessions: [session('a1', 5000), session('a2', 4000)] },
    ]
    const store = createSessionStore()
    store.applySnapshot({ groups })
    expect(store.getList().map((s) => s.id)).toEqual(sessionsInRuntimeGroupOrder(groups).map((s) => s.id))
  })

  it('空输入 → 空输出', () => {
    expect(sessionsInRuntimeGroupOrder([])).toEqual([])
  })
})

describe('A14 deriveSessionStatus ≡ deriveStatus（参数化输入 vs 桌面旧位置参数调用）', () => {
  let sut: { store: ChatStoreInstance; dispose: () => void }

  beforeEach(() => {
    setActivePinia(createPinia())
    sut = makeChatStore()
  })

  /** 等价断言：新入口（参数化对象）与桌面旧谓词（位置参数展开）同 store 状态下同输出 */
  function expectParity(
    sid: string,
    inputs: Parameters<typeof deriveSessionStatus>[2],
  ): string {
    const meta = inputs.metaStatus
    const legacy = deriveStatus(
      sid,
      sut.store,
      inputs.isActive,
      inputs.isCompacting,
      inputs.hasBackgroundWork,
      meta,
      inputs.hasBlockingOverlay ?? false,
    )
    const migrated = deriveSessionStatus(sid, sut.store, inputs)
    expect(migrated).toBe(legacy)
    return migrated
  }

  it('未 hydrate + 非活跃 + 无 meta → done（兜底）', () => {
    expect(expectParity('s1', { isActive: false, isCompacting: false, hasBackgroundWork: false })).toBe('done')
  })

  it('isActive=true（pendingSend 空窗）→ pending', () => {
    sut.store.addPendingSend('s1')
    expect(expectParity('s1', { isActive: true, isCompacting: false, hasBackgroundWork: false })).toBe('pending')
  })

  it('isGenerating（message_start）→ streaming', () => {
    sut.store.applyMessageEvent('s1', {
      type: 'message.message_start',
      payload: { sessionId: 's1', messageId: 'a1' },
    } as ServerMessage)
    expect(expectParity('s1', { isActive: true, isCompacting: false, hasBackgroundWork: false })).toBe('streaming')
  })

  it('isCompacting=true → compacting', () => {
    sut.store.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    expect(expectParity('s1', { isActive: false, isCompacting: true, hasBackgroundWork: false })).toBe('compacting')
  })

  it('hasBackgroundWork=true → working（移动输入 = A9 subagent 运行态布尔的消费形态）', () => {
    sut.store.hydrate('s1', [assistantMsg('m1')])
    expect(expectParity('s1', { isActive: false, isCompacting: false, hasBackgroundWork: true })).toBe('working')
  })

  it('末条 assistant toolCall running → waiting（最优先分支）', () => {
    sut.store.hydrate('s1', [
      assistantMsg('m1', { toolCalls: [{ id: 't1', toolName: 'bash', input: {}, status: 'running', startTime: 0 }] }),
    ])
    expect(expectParity('s1', { isActive: false, isCompacting: false, hasBackgroundWork: false })).toBe('waiting')
  })

  it('hasBlockingOverlay=true → waiting；缺省（undefined）与显式 false 同输出（移动恒 false 白名单语义）', () => {
    // 桌面输入：extensionUI pending → waiting
    expect(expectParity('s1', { isActive: false, isCompacting: false, hasBackgroundWork: false, hasBlockingOverlay: true })).toBe('waiting')
    // 移动输入：无该源，缺省与显式 false 等价（均为非 waiting 的回落分支）
    sut.store.hydrate('s2', [assistantMsg('m2')])
    const byDefault = deriveSessionStatus('s2', sut.store, { isActive: false, isCompacting: false, hasBackgroundWork: false })
    const byExplicitFalse = deriveSessionStatus('s2', sut.store, { isActive: false, isCompacting: false, hasBackgroundWork: false, hasBlockingOverlay: false })
    expect(byDefault).toBe(byExplicitFalse)
    expect(byDefault).toBe('done')
  })

  it('metaStatus 终态兜底：error/stopped 未 hydrate 直达；dead 按 deriveStatus 既有语义落 done（桌面侧栏同语义）', () => {
    expect(expectParity('s1', { isActive: false, isCompacting: false, hasBackgroundWork: false, metaStatus: 'error' })).toBe('error')
    expect(expectParity('s2', { isActive: false, isCompacting: false, hasBackgroundWork: false, metaStatus: 'stopped' })).toBe('stopped')
    expect(expectParity('s3', { isActive: false, isCompacting: false, hasBackgroundWork: false, metaStatus: 'dead' })).toBe('done')
  })
})
