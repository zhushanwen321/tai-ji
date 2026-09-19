/**
 * useExtensionUI 统一表单判定矩阵 + legacy 归一双路径单测（ui-presentation-protocol u4，
 * 设计 D5/D7；取代旧 useExtensionUI-schedule-create.test.ts 的分流面职责）。
 *
 * 锁定：
 * - formFilter 判定矩阵：只认 form 键（新 form 帧原生携带 / legacy 帧经归一附加；
 *   裸 askUser / scheduleCreate / 无标记均不命中——判定面收敛 G2）
 * - normalizeFormRequest 纯函数矩阵：type 推断（有 options → choice（multiSelect→multi）、
 *   无 options → text）、legacy 键保留、幂等透传
 * - legacy 双路径（D7 挂点①②）：
 *   · bus 路径——legacy scheduler 帧（scheduleCreate + draft 直挂）经 bus 归一入 store，
 *     respond 扁平 FormResult JSON 回包；
 *   · pending 路径——legacy askUser 帧（runtime {...r,...r.payload} 解包无 form 键）
 *     经挂点②归一后放行（respawn / 切回 session 恢复路径，漏挂则 pi select 永久挂起）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useExtensionUI-form-normalize.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope, ref, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { InternalEventBus } from '@taiji/core'

// ── mock extension api domain（WS/RPC 路径保留桩，范式同 useExtensionUI.test.ts）──
vi.mock('@taiji/core/transport/api/domains/extension', () => ({
  sendExtensionUIResponse: vi.fn(),
  onNotify: () => () => {},
  onExtensions: vi.fn(),
  getPendingRequests: vi.fn().mockResolvedValue([]),
}))

let mockBus: InternalEventBus

vi.mock('@/composables/shell/useExtensionHostBridge', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/composables/shell/useExtensionHostBridge')>()
  return {
    ...original,
    getExtensionBus: () => mockBus,
  }
})

import {
  useExtensionUI,
  formFilter,
  normalizeFormRequest,
  __resetExtensionBusSubscriptionForTesting,
} from '@/composables/useExtensionUI'
import { sendExtensionUIResponse, getPendingRequests } from '@taiji/core/transport/api/domains/extension'
import { useExtensionUIStore } from '@/stores/extension-ui'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import type { ScheduleDraft, FormQuestion } from '@zhushanwen/extension-protocol'

const draft: ScheduleDraft = {
  kind: 'recurring',
  schedule: '0 9 * * *',
  prompt: '总结昨天的工作进展',
  models: ['m-1', 'm-2'],
  currentModel: 'm-1',
}

/** legacy askUser 帧原始形状（ASK_USER_MARKER 广播；无 form 键） */
function mkAskUserReq(requestId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId,
    pluginId: 'p',
    kind: 'select',
    method: 'select',
    title: 't',
    askUser: true,
    askUserQuestions: [{ header: 'db', question: '选哪个数据库?', options: [{ label: 'Postgres' }] }],
    allowCancel: true,
    ...overrides,
  }
}

/** legacy scheduler 帧原始形状（SCHEDULE_CREATE_MARKER 广播；无 form 键） */
function mkScheduleCreateReq(requestId: string): Record<string, unknown> {
  return {
    requestId,
    pluginId: '',
    kind: 'select',
    method: 'select',
    scheduleCreate: true,
    scheduleDraft: draft,
  }
}

/** 新 form 帧形状（runtime event-adapter UI_FORM_MARKER 分支） */
function mkFormReq(requestId: string): Record<string, unknown> {
  return {
    requestId,
    pluginId: '',
    kind: 'select',
    method: 'select',
    form: true,
    formQuestions: [{ type: 'choice', header: 'db', question: '选哪个数据库?', options: [{ label: 'Postgres' }] }],
    allowCancel: true,
  }
}

function mkPlainSelectReq(requestId: string): Record<string, unknown> {
  return { requestId, pluginId: '', kind: 'select', method: 'select', title: '选择', options: ['a', 'b'] }
}

function emitBusUIRequest(sid: string, request: unknown): void {
  mockBus.emit({ kind: 'ui-request', sessionId: sid, request } as never)
}

/** 在独立 effectScope 内运行（useExtensionUI 注册 watch/onScopeDispose 的生命周期要求） */
function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, dispose: () => scope.stop() }
}

beforeEach(() => {
  __resetExtensionBusSubscriptionForTesting()
  setActivePinia(createPinia())
  mockBus = new InternalEventBus()
  vi.mocked(sendExtensionUIResponse).mockClear()
  vi.mocked(getPendingRequests).mockResolvedValue([])
})

