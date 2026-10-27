import { OTHER_VALUE, draftToScheduleFormResult, encodeFormAnswers, formQuestionsOf, initialQuestionState, isPlanReviewFrame, isQuestionAnswered, isRichInteractionFrame, questionKey, scheduleDraftOf, type QuestionState } from '../form-protocol';
import { createFormRequestChannel, type FormChannelPartitions, type FormRequestChannel, type FormRequestChannelOptions } from '../form-request-channel';
import type { DialogRequest } from '@taiji/core';
import type { InternalEvent } from '@taiji/core';
import { InternalEventBus } from '@taiji/core';
import { dispatchGlobal } from '@taiji/core/transport/api';
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← form-protocol.test.ts
// ======================================================================

function choiceReq(overrides: Partial<ExtensionUIRequest> = {}): ExtensionUIRequest {
  return {
    sessionId: 'sid-a',
    requestId: 'req-1',
    dialogKind: 'select',
    form: true,
    formQuestions: [
      { type: 'choice', question: '用哪个数据库？', options: [{ label: 'pg' }, { label: 'mysql' }] },
    ],
    ...overrides,
  }
}

function stateOf(selectedValues: string[], otherText = ''): QuestionState {
  return { selectedValues, otherText }
}

describe('问题 key 与已答判定', () => {
  it('questionKey：header 缺省回落 question 全文（协议 fallback 规则）', () => {
    expect(questionKey({ type: 'text', question: 'q1' })).toBe('q1')
    expect(questionKey({ type: 'text', header: 'h', question: 'q1' })).toBe('h')
  })

  it('choice：普通选项选中 ≥1 即已答；Other 选中无文本不算（另有其他选中则算）', () => {
    const q = { type: 'choice' as const, question: 'q', options: [{ label: 'a' }, { label: 'b' }] }
    expect(isQuestionAnswered(q, stateOf([]), true)).toBe(false)
    expect(isQuestionAnswered(q, stateOf(['a']), true)).toBe(true)
    expect(isQuestionAnswered(q, stateOf([OTHER_VALUE]), true)).toBe(false)
    expect(isQuestionAnswered(q, stateOf([OTHER_VALUE, 'a']), true)).toBe(true)
  })

  it('text / 空 options 退化 choice：非空文本即已答；schedule 委托 ready 入参', () => {
    const text = { type: 'text' as const, question: 'q' }
    expect(isQuestionAnswered(text, initialQuestionState(), true)).toBe(false)
    expect(isQuestionAnswered(text, stateOf([], '答案'), true)).toBe(true)
    const degenerate = { type: 'choice' as const, question: 'q', options: [] }
    expect(isQuestionAnswered(degenerate, stateOf([], '自由文本'), true)).toBe(true)
    const schedule = { type: 'schedule' as const, question: 'q' }
    expect(isQuestionAnswered(schedule, undefined, false)).toBe(false)
    expect(isQuestionAnswered(schedule, undefined, true)).toBe(true)
  })
})

describe('FormAnswers envelope 编码（桌面 FormOverlay.onSubmit 同契约）', () => {
  const single = { type: 'choice' as const, header: 'db', question: '用哪个数据库？', options: [{ label: 'pg' }, { label: 'mysql' }] }
  const multi = { type: 'choice' as const, header: 'feat', question: '要哪些功能？', multi: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }
  const text = { type: 'text' as const, header: 'note', question: '补充说明？' }

  it('单选 = label；多选 = JSON.stringify(label[])；Other 过滤占位符', () => {
    const answers = encodeFormAnswers(
      [single, multi],
      { db: stateOf(['pg']), feat: stateOf(['a', OTHER_VALUE, 'c']) },
      () => null,
    )
    expect(answers).toEqual({ db: 'pg', feat: JSON.stringify(['a', 'c']) })
  })

  it('Other 自由文本写 `${key}__other` 独立键；text 题答案只写 __other 不写主 key', () => {
    expect(encodeFormAnswers(
      [single, text],
      { db: stateOf([OTHER_VALUE], '自定义'), note: stateOf([], '备注内容') },
      () => null,
    )).toEqual({ db__other: '自定义', note__other: '备注内容' })
  })

  it('schedule 题经 scheduleValue 取回显 JSON 写主 key；不可构造返回 null 中止整表', () => {
    const schedule = { type: 'schedule' as const, question: '什么时候跑？', initial: undefined }
    expect(encodeFormAnswers([schedule], {}, () => null)).toBeNull()
    expect(encodeFormAnswers([schedule], {}, () => '{"action":"create"}')).toEqual({
      [schedule.question]: '{"action":"create"}',
    })
  })

  it('无状态的问题跳过（不伪造空答案键）', () => {
    expect(encodeFormAnswers([single], {}, () => null)).toEqual({})
  })
})

