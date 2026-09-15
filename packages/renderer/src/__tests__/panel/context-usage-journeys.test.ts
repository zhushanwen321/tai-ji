/**
 * context 用量 journey 集成测试（context-consistency Phase 3.2 层 3）
 * （用例定义：context-consistency-equivalence-test §2 层 3，父文档 §4 A1/A7 自动化）。
 *
 * 三视角中的使用者黑盒视角：mount 真实 ContextCapacityPopover，断言用户可见 DOM 文本
 * （按钮「{used}K · {percent}%」/「—」）。数值文本按组件 formatTokens 实际输出断言
 * （21K/30K，K/M 制），不按设计文档示例字面（「万」制）猜。
 *
 * journey：
 * - J1 切走再切回：A 真值 → B 无值占位 → 切回 A（RPC 往返期显示分区缓存，无闪横线）
 *   → getContext(A) resolve 后台 turn 新值 → 显示更新（无条件恢复腿，A7）；
 * - J2 0 帧哨兵：A 视图下全 0 帧 → 显示不变 + console.warn（D4 journey 级验证）。
 *
 * mock 边界：session.getContext mock 为受控 deferred（transport 层不在本层职责，对齐
 * use-context-usage.test.ts 的双 mock 形态——门面 '@/api' 须重指 mock 的 domain，断言才与
 * mock 共用同一 vi.fn）；事件走真实 events.dispatchSession 分发通道（stateSnapshot 回放在
 * renderer 侧最终也经此通道派发，等价覆盖）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/context-usage-journeys.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import * as events from '@taiji/core/transport/api'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { __clearInFlightContextFetchForTest } from '@/composables/features/model/useContextUsage'

import ContextCapacityPopover from '@/components/panel/ContextCapacityPopover.vue'

// ── mock 边界：getContext RPC mock 掉（受控 deferred）；门面 session 重指 mock domain ──
// vitest 注入 VITE_MOCK=true 使 '@/api' 门面默认指向 mock 门面（mock getContext 会返回
// 固定真值，污染「无值/在途」断言），须重指才能与断言共用同一 vi.fn。
const getContextMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/session', () => ({ getContext: getContextMock }))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  return { ...actual, session }
})

/** getContext reply / context.update 载荷形状（D1：字段缺失 = 无值）。 */
interface CtxReply {
  sessionId: string
  inputTokens?: number
  contextLimit?: number
  usagePercent?: number
}

/** 在途 RPC 的受控 deferred（mock 发起时登记，测试按编排 resolve）。 */
interface PendingRpc {
  sid: string
  resolve: (v: CtxReply) => void
  reject: (e: unknown) => void
}

let pendingRpcs: PendingRpc[] = []
const mountedWrappers: VueWrapper[] = []

/** mount 容量按钮组件（挂载即触发恢复腿 getContext(sid)，在途受控）。 */
function mountPopover(sid: string): VueWrapper {
  const wrapper = mount(ContextCapacityPopover, { props: { sessionId: sid } })
  mountedWrappers.push(wrapper)
  return wrapper
}

/**
 * 排空在途异步链：setTimeout(0) 是 macrotask，回调执行前所有已排队微任务（resolve →
 * applyReply 写分区 → Vue 调度 flush）全部跑完（与 use-context-usage.test.ts 同款）。
 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

/** resolve 指定 sid 的最早已登记在途 RPC（无则测试编排错误）。 */
function resolveForSid(sid: string, reply: CtxReply): void {
  const idx = pendingRpcs.findIndex((e) => e.sid === sid)
  if (idx < 0) throw new Error(`测试编排错误：sid ${sid} 无在途 RPC`)
  const [entry] = pendingRpcs.splice(idx, 1)
  entry.resolve(reply)
}

/** 真实通道派发 context.update ok 帧（stateSnapshot 回放 / live 帧共用形态）。 */
function pushOkFrame(sid: string, used: number, total: number, percent: number): void {
  events.dispatchSession(sid, {
    type: 'context.update',
    payload: { sessionId: sid, inputTokens: used, contextLimit: total, usagePercent: percent },
  })
}

