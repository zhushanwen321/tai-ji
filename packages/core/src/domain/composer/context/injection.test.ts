/**
 * useComposerInjection 测试（core 迁移版，全 deps mock + 真实 injectionStore）。
 *
 * 覆盖路由矩阵（target × variant × sessionId 匹配）+ chipType 分发（file/text）+
 * clearInjection 验证 + startFlow 失败清残留。用真实 createComposerInjectionStore（纯 factory，
 * 无 pinia 依赖）驱动 pendingInjection/clearInjection/routeToLanding，其余跨域能力 mock 注入。
 *
 * onMounted 补检查逻辑因需组件挂载环境（composable 测试无组件实例不触发），本文件不直接覆盖；
 * 其核心 consume 路由逻辑经 watch 路径完整覆盖（onMounted 复用同一 consume）。
 */
import { describe, it, expect, vi } from 'vitest'
import { effectScope, nextTick, ref, type Ref } from 'vue'
import { useComposerInjection, type InjectionDeps } from './injection'
import { createComposerInjectionStore } from './injection-store'

/** 等所有 microtask（consume async 链）跑完，弥补单次 nextTick 对 await startFlow 链的不足 */
const flushAll = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

type Spy = ReturnType<typeof vi.fn>

interface MockInput {
  focus: Spy
  insertFileChip: Spy
  insertTextAtCursor: Spy
  insertSessionChip: Spy
}

interface SetupCtx {
  input: MockInput
  sessionId: Ref<string | null>
  variant: Ref<'panel' | 'landing'>
  store: ReturnType<typeof createComposerInjectionStore>
  startFlow: Spy
  getSessionCwd: Spy
  getActiveSessionId: Spy
  scope: ReturnType<typeof effectScope>
}

function setup(opts: {
  sessionId?: string | null
  variant?: 'panel' | 'landing'
  activeSessionId?: string | null
  cwd?: string
  startFlowImpl?: ((cwd?: string) => Promise<void>) & ReturnType<typeof vi.fn>
} = {}): SetupCtx {
  const input: MockInput = {
    focus: vi.fn(),
    insertFileChip: vi.fn(),
    insertTextAtCursor: vi.fn(),
    insertSessionChip: vi.fn(),
  }
  const sessionId = ref<string | null>(opts.sessionId ?? 's1')
  const variant = ref<'panel' | 'landing'>(opts.variant ?? 'panel')
  const store = createComposerInjectionStore()
  const startFlow = opts.startFlowImpl ?? vi.fn((_cwd?: string) => Promise.resolve(undefined))
  const getSessionCwd = vi.fn((_cwd?: string) => opts.cwd ?? '/test')
  const getActiveSessionId = vi.fn(() => opts.activeSessionId ?? null)
  const deps: InjectionDeps = { injectionStore: store, startFlow, getSessionCwd, getActiveSessionId }
  const scope = effectScope()
  scope.run(() => useComposerInjection(ref(input) as unknown as Parameters<typeof useComposerInjection>[0], sessionId, variant, deps))
  return { input, sessionId, variant, store, startFlow, getSessionCwd, getActiveSessionId, scope }
}

describe('useComposerInjection · target=new 路由', () => {
  it('variant=panel + 活跃 session → startFlow + routeToLanding（不 applyInjection）', async () => {
    const ctx = setup({ sessionId: 's1', variant: 'panel', activeSessionId: 's1' })
    ctx.store.requestInjection({ target: 'new', path: '/a.ts' })
    await nextTick()
    await flushAll()
    expect(ctx.startFlow).toHaveBeenCalledWith('/test')
    expect(ctx.input.insertFileChip).not.toHaveBeenCalled()
    // routeToLanding 改写：target→current，sessionId→null（landing composer 接手阶段二）
    expect(ctx.store.pendingInjection.value?.target).toBe('current')
    expect(ctx.store.pendingInjection.value?.sessionId).toBeNull()
    ctx.scope.stop()
  })

  it('variant=panel + 非活跃 session → 不 startFlow，pending 保留', async () => {
    const ctx = setup({ sessionId: 's1', variant: 'panel', activeSessionId: 'other' })
    ctx.store.requestInjection({ target: 'new', path: '/a.ts' })
    await nextTick()
    await flushAll()
    expect(ctx.startFlow).not.toHaveBeenCalled()
    expect(ctx.input.insertFileChip).not.toHaveBeenCalled()
    expect(ctx.store.pendingInjection.value?.target).toBe('new')
    ctx.scope.stop()
  })

  it('variant=landing → 直接 applyInjection + clearInjection（不需 startFlow）', async () => {
    const ctx = setup({ variant: 'landing' })
    ctx.store.requestInjection({ target: 'new', path: '/a.ts' })
    await nextTick()
    expect(ctx.startFlow).not.toHaveBeenCalled()
    expect(ctx.input.insertFileChip).toHaveBeenCalledWith('/a.ts', undefined)
    expect(ctx.store.pendingInjection.value).toBeNull()
    ctx.scope.stop()
  })
})