describe('schedule 草稿回显（桌面 ScheduleForm 打开即确认路径等价）', () => {
  const baseDraft = {
    kind: 'once' as const,
    schedule: '30 14 2 10 *',
    prompt: '跑每日备份',
    models: ['m1', 'm2'],
  }

  it('once：草稿 cron 经 onceCronToDate 还原再 dateToOnceCron 折叠（往返稳定）', () => {
    const result = draftToScheduleFormResult(baseDraft)
    expect(result).not.toBeNull()
    expect(result!.action).toBe('create')
    expect(result!.kind).toBe('once')
    expect(result!.schedule).toBe(baseDraft.schedule) // 未过时刻往返字节稳定
    expect(result!.prompt).toBe('跑每日备份')
    expect(result!.name).toBeUndefined()
    expect(result!.expires).toBeUndefined() // once 不携带 expires
  })

  it('recurring：schedule 原样（trim）；expires 缺省 7d、显式 30d/never 保留；model 缺省剔除', () => {
    const result = draftToScheduleFormResult({
      ...baseDraft,
      kind: 'recurring',
      schedule: '  */5 * * * *  ',
      expires: '7d',
      model: '不在候选列表的模型',
    })
    expect(result).toEqual({
      action: 'create',
      kind: 'recurring',
      schedule: '*/5 * * * *',
      model: 'm1', // 预选回落候选首项（桌面 initModelSelection 同式）
      prompt: '跑每日备份',
      expires: '7d',
    })
    expect(draftToScheduleFormResult({ ...baseDraft, kind: 'recurring', expires: 'never' })!.expires).toBe('never')
    expect(draftToScheduleFormResult({ ...baseDraft, kind: 'recurring', expires: '30d' })!.expires).toBe('30d')
  })

  it('model 预选：draft.model 优先 → 会话当前模型 → 候选首项；空候选缺省', () => {
    expect(draftToScheduleFormResult({ ...baseDraft, model: 'm2' })!.model).toBe('m2')
    expect(draftToScheduleFormResult({ ...baseDraft, currentModel: 'm2' })!.model).toBe('m2')
    expect(draftToScheduleFormResult({ ...baseDraft, models: [] })!.model).toBeUndefined()
  })

  it('prompt 空 → null（桌面 canSubmit 同判）；once cron 非 5 段一次性形态 → null；name trim 空剔除', () => {
    expect(draftToScheduleFormResult({ ...baseDraft, prompt: '   ' })).toBeNull()
    expect(draftToScheduleFormResult({ ...baseDraft, schedule: '*/5 * * * *' })).toBeNull()
    expect(draftToScheduleFormResult({ ...baseDraft, name: '  ' })!.name).toBeUndefined()
  })
})

describe('帧标记守卫与字段收窄', () => {
  it('isRichInteractionFrame：form/planReview 放行；普通 dialog 帧拒绝；非对象安全 false', () => {
    expect(isRichInteractionFrame({ form: true })).toBe(true)
    expect(isRichInteractionFrame({ planReview: true })).toBe(true)
    expect(isRichInteractionFrame({ kind: 'select', options: ['a'] })).toBe(false)
    expect(isRichInteractionFrame(null)).toBe(false)
    expect(isRichInteractionFrame('form')).toBe(false)
  })

  it('isPlanReviewFrame 窄化 + selfReview 搬运；formQuestionsOf 过滤非法项；scheduleDraftOf 收窄', () => {
    const planFrame = { ...choiceReq(), planReview: true, selfReview: '自审结论' } as unknown as ExtensionUIRequest
    expect(isPlanReviewFrame(planFrame)).toBe(true)

    const mixed = choiceReq({
      formQuestions: [
        { type: 'choice', question: 'q1', options: [{ label: 'a' }] },
        { type: 'alien' },
        'not-an-object',
      ],
    })
    const qs = formQuestionsOf(mixed)
    expect(qs).toHaveLength(1)
    expect(formQuestionsOf({ ...choiceReq(), form: undefined })).toEqual([])

    const draft = { kind: 'once' as const, schedule: '30 14 2 10 *', prompt: 'p', models: ['m1'] }
    const draftReq = choiceReq({ scheduleCreate: true, scheduleDraft: draft })
    expect(scheduleDraftOf(draftReq)).not.toBeNull()
    expect(scheduleDraftOf(choiceReq({ scheduleCreate: true, scheduleDraft: { broken: true } }))).toBeNull()
    expect(scheduleDraftOf(choiceReq())).toBeNull()
  })
})

