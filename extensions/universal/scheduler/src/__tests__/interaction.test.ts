import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'

import { MockSchedulerBackend } from './mock-backend.js'
import {
  abortPendingScheduleForms,
  buildDraft,
  collectModelIds,
  openScheduleFormAsync,
  type ScheduleDraftSeed,
} from '../interaction.js'
import { SchedulerRuntime } from '../runtime.js'
import { SchedulerService } from '../service.js'

/**
 * interaction.ts 单测（不是纯平移：迁移自 tool.ts 的草稿构造 + 新增的命令路径生命周期接线）：
 * - 表单预填草稿构造（models 注入：scopedModels 优先、getAvailable() 回退——P-SCOPED）+ currentModel
 * - 模块级 AbortController 注册表：session_shutdown 接线点 abortPendingScheduleForms() 中止挂起表单
 *
 * 交互四态 / 协议错配 / 答案解析的命令路径覆盖见 commands-form.test.ts（含从 tool-create-flow
 * 迁移的 channel-error / non-json / echo 三条错误分支用例）。
 */

/** model stub：仅消费点字段（modelRef 读 provider/id） */
function stubModel(provider: string, id: string): { provider: string; id: string } {
  return { provider, id }
}

interface CtxOverrides {
  mode?: string
  custom?: (factory: unknown) => Promise<unknown>
  scopedModels?: { model: { provider: string; id: string } }[]
  model?: { provider: string; id: string } | undefined
  getAvailable?: () => { provider: string; id: string }[]
}

function createMockCtx(overrides: CtxOverrides = {}): ExtensionCommandContext {
  const ctx: Record<string, unknown> = {
    mode: 'rpc',
    hasUI: true,
    ui: { custom: overrides.custom, notify: vi.fn() },
    scopedModels: overrides.scopedModels ?? [],
    model: overrides.model,
    modelRegistry: { getAvailable: overrides.getAvailable ?? (() => []) },
    ...overrides,
  }
  return ctx as unknown as ExtensionCommandContext
}

function makeService(): SchedulerService {
  const backend = new MockSchedulerBackend()
  return new SchedulerService(new SchedulerRuntime(backend), () => backend.now())
}

const SEED: ScheduleDraftSeed = { schedule: '5m', prompt: 'agent draft' }

describe('buildDraft / collectModelIds（Draft.models 注入 P-SCOPED）', () => {
  it('models 回退：scopedModels 恒空（S12 taiji 形态）→ getAvailable() 映射 provider/id 列表 + currentModel', () => {
    const getAvailable = vi.fn(() => [stubModel('prov-a', 'm1'), stubModel('prov-b', 'm2')])
    const ctx = createMockCtx({ getAvailable, model: stubModel('prov-a', 'm1') })

    const draft = buildDraft(SEED, ctx)

    expect(getAvailable).toHaveBeenCalled()
    expect(draft.models).toEqual(['prov-a/m1', 'prov-b/m2'])
    expect(draft.currentModel).toBe('prov-a/m1')
  })

  it('models 优先：scopedModels 非空 → scoped 映射，getAvailable 不被调用', () => {
    const getAvailable = vi.fn(() => [stubModel('prov-a', 'm1')])
    const ctx = createMockCtx({
      getAvailable,
      scopedModels: [{ model: stubModel('prov-s', 'scoped-m') }],
      model: stubModel('prov-s', 'scoped-m'),
    })

    const draft = buildDraft(SEED, ctx)

    expect(getAvailable).not.toHaveBeenCalled()
    expect(draft.models).toEqual(['prov-s/scoped-m'])
    expect(draft.currentModel).toBe('prov-s/scoped-m')
  })

  it('buildDraft：seed 的 kind 缺省 recurring、可选字段按存在性透传（缺省不写键）', () => {
    const ctx = createMockCtx()

    expect(buildDraft(SEED, ctx)).toEqual({
      kind: 'recurring',
      schedule: '5m',
      prompt: 'agent draft',
      models: [],
    })

    const full = buildDraft(
      { ...SEED, kind: 'once', name: 'n', expires: 'never', model: 'prov-a/m1' },
      ctx,
    )
    expect(full).toMatchObject({ kind: 'once', name: 'n', expires: 'never', model: 'prov-a/m1' })
  })

  it('collectModelIds：无 scoped 且无可用模型 → 空列表（表单跟随会话当前模型）', () => {
    expect(collectModelIds(createMockCtx())).toEqual([])
  })
})

describe('模块级 AbortController 注册表（session_shutdown 接线）', () => {
  it('abortPendingScheduleForms()：中止挂起中表单的 AbortController（tui 分支 await 收尾）', async () => {
    const stubTui = { requestRender() {} }
    const stubTheme = {
      fg: (_token: string, text: string) => text,
      bg: (_token: string, text: string) => text,
      bold: (text: string) => text,
      inverse: (text: string) => text,
    }
    // custom 工厂接收 done；abort 后组件 cancel() → done(null) → custom 的 promise 解出，run() 收尾
    const custom = vi.fn((factory: (
      tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void,
    ) => unknown) => new Promise<unknown>((resolve) => {
      factory(stubTui, stubTheme, {}, r => resolve(r ?? null))
    }))
    const ctx = createMockCtx({ mode: 'tui', custom })
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort')

    try {
      // tui 分支：openScheduleFormAsync 会 await run()，abort 后由 comp.cancel() 解出
      const pending = openScheduleFormAsync(ctx, makeService(), SEED, { unavailable: false })
      await Promise.resolve() // 让 run() 跑到 factory（abort listener 注册）
      abortPendingScheduleForms()
      await pending

      expect(abortSpy).toHaveBeenCalled()
    } finally {
      abortSpy.mockRestore()
    }
  })

  it('abortPendingScheduleForms()：无挂起表单时 no-op（不抛）', () => {
    expect(() => abortPendingScheduleForms()).not.toThrow()
  })
})
