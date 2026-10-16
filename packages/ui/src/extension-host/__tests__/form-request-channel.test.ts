// form-request-channel.test.ts —— form/planReview 请求通道共享 factory 单测（MF-1-7）。
//
// 锁定双壳共同不变量（七环节算法单点；桌面 useExtensionUI / 移动 companion-bridge 迁移
// 改指后的行为锚）：
// - ingest：C4 富交互门（form ∨ planReview 放行、普通 dialog 帧拒）+ adaptFrame 适配 +
//   filter 第二道闸（桌面实例分型）+ onIngested 钩子
// - invalidate：摘除前 removed 条目捕获 + 按 requestId 摘除 + onInvalidated 钩子（无命中
//   不触发）
// - reconcile：快照差集剔除（**空快照也剔除**——僵尸请求修剪主算法）+ 补入只入富交互帧 +
//   adaptSnapshot 适配 + onSnapshotReconciled(removedIds)；retainOnly 可选批量路径与缺省
//   remove 路径等效；RPC 失败 warn 静默（不抛）
// - respond：定位失败 → onRespondExpired + false；未送达 → 分区保留 + onRespondUndelivered
//   + false（M1/RD-3#1 可重试不变量）；送达 → 摘除 + onRespondDelivered + true
// - cancel = respond(requestId, null)
// - 读口：firstFormRequest（队首 form 帧）/ planReviewRequests（审批帧列表）
//
// 策略：fake partitions（内存 Map + requestId dedup，对齐双壳实现语义）+ vi.mock extension
// 域断言 getPendingRequests/sendExtensionUIResponse 调用形状。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFormRequestChannel, type FormChannelPartitions, type FormRequestChannel, type FormRequestChannelOptions } from '../form-request-channel'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import type { DialogRequest } from '@taiji/core'

const { mockGetPending, mockSendResponse } = vi.hoisted(() => ({
  mockGetPending: vi.fn(),
  mockSendResponse: vi.fn(),
}))

vi.mock('@taiji/core/transport/api/domains/extension', () => ({
  getPendingRequests: mockGetPending,
  sendExtensionUIResponse: mockSendResponse,
}))

/** fake 分区容器（内存 Map + requestId dedup + 幂等 remove；retainOnly 按用例挂载） */
function fakePartitions(): FormChannelPartitions & { map: Map<string, ExtensionUIRequest[]> } {
  const map = new Map<string, ExtensionUIRequest[]>()
  return {
    map,
    get: (sid) => map.get(sid) ?? [],
    add: (sid, req) => {
      const list = map.get(sid) ?? []
      if (list.some((r) => r.requestId === req.requestId)) return
      map.set(sid, [...list, req])
    },
    remove: (sid, ids) => {
      const list = map.get(sid)
      if (!list) return
      const set = new Set(ids)
      const next = list.filter((r) => !set.has(r.requestId))
      if (next.length === list.length) return
      if (next.length === 0) map.delete(sid)
      else map.set(sid, next)
    },
  }
}

function formReq(requestId: string, overrides: Partial<ExtensionUIRequest> = {}): ExtensionUIRequest {
  return { sessionId: 'sid-a', requestId, dialogKind: 'select', form: true, ...overrides } as ExtensionUIRequest
}

function planReq(requestId: string, overrides: Partial<ExtensionUIRequest> = {}): ExtensionUIRequest {
  return { sessionId: 'sid-a', requestId, dialogKind: 'select', planReview: true, ...overrides } as ExtensionUIRequest
}

/** bus 热帧形状（core DialogRequest：marker 键由索引签名承载，同 useExtensionUI 测试族） */
function dialogFrame(requestId: string): DialogRequest {
  return { requestId, pluginId: '', kind: 'select' } as DialogRequest
}

function formFrame(requestId: string): DialogRequest {
  return { requestId, pluginId: '', kind: 'select', form: true } as DialogRequest
}

let partitions: ReturnType<typeof fakePartitions>
let channel: ReturnType<typeof createFormRequestChannel>

