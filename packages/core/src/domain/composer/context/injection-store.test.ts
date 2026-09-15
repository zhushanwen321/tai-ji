/**
 * composer injection store 单元测试（W3）。
 *
 * 合并自 renderer __tests__/stores/composer-injection.test.ts（file chip 场景）+
 * __tests__/terminal/composer-injection-text.test.ts（text 注入场景）。
 *
 * factory 模式：每个测试 `const store = createComposerInjectionStore()` 创建独立实例，
 * 不依赖 pinia（core 不持 pinia，store id 绑定是 shell 关切）。
 *
 * 与 pinia 的关键差异：factory 返回的 pendingInjection 是 **Ref**（不自动解包），
 * 测试访问需 `.value`（pinia defineStore 会自动解包 ref，factory 不会）。壳层
 * setup 时若需要自动解包语义，可在 pinia setup 内用 `storeToRefs` 或包装。
 *
 * 覆盖语义不变：pendingInjection 单值消息槽 + clearInjection + routeToLanding +
 * lineRange 透传 + target=new 时 sessionId 强制 null。
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/context/injection-store.test.ts
 */
import { describe, it, expect } from 'vitest'
import { createComposerInjectionStore } from './injection-store'

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
