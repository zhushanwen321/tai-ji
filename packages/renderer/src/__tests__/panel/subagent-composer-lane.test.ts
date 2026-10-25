/**
 * subagent composer 通道单测（subagent-composer 2026-10-18）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者（白盒）：发送/中止终端到 session.subagentAction message/cancel 的参数映射
 *   （vid → mainSid + subagentId 解构）
 * - 使用者（黑盒契约）：send 返回 true = 受理（sendActiveMessage 据此不清草稿）；
 *   false = 失败（core dispatch/send 据此 restoreSegments 恢复草稿）——R2-A5 失败
 *   信号契约同款
 * - 观察者：isStreaming 从 subagent store record 流状态派生（occupancy 对虚拟 id
 *   无投影，sendButtonState stop 态的事实源）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/subagent-composer-lane.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computed, ref } from 'vue'
import { useSubagentStore, subagentVirtualId } from '@/stores/subagent'
import type { SubagentRecord } from '@taiji/shared'
import { useSubagentComposerLane } from '@/composables/panel/subagent-composer-lane'

// session 域 mock（@/api 门面按 subagent-tab.test.ts 同款指回本命名空间）
vi.mock('@taiji/core/transport/api/domains/session', () => ({
  subagentAction: vi.fn().mockResolvedValue(undefined),
  getSubagents: vi.fn().mockResolvedValue({ subagents: [], oversize: false, found: false }),
  getSubagentHistory: vi.fn().mockResolvedValue([]),
  getAgentCallHistory: vi.fn().mockResolvedValue([]),
  getSubagentStreamState: vi.fn().mockResolvedValue({ found: false, msgSeq: 0, lastDeltaSeq: 0, lines: [] }),
}))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  return { ...actual, session }
})

import { subagentAction } from '@taiji/core/transport/api/domains/session'

const MAIN_SID = 's-lane-main'
const SUB_ID = 'sub-lane-1'
const VID = subagentVirtualId(MAIN_SID, SUB_ID)

function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: SUB_ID,
    sessionFile: null,
    agent: 'general-purpose',
    slug: 'worker',
    task: 'do something',
    status: 'idle',
    ...overrides,
  }
}

describe('subagent composer 通道', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.mocked(subagentAction).mockResolvedValue(undefined)
  })

  it('发送：vid 解构为 mainSid + subagentId 走 subagentAction(message)，受理返回 true', async () => {
    useSubagentStore().applyRecords(MAIN_SID, [makeRecord()])
    const lane = useSubagentComposerLane(computed(() => VID))
    expect(lane.isLane.value).toBe(true)

    const accepted = await lane.send([{ type: 'text', text: '换个角度查 Z' }])
    expect(accepted).toBe(true)
    expect(subagentAction).toHaveBeenCalledWith(MAIN_SID, 'message', {
      subagentId: SUB_ID,
      text: '换个角度查 Z',
    })
  })

  it('发送失败：返回 false（R2-A5 契约——调用方恢复草稿），不向上抛', async () => {
    useSubagentStore().applyRecords(MAIN_SID, [makeRecord()])
    vi.mocked(subagentAction).mockRejectedValue(new Error('Session not active'))
    const lane = useSubagentComposerLane(computed(() => VID))

    await expect(lane.send([{ type: 'text', text: 'x' }])).resolves.toBe(false)
  })

  it('非虚拟 id：isLane=false，send 不触达 RPC', async () => {
    const lane = useSubagentComposerLane(computed(() => 'real-session-id'))
    expect(lane.isLane.value).toBe(false)
    await expect(lane.send([{ type: 'text', text: 'x' }])).resolves.toBe(false)
    expect(subagentAction).not.toHaveBeenCalled()
  })

  it('isStreaming：record 在途（running 且无轮终）= true；中止走 cancel 通道', async () => {
    const store = useSubagentStore()
    store.applyRecords(MAIN_SID, [makeRecord({ status: 'running' })])
    const lane = useSubagentComposerLane(computed(() => VID))
    expect(lane.isStreaming.value).toBe(true)

    await lane.abort()
    expect(subagentAction).toHaveBeenCalledWith(MAIN_SID, 'cancel', { subagentId: SUB_ID })
    // 乐观翻边（cancelSubagent store 语义）：中止后 stop 态即退
    expect(lane.isStreaming.value).toBe(false)
  })

  it('ref 响应性：sessionId 切入虚拟 id 即进入通道（切 tab 场景）', () => {
    const sid = ref<string | null>('real-session-id')
    const lane = useSubagentComposerLane(computed(() => sid.value))
    expect(lane.isLane.value).toBe(false)
    sid.value = VID
    expect(lane.isLane.value).toBe(true)
  })
})
