/**
 * chat store occupancy 投影测试（session-occupancy u5b / D1，验收①）。
 *
 * 锁定：runtime session.occupancy state topic 帧（live 广播 + subscribeSession 的
 * stateSnapshot 回放共用 useChat.ensureStreamSubscription 的同一 handler 通路）驱动
 * chat store 的 sessionPhase 投影：
 * - turn 四态帧序列 → getOccupancy/sessionPhase/isCompacting（compacting 维度派生）跟随
 * - 快照恢复（重连 resubscribeAll / 切回 session 的 stateSnapshot 回放）→ 投影收敛到帧值
 * - setCompacting 双轨通路无残留引用（grep 断言，验收⑥）
 *
 * 回放等价性说明：stateSnapshot 回放经 core routeInbound FALLBACK → dispatchSession →
 * session 通道 → ensureStreamSubscription handler，与 live 帧共享同一消费点（见
 * subscription-state.subscribeSession 对 replayImpl 的接线与 PR #175 review R1）——
 * 本测试对 handler 注入帧序列即覆盖回放通路的消费语义（通道接线由 core
 * subscription-replay.test.ts 锁定）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/chat-occupancy-phase.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerMessage } from '@taiji/shared'
import { textToSegments } from '@taiji/shared'

type StreamCb = (msg: ServerMessage) => void

const { streamCbHolder, streamSubscribeMock, sendMock } = vi.hoisted(() => ({
  streamCbHolder: { current: null as StreamCb | null },
  sendMock: vi.fn(() => Promise.resolve()),
  streamSubscribeMock: vi.fn((_sid: string, cb: StreamCb) => {
    streamCbHolder.current = cb
    return () => {
      streamCbHolder.current = null
    }
  }),
}))

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: { send: sendMock, steer: vi.fn(() => Promise.resolve()), streamSubscribe: streamSubscribeMock },
  session: { writeSegments: vi.fn(() => Promise.resolve()) },
}))

import { useChatStore } from '@/stores/chat'
import { useChat, resetChatModuleState } from '@/composables/features/chat/useChat'

beforeEach(() => {
  setActivePinia(createPinia())
  streamCbHolder.current = null
  streamSubscribeMock.mockClear()
  sendMock.mockClear()
  resetChatModuleState()
})

/** 建立订阅（ensureStreamSubscription 经 send 触发，renderer 薄包装同 core handler） */
async function subscribe(sid: string): Promise<void> {
  await useChat().send(sid, textToSegments('trigger'))
  expect(streamCbHolder.current).not.toBeNull()
}

function occupancyMsg(sessionId: string, turn: 'idle' | 'dispatching' | 'generating' | 'settling', compacting: boolean, bash: boolean): ServerMessage {
  return { type: 'session.occupancy', payload: { sessionId, turn, compacting, bash } } as ServerMessage
}

describe('session.occupancy 帧 → sessionPhase 投影（D1）', () => {
  it('turn 四态帧序列：dispatching → generating → settling → idle，投影逐步跟随', async () => {
    const chat = useChatStore()
    await subscribe('o1')

    streamCbHolder.current!(occupancyMsg('o1', 'dispatching', false, false))
    expect(chat.sessionPhase('o1')).toEqual({ turn: 'dispatching', compacting: false, bash: false })
    expect(chat.getOccupancy('o1').turn).toBe('dispatching')

    streamCbHolder.current!(occupancyMsg('o1', 'generating', false, false))
    expect(chat.sessionPhase('o1').turn).toBe('generating')

    // settling（D6：收尾不是活跃 turn——投影必须能表达，分发器据此 defer）
    streamCbHolder.current!(occupancyMsg('o1', 'settling', false, false))
    expect(chat.sessionPhase('o1').turn).toBe('settling')

    streamCbHolder.current!(occupancyMsg('o1', 'idle', false, false))
    expect(chat.sessionPhase('o1')).toEqual({ turn: 'idle', compacting: false, bash: false })
  })

  it('compacting 维度帧 → isCompacting（occupancy 派生，单一来源）+ sessionPhase 正交表达', async () => {
    const chat = useChatStore()
    await subscribe('o2')

    // 无 occupancy 记录 = 全 idle 缺省
    expect(chat.isCompacting('o2')).toBe(false)

    streamCbHolder.current!(occupancyMsg('o2', 'idle', true, false))
    expect(chat.isCompacting('o2')).toBe(true)
    expect(chat.sessionPhase('o2')).toEqual({ turn: 'idle', compacting: true, bash: false })

    // threshold 形态：generating + compacting 并存（D6 行 3 的投影前提）
    streamCbHolder.current!(occupancyMsg('o2', 'generating', true, false))
    expect(chat.isCompacting('o2')).toBe(true)
    expect(chat.sessionPhase('o2').turn).toBe('generating')

    // compaction_end 三路复位（含失败）→ compacting=false
    streamCbHolder.current!(occupancyMsg('o2', 'idle', false, false))
    expect(chat.isCompacting('o2')).toBe(false)
  })

  it('bash 维度帧 → sessionPhase.bash（renderer bash flag 从 occupancy 取得，D6 行 6 数据源）', async () => {
    const chat = useChatStore()
    await subscribe('o2b')

    streamCbHolder.current!(occupancyMsg('o2b', 'idle', false, true))
    expect(chat.sessionPhase('o2b')).toEqual({ turn: 'idle', compacting: false, bash: true })

    streamCbHolder.current!(occupancyMsg('o2b', 'idle', false, false))
    expect(chat.sessionPhase('o2b').bash).toBe(false)
  })

  it('session.compacting{reason} → reason 文案源保留（浮层消费方不受 membership 通路切换影响）', async () => {
    const chat = useChatStore()
    await subscribe('o3')

    // interpreter 同一挂点先发 session.compacting 再发 occupancy（帧序）
    streamCbHolder.current!({ type: 'session.compacting', payload: { sessionId: 'o3', status: 'compacting', reason: 'manual' } } as ServerMessage)
    streamCbHolder.current!(occupancyMsg('o3', 'idle', true, false))
    expect(chat.isCompacting('o3')).toBe(true)
    expect(chat.getCompactingReason('o3')).toBe('manual')

    // compacted → reason 清除（occupancy compacting=false 由下一帧驱动）
    streamCbHolder.current!({ type: 'session.compacted', payload: { sessionId: 'o3', status: 'compacted' } } as ServerMessage)
    expect(chat.getCompactingReason('o3')).toBeUndefined()
    streamCbHolder.current!(occupancyMsg('o3', 'idle', false, false))
    expect(chat.isCompacting('o3')).toBe(false)
  })
})

