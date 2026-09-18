import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { ScheduleFormResult } from '@zhushanwen/extension-protocol'
import { SCHEDULE_CREATE_MARKER } from '@zhushanwen/extension-protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MockSchedulerBackend } from './mock-backend.js'
import { SchedulerRuntime } from '../runtime.js'
import { SchedulerService } from '../service.js'
import { handleSchedule } from '../tool.js'
import type { ScheduledTask, TaskSnapshot } from '../types.js'
import { snapshotToTask, toTaskSnapshot } from '../types.js'

/**
 * U2 六步流分支覆盖（.tmp/tech-design/scheduler-create-confirm-modal.md §3.1/§3.3/§3.5）：
 * 预校验 throw / headless 直通附注（D4）/ rpc 确认与取消（D5，GUI 用户取消经 timeout 折叠）/
 * TUI 确认与取消 / abort / channel-error 禁用工具 / non-json / draft models 注入
 * （scopedModels 优先、getAvailable() 回退——P-SCOPED）/ model 透传入 entry 快照。
 *
 * mock ctx 形态参照 sdk-contract.test.ts 的 createFakeCtx（as unknown as ExtensionContext）；
 * 协议层不 mock（四态经 ui.select mock 直接触达：reject → channel-error、undefined →
 * timeout/cancelled、非 JSON → non-json，见 extension-protocol select-rpc.ts）。
 */

// ── mock 脚手架 ──

/** model stub：仅消费点字段（modelRef 读 provider/id），其余 Model 字段不参与 */
function stubModel(provider: string, id: string): { provider: string; id: string } {
  return { provider, id }
}

interface MockPi {
  pi: ExtensionAPI
  setActiveTools: ReturnType<typeof vi.fn>
}

function createMockPi(): MockPi {
  const setActiveTools = vi.fn()
  const pi = {
    setActiveTools,
    getAllTools: () => [{ name: 'schedule' }, { name: 'schedule_control' }, { name: 'read' }],
  } as unknown as ExtensionAPI
  return { pi, setActiveTools }
}

