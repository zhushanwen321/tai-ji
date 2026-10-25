// 偏好持久化 + 设置屏单测（remote-use-mobile-v2 §6.17/§6.11 验收条款 4：偏好经
// PlatformPort.storage 读写 + 刷新保持；tokenCreatedAt 不显示；连接信息客户端派生）。
//
// storage 注入内存实现（PlatformPort.storage 端口注入形态，无真实 localStorage 依赖；
// 真实 localStorage 桥接语义在 mobile-shell.spec TC-4 已锁）。「刷新保持」的等价形态 =
// 同一 storage 上重新 load（刷新后的进程重新经 loadMobilePrefs 读盘）。
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { providePlatform, __resetPlatformForTesting } from '@taiji/core'
import type { KVStorage } from '@taiji/core'
import SettingsScreen from '../../screens/SettingsScreen.vue'
import { i18n } from '../../i18n'
import {
  applyMobilePrefs,
  connectedSince,
  DEFAULT_MOBILE_PREFS,
  loadMobilePrefs,
  MOBILE_PREFS_STORAGE_KEY,
  networkKindFromHost,
  saveMobilePrefs,
} from '../../shell/app-runtime'

/** 内存 KVStorage（PlatformPort.storage 注入替身；真实桥接语义归 TC-4） */
function memoryStorage(): KVStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    async get(key: string) {
      return map.get(key) ?? null
    },
    async set(key: string, value: string) {
      map.set(key, value)
    },
    async remove(key: string) {
      map.delete(key)
    },
  }
}

describe('偏好读写（PlatformPort.storage 端口，§6.17）', () => {
  let storage: ReturnType<typeof memoryStorage>

  beforeEach(() => {
    __resetPlatformForTesting()
    storage = memoryStorage()
    providePlatform({
      kind: 'mobile',
      storage,
      webSocket: { create: () => {
        throw new Error('not used in prefs tests')
      } },
    })
  })

  afterEach(() => {
    __resetPlatformForTesting()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-font-size')
  })

  it('默认偏好（无存储值）：theme=dark / fontSize=medium', async () => {
    expect(await loadMobilePrefs()).toEqual(DEFAULT_MOBILE_PREFS)
  })

  it('写 → 读回一致；存储键落 taiji.mobile.prefs 单 JSON 键', async () => {
    const merged = await saveMobilePrefs({ theme: 'light' })
    expect(merged).toEqual({ theme: 'light', fontSize: 'medium' })
    // 刷新保持：重新 load（= 刷新后进程读盘）读回已存值
    expect(await loadMobilePrefs()).toEqual({ theme: 'light', fontSize: 'medium' })
    const raw = storage.map.get(MOBILE_PREFS_STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toEqual({ theme: 'light', fontSize: 'medium' })
  })

  it('合并写：只传 patch 字段，另一字段保持既有值', async () => {
    await saveMobilePrefs({ theme: 'light' })
    const merged = await saveMobilePrefs({ fontSize: 'large' })
    expect(merged).toEqual({ theme: 'light', fontSize: 'large' })
    expect(await loadMobilePrefs()).toEqual({ theme: 'light', fontSize: 'large' })
  })

  it('坏 JSON / 形状不对 → 静默回默认（错误处理契约：辅助功能读写失败不炸壳）', async () => {
    storage.map.set(MOBILE_PREFS_STORAGE_KEY, '{not-json')
    expect(await loadMobilePrefs()).toEqual(DEFAULT_MOBILE_PREFS)
    storage.map.set(MOBILE_PREFS_STORAGE_KEY, JSON.stringify({ theme: 'blue', fontSize: 'huge' }))
    expect(await loadMobilePrefs()).toEqual(DEFAULT_MOBILE_PREFS)
  })
})

describe('偏好应用（data-theme / data-font-size 槽位）', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-font-size')
  })

  it('applyMobilePrefs 写根节点双槽位（tokens.css 槽位机制消费点）', () => {
    applyMobilePrefs({ theme: 'light', fontSize: 'large' })
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.fontSize).toBe('large')
  })
})