// ── formFilter 判定矩阵（G2 收敛终态：只认 form 键）──────────────────────

describe('formFilter 判定矩阵（判定面收敛：只认 form 键）', () => {
  it('form:true → 放行；裸 askUser / scheduleCreate / 无标记 → 不命中', () => {
    expect(formFilter(mkFormReq('r1') as never as ExtensionUIRequest)).toBe(true)
    // 裸 legacy 键（未经归一的原始帧）不命中——formFilter 与 legacy 判定面解耦
    expect(formFilter(mkAskUserReq('r2') as never as ExtensionUIRequest)).toBe(false)
    expect(formFilter(mkScheduleCreateReq('r3') as never as ExtensionUIRequest)).toBe(false)
    expect(formFilter(mkPlainSelectReq('r4') as never as ExtensionUIRequest)).toBe(false)
  })

  it('legacy 帧（bus 路径）入 store 后恒带 form 键——formFilter 对 store 记录命中', () => {
    const { dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))
    emitBusUIRequest('sessionA', mkAskUserReq('r-ask'))
    emitBusUIRequest('sessionA', mkScheduleCreateReq('r-sc'))

    const records = useExtensionUIStore().getRequestsBySession('sessionA')
    expect(records).toHaveLength(2)
    for (const r of records) {
      expect(formFilter(r)).toBe(true) // 归一附加 form 后统一命中
    }
    dispose()
  })
})

// ── normalizeFormRequest 纯函数矩阵（D7 归一层 type 推断）─────────────────

describe('normalizeFormRequest 归一矩阵', () => {
  it('legacy askUser 帧 → 附加 form + formQuestions（有 options → choice，multiSelect → multi）', () => {
    const out = normalizeFormRequest(mkAskUserReq('r1', {
      askUserQuestions: [{ header: 'db', question: 'q?', multiSelect: true, options: [{ label: 'PG' }] }],
    }))
    expect(out.form).toBe(true)
    expect(out.formQuestions).toEqual([
      { type: 'choice', header: 'db', question: 'q?', options: [{ label: 'PG' }], multi: true },
    ])
    // legacy 键保留（归一是附加不是替换）
    expect(out.askUser).toBe(true)
  })

  it('legacy askUser 帧（无 options 纯文本题）→ text 推断', () => {
    const out = normalizeFormRequest(mkAskUserReq('r2', {
      askUserQuestions: [{ header: 'note', question: '补充说明', context: 'ctx' }],
    }))
    expect(out.form).toBe(true)
    expect(out.formQuestions).toEqual([
      { type: 'text', header: 'note', question: '补充说明', context: 'ctx' },
    ])
  })

  it('legacy askUser 帧（askUserQuestions 非数组）→ formQuestions = []（不静默丢帧，空表单可取消）', () => {
    const out = normalizeFormRequest(mkAskUserReq('r3', { askUserQuestions: undefined }))
    expect(out.form).toBe(true)
    expect(out.formQuestions).toEqual([])
  })

  it('legacy scheduleCreate 帧 → 附加 form，保留 scheduleCreate/scheduleDraft 原键（draft 直挂源）', () => {
    const out = normalizeFormRequest(mkScheduleCreateReq('r4'))
    expect(out.form).toBe(true)
    expect(out.scheduleCreate).toBe(true)
    expect(out.scheduleDraft).toEqual(draft)
    expect(out.formQuestions).toBeUndefined() // scheduler 源不走 questions，FormOverlay 按 draft 分流
  })

  it('新 form 帧（已带 form 键）→ 幂等透传不重写', () => {
    const req = mkFormReq('r5')
    const out = normalizeFormRequest(req)
    expect(out).toBe(req) // 同引用返回（幂等）
  })

  it('无标记普通帧 → 原样透传（不附加 form）', () => {
    const out = normalizeFormRequest(mkPlainSelectReq('r6'))
    expect(out.form).toBeUndefined()
  })
})

// ── legacy 双路径（D7 挂点① bus / 挂点② pending）─────────────────────────