// ======================================================================
// ← form-request-channel.test.ts
// ======================================================================

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
    await vi.waitFor(() => expect(removedSeen).toHaveLength(1), { interval: 1 })

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
    await vi.waitFor(() => expect(partitions.get('sid-a').map((r) => r.requestId)).toContain('fresh'), { interval: 1 })

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
    await vi.waitFor(() => expect(retainCalls).toHaveLength(1), { interval: 1 })
    expect([...retainCalls[0]]).toEqual([])

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockGetPending.mockRejectedValue(new Error('rpc down'))
    expect(() => channel.reconcile('sid-a')).not.toThrow()
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled(), { interval: 1 })
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

// ======================================================================
// ← permission-request-controller.test.ts
// ======================================================================

// mock RPC 回传域（approve/deny 走 command → ws-client，测试环境不连 WS）
const approvePermissions = vi.fn()
const denyPermissions = vi.fn()
vi.mock('@taiji/core/transport/api/domains/plugin', () => ({
  approvePermissions: (...args: unknown[]) => approvePermissions(...args),
  denyPermissions: (...args: unknown[]) => denyPermissions(...args),
}))

import { createPermissionRequestController, type PermissionRequestController, } from '../permission-request-controller';
/** 通过 bus.emit 模拟 bridge 归一后的 permission 事件（requestId 默认合成形态） */
function emitPermissionRequest(
  bus: InternalEventBus,
  pluginId = 'p1',
  permissions: string[] = ['shell'],
  requestId = `perm_${pluginId}`,
): void {
  bus.emit({
    kind: 'plugin-permission-request',
    request: { pluginId, permissions, requestId },
  } as InternalEvent)
}

/** 通过 global 通道模拟 runtime 撤窗广播（payload { pluginId }，无 sessionId） */
function emitExpired(pluginId: string, requestId?: string): void {
  dispatchGlobal({
    type: 'plugin:permissionRequestExpired',
    payload: { pluginId, ...(requestId !== undefined ? { requestId } : {}) },
  })
}

/** 通过 bus.emit 模拟 bridge 归一后的 resolved 终局事件（S5-V3；requestId 空串 = 旧版广播窄化形态） */
function emitResolved(
  bus: InternalEventBus,
  pluginId: string,
  requestId: string,
  approved = true,
): void {
  bus.emit({
    kind: 'plugin-permission-request-resolved',
    resolved: { pluginId, requestId, approved },
  } as InternalEvent)
}

