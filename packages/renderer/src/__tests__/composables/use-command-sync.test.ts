/**
 * useCommandSync 单测 —— slash 命令补拉闭环。
 *
 * 覆盖（三视角）：
 * 1. 构建者（白盒）：watch(sessionIdRef, immediate) 拉取 → commandStore.applyCommands(reply.sessionId, reply.commands)
 * 2. 使用者（黑盒）：in-flight 去重（同 sid 并发只 1 次 RPC）
 * 3. 观察者（形态）：失败 → store 保留旧值、不抛、console.warn；sid null 不拉
 *
 * [测试缺口登记] 原 FM4 describe 已删：它在测试内手写 events.on handler 复刻
 * CommandPopover.vue 的订阅修复，SUT 不是 useCommandSync（本文件 SUT 只拉取不订阅）——
 * 测试绿不证明 CommandPopover 修复在位（假覆盖）。CommandPopover 的真实事件订阅契约
 * 当前无组件级测试，缺口待补（mount CommandPopover + 真实 events 的组件测试）。
 *
 * mock 边界：session.getCommands mock 掉（transport 层不在本层职责）；commandStore 真实例。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-command-sync.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, ref, nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import * as events from '@taiji/core/transport/api'
import { __resetCommandStoreForTesting, useCommandStore } from '@/composables/features/command/useCommandStore'
import {
  useCommandSync,
  __clearInFlightCommandsFetchForTest,
} from '@/composables/panel/useCommandSync'
import type { ServerMessage } from '@taiji/shared'

// ── mock 边界：getCommands RPC mock 掉；门面 session 重指回 mock 的 domain ──
const getCommandsMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/session', () => ({ getCommands: getCommandsMock }))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  return { ...actual, session }
})

// ── 共享测试基建 ─────────────────────────────────────────────

const SIDS = ['A', 'B'] as const

/** getCommands reply 形状。 */
interface CmdReply {
  sessionId: string
  commands: Array<{ name: string; description?: string; source: string }>
}

/** 在途 RPC 的受控 deferred。 */
interface PendingRpc {
  sid: string
  resolve: (v: CmdReply) => void
  reject: (e: unknown) => void
}

let pendingRpcs: PendingRpc[] = []
const mountedWrappers: VueWrapper[] = []

interface HostHandle {
  sidRef: ReturnType<typeof ref<string | null>>
}

/**
 * 测试宿主组件：在 setup 内调 useCommandSync（useSessionEvents 的 getCurrentInstance
 * 守卫要求组件 setup 上下文）。
 */
function mountHost(initialSid: string | null): HostHandle {
  const sidRef = ref<string | null>(initialSid)
  const wrapper = mount(
    defineComponent({
      setup() {
        useCommandSync(sidRef as ReturnType<typeof ref<string | null | undefined>>)
      },
      render: () => h('div'),
    }),
  )
  mountedWrappers.push(wrapper)
  return { sidRef }
}

/** 排空在途异步链。 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

/** resolve 指定 sid 的最早已登记在途 RPC。 */
function resolveForSid(sid: string, reply: CmdReply): void {
  const idx = pendingRpcs.findIndex((e) => e.sid === sid)
  if (idx < 0) throw new Error(`测试编排错误：sid ${sid} 无在途 RPC`)
  const [entry] = pendingRpcs.splice(idx, 1)
  entry.resolve(reply)
}

/** reject 指定 sid 的最早已登记在途 RPC。 */
function rejectForSid(sid: string, err: unknown): void {
  const idx = pendingRpcs.findIndex((e) => e.sid === sid)
  if (idx < 0) throw new Error(`测试编排错误：sid ${sid} 无在途 RPC`)
  const [entry] = pendingRpcs.splice(idx, 1)
  entry.reject(err)
}

