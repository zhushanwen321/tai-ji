import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import type { ScheduleFormResult } from '@zhushanwen/extension-protocol'
import { UI_FORM_MARKER } from '@zhushanwen/extension-protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MockSchedulerBackend } from './mock-backend.js'
import { registerScheduleCommand } from '../commands.js'
import { SchedulerRuntime } from '../runtime.js'
import { SchedulerService } from '../service.js'

/**
 * 命令路径表单覆盖（设计 §6.2 D2）：
 * 无参 / 带参预填 / 取消 / 提交成功 / channel-error / non-json / echo（三条错误分支从
 * tool-create-flow.test.ts 迁入，覆盖不丢）/ 模式矩阵（rpc / tui / json / print）/
 * handler 立即 resolve（异步不阻塞）/ json·print 无参 throw / 带参失败 throw /
 * json·print 失败不被 catch 吞（rethrow）/ notify severity 分级。
 *
 * 命令 handler 经 registerScheduleCommand 捕获后调用——覆盖 handler 整体 try/catch 的
 * mode 分流（json/print rethrow），而非只测内部函数。
 */

interface CommandOpts {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
}

interface HandlerHarness {
  handler: CommandOpts['handler']
  notify: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
  custom: ReturnType<typeof vi.fn>
  ctx: ExtensionCommandContext
}

// ── mock 脚手架 ──

function stubModel(provider: string, id: string): { provider: string; id: string } {
  return { provider, id }
}

function makeService(): { service: SchedulerService; backend: MockSchedulerBackend } {
  const backend = new MockSchedulerBackend()
  return { service: new SchedulerService(new SchedulerRuntime(backend), () => backend.now()), backend }
}

/** 从请求 payload 解析 answers key（D2 fallback：header ?? question——与 FormOverlay qKey 同规则） */
function answerKeyFromPayload(options: string[]): string {
  const q = JSON.parse(options[0]!).formQuestions[0]
  return typeof q.header === 'string' ? q.header : q.question
}