describe('createPermissionRequestController 状态机（双壳共享）', () => {
  let bus: InternalEventBus
  let controller: PermissionRequestController

  beforeEach(() => {
    approvePermissions.mockReset()
    denyPermissions.mockReset()
    bus = new InternalEventBus()
    controller = createPermissionRequestController(bus)
  })

  afterEach(() => {
    controller.dispose()
  })

  it('TC1: 正常事件 → state 弹窗（pluginId/permissions/pending=true/error=false）；permissions 拷贝防串改', () => {
    const shared: string[] = ['fs.read', 'net.http']
    emitPermissionRequest(bus, 'tasks', shared)

    expect(controller.state.pluginId).toBe('tasks')
    expect(controller.state.permissions).toEqual(['fs.read', 'net.http'])
    expect(controller.state.pending).toBe(true)
    expect(controller.state.error).toBe(false)

    // 拷贝防串扰：emit 后外部数组变更不串入 state
    shared.push('later-mutation')
    expect(controller.state.permissions).toEqual(['fs.read', 'net.http'])
  })

  it('TC2: 畸形事件检查 warn+skip：空 pluginId / permissions 非数组 / 非字符串项 均不写 state，后续合法事件照常', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 空 pluginId
      emitPermissionRequest(bus, '', ['fs.read'])
      expect(controller.state.pending).toBe(false)

      // permissions 非数组（测试注入坏形状，受控 cast）
      bus.emit({
        kind: 'plugin-permission-request',
        request: { pluginId: 'p1', permissions: 'fs.read' as unknown as string[], requestId: 'r' },
      } as InternalEvent)
      expect(controller.state.pending).toBe(false)

      // permissions 含非字符串项
      bus.emit({
        kind: 'plugin-permission-request',
        request: { pluginId: 'p1', permissions: ['ok', 42 as unknown as string], requestId: 'r' },
      } as InternalEvent)
      expect(controller.state.pending).toBe(false)
      expect(controller.state.pluginId).toBe('')

      expect(warnSpy).toHaveBeenCalledTimes(3)

      // 检查只 skip 不毒害状态：合法事件照常弹出
      emitPermissionRequest(bus, 'p2', ['fs.read'])
      expect(controller.state.pending).toBe(true)
      expect(controller.state.pluginId).toBe('p2')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('TC3: 新请求覆盖旧弹窗：error 清零 + pluginId/permissions 全量重置（上一单失败错误态不残留）', async () => {
    // 先制造失败错误态（BM3）
    emitPermissionRequest(bus, 'p1', ['shell'])
    denyPermissions.mockRejectedValue(new Error('rpc boom'))
    controller.transport.deny('p1')
    await vi.waitFor(() => expect(controller.state.error).toBe(true), { interval: 1 })
    expect(controller.state.pending).toBe(true)

    // 新请求覆盖：error 清零，pluginId/permissions 换新
    emitPermissionRequest(bus, 'p2', ['fs.read', 'net.http'])
    expect(controller.state.error).toBe(false)
    expect(controller.state.pending).toBe(true)
    expect(controller.state.pluginId).toBe('p2')
    expect(controller.state.permissions).toEqual(['fs.read', 'net.http'])
  })

  it('TC4: approve 成功 → pending=false + error=false；失败 → pending 保持 true + error=true（BM3），重试成功收尾', async () => {
    emitPermissionRequest(bus)
    approvePermissions.mockResolvedValue(undefined)
    controller.transport.approve('p1', ['shell'])
    await vi.waitFor(() => expect(controller.state.pending).toBe(false), { interval: 1 })
    expect(controller.state.error).toBe(false)
    expect(approvePermissions).toHaveBeenCalledWith('p1', ['shell'])

    // 失败路径（BM3 假成功红线）：弹窗保持打开 + 错误显形
    emitPermissionRequest(bus)
    approvePermissions.mockRejectedValue(new Error('rpc boom'))
    controller.transport.approve('p1', ['shell'])
    await vi.waitFor(() => expect(controller.state.error).toBe(true), { interval: 1 })
    expect(controller.state.pending).toBe(true)

    // 重试成功 → 正常收尾
    approvePermissions.mockResolvedValue(undefined)
    controller.transport.approve('p1', ['shell'])
    await vi.waitFor(() => expect(controller.state.pending).toBe(false), { interval: 1 })
    expect(controller.state.error).toBe(false)
  })

  it('TC5: deny 走 denyPermissions（拒绝本次申请）：成功 pending=false；失败 pending 保持 true + error=true（BM3）', async () => {
    emitPermissionRequest(bus)
    denyPermissions.mockResolvedValue(undefined)
    controller.transport.deny('p1')
    await vi.waitFor(() => expect(controller.state.pending).toBe(false), { interval: 1 })
    expect(denyPermissions).toHaveBeenCalledWith('p1')
    expect(controller.state.error).toBe(false)

    // 失败路径：弹窗保持打开 + 错误显形
    emitPermissionRequest(bus)
    denyPermissions.mockRejectedValue(new Error('rpc boom'))
    controller.transport.deny('p1')
    await vi.waitFor(() => expect(controller.state.error).toBe(true), { interval: 1 })
    expect(controller.state.pending).toBe(true)
  })

  it('TC6: expired 命中当前弹窗（pluginId 匹配）→ pending=false + error=false（超时撤窗连错误行一起清）', async () => {
    emitPermissionRequest(bus, 'p1')
    // 先制造失败错误态，再撤窗——弹窗都撤了，错误无载体
    denyPermissions.mockRejectedValue(new Error('rpc boom'))
    controller.transport.deny('p1')
    await vi.waitFor(() => expect(controller.state.error).toBe(true), { interval: 1 })

    emitExpired('p1')
    expect(controller.state.pending).toBe(false)
    expect(controller.state.error).toBe(false)
  })

  it('TC7: expired pluginId 不匹配 → noop（陈旧广播不误撤新插件弹窗）；无挂起 → noop 幂等', () => {
    emitPermissionRequest(bus, 'p2')

    // 旧插件 p1 的迟到 expired 广播：当前弹窗属于 p2，不应被撤
    emitExpired('p1')
    expect(controller.state.pending).toBe(true)
    expect(controller.state.pluginId).toBe('p2')

    // p2 自己的 expired 才撤
    emitExpired('p2')
    expect(controller.state.pending).toBe(false)

    // 无挂起弹窗时再收 → noop 幂等
    emitExpired('p2')
    expect(controller.state.pending).toBe(false)
  })

  it('TC8: dispose 退订：bus 事件与 expired 广播均不再驱动 state', () => {
    // 先置 pending=true（弹窗在场）再 dispose——终局态（pending=false）下 expired 泄漏是恒 noop，测不出退订
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    expect(controller.state.pending).toBe(true)

    controller.dispose()

    // offRequest 退订锚：泄漏时新请求会覆盖 state（pluginId/requestId 被改写）
    emitPermissionRequest(bus, 'p2', ['fs.read'], 'req-b')
    expect(controller.state.pending).toBe(true)
    expect(controller.state.pluginId).toBe('p1')
    expect(controller.state.requestId).toBe('req-a')

    // offExpired 退订锚：泄漏时命中形态（同 pluginId 同 requestId）的 expired 广播会误撤窗
    emitExpired('p1', 'req-a')
    expect(controller.state.pending).toBe(true)
  })

  it('TC9: 同 pluginId 先后两单，expired 按 requestId 精确撤回——前单陈旧广播不误撤后到弹窗', () => {
    // 同插件 p1 的两次审批请求先后到达（弹窗全局单例，后者覆盖前者）
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    expect(controller.state.pending).toBe(true)
    expect(controller.state.requestId).toBe('req-a')
    emitPermissionRequest(bus, 'p1', ['net.http'], 'req-b')
    expect(controller.state.requestId).toBe('req-b')

    // 前单 req-a 的陈旧 expired 广播迟到：requestId 不匹配当前弹窗 → noop 不误撤
    emitExpired('p1', 'req-a')
    expect(controller.state.pending).toBe(true)
    expect(controller.state.requestId).toBe('req-b')

    // 当前单 req-b 的 expired 才撤
    emitExpired('p1', 'req-b')
    expect(controller.state.pending).toBe(false)

    // 撤回后同 pluginId 再收 expired → noop 幂等
    emitExpired('p1', 'req-b')
    expect(controller.state.pending).toBe(false)
  })

  it('TC10: expired payload 缺 requestId（旧版广播）→ 回退按 pluginId 匹配撤回', () => {
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    emitExpired('p1')
    expect(controller.state.pending).toBe(false)
  })

  it('TC11: resolved 按 requestId 精确撤回——同 pluginId 先后两单，前单陈旧 resolved 不误撤后到弹窗；命中时连错误行一起清', async () => {
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    emitPermissionRequest(bus, 'p1', ['net.http'], 'req-b')

    // 前单 req-a 的陈旧 resolved（A 端对旧弹窗的批准广播迟到）：requestId 不匹配 → noop
    emitResolved(bus, 'p1', 'req-a', true)
    expect(controller.state.pending).toBe(true)
    expect(controller.state.requestId).toBe('req-b')

    // 当前单 req-b 的 resolved 命中撤回；先制造错误态再撤（弹窗都撤了，错误无载体）
    denyPermissions.mockRejectedValue(new Error('rpc boom'))
    controller.transport.deny('p1')
    await vi.waitFor(() => expect(controller.state.error).toBe(true), { interval: 1 })
    emitResolved(bus, 'p1', 'req-b', true)
    expect(controller.state.pending).toBe(false)
    expect(controller.state.error).toBe(false)
  })

  it('TC12: resolved requestId 空串（bridge 对旧版广播的宽容窄化产物）→ 回退按 pluginId 匹配撤回', () => {
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    emitResolved(bus, 'p1', '', false)
    expect(controller.state.pending).toBe(false)
  })

  it('TC13: dispose 退订 resolved 订阅：dispose 后 resolved 命中形态不再撤窗', () => {
    // 先置 pending=true（弹窗在场）再 dispose——终局态（pending=false）下 resolved 泄漏是恒 noop，测不出退订
    emitPermissionRequest(bus, 'p1', ['shell'], 'req-a')
    expect(controller.state.pending).toBe(true)

    controller.dispose()

    // offResolved 泄漏时：requestId 命中形态的 resolved 广播会误撤窗（pending 翻 false）
    emitResolved(bus, 'p1', 'req-a', true)
    expect(controller.state.pending).toBe(true)
  })
})
