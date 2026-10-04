/**
 * useTerminal `terminal.list` 对账的连接世代防护测试（greptile PR #30 发现 2）。
 *
 * 场景：list 请求在途期间 auth token 变化（runtime 重启换 token = 连接世代变更），
 * 旧世代落定的清单响应必须被丢弃——不进实例注册表、按失败腿返回（不自动新建）。
 * 当前接线下断连时 use-connection 的 pendingApi.rejectAll 已把在途请求 reject 走失败腿，
 * 本防护是纵深第二层：传输层行为变化（旧响应不再被 reject 直达注册表）时兜住
 * 「旧清单响应复活幽灵终端」，与 resetTerminalDomain 的世代重置语义配套。
 *
 * mock 策略：与 use-terminal-generation-seed.test.ts 同——ws-client 部分替身
 * （importActual 保留其余导出），世代 token 用可控变量注入。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/terminal/use-terminal-reconcile-generation.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ── mock terminalApi（隔离 RPC）────────────────────────────────────────────
const terminalApiMock = vi.hoisted(() => ({
  spawn: vi.fn(() => Promise.resolve({})),
  write: vi.fn(() => Promise.resolve()),
  resize: vi.fn(() => Promise.resolve()),
  kill: vi.fn(() => Promise.resolve()),
  attach: vi.fn(() => Promise.resolve()),
  list: vi.fn(() => Promise.resolve([] as Array<{ terminalId: string; alive: boolean }>)),
}))
vi.mock('@taiji/core/transport/api/domains/terminal', () => ({
  terminalApi: terminalApiMock,
}))

// ── 可控 ws-client 世代 token（其余导出保留真实实现）────────────────────────
const wsControl = vi.hoisted(() => ({ token: null as string | null }))
vi.mock('@taiji/core/transport/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/ws-client')>()
  return {
    ...actual,
    getCurrentToken: () => wsControl.token,
  }
})

import {
  useTerminal,
  __resetTerminalStateForTest,
  __terminalPartitionCountForTest,
  __terminalSubscriptionCountForTest,
} from '@/composables/features/terminal/useTerminal'
import { hasInstance } from '@/composables/features/terminal/terminal-instance-registry'

const T1 = 'term:s1:1'

beforeEach(() => {
  setActivePinia(createPinia())
  __resetTerminalStateForTest()
  wsControl.token = null
  for (const key of Object.keys(terminalApiMock) as (keyof typeof terminalApiMock)[]) {
    terminalApiMock[key].mockClear()
  }
  terminalApiMock.list.mockResolvedValue([])
})

describe('terminal.list 对账的连接世代防护（greptile PR #30 发现 2）', () => {
  it('请求在途期间世代变更 → 落定的旧世代清单响应被丢弃，注册表/分区/订阅零污染', async () => {
    terminalApiMock.list.mockImplementation(async () => {
      // 模拟 list RPC 在途期间 runtime 重启（auth token 更换 = 连接世代变更）
      wsControl.token = 'token-B'
      return [{ terminalId: T1, alive: true }]
    })
    const terminal = useTerminal(ref('s1'))
    const result = await terminal.reconcileInstances()

    // 失败腿语义：不自动新建、保留既有条目（响应整体丢弃，不按清单增删注册表）
    expect(result).toEqual({ ok: false, count: -1 })
    expect(hasInstance(T1)).toBe(false)
    expect(terminal.instances.value).toEqual([])
    expect(__terminalPartitionCountForTest()).toBe(0)
    expect(__terminalSubscriptionCountForTest()).toBe(0)
  })

  it('同世代（token 未变）响应照常建档（防护不吞正常清单）', async () => {
    terminalApiMock.list.mockResolvedValue([{ terminalId: T1, alive: true }])
    const terminal = useTerminal(ref('s1'))
    const result = await terminal.reconcileInstances()

    expect(result).toEqual({ ok: true, count: 1 })
    expect(hasInstance(T1)).toBe(true)
    expect(terminal.instances.value.map((i) => i.terminalId)).toEqual([T1])
  })
})