function capturedDraft(select: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const payload = JSON.parse(select.mock.calls[0]![1]![0]!) as {
    formQuestions: { initial?: Record<string, unknown> }[]
  }
  return payload.formQuestions[0]!.initial!
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

function envelopeReturning(valueJson: string) {
  return vi.fn(async (_header: string, options: string[]) => {
    const key = answerKeyFromPayload(options)
    return JSON.stringify({ [key]: valueJson })
  })
}

/** select 返回形态：undefined = 取消；string = 原始回包；formResult = 合法 envelope */
function selectReturning(form: ScheduleFormResult | string | undefined) {
  return vi.fn(async (_header: string, options: string[]) =>
    form === undefined ? undefined : typeof form === 'string' ? form
      : envelopeReturning(JSON.stringify(form))(_header, options),
  )
}

interface CtxOverrides {
  mode?: string
  select?: ReturnType<typeof vi.fn>
  custom?: ReturnType<typeof vi.fn>
  getAvailable?: () => { provider: string; id: string }[]
  model?: { provider: string; id: string } | undefined
}

function createCtx(overrides: CtxOverrides = {}): {
  ctx: ExtensionCommandContext
  notify: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
  custom: ReturnType<typeof vi.fn>
} {
  const notify = vi.fn()
  const select = overrides.select ?? vi.fn()
  const custom = overrides.custom ?? vi.fn()
  const ctx = {
    mode: overrides.mode ?? 'rpc',
    hasUI: true,
    ui: { select, custom, notify },
    scopedModels: [],
    model: overrides.model,
    modelRegistry: { getAvailable: overrides.getAvailable ?? (() => []) },
  } as unknown as ExtensionCommandContext
  return { ctx, notify, select, custom }
}

function registerHandler(getService: () => SchedulerService | null): CommandOpts['handler'] {
  const commands = new Map<string, CommandOpts>()
  const pi = {
    registerCommand: (name: string, opts: CommandOpts) => {
      commands.set(name, opts)
    },
  }
  registerScheduleCommand(pi as never, getService)
  return commands.get('schedule')!.handler
}

/** 让已 fire-and-forget 的 rpc 续跑（run）settle：0ms macrotask 在所有待决微任务之后。 */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

// ── rpc：打开表单（无参 / 带参预填） ──

describe('/schedule 命令 表单路径（rpc）', () => {
  let handler: CommandOpts['handler']
  let service: SchedulerService
  let backend: MockSchedulerBackend

  beforeEach(() => {
    vi.clearAllMocks()
    const s = makeService()
    service = s.service
    backend = s.backend
    handler = registerHandler(() => service)
  })

  it('无参：打开表单，draft = 单次 + 空时刻 + 空 prompt + models 注入（默认单次裁决）', async () => {
    const select = selectReturning(undefined)
    const getAvailable = vi.fn(() => [stubModel('prov-a', 'm1')])
    const { ctx } = createCtx({ select, getAvailable, model: stubModel('prov-a', 'm1') })

    await handler('', ctx)
    await flush()

    expect(select).toHaveBeenCalledTimes(1)
    expect(select.mock.calls[0]![0]).toBe(UI_FORM_MARKER)
    const payload = JSON.parse(select.mock.calls[0]![1]![0]!) as {
      formQuestions: { type: string }[]
      allowCancel?: boolean
      expectTurn?: boolean
    }
    expect(payload.formQuestions).toHaveLength(1)
    expect(payload.formQuestions[0]!.type).toBe('schedule')
    expect(payload.allowCancel).toBe(true)
    // 命令路径声明无 turn（form-submit-busy-convergence D1 段 2）：显式 false 进 payload
    expect(payload.expectTurn).toBe(false)

    const draft = capturedDraft(select)
    expect(draft.kind).toBe('once')
    expect(draft.schedule).toBe('')
    expect(draft.prompt).toBe('')
    expect(draft.models).toEqual(['prov-a/m1'])
    expect(draft.currentModel).toBe('prov-a/m1')
  })

  it('带参：/schedule <spec> <prompt> 预填 draft（引号内空格保留）', async () => {
    const select = selectReturning(undefined)
    const { ctx } = createCtx({ select })

    await handler("5m 'check build'", ctx)
    await flush()

    const draft = capturedDraft(select)
    expect(draft.schedule).toBe('5m')
    expect(draft.prompt).toBe('check build')
  })

  it('取消（select resolve undefined）：不创建、无 toast', async () => {
    const select = selectReturning(undefined)
    const { ctx, notify } = createCtx({ select })

    await handler("5m 'x'", ctx)
    await flush()

    expect(backend.appendedOps).toHaveLength(0)
    expect(notify).not.toHaveBeenCalled()
  })

  it('提交成功：以 FormResult 最终值创建 + notify info（词典渲染，含 next run）', async () => {
    const form = formResult({ kind: 'once', schedule: '0 9 19 9 *', prompt: 'edited', model: 'prov-b/m2' })
    const select = selectReturning(form)
    const { ctx, notify } = createCtx({ select })

    await handler("5m 'draft'", ctx)
    await flush()

    // 词典模板 task.created：'Created {id}: {name} · {schedule} · next run {relative}'（非 result.message）
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Created'), 'info')
    expect(notify.mock.calls[0]![0]).toContain('edited')
    expect(notify.mock.calls[0]![0]).not.toContain('Task "edited"')
    const upsert = backend.appendedOps.find(op => op.op === 'upsert')
    expect(upsert && upsert.op === 'upsert' ? upsert.task.kind : undefined).toBe('once')
    expect(upsert && upsert.op === 'upsert' ? upsert.task.model : undefined).toBe('prov-b/m2')
  })

  it('提交创建失败：notify error（severity 分级——成功 info / 失败 error）', async () => {
    const failing = {
      create: vi.fn(async () => ({ success: false, message: 'Task limit reached (50)' })),
    } as unknown as SchedulerService
    handler = registerHandler(() => failing)
    const select = selectReturning(formResult())
    const { ctx, notify } = createCtx({ select })

    await handler('5m x', ctx)
    await flush()

    expect(notify).toHaveBeenCalledWith('Task limit reached (50)', 'error')
  })

  // ── 三条错误分支（从 tool-create-flow.test.ts 迁入，覆盖不丢） ──

  it('channel-error（select reject）→ notify error + 后续 /schedule 不重复试探', async () => {
    const select = vi.fn(async () => {
      throw new Error('channel down')
    })
    const { ctx, notify } = createCtx({ select })

    await handler("5m 'x'", ctx)
    await flush()

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Form channel unavailable'), 'error')
    expect(backend.appendedOps).toHaveLength(0)

    // 「本会话后续直接给提示」：select 不再被调用
    const next = createCtx({ select: vi.fn() })
    await handler("5m 'y'", next.ctx)
    await flush()
    expect(next.select).not.toHaveBeenCalled()
    expect(next.notify).toHaveBeenCalledWith(expect.stringContaining('Form channel unavailable'), 'error')
  })

  it('non-json（回包非法）→ notify error 协议版本错配文案', async () => {
    const select = selectReturning('not-json-garbage')
    const { ctx, notify } = createCtx({ select })

    await handler("5m 'x'", ctx)
    await flush()

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Form protocol mismatch'), 'error')
    expect(backend.appendedOps).toHaveLength(0)
  })

  it('echo（回包=发送 payload，旧宿主组合）→ channel-error 折叠：notify error', async () => {
    const select = vi.fn(async (_header: string, options: string[]) => options[0])
    const { ctx, notify } = createCtx({ select })

    await handler("5m 'x'", ctx)
    await flush()

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Form channel unavailable'), 'error')
    expect(backend.appendedOps).toHaveLength(0)
  })

  it('envelope 值非 ScheduleFormResult 形状 → notify error（协议版本错配）', async () => {
    const select = selectReturning(JSON.stringify({
      action: 'cancel', kind: 'once', schedule: '0 9 19 9 *', prompt: 'p',
    }))
    const { ctx, notify } = createCtx({ select })

    await handler("5m 'x'", ctx)
    await flush()

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Form protocol mismatch'), 'error')
    expect(backend.appendedOps).toHaveLength(0)
  })

  it('envelope 键缺失（空 FormAnswers）→ notify error（协议版本错配）', async () => {
    const select = selectReturning('{}')
    const { ctx, notify } = createCtx({ select })

    await handler("5m 'x'", ctx)
    await flush()

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Form protocol mismatch'), 'error')
    expect(backend.appendedOps).toHaveLength(0)
  })

  // ── 异步打开：handler 不 await 表单（规避 prompt RPC 60s 窗口） ──

  it('handler 立即 resolve：select 挂起未决时 handler 已返回（异步打开不阻塞）', async () => {
    let resolveSelect: ((value: string | undefined) => void) | undefined
    const select = vi.fn(() => new Promise<string | undefined>((resolve) => {
      resolveSelect = resolve
    }))
    const { ctx } = createCtx({ select })

    const pending = handler("5m 'x'", ctx)
    const settled = await Promise.race([
      pending.then(() => 'resolved' as const),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 50)),
    ])

    expect(settled).toBe('resolved')
    expect(select).toHaveBeenCalledTimes(1)

    // 清理挂起交互，避免跨用例泄漏
    resolveSelect!(undefined)
    await flush()
  })
})

