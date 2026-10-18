/**
 * normalizeCookieHeader 单测（2026-10-18 自 runtime 迁入 shared 后的 SSOT 回归锚）。
 *
 * 覆盖四类真实输入：
 * - DevTools「请求头 Cookie」复制形态（`k=v; k2=v2`）原样通过
 * - 分隔空白伪影（`k = v ;  k2 = v2`）逐对修剪
 * - 值内引号保留（`k="v"` 是浏览器线上传输形态，动了破坏鉴权）
 * - 无任何 `k=v` 对的形态（Application → Cookies 表格粘出的制表符文本 / 空串）→ 空串
 *   （renderer 据此在保存前拦截，runtime fetcher 据此返回 cookie-invalid-format）
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/quota-cookie-normalize.test.ts
 */
import { describe, it, expect } from 'vitest'
import { normalizeCookieHeader } from '../quota-types'

describe('normalizeCookieHeader · 归一化与格式判定（双端同一 SSOT）', () => {
  it('标准请求头形态原样通过（多对分隔 = "; "）', () => {
    expect(normalizeCookieHeader('a=1; b=2; c=3')).toBe('a=1; b=2; c=3')
  })

  it('键值对两侧空白修剪，分隔符重排为 "; "', () => {
    expect(normalizeCookieHeader(' a = 1 ;\tb = 2 ')).toBe('a=1; b=2')
  })

  it('值内引号与内部空格保留（不做解码/去引号）', () => {
    expect(normalizeCookieHeader('token="a b"; x= y ')).toBe('token="a b"; x=y')
  })

  it('剥掉可选的 Cookie: 请求头名（帮助文案的整串复制形态）', () => {
    expect(normalizeCookieHeader('Cookie: a=1; b=2')).toBe('a=1; b=2')
    expect(normalizeCookieHeader('  cookie :  a = 1 ; b = 2 ')).toBe('a=1; b=2')
    // 值里出现 cookie: 字样不误杀（只剥开头的头名）
    expect(normalizeCookieHeader('a=cookie:1; b=2')).toBe('a=cookie:1; b=2')
  })

  it('缺失 "=" 的片段（DevTools 表格 TSV 粘贴残留）被丢弃 → 空串', () => {
    expect(normalizeCookieHeader('Name\tValue\tauth\txyz')).toBe('')
    expect(normalizeCookieHeader('   ')).toBe('')
    expect(normalizeCookieHeader('')).toBe('')
  })

  it('空名（"= value"）被丢弃；有值无名的片段不构成合法 cookie', () => {
    expect(normalizeCookieHeader('=orphan; ok=1')).toBe('ok=1')
  })

  it('空值合法保留（"a=" 是浏览器可发送形态，不判非法格式）', () => {
    expect(normalizeCookieHeader('a=')).toBe('a=')
  })
})