beforeEach(() => {
  pendingRpcs = []
  setActivePinia(createPinia())
  __resetCommandStoreForTesting()
  __clearInFlightCommandsFetchForTest()

  getCommandsMock.mockReset()
  getCommandsMock.mockImplementation(
    (sid: string) =>
      new Promise<CmdReply>((resolve, reject) => {
        pendingRpcs.push({ sid, resolve, reject })
      }),
  )
})

afterEach(() => {
  while (mountedWrappers.length) mountedWrappers.pop()?.unmount()
  document.body.innerHTML = ''
})

// ── 定向用例 ─────────────────────────────────────────────────

describe('挂载/sid 变化触发拉取', () => {
  it('挂载时立即拉取当前 sid（immediate watch）→ applyCommands 写 reply.sessionId 分区', async () => {
    const store = useCommandStore()
    mountHost('A')
    await settle()
    expect(getCommandsMock).toHaveBeenCalledTimes(1)
    expect(getCommandsMock).toHaveBeenCalledWith('A')

    resolveForSid('A', {
      sessionId: 'A',
      commands: [{ name: 'goal', source: 'extension' }, { name: 'todo', source: 'skill' }],
    })
    await settle()

    const cmds = store.getCommands('A')
    expect(cmds.map((c) => c.name)).toEqual(['goal', 'todo'])
  })

  it('sid 变化时拉取新 sid → 新分区写入，旧分区保留', async () => {
    const store = useCommandStore()
    const host = mountHost('A')
    await settle()
    resolveForSid('A', {
      sessionId: 'A',
      commands: [{ name: 'goal', source: 'extension' }],
    })
    await settle()
    expect(store.getCommands('A').map((c) => c.name)).toEqual(['goal'])

    // 切到 B
    host.sidRef.value = 'B'
    await settle()
    expect(getCommandsMock).toHaveBeenCalledTimes(2) // A 首拉 + B 首拉

    resolveForSid('B', {
      sessionId: 'B',
      commands: [{ name: 'review', source: 'skill' }],
    })
    await settle()

    // B 分区写入
    expect(store.getCommands('B').map((c) => c.name)).toEqual(['review'])
    // A 分区保留
    expect(store.getCommands('A').map((c) => c.name)).toEqual(['goal'])
  })

  it('sid 为 null 不拉取', async () => {
    mountHost(null)
    await settle()
    expect(getCommandsMock).not.toHaveBeenCalled()
  })
})

describe('in-flight 去重（同 sid 并发只 1 次 RPC）', () => {
  it('两次并发同 sid 只发 1 次 RPC（模块级 in-flight 去重）', async () => {
    // 双实例模拟 split panel
    mountHost('A')
    await settle()
    mountHost('A')
    await settle()

    // 两个实例都挂载了 A，但模块级去重 → 只 1 次 RPC
    expect(getCommandsMock).toHaveBeenCalledTimes(1)

    resolveForSid('A', {
      sessionId: 'A',
      commands: [{ name: 'goal', source: 'extension' }],
    })
    await settle()

    const store = useCommandStore()
    expect(store.getCommands('A').map((c) => c.name)).toEqual(['goal'])
  })
})

describe('失败降级（D3）', () => {
  it('RPC 失败 → store 保留旧值、不抛、console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = useCommandStore()

    // 先写入旧值
    store.applyCommands('A', [{ name: 'existing', source: 'extension' }])

    mountHost('A')
    await settle()

    // RPC 失败
    rejectForSid('A', new Error('network timeout'))
    await settle()

    // store 保留旧值
    expect(store.getCommands('A').map((c) => c.name)).toEqual(['existing'])
    // console.warn 被调用
    expect(warnSpy).toHaveBeenCalledWith(
      '[useCommandSync] fetch commands failed:',
      'network timeout',
    )

    warnSpy.mockRestore()
  })

  it('RPC 失败不抛异常（catch 兜底）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    mountHost('A')
    await settle()

    // reject 不应导致 unhandled rejection
    rejectForSid('A', new Error('fail'))
    await settle()

    // 如果到这里没抛，测试通过
    expect(true).toBe(true)

    vi.restoreAllMocks()
  })
})
