/**
 * btw 目录布局推导（btw-question D2：`btw/<encodeCwd>/<mainSid>/`）——M1-b 领地 pi-paths.ts。
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { encodeCwd, getBtwSessionsRoot, getBtwThreadDir, getPiAgentDir, isPiSessionId } from '../../../infra/pi/pi-paths.js'

describe('btw 目录布局推导（D2 目录即关联）', () => {
  it('根目录 = <piAgentDir>/btw（不落 sessions/ 扫描面）', () => {
    expect(getBtwSessionsRoot()).toBe(join(getPiAgentDir(), 'btw'))
    expect(getBtwSessionsRoot()).not.toContain(join(getPiAgentDir(), 'sessions'))
  })

  it('线目录 = <root>/<encodeCwd(cwd)>/<mainSid>/', () => {
    const cwd = '/Users/x/proj'
    expect(getBtwThreadDir(cwd, '0198ab12-cdef-7000-8000-1234567890ab'))
      .toBe(join(getBtwSessionsRoot(), encodeCwd(cwd), '0198ab12-cdef-7000-8000-1234567890ab'))
  })

  it('mainSid 非法形态 fail-fast（路径注入 + vid 误传防线）', () => {
    for (const bad of ['', '..', 'a/b', 'a\\b', 'btw:sid-x', ':', 'sid x', '.']) {
      expect(() => getBtwThreadDir('/p', bad), `should reject "${bad}"`).toThrow(/mainSid 非法/)
    }
  })

  it('isPiSessionId 值域 = pi assertValidSessionId 同款', () => {
    expect(isPiSessionId('0198ab12-cdef-7000-8000-1234567890ab')).toBe(true)
    expect(isPiSessionId('a.b-c_d')).toBe(true)
    expect(isPiSessionId('_leading')).toBe(false)
    expect(isPiSessionId('trailing-')).toBe(false) // pi 正则：尾字符须 [A-Za-z0-9]，'-' 收尾拒绝
    expect(isPiSessionId('btw:x')).toBe(false)
    expect(isPiSessionId('')).toBe(false)
  })
})