describe('useComposerInjection · target=current 路由', () => {
  it('variant=landing + sessionId=null → applyInjection + clearInjection', async () => {
    const ctx = setup({ variant: 'landing' })
    ctx.store.requestInjection({ target: 'current', sessionId: null, path: '/b.ts' })
    await nextTick()
    expect(ctx.input.insertFileChip).toHaveBeenCalledWith('/b.ts', undefined)
    expect(ctx.store.pendingInjection.value).toBeNull()
    ctx.scope.stop()
  })

  it('variant=landing + sessionId≠null → 不匹配，pending 保留', async () => {
    const ctx = setup({ variant: 'landing' })
    ctx.store.requestInjection({ target: 'current', sessionId: 's1', path: '/b.ts' })
    await nextTick()
    expect(ctx.input.insertFileChip).not.toHaveBeenCalled()
    expect(ctx.store.pendingInjection.value?.path).toBe('/b.ts')
    ctx.scope.stop()
  })

  it('variant=panel + sessionId 匹配 → applyInjection + clearInjection', async () => {
    const ctx = setup({ sessionId: 's1', variant: 'panel' })
    ctx.store.requestInjection({ target: 'current', sessionId: 's1', path: '/c.ts' })
    await nextTick()
    expect(ctx.input.insertFileChip).toHaveBeenCalledWith('/c.ts', undefined)
    expect(ctx.store.pendingInjection.value).toBeNull()
    ctx.scope.stop()
  })

  it('variant=panel + sessionId 不匹配（stale session）→ 丢弃不 apply，pending 保留', async () => {
    const ctx = setup({ sessionId: 's1', variant: 'panel' })
    ctx.store.requestInjection({ target: 'current', sessionId: 'other', path: '/c.ts' })
    await nextTick()
    expect(ctx.input.insertFileChip).not.toHaveBeenCalled()
    expect(ctx.store.pendingInjection.value?.path).toBe('/c.ts')
    ctx.scope.stop()
  })
})

describe('useComposerInjection · chipType 分发（file/text）', () => {
  it('text 请求 → insertTextAtCursor', async () => {
    const ctx = setup({ sessionId: 's1', variant: 'panel' })
    ctx.store.requestInjection({ target: 'current', sessionId: 's1', text: '发给 AI 的选区' })
    await nextTick()
    expect(ctx.input.insertTextAtCursor).toHaveBeenCalledWith('发给 AI 的选区')
    expect(ctx.input.insertFileChip).not.toHaveBeenCalled()
    expect(ctx.input.focus).toHaveBeenCalled()
    ctx.scope.stop()
  })

  it('path + lineRange → insertFileChip(path, [start, end])', async () => {
    const ctx = setup({ sessionId: 's1', variant: 'panel' })
    ctx.store.requestInjection({
      target: 'current', sessionId: 's1', path: '/d.ts', lineStart: 10, lineEnd: 20,
    })
    await nextTick()
    expect(ctx.input.insertFileChip).toHaveBeenCalledWith('/d.ts', [10, 20])
    ctx.scope.stop()
  })

  it('refSessionId 请求 → insertSessionChip(refSessionId, label) + focus（§3.3.4 sidebar 直引）', async () => {
    const ctx = setup({ sessionId: 's-target', variant: 'panel' })
    ctx.store.requestInjection({
      target: 'current', sessionId: 's-target', refSessionId: 's-ref', label: 'fix-com 设计讨论',
    })
    await nextTick()
    expect(ctx.input.insertSessionChip).toHaveBeenCalledWith('s-ref', 'fix-com 设计讨论')
    expect(ctx.input.focus).toHaveBeenCalled()
    expect(ctx.input.insertFileChip).not.toHaveBeenCalled()
    expect(ctx.input.insertTextAtCursor).not.toHaveBeenCalled()
    expect(ctx.store.pendingInjection.value).toBeNull()
    ctx.scope.stop()
  })

  it('refSessionId 请求 label 缺省 → chip label 兜底 refSessionId', async () => {
    const ctx = setup({ sessionId: 's1', variant: 'panel' })
    ctx.store.requestInjection({ target: 'current', sessionId: 's1', refSessionId: 's-ref' })
    await nextTick()
    expect(ctx.input.insertSessionChip).toHaveBeenCalledWith('s-ref', 's-ref')
    ctx.scope.stop()
  })

  it('target=new 的 refSessionId 请求 → landing variant 直接消费 insertSessionChip', async () => {
    const ctx = setup({ variant: 'landing' })
    ctx.store.requestInjection({ target: 'new', refSessionId: 's-ref', label: 'landing 引用' })
    await nextTick()
    expect(ctx.startFlow).not.toHaveBeenCalled()
    expect(ctx.input.insertSessionChip).toHaveBeenCalledWith('s-ref', 'landing 引用')
    expect(ctx.store.pendingInjection.value).toBeNull()
    ctx.scope.stop()
  })
})

describe('useComposerInjection · startFlow 失败清残留（W8）', () => {
  it('startFlow reject → clearInjection 防永久占槽', async () => {
    const ctx = setup({
      sessionId: 's1', variant: 'panel', activeSessionId: 's1',
      startFlowImpl: vi.fn().mockRejectedValue(new Error('landing 已占用')),
    })
    ctx.store.requestInjection({ target: 'new', path: '/e.ts' })
    await nextTick()
    await flushAll()
    expect(ctx.startFlow).toHaveBeenCalledWith('/test')
    expect(ctx.input.insertFileChip).not.toHaveBeenCalled()
    // 失败后清空占位请求，防后续误判为「阶段二遗留」误消费
    expect(ctx.store.pendingInjection.value).toBeNull()
    ctx.scope.stop()
  })
})
