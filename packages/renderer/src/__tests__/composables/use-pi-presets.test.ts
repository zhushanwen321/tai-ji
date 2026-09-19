/**
 * usePiPresets 编排层单测（pi-launch-presets wave1，TC-4/TC-5）。
 *
 * 覆盖：
 * - loadPresets()：mock presetApi.list/getDefault 并行调用，结果写 store（TC-4）
 * - loadPresets 降级：getDefault 失败不阻断 list 写 store（allSettled，TC-4 边界）
 * - setDefault(id)：乐观更新 store + 调 RPC（TC-5）
 * - **u5 加载点：`installPresetAutoLoad()`**（下方独立 describe）——首次 connected 后拉取 /
 *   安装时已 connected 立即可用 / 失败后下一次 connected 补拉（可自愈）/ 重连不重复请求（幂等）
 *   （`mode-declaration-row.test.ts` 头注声明“加载点本身由本文件覆盖”，即指该 describe）
 *
 * mock 策略：mock @/api 的 preset 域（vi.hoisted 捕获调用），真 pinia + 真 preset store。
 * 验证编排层「RPC 拉取 → store 写入」接线正确（不验 RPC 本身——那是 preset-domain.test 的职责）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-pi-presets.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import type { PiLaunchPreset } from '@taiji/shared'

// mock preset 域（捕获 list/getDefault/setDefault/create/update/remove 调用 + 可控返回值）
const presetApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  getDefault: vi.fn(),
  setDefault: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  preset: presetApiMock,
}))

// ── mock 边界：ws 连接态受控 ref（u5 加载点测试驱动；默认 disconnected，存量用例零影响）──
const wsMock = vi.hoisted(() => ({ ref: null as null | { value: string } }))
vi.mock('@taiji/core/transport/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/ws-client')>()
  const { ref } = await import('vue')
  const stateRef = ref<string>('disconnected')
  wsMock.ref = stateRef
  return { ...actual, getState: () => stateRef }
})

import { usePresetStore } from '@/stores/preset'
import {
  usePiPresets,
  installPresetAutoLoad,
  __resetPresetAutoLoadForTest,
} from '@/composables/features/settings/usePiPresets'

const FIXTURE_PRESETS: PiLaunchPreset[] = [
  { id: 'builtin:full', name: '全工具模式', builtin: true, order: 0, toolMode: 'all', extensionMode: 'all' },
  { id: 'builtin:readonly', name: '只读模式', builtin: true, order: 2, toolMode: 'allowlist', allowedTools: ['read'], extensionMode: 'all' },
]

beforeEach(() => {
  setActivePinia(createPinia())
  presetApiMock.list.mockReset()
  presetApiMock.getDefault.mockReset()
  presetApiMock.setDefault.mockReset()
  presetApiMock.create.mockReset()
  presetApiMock.update.mockReset()
  presetApiMock.remove.mockReset()
})

describe('usePiPresets.loadPresets（TC-4）', () => {
  it('loadPresets() → list 与 getDefault 并行调用，结果写 store', async () => {
    presetApiMock.list.mockResolvedValueOnce(FIXTURE_PRESETS)
    presetApiMock.getDefault.mockResolvedValueOnce('builtin:full')

    const store = usePresetStore()
    const { loadPresets } = usePiPresets()
    await loadPresets()

    expect(presetApiMock.list).toHaveBeenCalledTimes(1)
    expect(presetApiMock.getDefault).toHaveBeenCalledTimes(1)
    expect(store.presets).toEqual(FIXTURE_PRESETS)
    expect(store.defaultPresetId).toBe('builtin:full')
  })

  it('loadPresets 降级：getDefault reject 不阻断 list 写 store（allSettled）', async () => {
    presetApiMock.list.mockResolvedValueOnce(FIXTURE_PRESETS)
    presetApiMock.getDefault.mockRejectedValueOnce(new Error('rpc failed'))

    const store = usePresetStore()
    const { loadPresets } = usePiPresets()
    await loadPresets()

    // list 成功 → presets 写入；getDefault 失败 → defaultPresetId 保持初值 ''
    expect(store.presets).toEqual(FIXTURE_PRESETS)
    expect(store.defaultPresetId).toBe('')
  })

  it('loadPresets 降级：list reject 不阻断 getDefault 写 store（allSettled）', async () => {
    presetApiMock.list.mockRejectedValueOnce(new Error('rpc failed'))
    presetApiMock.getDefault.mockResolvedValueOnce('builtin:readonly')

    const store = usePresetStore()
    const { loadPresets } = usePiPresets()
    await loadPresets()

    expect(store.presets).toEqual([])
    expect(store.defaultPresetId).toBe('builtin:readonly')
  })
})

describe('usePiPresets.setDefault（TC-5）', () => {
  it('setDefault(id) → 乐观更新 store + 调 RPC', async () => {
    presetApiMock.setDefault.mockResolvedValueOnce(undefined)

    const store = usePresetStore()
    const { setDefault } = usePiPresets()
    await setDefault('builtin:readonly')

    expect(store.defaultPresetId).toBe('builtin:readonly')
    expect(presetApiMock.setDefault).toHaveBeenCalledWith('builtin:readonly')
  })
})

describe('usePiPresets.create（W-RN-3 reply 回写）', () => {
  it('create(preset) → 乐观 upsert + RPC reply 回写 store（runtime 补全字段）', async () => {
    const input: PiLaunchPreset = {
      id: 'custom:abc',
      name: '新预设',
      builtin: false,
      order: 99,
      toolMode: 'all',
      extensionMode: 'all',
    }
    // runtime reply 补全 order（99 → 3）
    const saved: PiLaunchPreset = { ...input, order: 3 }
    presetApiMock.create.mockResolvedValueOnce(saved)

    const store = usePresetStore()
    const { create } = usePiPresets()
    const result = await create(input)

    // 调用了 RPC
    expect(presetApiMock.create).toHaveBeenCalledWith(input)
    // 返回值是 reply（不是输入）
    expect(result).toEqual(saved)
    // store 里是 runtime 规范化后的 order=3（reply 回写覆盖乐观镜像）
    expect(store.presets).toHaveLength(1)
    expect(store.presets[0]!.order).toBe(3)
  })

  it('create RPC 失败 → 移除乐观插入的预设 + throw', async () => {
    const input: PiLaunchPreset = {
      id: 'custom:fail',
      name: '失败预设',
      builtin: false,
      order: 0,
      toolMode: 'all',
      extensionMode: 'all',
    }
    presetApiMock.create.mockRejectedValueOnce(new Error('rpc failed'))

    const store = usePresetStore()
    const { create } = usePiPresets()
    await expect(create(input)).rejects.toThrow('rpc failed')

    // 失败回滚：store 里没有该预设
    expect(store.presets.find((p) => p.id === 'custom:fail')).toBeUndefined()
  })
})

describe('usePiPresets.update（W-RN-3 reply 回写）', () => {
  it('update(preset) → 乐观 upsert + RPC reply 回写 store', async () => {
    const original: PiLaunchPreset = {
      id: 'builtin:full',
      name: '全工具模式',
      builtin: true,
      order: 0,
      toolMode: 'all',
      extensionMode: 'all',
    }
    const store = usePresetStore()
    store.setPresets([original])
    const input: PiLaunchPreset = { ...original, toolMode: 'denylist', deniedTools: ['bash'] }
    // runtime reply（PresetGuard 规范化后的权威态）
    const saved: PiLaunchPreset = { ...input, deniedTools: ['bash', 'edit'] }
    presetApiMock.update.mockResolvedValueOnce(saved)

    const { update } = usePiPresets()
    const result = await update(input)

    expect(presetApiMock.update).toHaveBeenCalledWith(input)
    expect(result).toEqual(saved)
    // store 里是 reply 的权威态
    expect(store.presets[0]!.deniedTools).toEqual(['bash', 'edit'])
  })

  it('update RPC 失败 → loadPresets 全量刷新回滚 + throw', async () => {
    const original: PiLaunchPreset = {
      id: 'builtin:full',
      name: '全工具模式',
      builtin: true,
      order: 0,
      toolMode: 'all',
      extensionMode: 'all',
    }
    const store = usePresetStore()
    store.setPresets([original])
    // 失败后 loadPresets 全量刷新（list 返回原值）
    presetApiMock.update.mockRejectedValueOnce(new Error('rpc failed'))
    presetApiMock.list.mockResolvedValueOnce([original])
    presetApiMock.getDefault.mockResolvedValueOnce('builtin:full')

    const { update } = usePiPresets()
    const input: PiLaunchPreset = { ...original, toolMode: 'denylist' }
    await expect(update(input)).rejects.toThrow('rpc failed')

    // loadPresets 回滚：toolMode 恢复为原值
    expect(store.presets[0]!.toolMode).toBe('all')
    expect(presetApiMock.list).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// u5 mode-declaration-row · 加载点（设计 §6.5 P0-12）：首次 connected 必拉一次，
// 重连不重复；加载失败不置位 → 下一次 connected 补拉（E7 ③ 恢复通道）。
// ─────────────────────────────────────────────────────────────────────────
describe('usePiPresets.installPresetAutoLoad（u5 加载点）', () => {
  beforeEach(() => {
    __resetPresetAutoLoadForTest()
    wsMock.ref!.value = 'disconnected'
  })

  afterEach(() => {
    __resetPresetAutoLoadForTest()
    wsMock.ref!.value = 'disconnected'
  })

  it('首次 connected → 拉一次（list/getDefault 各一次）；重连不重复拉', async () => {
    presetApiMock.list.mockResolvedValue(FIXTURE_PRESETS)
    presetApiMock.getDefault.mockResolvedValue('builtin:full')

    installPresetAutoLoad()
    // 安装时未 connected → 不拉（bootstrap 只提交连接不等于 connected）
    expect(presetApiMock.list).not.toHaveBeenCalled()

    wsMock.ref!.value = 'connected'
    await flushPromises()
    expect(presetApiMock.list).toHaveBeenCalledTimes(1)
    expect(presetApiMock.getDefault).toHaveBeenCalledTimes(1)
    expect(usePresetStore().presets).toEqual(FIXTURE_PRESETS)

    // 重连边沿：disconnected → connected 不重复拉
    wsMock.ref!.value = 'reconnecting'
    await flushPromises()
    wsMock.ref!.value = 'connected'
    await flushPromises()
    expect(presetApiMock.list).toHaveBeenCalledTimes(1)
  })

  it('安装时已 connected（AppShell 稳态：仅在 connected 后渲染）→ immediate 拉一次', async () => {
    presetApiMock.list.mockResolvedValue(FIXTURE_PRESETS)
    presetApiMock.getDefault.mockResolvedValue('builtin:full')
    wsMock.ref!.value = 'connected'

    installPresetAutoLoad()
    await flushPromises()
    expect(presetApiMock.list).toHaveBeenCalledTimes(1)
    expect(usePresetStore().defaultPresetId).toBe('builtin:full')
  })

  it('加载失败 → 不置位，下一次 connected 补拉（E7 ③ 恢复通道）', async () => {
    presetApiMock.list.mockRejectedValueOnce(new Error('rpc failed'))
    presetApiMock.getDefault.mockRejectedValueOnce(new Error('rpc failed'))

    installPresetAutoLoad()
    wsMock.ref!.value = 'connected'
    await flushPromises()
    expect(presetApiMock.list).toHaveBeenCalledTimes(1)
    expect(usePresetStore().loadError).not.toBeNull()

    // 下一次 connected：因未置位而补拉，成功后清错误态
    presetApiMock.list.mockResolvedValueOnce(FIXTURE_PRESETS)
    presetApiMock.getDefault.mockResolvedValueOnce('builtin:full')
    wsMock.ref!.value = 'disconnected'
    await flushPromises()
    wsMock.ref!.value = 'connected'
    await flushPromises()
    expect(presetApiMock.list).toHaveBeenCalledTimes(2)
    expect(usePresetStore().loadError).toBeNull()
    expect(usePresetStore().presets).toEqual(FIXTURE_PRESETS)
  })

  it('幂等：重复 installPresetAutoLoad 只挂一个 watcher（不重复拉）', async () => {
    presetApiMock.list.mockResolvedValue(FIXTURE_PRESETS)
    presetApiMock.getDefault.mockResolvedValue('builtin:full')
    wsMock.ref!.value = 'connected'

    installPresetAutoLoad()
    installPresetAutoLoad()
    await flushPromises()
    expect(presetApiMock.list).toHaveBeenCalledTimes(1)
  })
})
