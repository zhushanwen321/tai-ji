/**
 * useExtensionUI 统一表单判定矩阵 + view-ready 帧双路径消费单测（ui-presentation-protocol
 * u4 / MF-1-5 归一上移后形态）。
 *
 * 锁定：
 * - formFilter 判定矩阵：只认 form 键（全部表单族帧由 runtime event-adapter marker 分支
 *   统一产出 form:true；裸 askUser / scheduleCreate / 无标记均不命中——判定面收敛 G2）
 * - C4 契约（归一上移 runtime 后）：本层只消费 view-ready 帧——裸 legacy 键帧（假设性
 *   旧 runtime 产物）不放行入 store
 * - 双路径消费（原 D7 挂点①②位置，归一已删只留入队）：
 *   · bus 路径——runtime 产出的 scheduleCreate 源帧（form + scheduleCreate + draft 直挂）
 *     入 store，respond 扁平 FormResult JSON 回包；
 *   · pending 路径——runtime {...r,...r.payload} 解包的 view-ready 帧（form:true 原生
 *     携带）直接入 store（respawn / 切回 session 恢复路径）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useExtensionUI-form-normalize.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope, ref, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { InternalEventBus } from '@taiji/core'

// ── mock extension api domain（WS/RPC 路径保留桩，范式同 useExtensionUI.test.ts）──
vi.mock('@taiji/core/transport/api/domains/extension', () => ({
  // 返 true = 送达（M1 环 3 后 respond 消费 boolean）
  sendExtensionUIResponse: vi.fn((): boolean => true),
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
  __resetExtensionBusSubscriptionForTesting,
} from '@/composables/useExtensionUI'
import { sendExtensionUIResponse, getPendingRequests } from '@taiji/core/transport/api/domains/extension'
import { useExtensionUIStore } from '@/stores/extension-ui'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import type { ScheduleDraft } from '@zhushanwen/extension-protocol'

const draft: ScheduleDraft = {
  kind: 'recurring',
  schedule: '0 9 * * *',
  prompt: '总结昨天的工作进展',
  models: ['m-1', 'm-2'],
  currentModel: 'm-1',
}

/** runtime event-adapter ASK_USER_MARKER 分支产出形状（legacy 归一上移后：form + type 推断映射） */
function mkAskUserReq(requestId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId,
    pluginId: 'p',
    kind: 'select',
    method: 'select',
    title: 't',
    form: true,
    formQuestions: [{ type: 'choice', header: 'db', question: '选哪个数据库?', options: [{ label: 'Postgres' }] }],
    allowCancel: true,
    ...overrides,
  }
}

/** runtime event-adapter SCHEDULE_CREATE_MARKER 分支产出形状（源键保留分流应答形状） */
function mkScheduleCreateReq(requestId: string): Record<string, unknown> {
  return {
    requestId,
    pluginId: '',
    kind: 'select',
    method: 'select',
    form: true,
    scheduleCreate: true,
    scheduleDraft: draft,
  }
}

/** 假设性旧 runtime 产物：裸 legacy 键帧（无 form 键——归一上移后 runtime 不再产出） */
function mkBareLegacyAskUserReq(requestId: string): Record<string, unknown> {
  return {
    requestId,
    pluginId: 'p',
    kind: 'select',
    method: 'select',
    title: 't',
    askUser: true,
    askUserQuestions: [{ header: 'db', question: '选哪个数据库?', options: [{ label: 'Postgres' }] }],
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
  it('form:true → 放行；裸 legacy 键 / 无标记 → 不命中', () => {
    expect(formFilter(mkFormReq('r1') as never as ExtensionUIRequest)).toBe(true)
    expect(formFilter(mkAskUserReq('r2') as never as ExtensionUIRequest)).toBe(true)
    // 裸 legacy 键（无 form 键——归一上移后 runtime 不再产出，假设性畸形帧）不命中
    expect(formFilter(mkBareLegacyAskUserReq('r3') as never as ExtensionUIRequest)).toBe(false)
    expect(formFilter(mkPlainSelectReq('r4') as never as ExtensionUIRequest)).toBe(false)
  })

  it('表单族帧（bus 路径）入 store 后恒带 form 键——formFilter 对 store 记录命中', () => {
    const { dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))
    emitBusUIRequest('sessionA', mkAskUserReq('r-ask'))
    emitBusUIRequest('sessionA', mkScheduleCreateReq('r-sc'))

    const records = useExtensionUIStore().getRequestsBySession('sessionA')
    expect(records).toHaveLength(2)
    for (const r of records) {
      expect(formFilter(r)).toBe(true) // runtime 产出的 view-ready 帧原生带 form 键
    }
    dispose()
  })
})

// ── C4 契约（归一上移 runtime：只消费 view-ready 帧）─────────────────────

describe('C4 契约（renderer 只消费 view-ready 帧）', () => {
  it('裸 legacy 键帧（无 form 键，假设性旧 runtime 产物）→ C4 不放行不入 store', () => {
    const { dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

    emitBusUIRequest('sessionA', mkBareLegacyAskUserReq('r-bare'))

    expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(0)
    dispose()
  })
})

// ── 双路径消费（bus / pending——归一层已删，view-ready 帧直接入队）─────────

describe('bus 路径（runtime marker 分支产出的 view-ready 帧入队）', () => {
  it('scheduleCreate 源帧（draft 直挂）→ store 记录 form+scheduleCreate 双键、draft 保真', () => {
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

  it('scheduleCreate 源帧 respond → 扁平 FormResult JSON 回传（今日 ScheduleCreateOverlay 路径等价）', async () => {
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

  it('双源并存排序：askUser 源与 scheduleCreate 源并存 → 先到先渲染、respond 后接管', () => {
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

describe('pending 路径（runtime {...r,...r.payload} 解包的 view-ready 帧直接入队——respawn / 切回恢复）', () => {
  it('pending 拉取返回 askUser 源帧（runtime 已归一带 form 键）→ 放行入 store（respawn 恢复）', async () => {
    // respawn 场景：pi 挂起 select → 引擎崩溃 → respawn 完成 → renderer 重新订阅拉取
    // pending——runtime marker 分支产出的 payload 自带 form:true，pending 解包帧直接入队
    vi.mocked(getPendingRequests).mockResolvedValue([
      mkAskUserReq('r-recover') as never as ExtensionUIRequest,
    ])
    const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

    await nextTick()
    await nextTick()

    expect(result.currentFormRequest.value?.requestId).toBe('r-recover')
    expect(result.currentFormRequest.value?.form).toBe(true)
    dispose()
  })

  it('pending 拉取返回 scheduler 源帧 → 同样放行（draft 保真）', async () => {
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

  it('pending 返回无标记普通帧 → 不命中 overlay 队列（C4 语义不扩）', async () => {
    // 原行为保真：pending 全量入 store（dialog 类供 hasPendingDialog 等消费面查询），
    // currentFormRequest 只认 form 键
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
