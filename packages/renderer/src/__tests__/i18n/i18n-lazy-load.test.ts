/**
 * W03 Q1-2：i18n 惰性 locale 加载。
 *
 * - 默认（无偏好）启动只注册 zh-CN，en-US 不在初始 messages（动态 import 拆 chunk，不进首屏）
 * - setLocale('en-US') 动态 import + setLocaleMessage 后文案为英文，zh-CN 可切回
 * - en-US 偏好冷启动：模块解析（top-level await）完成即 en-US 可用，无回退闪烁
 * - 连续快速切换后写胜（过期的动态加载完成晚到不回写 locale）
 * - [Fix-2] fallbackLocale 'en-US' 懒加载的兜底恢复：启动后 idle 预载（幂等守卫零重复注册）
 * - [Fix-3] en-US 动态 import 失败：内部 catch + 可操作 warn，locale 停留旧值、无 unhandledrejection
 *
 * 每个用例经 vi.resetModules + 动态 import 取全新模块实例（i18n 是模块级单例，
 * loadedLocales / initialLocale 都在模块状态里，不复位会互相污染）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const SYSTEM_KEY = 'taiji:system-settings'

async function importFreshI18n() {
  vi.resetModules()
  return import('@/i18n')
}

describe('i18n 惰性 locale 加载（Q1-2）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('默认（无偏好）启动只注册 zh-CN，en-US 未载入', async () => {
    const mod = await importFreshI18n()
    expect(mod.getLocale()).toBe('zh-CN')
    expect(Object.keys(mod.default.global.getLocaleMessage('zh-CN')).length).toBeGreaterThan(0)
    // en-US 未注册（动态 import 拆 chunk，不进首屏）
    expect(mod.default.global.getLocaleMessage('en-US')).toEqual({})
    expect(mod.default.global.t('settings.title')).toBe('设置')
  })

  it("setLocale('en-US') 后文案为英文，且 zh-CN 可切回", async () => {
    const mod = await importFreshI18n()
    await mod.setLocale('en-US')
    expect(mod.getLocale()).toBe('en-US')
    // 动态 import + setLocaleMessage 已注册 en-US messages
    expect(Object.keys(mod.default.global.getLocaleMessage('en-US')).length).toBeGreaterThan(0)
    expect(mod.default.global.t('settings.title')).toBe('Settings')
    // 切回 zh-CN（初始已载入，命中缓存）
    await mod.setLocale('zh-CN')
    expect(mod.getLocale()).toBe('zh-CN')
    expect(mod.default.global.t('settings.title')).toBe('设置')
  })

  it('en-US 偏好冷启动：模块解析完成即 en-US 可用（top-level await，无回退闪烁）', async () => {
    localStorage.setItem(SYSTEM_KEY, JSON.stringify({ locale: 'en-US' }))
    const mod = await importFreshI18n()
    // import resolve 时 en-US 已在模块解析内补齐（否则首帧会是裸 key / 中文回退）
    expect(mod.getLocale()).toBe('en-US')
    expect(Object.keys(mod.default.global.getLocaleMessage('en-US')).length).toBeGreaterThan(0)
    expect(mod.default.global.t('settings.title')).toBe('Settings')
  })

  it('连续快速切换时后写胜：先发的 en-US 动态加载晚到不回写过期 locale', async () => {
    const mod = await importFreshI18n()
    const first = mod.setLocale('en-US') // 触发动态 import（较慢）
    await mod.setLocale('zh-CN') // zh-CN 已载入，立即生效（后写）
    await first // 先发的 en-US 加载完成，seq 已过期 → 不回写
    expect(mod.getLocale()).toBe('zh-CN')
    expect(mod.default.global.t('settings.title')).toBe('设置')
  })

  it('[Fix-2] fallback 预载：idle 回调触发后 en-US messages 已注册（zh-CN 缺 key 兜底恢复）', async () => {
    // happy-dom 无 requestIdleCallback，注入可控桩验证主路径（Electron/Chromium 走此路径；
    // 缺失环境的 setTimeout 回落调用同一 loadEnUsMessages，不单独展开）
    const idleCallbacks: Array<() => void> = []
    window.requestIdleCallback = ((cb: () => void) => {
      idleCallbacks.push(cb)
      return idleCallbacks.length
    }) as typeof window.requestIdleCallback
    try {
      const mod = await importFreshI18n()
      // 预载回调已注册，但尚未触发：en-US 仍未加载（不阻塞首屏）
      expect(idleCallbacks).toHaveLength(1)
      expect(mod.default.global.getLocaleMessage('en-US')).toEqual({})
      idleCallbacks[0]!() // 触发 idle 回调（内部 void loadEnUsMessages()）
      await vi.waitFor(() => {
        expect(Object.keys(mod.default.global.getLocaleMessage('en-US')).length).toBeGreaterThan(0)
      })
      // fallback 兜底恢复：locale 仍 zh-CN，en-US messages 可供回退
      expect(mod.getLocale()).toBe('zh-CN')
    } finally {
      delete window.requestIdleCallback
    }
  })

  it('[Fix-2] en-US 已加载时 idle 预载零开销（幂等守卫：不重复 import/setLocaleMessage）', async () => {
    const idleCallbacks: Array<() => void> = []
    window.requestIdleCallback = ((cb: () => void) => {
      idleCallbacks.push(cb)
      return idleCallbacks.length
    }) as typeof window.requestIdleCallback
    try {
      const mod = await importFreshI18n()
      await mod.setLocale('en-US') // en-US 已动态加载
      const before = mod.default.global.getLocaleMessage('en-US')
      // 此时触发启动时注册的 idle 预载回调：loadedLocales 幂等守卫早退，
      // 不重复 import / setLocaleMessage → messages 对象引用不变
      idleCallbacks[0]!()
      await Promise.resolve()
      expect(mod.default.global.getLocaleMessage('en-US')).toBe(before)
      expect(mod.getLocale()).toBe('en-US')
    } finally {
      delete window.requestIdleCallback
    }
  })

  it('[Fix-3] en-US 动态 import 失败：可操作 warn + locale 停留旧值 + 无 unhandledrejection', async () => {
    vi.doMock('@/i18n/locales/en-US', () => {
      throw new Error('en-US chunk 404 (mock)')
    })
    try {
      const mod = await importFreshI18n()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        // 失败在 setLocale 内部 catch：promise 正常 resolve（不会变 unhandledrejection）
        await expect(mod.setLocale('en-US')).resolves.toBeUndefined()
        // warn 被调且指向恢复动作（重试 setLocale / 检查构建产物），非静默
        expect(warnSpy).toHaveBeenCalled()
        const msgs = warnSpy.mock.calls.map((c) => String(c[0])).join('\n')
        expect(msgs).toContain("setLocale('en-US')")
        expect(msgs).toContain('产物')
        // locale 停留旧值：messages 缺失下切换只会显示裸 key，不切换
        expect(mod.getLocale()).toBe('zh-CN')
        expect(mod.default.global.t('settings.title')).toBe('设置')
      } finally {
        warnSpy.mockRestore()
      }
    } finally {
      vi.doUnmock('@/i18n/locales/en-US')
    }
  })
})