/** 用户可见断言锚点：容量按钮全文（「{used}K · {percent}%」或「—」）。 */
function capacityText(wrapper: VueWrapper): string {
  return wrapper.get('[title="上下文容量"]').text()
}

beforeEach(() => {
  setActivePinia(createPinia())
  pendingRpcs = []
  getContextMock.mockReset()
  getContextMock.mockImplementation(
    (sid: string) =>
      new Promise<CtxReply>((resolve, reject) => {
        pendingRpcs.push({ sid, resolve, reject })
      }),
  )
  __clearSessionCleanupRegistryForTest()
  __clearInFlightContextFetchForTest()
})

afterEach(() => {
  while (mountedWrappers.length) mountedWrappers.pop()?.unmount()
})

describe('J1: 切走再切回——分区缓存无闪横线，恢复腿收敛新值（G1/G2/G3）', () => {
  it('A 真值 → B 无值 → 切回 A 显示缓存 → getContext resolve 后更新（父文档 A1+A7）', async () => {
    const wrapper = mountPopover('A')
    await settle()
    // 首拉在途，分区 unknown → 「—」（无假数字）
    expect(capacityText(wrapper)).toContain('—')

    // A 的 stateSnapshot 回放 ok 帧 → 按钮显示 A 的用量（21000 → 21K，formatTokens 实际输出）
    pushOkFrame('A', 21000, 600000, 3.5)
    await settle()
    expect(capacityText(wrapper)).toContain('21K')
    expect(capacityText(wrapper)).toContain('3.5%')

    // A 首拉 resolve（与帧同值）：显示不变
    resolveForSid('A', { sessionId: 'A', inputTokens: 21000, contextLimit: 600000, usagePercent: 3.5 })
    await settle()
    expect(capacityText(wrapper)).toContain('21K')

    // 切到 B：B 的快照含无值占位帧 + reply 无值 → 「—」（合法无值诚实显示，G2）
    await wrapper.setProps({ sessionId: 'B' })
    await settle()
    events.dispatchSession('B', { type: 'context.update', payload: { sessionId: 'B' } })
    resolveForSid('B', { sessionId: 'B' })
    await settle()
    expect(capacityText(wrapper)).toContain('—')

    // 切回 A：RPC 往返期间即显示分区缓存值「21K · 3.5%」（无闪横线，G1）
    await wrapper.setProps({ sessionId: 'A' })
    await settle()
    expect(capacityText(wrapper)).toContain('21K')
    expect(capacityText(wrapper)).toContain('3.5%')

    // getContext(A) resolve 后台 turn 产生的新值（30000 → 30K，A7 无条件恢复腿）
    resolveForSid('A', { sessionId: 'A', inputTokens: 30000, contextLimit: 600000, usagePercent: 5 })
    await settle()
    expect(capacityText(wrapper)).toContain('30K')
    expect(capacityText(wrapper)).toContain('5%')

    // 恢复腿无条件触发：A 首拉 + A 切回重拉各一次（B 同理），非「有缓存不拉」
    const callsForA = getContextMock.mock.calls.filter((c) => c[0] === 'A')
    expect(callsForA).toHaveLength(2)
  })
})

describe('J2: 0 帧防御哨兵——全 0 残帧不清显示（D4 journey 级）', () => {
  it('A 视图下喂全 0 帧 → 显示不变 + 哨兵 warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = mountPopover('A')
    await settle()
    pushOkFrame('A', 21000, 600000, 3.5)
    await settle()
    expect(capacityText(wrapper)).toContain('21K')

    // 全 0 基线残帧（物理上不可能是真值）→ 哨兵丢弃，不把显示清成「—」
    events.dispatchSession('A', {
      type: 'context.update',
      payload: { sessionId: 'A', inputTokens: 0, contextLimit: 0, usagePercent: 0 },
    })
    await settle()
    expect(capacityText(wrapper)).toContain('21K')
    expect(capacityText(wrapper)).toContain('3.5%')
    expect(warnSpy).toHaveBeenCalledWith('[context-usage] dropping impossible all-zero frame', 'A')
    warnSpy.mockRestore()
  })
})