/** 装配测试通道（公共 adapt 双源 + 可选钩子/partitions 覆盖；各用例只声明自己观测的面） */
function makeChannel(
  hooks: Partial<FormRequestChannelOptions> = {},
  adaptFrame?: FormRequestChannelOptions['adaptFrame'],
): FormRequestChannel {
  return createFormRequestChannel({
    partitions,
    adaptFrame: adaptFrame ?? ((sid, req) => formReq(req.requestId, { sessionId: sid })),
    adaptSnapshot: (sid, req) => ({ ...req, sessionId: sid }),
    ...hooks,
  })
}

beforeEach(() => {
  partitions = fakePartitions()
  channel = makeChannel()
  mockGetPending.mockReset().mockResolvedValue([])
  mockSendResponse.mockReset().mockReturnValue(true)
})

describe('ingest：C4 门 + 适配 + filter 第二道闸', () => {
  it('form/planReview 帧放行入分区（adaptFrame 适配）；普通 dialog 帧拒绝', () => {
    channel.ingest('sid-a', formFrame('r1'))
    channel.ingest('sid-a', dialogFrame('r2'))
    expect(partitions.get('sid-a').map((r) => r.requestId)).toEqual(['r1'])

    const planChannel = makeChannel({}, (sid, req) => planReq(req.requestId, { sessionId: sid }))
    planChannel.ingest('sid-a', { ...dialogFrame('r3'), planReview: true } as DialogRequest)
    expect(partitions.get('sid-a').map((r) => r.requestId)).toEqual(['r1', 'r3'])
  })

  it('filter 第二道闸：不放行的适配帧不入分区（实例分型，dedup 归分区实现）', () => {
    channel.ingest('sid-a', formFrame('r1'), () => false)
    expect(partitions.get('sid-a')).toHaveLength(0)
    channel.ingest('sid-a', formFrame('r1'), () => true)
    expect(partitions.get('sid-a')).toHaveLength(1)
  })

  it('onIngested 钩子在写入后收到适配帧', () => {
    const seen: string[] = []
    const c = makeChannel({ onIngested: (_sid, req) => seen.push(req.requestId) })
    c.ingest('sid-a', formFrame('r1'))
    c.ingest('sid-a', dialogFrame('r2')) // C4 拒绝，不触发钩子
    expect(seen).toEqual(['r1'])
  })
})

describe('invalidate：removed 捕获 + 摘除', () => {
  it('按 requestId 摘除；onInvalidated 收到摘除前条目；无命中不触发钩子', () => {
    partitions.add('sid-a', formReq('r1'))
    partitions.add('sid-a', formReq('r2'))
    const seen: Array<{ ids: readonly string[]; removed: readonly string[] }> = []
    const c = makeChannel({
      onInvalidated: (_sid, ids, removed) => seen.push({ ids, removed: removed.map((r) => r.requestId) }),
    })

    c.invalidate('sid-a', ['r1', 'r-miss'])
    expect(partitions.get('sid-a').map((r) => r.requestId)).toEqual(['r2'])
    expect(seen).toEqual([{ ids: ['r1', 'r-miss'], removed: ['r1'] }])

    seen.length = 0
    c.invalidate('sid-a', ['r-miss']) // 无命中：分区不动、钩子不触发
    expect(seen).toEqual([])
  })
})

