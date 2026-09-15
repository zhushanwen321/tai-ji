/**
 * composer-injection store 单元测试（W2, U5）。
 *
 * 验证 pendingInjection 单值消息槽：覆盖语义 + clearInjection + routeToLanding。
 * 参照 commandStore.pendingSlash 模式。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'

describe('composer-injection store（W2）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // W4：store 改为模块级单例（composer-injection-store.ts），跨测试需显式清槽
    // （原 pinia wrapper 每次 setActivePinia 重建实例，单例没有该语义）
    composerInjectionStore.clearInjection()
  })

  it('U5: pendingInjection 单值覆盖（后者覆盖前者）', () => {
    const store = composerInjectionStore
    store.requestInjection({ target: 'current', path: 'a.ts', sessionId: 's1' })
    expect(store.pendingInjection.value?.path).toBe('a.ts')
    store.requestInjection({ target: 'current', path: 'b.ts', sessionId: 's1' })
    expect(store.pendingInjection.value?.path).toBe('b.ts')
  })

  it('U5b: requestInjection 内部补 ts', () => {
    const store = composerInjectionStore
    store.requestInjection({ target: 'current', path: 'a.ts', sessionId: 's1' })
    expect(store.pendingInjection.value?.ts).toBeTypeOf('number')
  })

  it('U5c: clearInjection 置 null', () => {
    const store = composerInjectionStore
    store.requestInjection({ target: 'current', path: 'a.ts', sessionId: 's1' })
    store.clearInjection()
    expect(store.pendingInjection.value).toBeNull()
  })

  it('U5d: payload 含 lineStart/lineEnd 时透传', () => {
    const store = composerInjectionStore
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

  it('U5e: target=new 时 sessionId 强制 null（新对话落地 landing composer）', () => {
    const store = composerInjectionStore
    store.requestInjection({ target: 'new', path: 'a.ts', sessionId: 's1' })
    expect(store.pendingInjection.value?.target).toBe('new')
    expect(store.pendingInjection.value?.sessionId).toBeNull()
  })

  it('U5f: routeToLanding 把 target 从 new 改 current 并重置 ts', () => {
    const store = composerInjectionStore
    store.requestInjection({ target: 'new', path: 'a.ts', sessionId: 's1' })
    const tsBefore = store.pendingInjection.value!.ts
    store.routeToLanding()
    expect(store.pendingInjection.value?.target).toBe('current')
    expect(store.pendingInjection.value?.sessionId).toBeNull()
    expect(store.pendingInjection.value!.ts).toBeGreaterThanOrEqual(tsBefore)
  })

  it('U5g: routeToLanding 无 pendingInjection 时 no-op', () => {
    const store = composerInjectionStore
    store.routeToLanding()
    expect(store.pendingInjection.value).toBeNull()
  })
})
