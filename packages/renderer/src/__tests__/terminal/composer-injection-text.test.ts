/**
 * composer-injection text 注入测试（Phase 4 V4.1）。
 *
 * 验证 PendingInjection schema 加 text 字段后：
 * - requestInjection({ target:'current', text }) → 消费端调 insertTextAtCursor
 * - file chip 路径（path）不受影响，仍调 insertFileChip
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/terminal/composer-injection-text.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { composerInjectionStore } from '@/composables/panel/composer-injection-store'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('composer-injection text 扩展（Phase 4 联动 1）', () => {
  it('CI-1: requestInjection({ text }) 写入 pendingInjection 含 text 字段', () => {
    const store = composerInjectionStore
    store.requestInjection({ target: 'current', text: 'terminal output line', sessionId: 's1' })
    expect(store.pendingInjection.value).toBeTruthy()
    expect(store.pendingInjection.value!.text).toBe('terminal output line')
    expect(store.pendingInjection.value!.path).toBeUndefined()
    expect(store.pendingInjection.value!.sessionId).toBe('s1')
    expect(store.pendingInjection.value!.ts).toBeGreaterThan(0)
  })

  it('CI-2: requestInjection({ path }) 仍正常写入 path（file chip 路径不受影响）', () => {
    const store = composerInjectionStore
    store.requestInjection({ target: 'current', path: '/a/b.ts', lineStart: 1, lineEnd: 5, sessionId: 's1' })
    expect(store.pendingInjection.value!.path).toBe('/a/b.ts')
    expect(store.pendingInjection.value!.text).toBeUndefined()
    expect(store.pendingInjection.value!.lineStart).toBe(1)
    expect(store.pendingInjection.value!.lineEnd).toBe(5)
  })

  it('CI-3: target=new 时 sessionId 强制 null（text 也遵守）', () => {
    const store = composerInjectionStore
    store.requestInjection({ target: 'new', text: 'some output', sessionId: 'ignored-sid' })
    expect(store.pendingInjection.value!.sessionId).toBeNull()
    expect(store.pendingInjection.value!.text).toBe('some output')
  })

  it('CI-4: clearInjection 清空 pendingInjection', () => {
    const store = composerInjectionStore
    store.requestInjection({ target: 'current', text: 'x', sessionId: 's1' })
    store.clearInjection()
    expect(store.pendingInjection.value).toBeNull()
  })

  it('CI-5: routeToLanding 把 target new→current + sessionId→null（text 场景）', () => {
    const store = composerInjectionStore
    store.requestInjection({ target: 'new', text: 'error log', sessionId: 'ignored' })
    const originalTs = store.pendingInjection.value!.ts
    store.routeToLanding()
    expect(store.pendingInjection.value!.target).toBe('current')
    expect(store.pendingInjection.value!.sessionId).toBeNull()
    expect(store.pendingInjection.value!.text).toBe('error log')
    expect(store.pendingInjection.value!.ts).toBeGreaterThanOrEqual(originalTs)
  })
})