describe('reconcile：快照差集剔除 + 富交互补入', () => {
  it('空快照也剔除（僵尸请求修剪主算法）；removedIds 随 onSnapshotReconciled 外发', async () => {
    partitions.add('sid-a', formReq('stale'))
    const removedSeen: string[][] = []
    const c = makeChannel({
      onSnapshotReconciled: (_sid, removedIds) => removedSeen.push([...removedIds]),
    })

    mockGetPending.mockResolvedValue([])
    c.reconcile('sid-a')
    await vi.waitFor(() => expect(removedSeen).toHaveLength(1))

    expect(partitions.get('sid-a')).toHaveLength(0) // 空快照剔除
    expect(removedSeen[0]).toEqual(['stale'])
  })

  it('补入只入富交互帧（普通 dialog 帧不进分区）；快照富交互帧保留（keepIds 权威）', async () => {
    partitions.add('sid-a', formReq('kept'))
    mockGetPending.mockResolvedValue([
      formReq('kept'),
      formReq('fresh'),
      { sessionId: 'sid-a', requestId: 'plain', dialogKind: 'select' },
    ])
    channel.reconcile('sid-a')
    await vi.waitFor(() => expect(partitions.get('sid-a').map((r) => r.requestId)).toContain('fresh'))

    expect(partitions.get('sid-a').map((r) => r.requestId).sort()).toEqual(['fresh', 'kept'])
  })

  it('提供 retainOnly 时走批量路径（不逐条 remove）；RPC 失败 warn 静默不抛', async () => {
    const retainCalls: Array<ReadonlySet<string>> = []
    const withRetain = makeChannel({
      partitions: {
        ...partitions,
        retainOnly: (_sid, keepIds) => retainCalls.push(keepIds),
      },
    })
    withRetain.reconcile('sid-a')
    await vi.waitFor(() => expect(retainCalls).toHaveLength(1))
    expect([...retainCalls[0]]).toEqual([])

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockGetPending.mockRejectedValue(new Error('rpc down'))
    expect(() => channel.reconcile('sid-a')).not.toThrow()
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled())
    warnSpy.mockRestore()
  })
})

describe('respond：未送达保留 / 送达摘除 / 已终结丢弃', () => {
  it('定位失败 → onRespondExpired + false（分区不动）', () => {
    const expired: string[] = []
    const c = makeChannel({ onRespondExpired: (_sid, rid) => expired.push(rid) })
    expect(c.respond('sid-a', 'ghost', 'answer')).toBe(false)
    expect(expired).toEqual(['ghost'])
    expect(mockSendResponse).not.toHaveBeenCalled()
  })

  it('未送达 → 分区条目保留（M1/RD-3#1 可重试）+ onRespondUndelivered + false', () => {
    partitions.add('sid-a', formReq('r1'))
    const undelivered: string[] = []
    const c = makeChannel({ onRespondUndelivered: (_sid, rid) => undelivered.push(rid) })
    mockSendResponse.mockReturnValueOnce(false)
    expect(c.respond('sid-a', 'r1', 'answer')).toBe(false)
    expect(undelivered).toEqual(['r1'])
    expect(partitions.get('sid-a').map((r) => r.requestId)).toEqual(['r1'])
  })

  it('送达 → 摘除 + onRespondDelivered（条目与 result 外发）+ true；cancel = respond null', () => {
    partitions.add('sid-a', formReq('r1'))
    const delivered: Array<{ rid: string; result: boolean | string | null }> = []
    const c = makeChannel({
      onRespondDelivered: (_sid, req, result) => delivered.push({ rid: req.requestId, result }),
    })
    expect(c.respond('sid-a', 'r1', 'answer')).toBe(true)
    expect(mockSendResponse).toHaveBeenCalledWith('sid-a', 'r1', 'select', 'answer')
    expect(partitions.get('sid-a')).toHaveLength(0)
    expect(delivered).toEqual([{ rid: 'r1', result: 'answer' }])

    partitions.add('sid-a', formReq('r2'))
    c.cancel('sid-a', 'r2')
    expect(mockSendResponse).toHaveBeenLastCalledWith('sid-a', 'r2', 'select', null)
    expect(partitions.get('sid-a')).toHaveLength(0)
  })
})

describe('读口：firstFormRequest / planReviewRequests', () => {
  it('队首 form 帧命中；无 sid 分区恒 undefined；planReview 列表窄化 selfReview', () => {
    expect(channel.firstFormRequest('sid-a')).toBeUndefined()
    partitions.add('sid-a', formReq('r1'))
    partitions.add('sid-a', formReq('r2'))
    partitions.add('sid-a', planReq('p1', { selfReview: '自审' } as Partial<ExtensionUIRequest>))

    expect(channel.firstFormRequest('sid-a')?.requestId).toBe('r1')
    const plans = channel.planReviewRequests('sid-a')
    expect(plans).toHaveLength(1)
    expect(plans[0].requestId).toBe('p1')
    expect(plans[0].selfReview).toBe('自审')
  })
})