// ── 模式矩阵 ──

describe('/schedule 命令 模式矩阵', () => {
  let handler: CommandOpts['handler']
  let service: SchedulerService
  let backend: MockSchedulerBackend

  beforeEach(() => {
    vi.clearAllMocks()
    const s = makeService()
    service = s.service
    backend = s.backend
    handler = registerHandler(() => service)
  })

  it('tui：走 ScheduleCreateComponent（custom），不走 select；提交创建', async () => {
    const stubTui = { requestRender() {} }
    const stubTheme = {
      fg: (_token: string, text: string) => text,
      bg: (_token: string, text: string) => text,
      bold: (text: string) => text,
      inverse: (text: string) => text,
    }
    const custom = vi.fn(async (factory: (
      tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void,
    ) => unknown) => {
      factory(stubTui, stubTheme, {}, () => {})
      return formResult({ prompt: 'tui edited' })
    })
    const { ctx, notify, select } = createCtx({ mode: 'tui', custom })

    await handler("5m 'draft'", ctx)

    expect(custom).toHaveBeenCalledTimes(1)
    expect(select).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('tui edited'), 'info')
    expect(backend.appendedOps.some(op => op.op === 'upsert')).toBe(true)
  })

  it('tui：custom resolve null（取消）→ 不创建、无 toast', async () => {
    const custom = vi.fn(async () => null)
    const { ctx, notify } = createCtx({ mode: 'tui', custom })

    await handler("5m 'x'", ctx)

    expect(backend.appendedOps).toHaveLength(0)
    expect(notify).not.toHaveBeenCalled()
  })

  it('json：带参直建（不打开表单），任务落 entry', async () => {
    const { ctx, notify, select, custom } = createCtx({ mode: 'json' })

    await handler("5m 'check build'", ctx)

    expect(select).not.toHaveBeenCalled()
    expect(custom).not.toHaveBeenCalled()
    expect(backend.appendedOps.some(op => op.op === 'upsert')).toBe(true)
    expect(notify).not.toHaveBeenCalled() // json 模式 notify 是 no-op，成功路径无信号（已登记 P3）
  })

  it('print：带参直建（同 json）', async () => {
    const { ctx, select, custom } = createCtx({ mode: 'print' })
    await handler("5m 'check build'", ctx)
    expect(select).not.toHaveBeenCalled()
    expect(custom).not.toHaveBeenCalled()
    expect(backend.appendedOps.some(op => op.op === 'upsert')).toBe(true)
  })

  // ── json / print 无参 → throw ──

  it('json / print：无参 → throw（notify 是 no-op，stderr 是唯一可见通道）', async () => {
    for (const mode of ['json', 'print']) {
      const { ctx } = createCtx({ mode })
      await expect(handler('', ctx)).rejects.toThrow('No interactive form')
    }
    expect(backend.appendedOps).toHaveLength(0)
  })

  // ── json / print 带参失败 → throw（不被 catch 吞） ──

  it('json / print：缺 prompt → throw', async () => {
    for (const mode of ['json', 'print']) {
      const { ctx } = createCtx({ mode })
      await expect(handler('5m', ctx)).rejects.toThrow('No interactive form')
    }
  })

  it('json / print：非法 schedule → throw（service 失败原样上抛，不被 catch 吞）', async () => {
    for (const mode of ['json', 'print']) {
      const { ctx, notify } = createCtx({ mode })
      await expect(handler("nonsense-bad-spec 'x'", ctx)).rejects.toThrow('Invalid schedule')
      expect(notify).not.toHaveBeenCalled()
    }
    expect(backend.appendedOps).toHaveLength(0)
  })
})
