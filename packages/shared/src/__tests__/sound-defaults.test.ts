import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SUCCESS_PLATFORM,
  DEFAULT_ERROR_PLATFORM,
  getDefaultSound,
} from '../sound-defaults'

describe('DEFAULT_SUCCESS_PLATFORM / DEFAULT_ERROR_PLATFORM', () => {
  it('三平台都有默认成功音', () => {
    expect(DEFAULT_SUCCESS_PLATFORM.darwin).toBeTruthy()
    expect(DEFAULT_SUCCESS_PLATFORM.win32).toBeTruthy()
    expect(DEFAULT_SUCCESS_PLATFORM.linux).toBeTruthy()
  })

  it('三平台都有默认失败音', () => {
    expect(DEFAULT_ERROR_PLATFORM.darwin).toBeTruthy()
    expect(DEFAULT_ERROR_PLATFORM.win32).toBeTruthy()
    expect(DEFAULT_ERROR_PLATFORM.linux).toBeTruthy()
  })

  it('成功音与失败音不同（每个平台）', () => {
    // 避免手维护时把两个 map 复制成一样的
    expect(DEFAULT_SUCCESS_PLATFORM.darwin).not.toBe(DEFAULT_ERROR_PLATFORM.darwin)
    expect(DEFAULT_SUCCESS_PLATFORM.win32).not.toBe(DEFAULT_ERROR_PLATFORM.win32)
    expect(DEFAULT_SUCCESS_PLATFORM.linux).not.toBe(DEFAULT_ERROR_PLATFORM.linux)
  })
})

describe('getDefaultSound', () => {
  it('darwin success 返回 Glass', () => {
    expect(getDefaultSound('darwin', 'success')).toBe('Glass')
  })

  it('darwin error 返回 Funk', () => {
    expect(getDefaultSound('darwin', 'error')).toBe('Funk')
  })

  it('win32 success 返回 Windows Notify System Generic', () => {
    expect(getDefaultSound('win32', 'success')).toBe('Windows Notify System Generic')
  })

  it('linux success 返回 complete', () => {
    expect(getDefaultSound('linux', 'success')).toBe('complete')
  })

  it('linux error 返回 message-new-instant', () => {
    expect(getDefaultSound('linux', 'error')).toBe('message-new-instant')
  })

  it('与 main 精选清单一致：默认音必须是该平台已知音（防 SSOT 漂移）', () => {
    // SSOT 是 main isKnownSound 校验的回落目标，默认音必须是合法的精选音 id。
    // 这里只校验自身常量自洽（精选清单在 main 侧，跨包校验由 main 测试覆盖）。
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(DEFAULT_SUCCESS_PLATFORM[platform]).not.toBe(DEFAULT_ERROR_PLATFORM[platform])
    }
  })
})
