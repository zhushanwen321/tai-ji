// injection.test.ts —— core C26 簇合并产物（round5-G）。
// 共同被测业务模块：`src/domain/composer/context/injection-store.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/domain/composer/context/injection-store.test.ts（17 用例，skip 0）
//   - src/domain/composer/context/injection.test.ts（13 用例，skip 0）

import { describe, it, expect, vi } from 'vitest'
import { createComposerInjectionStore } from './injection-store'
import { effectScope, nextTick, ref, type Ref } from 'vue'
import { useComposerInjection, type InjectionDeps } from './injection'

// ======== 来源：injection-store.test.ts ========
describe("injection-store", () => {
  describe('composer-injection store（file chip 场景）', () => {
    it('pendingInjection 单值覆盖（后者覆盖前者）', () => {
      const store = createComposerInjectionStore()
      store.requestInjection({ target: 'current', path: 'a.ts', sessionId: 's1' })
      expect(store.pendingInjection.value?.path).toBe('a.ts')
      store.requestInjection({ target: 'current', path: 'b.ts', sessionId: 's1' })
      expect(store.pendingInjection.value?.path).toBe('b.ts')
    })

    it('requestInjection 内部补 ts', () => {
      const store = createComposerInjectionStore()
      store.requestInjection({ target: 'current', path: 'a.ts', sessionId: 's1' })
      expect(store.pendingInjection.value?.ts).toBeTypeOf('number')
    })

    it('clearInjection 置 null', () => {
      const store = createComposerInjectionStore()
      store.requestInjection({ target: 'current', path: 'a.ts', sessionId: 's1' })
      store.clearInjection()
      expect(store.pendingInjection.value).toBeNull()
    })

    it('payload 含 lineStart/lineEnd 时透传', () => {
      const store = createComposerInjectionStore()
      store.requestInjection({
        target: 'current',
        path: 'a.ts',
        lineStart: 10,
        lineEnd: 20,
        sessionId: 's1',
      })
      expect(store.pendingInjection.value?.lineStart).toBe(10)
      expect(store.pendingInjection.value?.lineEnd).toBe(20)
    })

    it('target=new 时 sessionId 强制 null（新对话落地 landing composer）', () => {
      const store = createComposerInjectionStore()
      store.requestInjection({ target: 'new', path: 'a.ts', sessionId: 's1' })
      expect(store.pendingInjection.value?.target).toBe('new')
      expect(store.pendingInjection.value?.sessionId).toBeNull()
    })

    it('routeToLanding 把 target 从 new 改 current 并重置 ts', () => {
      const store = createComposerInjectionStore()
      store.requestInjection({ target: 'new', path: 'a.ts', sessionId: 's1' })
      const tsBefore = store.pendingInjection.value!.ts
      store.routeToLanding()
      expect(store.pendingInjection.value?.target).toBe('current')
      expect(store.pendingInjection.value?.sessionId).toBeNull()
      expect(store.pendingInjection.value!.ts).toBeGreaterThanOrEqual(tsBefore)
    })

    it('routeToLanding 无 pendingInjection 时 no-op', () => {
      const store = createComposerInjectionStore()
      store.routeToLanding()
      expect(store.pendingInjection.value).toBeNull()
    })
  })

  describe('composer-injection text 扩展（Phase 4 联动 1）', () => {
    it('requestInjection({ text }) 写入 pendingInjection 含 text 字段', () => {
      const store = createComposerInjectionStore()
      store.requestInjection({ target: 'current', text: 'terminal output line', sessionId: 's1' })
      expect(store.pendingInjection.value).toBeTruthy()
      expect(store.pendingInjection.value!.text).toBe('terminal output line')
      expect(store.pendingInjection.value!.path).toBeUndefined()
      expect(store.pendingInjection.value!.sessionId).toBe('s1')
      expect(store.pendingInjection.value!.ts).toBeGreaterThan(0)
    })

    it('requestInjection({ path }) 仍正常写入 path（file chip 路径不受影响）', () => {
      const store = createComposerInjectionStore()
      store.requestInjection({ target: 'current', path: '/a/b.ts', lineStart: 1, lineEnd: 5, sessionId: 's1' })
      expect(store.pendingInjection.value!.path).toBe('/a/b.ts')
      expect(store.pendingInjection.value!.text).toBeUndefined()
      expect(store.pendingInjection.value!.lineStart).toBe(1)
      expect(store.pendingInjection.value!.lineEnd).toBe(5)
    })

    it('target=new 时 sessionId 强制 null（text 也遵守）', () => {
      const store = createComposerInjectionStore()
      store.requestInjection({ target: 'new', text: 'some output', sessionId: 'ignored-sid' })
      expect(store.pendingInjection.value!.sessionId).toBeNull()
      expect(store.pendingInjection.value!.text).toBe('some output')
    })

    it('clearInjection 清空 pendingInjection', () => {
      const store = createComposerInjectionStore()
      store.requestInjection({ target: 'current', text: 'x', sessionId: 's1' })
      store.clearInjection()
      expect(store.pendingInjection.value).toBeNull()
    })

    it('routeToLanding 把 target new→current + sessionId→null（text 场景）', () => {
      const store = createComposerInjectionStore()
      store.requestInjection({ target: 'new', text: 'error log', sessionId: 'ignored' })
      const originalTs = store.pendingInjection.value!.ts
      store.routeToLanding()
      expect(store.pendingInjection.value!.target).toBe('current')
      expect(store.pendingInjection.value!.sessionId).toBeNull()
      expect(store.pendingInjection.value!.text).toBe('error log')
      expect(store.pendingInjection.value!.ts).toBeGreaterThanOrEqual(originalTs)
    })
  })

  describe('composer-injection session 引用扩展（四符号体系 §3.3.4 sidebar 直引）', () => {
    it('requestInjection({ refSessionId, label }) 写入 pendingInjection 含两字段', () => {
      const store = createComposerInjectionStore()
      store.requestInjection({
        target: 'current',
        sessionId: 's-target',
        refSessionId: 's-ref',
        label: 'fix-com 设计讨论',
      })
      expect(store.pendingInjection.value!.refSessionId).toBe('s-ref')
      expect(store.pendingInjection.value!.label).toBe('fix-com 设计讨论')
      // 目标路由 sessionId 与被引用 refSessionId 独立（两个不同 session）
      expect(store.pendingInjection.value!.sessionId).toBe('s-target')
      expect(store.pendingInjection.value!.ts).toBeGreaterThan(0)
    })

    it('互斥归一化：refSessionId 存在时丢弃 path/text/行范围', () => {
      const store = createComposerInjectionStore()
      store.requestInjection({
        target: 'current',
        sessionId: 's-target',
        path: 'a.ts',
        lineStart: 1,
        lineEnd: 5,
        text: 'stale text',
        refSessionId: 's-ref',
        label: '引用',
      })
      expect(store.pendingInjection.value!.refSessionId).toBe('s-ref')
      expect(store.pendingInjection.value!.path).toBeUndefined()
      expect(store.pendingInjection.value!.lineStart).toBeUndefined()
      expect(store.pendingInjection.value!.lineEnd).toBeUndefined()
      expect(store.pendingInjection.value!.text).toBeUndefined()
    })

    it('不传 refSessionId 时 path 注入不受影响（互斥归一化零副作用）', () => {
      const store = createComposerInjectionStore()
      store.requestInjection({ target: 'current', path: 'a.ts', lineStart: 1, lineEnd: 5, sessionId: 's1' })
      expect(store.pendingInjection.value!.path).toBe('a.ts')
      expect(store.pendingInjection.value!.refSessionId).toBeUndefined()
      expect(store.pendingInjection.value!.label).toBeUndefined()
    })

    it('target=new 时 sessionId 强制 null 但 refSessionId/label 保留（landing 注入）', () => {
      const store = createComposerInjectionStore()
      store.requestInjection({
        target: 'new',
        sessionId: 'ignored',
        refSessionId: 's-ref',
        label: 'landing 引用',
      })
      expect(store.pendingInjection.value!.sessionId).toBeNull()
      expect(store.pendingInjection.value!.refSessionId).toBe('s-ref')
      expect(store.pendingInjection.value!.label).toBe('landing 引用')
    })

    it('clearInjection 清空 session 引用请求', () => {
      const store = createComposerInjectionStore()
      store.requestInjection({ target: 'current', sessionId: 's1', refSessionId: 's-ref', label: 'x' })
      store.clearInjection()
      expect(store.pendingInjection.value).toBeNull()
    })
  })
});

// ======== 来源：injection.test.ts ========
describe("injection", () => {
  /** 等所有 microtask（consume async 链）跑完，弥补单次 nextTick 对 await startFlow 链的不足 */
  const flushAll = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  type Spy = ReturnType<typeof vi.fn>

  interface MockInput { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    focus: Spy
    insertFileChip: Spy
    insertTextAtCursor: Spy
    insertSessionChip: Spy
  }

  interface SetupCtx { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
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
});