describe('连接信息客户端派生（§6.11）', () => {
  it('网络形态判定：Tailscale 网段（100.64/10）→ tailscale，网段外与域名 → lan', () => {
    expect(networkKindFromHost('100.100.1.2')).toBe('tailscale')
    expect(networkKindFromHost('100.64.0.1')).toBe('tailscale')
    expect(networkKindFromHost('100.127.255.254')).toBe('tailscale')
    expect(networkKindFromHost('100.63.0.1')).toBe('lan')
    expect(networkKindFromHost('100.128.0.1')).toBe('lan')
    expect(networkKindFromHost('192.168.1.5')).toBe('lan')
    expect(networkKindFromHost('mydevice.tailnet.ts.net')).toBe('lan')
  })
})

describe('SettingsScreen（使用者视角 DOM 断言）', () => {
  let storage: ReturnType<typeof memoryStorage>

  function mountScreen() {
    return mount(SettingsScreen, { global: { plugins: [i18n] } })
  }

  beforeEach(() => {
    __resetPlatformForTesting()
    storage = memoryStorage()
    providePlatform({
      kind: 'mobile',
      storage,
      webSocket: { create: () => {
        throw new Error('not used in prefs tests')
      } },
    })
  })

  afterEach(async () => {
    __resetPlatformForTesting()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-font-size')
  })

  it('首屏冒烟：外观段（主题/字号段控）+ 连接信息段（主机/网络/时长）结构元素在场', async () => {
    const wrapper = mountScreen()
    await flushPromises()
    await nextTick()
    expect(wrapper.find('[data-testid="settings-screen"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="settings-appearance"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="settings-theme"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="settings-font-size"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="settings-connection"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="settings-host"]').text()).toBe(location.host)
    expect(wrapper.find('[data-testid="settings-network"]').text()).not.toBe('')
    expect(wrapper.find('[data-testid="settings-connected-duration"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('tokenCreatedAt 不显示（无事实源字段不渲染——§6.11 裁决的防回归锚）', async () => {
    const wrapper = mountScreen()
    await flushPromises()
    await nextTick()
    expect(wrapper.text()).not.toContain('tokenCreatedAt')
    expect(wrapper.text()).not.toContain('Token 创建')
    expect(wrapper.text()).not.toContain('Token created')
    wrapper.unmount()
  })

  it('切浅色主题：根节点 data-theme 即时生效 + storage 落盘', async () => {
    const wrapper = mountScreen()
    await flushPromises()
    await nextTick()
    await wrapper.find('[data-testid="segmented-option-light"]').trigger('click')
    await nextTick()
    await nextTick()
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(JSON.parse(storage.map.get(MOBILE_PREFS_STORAGE_KEY)!)).toMatchObject({ theme: 'light' })
    wrapper.unmount()
  })

  it('刷新保持：已存 light 偏好下重新挂载（= 刷新后进程），选中态与槽位恢复 light', async () => {
    storage.map.set(MOBILE_PREFS_STORAGE_KEY, JSON.stringify({ theme: 'light', fontSize: 'large' }))
    const wrapper = mountScreen()
    await flushPromises()
    await nextTick()
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.fontSize).toBe('large')
    expect(wrapper.find('[data-testid="segmented-option-light"]').classes()).toContain('bg-bg-elevated')
    expect(wrapper.find('[data-testid="segmented-option-large"]').classes()).toContain('bg-bg-elevated')
    wrapper.unmount()
  })

  it('已连接时长：connectedSince 派生分钟数呈现（壳内记录的连接建立时刻）', async () => {
    connectedSince.value = Date.now() - 5 * 60_000
    const wrapper = mountScreen()
    await flushPromises()
    await nextTick()
    expect(wrapper.find('[data-testid="settings-connected-duration"]').text()).toContain('5')
    wrapper.unmount()
  })
})
