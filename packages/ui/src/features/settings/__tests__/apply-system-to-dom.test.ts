/**
 * applySystemToDom 单测（W3 · TC-1）。
 *
 * 覆盖：theme=light/dark 直写；theme=system 走 matchMedia 解析（matches true/false）；
 * themePreset/fontSize 槽位 + 默认值；SSR 早返；deps.setLocale 调用。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { applySystemToDom, resolveTheme } from '../apply-system-to-dom'
import type { SystemSettings } from '@taiji/core'

function makeSystem(over: Partial<SystemSettings> = {}): SystemSettings {
  return {
    locale: 'zh-CN',
    theme: 'dark',
    themePreset: 'cold-blue',
    fontSize: 'medium',
    ...over,
  } as SystemSettings
}

describe('applySystemToDom', () => {
  let setAttribute: ReturnType<typeof vi.fn>
  let matchMediaMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setAttribute = vi.fn()
    matchMediaMock = vi.fn()
    // happy-dom 提供 document.documentElement
    vi.stubGlobal('document', {
      ...((globalThis as any).document ?? {}),
      documentElement: { setAttribute, dataset: {} as Record<string, string> },
    })
    vi.stubGlobal('window', { matchMedia: matchMediaMock })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('theme=light 直写 data-theme=light', () => {
    applySystemToDom(makeSystem({ theme: 'light' }))
    expect(setAttribute).toHaveBeenCalledWith('data-theme', 'light')
  })

  it('theme=dark 直写 data-theme=dark', () => {
    applySystemToDom(makeSystem({ theme: 'dark' }))
    expect(setAttribute).toHaveBeenCalledWith('data-theme', 'dark')
  })

  it('theme=system + matchMedia matches=true → data-theme=light', () => {
    matchMediaMock.mockReturnValue({ matches: true })
    applySystemToDom(makeSystem({ theme: 'system' }))
    expect(setAttribute).toHaveBeenCalledWith('data-theme', 'light')
  })

  it('theme=system + matchMedia matches=false → data-theme=dark', () => {
    matchMediaMock.mockReturnValue({ matches: false })
    applySystemToDom(makeSystem({ theme: 'system' }))
    expect(setAttribute).toHaveBeenCalledWith('data-theme', 'dark')
  })

  it('themePreset 写 data-theme-preset，缺省 cold-blue', () => {
    applySystemToDom(makeSystem({ themePreset: 'warm-amber' }))
    expect(setAttribute).toHaveBeenCalledWith('data-theme-preset', 'warm-amber')
  })

  it('themePreset 缺省回落 cold-blue', () => {
    applySystemToDom(makeSystem({ themePreset: undefined }))
    expect(setAttribute).toHaveBeenCalledWith('data-theme-preset', 'cold-blue')
  })

  it('fontSize 写 dataset.fontSize，缺省 medium', () => {
    const doc: any = (globalThis as any).document
    applySystemToDom(makeSystem({ fontSize: 'large' }))
    expect(doc.documentElement.dataset.fontSize).toBe('large')
  })

  it('fontSize 缺省回落 medium', () => {
    const doc: any = (globalThis as any).document
    applySystemToDom(makeSystem({ fontSize: undefined }))
    expect(doc.documentElement.dataset.fontSize).toBe('medium')
  })

  it('fontScales 写 data-fs-* dataset，逐区域独立档位', () => {
    const doc: any = (globalThis as any).document
    applySystemToDom(makeSystem({ fontScales: { sidebar: 'small', chat: 'xlarge', drawer: 'large' } }))
    expect(doc.documentElement.dataset.fsSidebar).toBe('small')
    expect(doc.documentElement.dataset.fsChat).toBe('xlarge')
    expect(doc.documentElement.dataset.fsDrawer).toBe('large')
  })

  it('fontScales 缺省/部分缺省 → 对应区域回落 medium', () => {
    const doc: any = (globalThis as any).document
    applySystemToDom(makeSystem({ fontScales: { chat: 'large' } }))
    expect(doc.documentElement.dataset.fsSidebar).toBe('medium')
    expect(doc.documentElement.dataset.fsChat).toBe('large')
    expect(doc.documentElement.dataset.fsDrawer).toBe('medium')
    applySystemToDom(makeSystem())
    expect(doc.documentElement.dataset.fsChat).toBe('medium')
  })

  it('locale 非空 + deps.setLocale 存在 → 调用 setLocale', () => {
    const setLocale = vi.fn()
    applySystemToDom(makeSystem({ locale: 'en-US' }), { setLocale })
    expect(setLocale).toHaveBeenCalledWith('en-US')
  })

  it('无 deps.setLocale → 不抛错（locale 不切换）', () => {
    expect(() => applySystemToDom(makeSystem({ locale: 'en-US' }))).not.toThrow()
  })

  it('resolveTheme 纯函数：system 无 window.matchMedia → dark 兜底', () => {
    vi.stubGlobal('window', {}) // 无 matchMedia
    expect(resolveTheme('system')).toBe('dark')
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
  })
})
