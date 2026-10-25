/**
 * btw 目录布局推导（session-store-layout-inversion 换根后：`<root>/<mainSid>/btw/`，
 * <root> = `<dataDir>/ext-sessions/`；getBtwThreadDir 委托 shared getSessionBtwDir SSOT）。
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { getBtwSessionsRoot, getBtwThreadDir, getPiAgentDir, isPiSessionId } from '../../../infra/pi/pi-paths.js'
import { getSessionBtwDir, getSessionStoreDir } from '@taiji/shared/paths'

describe('btw 目录布局推导（session-store-layout-inversion 换根后）', () => {
  it('线目录 = <root>/<mainSid>/btw（委托 shared 公式同值；mainSid 即分区键，encodeCwd 层已消除）', () => {
    const sid = '0198ab12-cdef-7000-8000-1234567890ab'
    expect(getBtwThreadDir(sid)).toBe(join(getSessionStoreDir(), sid, 'btw'))
    expect(getBtwThreadDir(sid)).toBe(getSessionBtwDir(sid))
  })

  it('新布局不落 pi 宿主树（<agentDir>/ 不含线目录；不落 sessions/ 扫描面语义保持）', () => {
    const threadDir = getBtwThreadDir('0198ab12-cdef-7000-8000-1234567890ab')
    expect(threadDir.startsWith(getPiAgentDir())).toBe(false)
    expect(threadDir).toContain('ext-sessions')
  })

  it('getBtwSessionsRoot = 旧布局树段锚点（<piAgentDir>/btw，对拍机检逐位对拍 + 树段常量消费；无现役读取方，存量静置）', () => {
    expect(getBtwSessionsRoot()).toBe(join(getPiAgentDir(), 'btw'))
  })

  it('mainSid 非法形态 fail-fast（路径注入 + 虚拟 id 误传防线，校验随 shared 公式）', () => {
    for (const bad of ['', '..', 'a/b', 'a\\b', 'btw:sid-x', ':', 'sid x', '.']) {
      expect(() => getBtwThreadDir(bad), `should reject "${bad}"`).toThrow(/invalid sessionId/)
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