interface CtxOverrides {
  mode?: string
  select?: (header: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>
  custom?: (factory: unknown) => Promise<unknown>
  scopedModels?: { model: { provider: string; id: string } }[]
  model?: { provider: string; id: string } | undefined
  getAvailable?: () => { provider: string; id: string }[]
}

function createMockCtx(overrides: CtxOverrides = {}): ExtensionContext {
  const ctx: Record<string, unknown> = {
    mode: 'rpc',
    hasUI: true,
    ui: {
      select: overrides.select ?? vi.fn(),
      custom: overrides.custom,
    },
    scopedModels: overrides.scopedModels ?? [],
    model: overrides.model,
    modelRegistry: { getAvailable: overrides.getAvailable ?? (() => []) },
    ...overrides,
  }
  return ctx as unknown as ExtensionContext
}

function makeService(): { service: SchedulerService; backend: MockSchedulerBackend } {
  const backend = new MockSchedulerBackend()
  return { service: new SchedulerService(new SchedulerRuntime(backend), () => backend.now()), backend }
}

function formResult(overrides: Partial<ScheduleFormResult> = {}): ScheduleFormResult {
  return {
    action: 'create',
    kind: 'recurring',
    schedule: '*/7 * * * *',
    prompt: 'user-edited prompt',
    ...overrides,
  }
}

/** 捕获 rpc 交互的 select 调用参数（marker + draft payload） */
function selectReturning(form: ScheduleFormResult | string | undefined) {
  return vi.fn(async (_header: string, _options: string[]) =>
    form === undefined ? undefined : typeof form === 'string' ? form : JSON.stringify(form),
  )
}

/** rpc draft payload 断言辅助：从 select 首次调用的 options[0] 解析 draft */
function capturedDraft(select: ReturnType<typeof selectReturning>): Record<string, unknown> {
  const payload = select.mock.calls[0]![1]![0]!
  return JSON.parse(payload) as Record<string, unknown>
}

// ── 六步流 ──

describe('handleSchedule 六步流', () => {
  let setActiveTools: ReturnType<typeof vi.fn>
  let pi: ExtensionAPI
  let service: SchedulerService
  let backend: MockSchedulerBackend

  beforeEach(() => {
    const mocks = createMockPi()
    setActiveTools = mocks.setActiveTools
    pi = mocks.pi
    const s = makeService()
    service = s.service
    backend = s.backend
  })

  // ── 步骤 1 预校验（§3.5 第三行：不发起交互直接 throw，LLM 可自修复） ──

  it('预校验：prompt 空 → throw 且不发起交互', async () => {
    const select = selectReturning(formResult())
    const ctx = createMockCtx({ select })

    await expect(handleSchedule(pi, service, { prompt: '', schedule: '5m' }, ctx, undefined))
      .rejects.toThrow('prompt must not be empty')
    expect(select).not.toHaveBeenCalled()
  })

  it('预校验：schedule 非法（ISO 时间戳不可解析）→ throw 且不发起交互', async () => {
    const select = selectReturning(formResult())
    const ctx = createMockCtx({ select })

    await expect(
      handleSchedule(pi, service, { prompt: 'x', schedule: '2026-09-19T09:00:00' }, ctx, undefined),
    ).rejects.toThrow('unrecognized schedule')
    expect(select).not.toHaveBeenCalled()
  })

  // ── 步骤 2 headless 分支（D4 分支 1：直通创建 + 附注 + 不禁用工具） ──

  it('headless（mode 非 tui/rpc）：参数直接创建 + 末尾附注未经确认 + 工具未被禁用', async () => {
    const ctx = createMockCtx({ mode: 'print' })

    const result = await handleSchedule(
      pi, service,
      { prompt: 'check build', schedule: '5m', model: 'prov-a/m1' },
      ctx, undefined,
    )

    const text = result.content[0]!.text
    expect(text).toContain('Task "check build"')
    expect(text).toContain('(Created without user confirmation: this session has no interactive channel.)')
    expect(setActiveTools).not.toHaveBeenCalled()
    // D4 附注 + model 透传同路径落库：upsert 快照携带 model
    const upsert = backend.appendedOps.find(op => op.op === 'upsert')
    expect(upsert && upsert.op === 'upsert' ? upsert.task.model : undefined).toBe('prov-a/m1')
  })

  // ── 步骤 3+6 rpc 交互：确认创建（draft 透传 / FormResult 值创建 / model 入快照） ──

  it('rpc 确认：select 携带 marker + draft，FormResult 最终值创建且 model 透传入 entry 快照', async () => {
    const form = formResult({ kind: 'once', schedule: '0 0 9 19 9 *', model: 'prov-b/m2' })
    const select = selectReturning(form)
    const ctx = createMockCtx({ select, model: stubModel('prov-a', 'm1') })

    const result = await handleSchedule(
      pi, service,
      { prompt: 'agent draft', schedule: '0 9 * * *', model: 'prov-a/m1' },
      ctx, undefined,
    )

    // select 第一参 = marker，payload = JSON draft（LLM 参数原样预填）
    expect(select.mock.calls[0]![0]).toBe(SCHEDULE_CREATE_MARKER)
    const draft = capturedDraft(select)
    expect(draft.kind).toBe('recurring')
    expect(draft.schedule).toBe('0 9 * * *')
    expect(draft.prompt).toBe('agent draft')
    expect(draft.model).toBe('prov-a/m1')

    // 步骤 6：以 FormResult 最终值创建（用户可改），非 LLM 原始参数
    expect(result.content[0]!.text).toContain('Task "user-edited prompt"')
    const upsert = backend.appendedOps.find(op => op.op === 'upsert')
    expect(upsert && upsert.op === 'upsert' ? upsert.task.kind : undefined).toBe('once')
    expect(upsert && upsert.op === 'upsert' ? upsert.task.model : undefined).toBe('prov-b/m2')
  })

  // ── 步骤 4+5 取消路径（D5：cancelled result 正常返回，不 throw，不创建） ──

  it('rpc 取消：GUI 用户取消 resolve undefined（无 signal 折叠 timeout）→ cancelled result 且未创建', async () => {
    const select = selectReturning(undefined)
    const ctx = createMockCtx({ select })

    const result = await handleSchedule(pi, service, { prompt: 'x', schedule: '5m' }, ctx, undefined)

    expect(result.details).toEqual({ cancelled: true })
    expect(result.content[0]!.text).toContain('The task was NOT created')
    expect(result.content[0]!.text).toContain('Do not assume a configuration and do not retry')
    expect(backend.appendedOps).toHaveLength(0)
    expect(setActiveTools).not.toHaveBeenCalled()
  })

  it('rpc abort：signal 已中止 → cancelled 语义（同取消路径）', async () => {
    const controller = new AbortController()
    controller.abort()
    const select = selectReturning(undefined)
    const ctx = createMockCtx({ select })

    const result = await handleSchedule(
      pi, service, { prompt: 'x', schedule: '5m' }, ctx, controller.signal,
    )

    expect(result.details).toEqual({ cancelled: true })
    expect(backend.appendedOps).toHaveLength(0)
  })

  it('TUI 取消：custom resolve null → cancelled result 且未创建', async () => {
    const custom = vi.fn(async () => null)
    const ctx = createMockCtx({ mode: 'tui', custom })

    const result = await handleSchedule(pi, service, { prompt: 'x', schedule: '5m' }, ctx, undefined)

    expect(result.details).toEqual({ cancelled: true })
    expect(backend.appendedOps).toHaveLength(0)
  })

  it('TUI abort：custom resolve undefined（abort 后组件归 null 的兼容形态）→ cancelled result', async () => {
    const custom = vi.fn(async () => undefined)
    const ctx = createMockCtx({ mode: 'tui', custom })

    const result = await handleSchedule(pi, service, { prompt: 'x', schedule: '5m' }, ctx, undefined)

    expect(result.details).toEqual({ cancelled: true })
  })

  // ── 步骤 3 TUI 接线：custom factory 构造组件 + abort 监听注册 ──

  it('TUI 确认：custom factory 构造组件并回传 FormResult → 创建', async () => {
    const stubTui = { requestRender() {} }
    const stubTheme = {
      fg: (_token: string, text: string) => text,
      bg: (_token: string, text: string) => text,
      bold: (text: string) => text,
      inverse: (text: string) => text,
    }
    let compExposed = false
    const custom = vi.fn(async (factory: (
      tui: unknown, theme: unknown, kb: unknown, done: (r: ScheduleFormResult | null) => void,
    ) => unknown) => {
      let captured: unknown
      captured = factory(stubTui, stubTheme, {}, () => {})
      compExposed = captured != null
      return formResult()
    })
    const ctx = createMockCtx({ mode: 'tui', custom })

    const result = await handleSchedule(pi, service, { prompt: 'x', schedule: '5m' }, ctx, undefined)

    expect(custom).toHaveBeenCalledTimes(1)
    expect(compExposed).toBe(true)
    expect(result.content[0]!.text).toContain('Task "user-edited prompt"')
    expect(backend.appendedOps.some(op => op.op === 'upsert')).toBe(true)
  })

  // ── §3.5 错误规格：channel-error / non-json ──

  it('rpc channel-error（select reject）→ 禁用本会话 schedule 工具 + throw', async () => {
    const select = vi.fn(async () => {
      throw new Error('channel down')
    })
    const ctx = createMockCtx({ select })

    await expect(handleSchedule(pi, service, { prompt: 'x', schedule: '5m' }, ctx, undefined))
      .rejects.toThrow('disabled for this session')

    const disabledList = setActiveTools.mock.calls[0]![0] as string[]
    expect(disabledList).not.toContain('schedule')
    expect(disabledList).toContain('schedule_control')
    expect(backend.appendedOps).toHaveLength(0)
  })

  it('rpc non-json（回包非法）→ throw 协议版本错配文案', async () => {
    const select = selectReturning('not-json-garbage')
    const ctx = createMockCtx({ select })

    await expect(handleSchedule(pi, service, { prompt: 'x', schedule: '5m' }, ctx, undefined))
      .rejects.toThrow('protocol version mismatch')
    expect(setActiveTools).not.toHaveBeenCalled()
  })

  // ── Draft.models 注入（P-SCOPED：scopedModels 优先 / getAvailable() 回退） ──

  it('models 回退：scopedModels 恒空（S12 taiji 形态）→ getAvailable() 映射 provider/id 列表 + currentModel', async () => {
    const form = formResult()
    const select = selectReturning(form)
    const getAvailable = vi.fn(() => [stubModel('prov-a', 'm1'), stubModel('prov-b', 'm2')])
    const ctx = createMockCtx({
      select,
      getAvailable,
      model: stubModel('prov-a', 'm1'),
    })

    await handleSchedule(pi, service, { prompt: 'x', schedule: '5m' }, ctx, undefined)

    expect(getAvailable).toHaveBeenCalled()
    const draft = capturedDraft(select)
    expect(draft.models).toEqual(['prov-a/m1', 'prov-b/m2'])
    expect(draft.currentModel).toBe('prov-a/m1')
  })

  it('models 优先：scopedModels 非空 → scoped 映射，getAvailable 不被调用', async () => {
    const form = formResult()
    const select = selectReturning(form)
    const getAvailable = vi.fn(() => [stubModel('prov-a', 'm1')])
    const ctx = createMockCtx({
      select,
      getAvailable,
      scopedModels: [{ model: stubModel('prov-s', 'scoped-m') }],
      model: stubModel('prov-s', 'scoped-m'),
    })

    await handleSchedule(pi, service, { prompt: 'x', schedule: '5m' }, ctx, undefined)

    expect(getAvailable).not.toHaveBeenCalled()
    const draft = capturedDraft(select)
    expect(draft.models).toEqual(['prov-s/scoped-m'])
    expect(draft.currentModel).toBe('prov-s/scoped-m')
  })
})

// ── model 字段族持久化（U2 领地：types.ts + runtime.addTask 构造段） ──

describe('model 字段族落盘', () => {
  it('addTask 透传 options.model 进 task；缺省 = undefined（跟随会话当前模型）', async () => {
    const backend = new MockSchedulerBackend()
    const runtime = new SchedulerRuntime(backend)

    const withModel = await runtime.addTask('p1', { mode: 'interval', intervalMs: 60000 }, { model: 'prov-a/m1' })
    const withoutModel = await runtime.addTask('p2', { mode: 'interval', intervalMs: 60000 })

    expect(withModel.model).toBe('prov-a/m1')
    expect(withoutModel.model).toBeUndefined()
  })

  it('toTaskSnapshot → snapshotToTask 往返 model 保真（漏加列举 = 重放丢失的反向验证）', () => {
    const task: ScheduledTask = {
      id: 'abcd1234',
      name: 'm task',
      prompt: 'p',
      kind: 'recurring',
      schedule: { mode: 'interval', intervalMs: 60000 },
      model: 'prov-a/m1',
      enabled: true,
      createdAt: 1000,
      nextRunAt: 2000,
      runCount: 0,
      history: [],
    }

    const snapshot: TaskSnapshot = toTaskSnapshot(task)
    expect(snapshot.model).toBe('prov-a/m1')
    const restored = snapshotToTask(snapshot)
    expect(restored.model).toBe('prov-a/m1')
  })
})