describe('occupancy 快照恢复（G4：重连 resubscribeAll / 切回 session）', () => {
  it('回放帧序列收敛：压缩中状态从 stateSnapshot 回放恢复（V5 场景等价断言）', async () => {
    const chat = useChatStore()
    await subscribe('r1')

    // 重连/切回后 subscribe 的 stateSnapshot 回放最后一帧 occupancy{compacting:true}
    //（last-value 快照）——handler 与 live 同通路，投影收敛到帧值。
    streamCbHolder.current!(occupancyMsg('r1', 'idle', true, false))
    expect(chat.isCompacting('r1')).toBe(true)
    expect(chat.sessionPhase('r1')).toEqual({ turn: 'idle', compacting: true, bash: false })
  })

  it('重连快照回放 settle：占用中断连后回放 idle 帧 → 投影复位 + 空记录回落全 idle 缺省', async () => {
    const chat = useChatStore()
    await subscribe('r2')

    // 占用投影（断连前最后已知态）
    streamCbHolder.current!(occupancyMsg('r2', 'generating', true, false))
    expect(chat.isCompacting('r2')).toBe(true)

    // 重连回放：pi 已收口，stateSnapshot 的 last-value 是 idle
    streamCbHolder.current!(occupancyMsg('r2', 'idle', false, false))
    expect(chat.isCompacting('r2')).toBe(false)
    expect(chat.sessionPhase('r2')).toEqual({ turn: 'idle', compacting: false, bash: false })
  })
})

describe('occupancy idle × defer 队列非空 → flush 触发（D6 sendRoute 解除）', () => {
  it('占用帧不触发投递，idle 帧触发（bash 维度参与判定）', async () => {
    const { effectScope } = await import('vue')
    const chat = useChatStore()
    // 预创建 compactQueue 单例（绑定测试 effect scope，对齐 useChat-compacting-fallback 契约）
    const queueMod = await import('@/composables/panel/useCompactQueue')
    effectScope(true).run(() => queueMod.useCompactQueue())
    const queue = queueMod.useCompactQueue()
    queue._clearAllForTest()
    await subscribe('f1')
    // subscribe 阶段的 send（触发订阅）不计入投递断言；并收口其乐观 pendingSend——
    // 否则 flush 的 channel 判定见 isActive=true 全部走 steer（本用例锁定 send 通道）
    sendMock.mockClear()
    chat.clearPendingSend('f1')
    queue.enqueue('f1', '待投递')

    // settling（行 4）：不投递
    streamCbHolder.current!(occupancyMsg('f1', 'settling', false, false))
    await Promise.resolve()
    expect(sendMock).not.toHaveBeenCalled()

    // idle + bash（行 6 形态）：不投递
    streamCbHolder.current!(occupancyMsg('f1', 'idle', false, true))
    await Promise.resolve()
    expect(sendMock).not.toHaveBeenCalled()

    // 全 idle（行 1）：投递（send 携 clientUuid=条目 id；[簇 A2] 提交文本尾附加确认标记）
    const entry = queue.peek('f1')[0]!
    streamCbHolder.current!(occupancyMsg('f1', 'idle', false, false))
    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledWith('f1', `待投递\n<!--taiji:msg:${entry.id}-->`, undefined, { clientUuid: entry.id })
    })
    void chat
  })
})

describe('setCompacting 双轨通路无残留（验收⑥，grep 断言）', () => {
  /** 递归收集目录下 .ts/.vue 文件（不含 __tests__） */
  function collectSourceFiles(dir: string, acc: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (name === '__tests__' || name === 'node_modules') continue
      if (readdirSync(dir, { withFileTypes: true }).find((e) => e.name === name)?.isDirectory()) {
        collectSourceFiles(p, acc)
      } else if (name.endsWith('.ts') || name.endsWith('.vue')) {
        acc.push(p)
      }
    }
    return acc
  }

  it('renderer + core 生产源码零 `.setCompacting(` 调用（通路废弃，u5b 收口）', () => {
    const roots = [
      join(__dirname, '../../composables'),
      join(__dirname, '../../components'),
      join(__dirname, '../../stores'),
      join(__dirname, '../../../../core/src/domain/chat'),
      join(__dirname, '../../../../core/src/domain/composer'),
    ]
    const offenders: string[] = []
    for (const root of roots) {
      for (const file of collectSourceFiles(root)) {
        const content = readFileSync(file, 'utf-8')
        if (/\.setCompacting\(/.test(content)) offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