describe('legacy bus 路径（挂点①：C4 判定之前归一）', () => {
  it('legacy scheduler 帧（draft 直挂）经 bus → store 记录 form+scheduleCreate 双键、draft 保真', () => {
    const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

    emitBusUIRequest('sessionA', mkScheduleCreateReq('r-sc'))

    const records = useExtensionUIStore().getRequestsBySession('sessionA')
    expect(records).toHaveLength(1)
    expect(records[0].form).toBe(true)
    expect(records[0].scheduleCreate).toBe(true)
    expect(records[0].scheduleDraft).toEqual(draft)
    expect(records[0].method).toBe('select')
    // currentFormRequest 命中（find 谓词 form 键）
    expect(result.currentFormRequest.value?.requestId).toBe('r-sc')
    dispose()
  })

  it('legacy scheduler 帧 respond → 扁平 FormResult JSON 回传（今日 ScheduleCreateOverlay 路径等价）', async () => {
    const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

    emitBusUIRequest('sessionA', mkScheduleCreateReq('r-sc'))
    const formResult = JSON.stringify({ action: 'create', kind: 'recurring', schedule: '0 9 * * *', prompt: 'p' })
    result.respond('r-sc', formResult)

    expect(vi.mocked(sendExtensionUIResponse)).toHaveBeenCalledWith('sessionA', 'r-sc', 'select', formResult)
    // respond 后出队
    expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(0)
    dispose()
  })

  it('无标记普通 select 不入 store（CompanionBand 独占，零重叠）', () => {
    const { dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

    emitBusUIRequest('sessionA', mkPlainSelectReq('r2'))

    expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(0)
    dispose()
  })

  it('双源并存排序：askUser 与 scheduleCreate 并存 → 先到先渲染、respond 后接管', () => {
    const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

    emitBusUIRequest('sessionA', mkAskUserReq('r-ask'))
    emitBusUIRequest('sessionA', mkScheduleCreateReq('r-sc'))

    expect(result.currentFormRequest.value?.requestId).toBe('r-ask')
    expect(result.currentFormRequest.value?.form).toBe(true)

    result.respond('r-ask', 'answer')
    expect(result.currentFormRequest.value?.requestId).toBe('r-sc')
    expect(result.currentFormRequest.value?.scheduleCreate).toBe(true)
    dispose()
  })
})

describe('legacy pending 路径（挂点②：addRequest 之前归一——respawn / 切回恢复）', () => {
  it('pending 拉取返回 legacy askUser 帧（无 form 键）→ 归一后放行入 store（respawn 恢复）', async () => {
    // respawn 场景：pi 挂起 select → 引擎崩溃 → respawn 完成 → renderer 重新订阅拉取
    // pending——runtime {...r,...r.payload} 解包保留原始键、无 form 键，漏挂点②则旧帧
    // 不弹、pi select 永久挂起
    vi.mocked(getPendingRequests).mockResolvedValue([
      mkAskUserReq('r-recover') as never as ExtensionUIRequest,
    ])
    const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

    await nextTick()
    await nextTick()

    expect(result.currentFormRequest.value?.requestId).toBe('r-recover')
    // 归一附加 form + formQuestions 推断（choice 形态）
    expect(result.currentFormRequest.value?.form).toBe(true)
    const questions = result.currentFormRequest.value?.formQuestions as FormQuestion[]
    expect(questions[0]).toMatchObject({ type: 'choice', header: 'db', options: [{ label: 'Postgres' }] })
    dispose()
  })

  it('pending 拉取返回 legacy scheduler 帧 → 同样归一放行（draft 保真）', async () => {
    vi.mocked(getPendingRequests).mockResolvedValue([
      mkScheduleCreateReq('r-sc-recover') as never as ExtensionUIRequest,
    ])
    const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

    await nextTick()
    await nextTick()

    expect(result.currentFormRequest.value?.requestId).toBe('r-sc-recover')
    expect(result.currentFormRequest.value?.form).toBe(true)
    expect(result.currentFormRequest.value?.scheduleDraft).toEqual(draft)
    dispose()
  })

  it('pending 返回新 form 帧 → 归一幂等透传（无重复附加）', async () => {
    vi.mocked(getPendingRequests).mockResolvedValue([
      mkFormReq('r-new') as never as ExtensionUIRequest,
    ])
    const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

    await nextTick()
    await nextTick()

    expect(result.currentFormRequest.value?.requestId).toBe('r-new')
    expect(result.currentFormRequest.value?.form).toBe(true)
    dispose()
  })

  it('pending 返回无标记普通帧 → 不命中 overlay 队列（挂点②只归一不扩 C4 语义）', async () => {
    // 原行为保真：pending 全量入 store（dialog 类供 hasPendingDialog 等消费面查询），
    // 归一不附加 form → currentFormRequest 不命中
    vi.mocked(getPendingRequests).mockResolvedValue([
      mkPlainSelectReq('r-plain') as never as ExtensionUIRequest,
    ])
    const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

    await nextTick()
    await nextTick()

    expect(result.currentFormRequest.value).toBeUndefined()
    const records = useExtensionUIStore().getRequestsBySession('sessionA')
    expect(records).toHaveLength(1)
    expect(records[0].form).toBeUndefined()
    dispose()
  })
})
