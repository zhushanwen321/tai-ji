/**
 * useBrowserFocusSync 单测（Browser Drawer Wave 4）。
 *
 * 覆盖：
 * - focusedSessionId 变化时调 browserFocus(newSid)
 * - immediate: true 首次挂载时（已有 session）触发一次
 * - null sid（无 session）时不调 browserFocus
 *
 * mock 策略：vi.mock('@/lib/ipc') 捕获 browserFocus；vi.mock('@/stores/panel') 提供可控的
 * focusedSessionId ref。composable 经 storeToRefs(panel) 读 focusedSessionId（单 panel 下直接读
 * layout.value.sessionId）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useBrowserFocusSync.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ── mock lib/ipc：捕获 browserFocus ──
const mockBrowserFocus = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/ipc', () => ({
  browserFocus: (sid: string) => mockBrowserFocus(sid),
}))

// ── mock panel store：模拟 Pinia store 的 ref 自动 unwrap 行为 ──
// composable 经 storeToRefs(panel) 读 focusedSessionId（panel store 暴露的 computed，
// 单 panel 下直接读 layout.value.sessionId）。mock 提供可控的 focusedSessionId ref。
const focusedSessionIdRef = ref<string | null>(null)

vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({
    // storeToRefs 读 ref/computed：返回真实 ref 让 watch 依赖追踪正常工作
    focusedSessionId: focusedSessionIdRef,
  }),
}))

import { useBrowserFocusSync } from '@/composables/features/browser/useBrowserFocusSync'

import { afterEach } from 'vitest'

/** 当前测试的 effectScope（beforeEach 时 stop 上一轮的，防 watch 泄漏到下一个测试） */
let currentScope: ReturnType<typeof effectScope> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  // stop 上一轮 scope，确保上一个测试的 watch 不响应本轮 ref 重置（否则 mock 被多调）
  currentScope?.stop()
  currentScope = null
  vi.clearAllMocks()
  focusedSessionIdRef.value = null
})

afterEach(() => {
  currentScope?.stop()
  currentScope = null
})

/**
 * 在 effectScope 内调 composable。composable 内部用 watch，跟随 active scope 生命周期。
 * scope 在 beforeEach/afterEach 自动 stop，测试内无需手动清理。
 */
function setupFocusSync(): void {
  const scope = effectScope()
  scope.run(() => {
    useBrowserFocusSync()
  })
  currentScope = scope
}

describe('useBrowserFocusSync（Wave 4）', () => {
  it('immediate: 首次挂载时已有 session → 立即调 browserFocus(sid)', async () => {
    focusedSessionIdRef.value = 'sess-A'

    setupFocusSync()
    // watch immediate 回调是同步的，但 browserFocus 返回 Promise（void），flush 后断言
    await Promise.resolve()

    expect(mockBrowserFocus).toHaveBeenCalledWith('sess-A')
  })

  it('focusedSessionId 变化 → 调 browserFocus(newSid)', async () => {
    focusedSessionIdRef.value = 'sess-A'

    setupFocusSync()
    await Promise.resolve()
    expect(mockBrowserFocus).toHaveBeenCalledTimes(1)

    // 切到 sess-B
    focusedSessionIdRef.value = 'sess-B'
    await Promise.resolve()

    expect(mockBrowserFocus).toHaveBeenCalledWith('sess-B')
    expect(mockBrowserFocus).toHaveBeenCalledTimes(2)
  })

  it('focusedSessionId 变 null（无 session）→ 不调 browserFocus', async () => {
    focusedSessionIdRef.value = 'sess-A'

    setupFocusSync()
    await Promise.resolve()
    expect(mockBrowserFocus).toHaveBeenCalledTimes(1)

    // focusedSessionId 变 null（无 session）
    focusedSessionIdRef.value = null
    await Promise.resolve()

    // null sid 时 watch 回调跳过，不调 browserFocus
    expect(mockBrowserFocus).toHaveBeenCalledTimes(1)
  })

  it('首次挂载时无 session（focusedSessionId=null）→ 不调 browserFocus', async () => {
    setupFocusSync()
    await Promise.resolve()

    expect(mockBrowserFocus).not.toHaveBeenCalled()
  })
})
