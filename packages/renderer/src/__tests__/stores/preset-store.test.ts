/**
 * preset store 纯状态容器单测（pi-launch-presets wave1，TC-3）。
 *
 * 覆盖：
 * - 初值：presets=[]、defaultPresetId=''
 * - setPresets([a,b]) → store.presets === [a,b]
 * - setDefaultPresetId('builtin:full') → store.defaultPresetId === 'builtin:full'
 *
 * mock 策略：setActivePinia(createPinia()) 后直接调 store action 读 state。
 * 纯状态容器无外部依赖，无需 mock @/api（且源码不 import @/api——铁律）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/preset-store.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { PiLaunchPreset } from '@taiji/shared'
import { usePresetStore } from '@/stores/preset'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('preset store 初值', () => {
  it('初值：presets=[]、defaultPresetId=""', () => {
    const store = usePresetStore()
    expect(store.presets).toEqual([])
    expect(store.defaultPresetId).toBe('')
  })
})

describe('preset store setPresets（TC-3）', () => {
  it('setPresets([a,b]) → store.presets === [a,b]', () => {
    const store = usePresetStore()
    const presets: PiLaunchPreset[] = [
      { id: 'builtin:full', name: '全工具模式', builtin: true, order: 0, toolMode: 'all', extensionMode: 'all' },
      { id: 'builtin:readonly', name: '只读模式', builtin: true, order: 2, toolMode: 'allowlist', allowedTools: ['read'], extensionMode: 'all' },
    ]
    store.setPresets(presets)
    expect(store.presets).toEqual(presets)
    expect(store.presets).toHaveLength(2)
  })
})

describe('preset store setDefaultPresetId（TC-3）', () => {
  it('setDefaultPresetId("builtin:full") → store.defaultPresetId === "builtin:full"', () => {
    const store = usePresetStore()
    store.setDefaultPresetId('builtin:full')
    expect(store.defaultPresetId).toBe('builtin:full')
  })

  it('重复 setDefaultPresetId 覆盖（纯写入幂等覆盖）', () => {
    const store = usePresetStore()
    store.setDefaultPresetId('builtin:full')
    store.setDefaultPresetId('builtin:readonly')
    expect(store.defaultPresetId).toBe('builtin:readonly')
  })
})
