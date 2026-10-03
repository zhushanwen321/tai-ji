/**
 * useTerminal 世代判据播种测试（terminal-multi-instance U3 / 设计 §0.5 P6）。
 *
 * 真机时序（本文件构造）：
 * ① App onMounted bootstrap 即建连（token-A → state=connected）；
 * ② useTerminal 经 TerminalView 的 `defineAsyncComponent` 懒加载（底部抽屉默认关闭），
 *    **模块求值晚于首次连接**；
 * ③ 同世代 WS 闪断重连（ws-client 退避 / visibility 复用 currentToken 与 url，token 不变）。
 * 模块观察到的第一条 `connected` 边沿是 ③——旧值若未播种会被判「世代变更」误重置
 * （清空分区 / 订阅 / 滞留命令并弹提示），T11/T12 反向验收落空。
 *
 * 本文件用 vi.mock 固定 ws-client 初态 = 「已连接 + token-A」，使 useTerminal 在
 * **模块求值时**即读到已知 token（播种），再驱动边沿复现 ③。
 * 与 use-terminal.test.ts 的 GEN-2 的区别：后者在 beforeEach 里
 * `__resetTerminalStateForTest` 清掉播种值、再手工喂一次首边沿——恰好掩盖了本时序。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/terminal/use-terminal-generation-seed.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, nextTick, type Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

type WsState = 'disconnected' | 'connected'

// ── mock terminalApi（隔离 RPC）────────────────────────────────────────────
const terminalApiMock = vi.hoisted(() => ({
  spawn: vi.fn(() => Promise.resolve({})),
  write: vi.fn(() => Promise.resolve()),
  resize: vi.fn(() => Promise.resolve()),
  kill: vi.fn(() => Promise.resolve()),
  attach: vi.fn(() => Promise.resolve()),
  list: vi.fn(() => Promise.resolve([])),
}))
vi.mock('@taiji/core/transport/api/domains/terminal', () => ({
  terminalApi: terminalApiMock,
}))

// ── 可控 ws-client 连接态（初态 = 已连接 token-A，供模块求值播种）───────────
const wsControl = vi.hoisted(() => ({
  state: null as Ref<WsState> | null,
  token: 'token-A' as string | null,
}))
vi.mock('@taiji/core/transport/ws-client', async () => {
  const actual = await vi.importActual<typeof import('@taiji/core/transport/ws-client')>(
    '@taiji/core/transport/ws-client',
  )
  const { ref: vueRef } = await import('vue')
  wsControl.state = vueRef<WsState>('connected')
  return {
    ...actual,
    getState: () => wsControl.state,
    getCurrentToken: () => wsControl.token,
  }
})

// 静态 import 在 vi.mock 生效后执行——模块求值时 getState() 已返回 connected、token-A。
import {
  useTerminal,
  __terminalPartitionCountForTest,
} from '@/composables/features/terminal/useTerminal'
import { useToast } from '@/composables/useToast'

const T1 = 'term:s1:1'

/** 驱动 connected 边沿（前值非 connected → connected），模拟 ws-client 重连完成。 */
async function fireReconnectEdge(): Promise<void> {
  wsControl.state!.value = 'disconnected'
  await nextTick()
  wsControl.state!.value = 'connected'
  await nextTick()
  await nextTick()
}

beforeEach(() => {
  setActivePinia(createPinia())
  useToast().toasts.value = []
  for (const key of Object.keys(terminalApiMock) as (keyof typeof terminalApiMock)[]) {
    terminalApiMock[key].mockClear()
  }
  terminalApiMock.spawn.mockResolvedValue({})
  terminalApiMock.list.mockResolvedValue([])
})

describe('世代判据播种（模块懒加载晚于首次连接）', () => {
  it('GEN-SEED: 同世代重连不误重置；真世代变更仍重置', async () => {
    const terminal = useTerminal(ref('s1'))
    terminalApiMock.spawn.mockResolvedValue({ terminalId: T1 })
    await terminal.spawnTerminal('/tmp', 80, 24)
    expect(terminal.instances.value.map((i) => i.terminalId)).toEqual([T1])
    expect(__terminalPartitionCountForTest()).toBe(1)

    // ③ 同世代重连（token 未变）：播种命中 → 不重置（分区 / 条目保持、无重置提示）
    await fireReconnectEdge()
    expect(__terminalPartitionCountForTest()).toBe(1)
    expect(terminal.instances.value.map((i) => i.terminalId)).toEqual([T1])
    expect(useToast().toasts.value).toHaveLength(0)

    // 反向对照：真世代变更（token 变化）→ 仍重置（播种不吞掉真实世代信号）
    wsControl.token = 'token-B'
    await fireReconnectEdge()
    expect(__terminalPartitionCountForTest()).toBe(0)
    expect(terminal.instances.value).toEqual([])
  })
})
