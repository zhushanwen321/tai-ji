/**
 * mergeCookieHeader 单测（cookie 滑动续期合并规则，方案①）。
 *
 * 覆盖四类行为：
 * - Set-Cookie 新值覆盖同名旧值（值更新、位置留在当前头原顺序处），其余 cookie 原序原值保留
 * - Set-Cookie 行的属性段（Path/HttpOnly/Expires/Secure）只取第一段 name=value
 * - 值为空的 Set-Cookie（`name=`）= 服务端删除标记，从结果移除
 * - 当前头没有的新 cookie 按行序追加尾部；空输入边界（空头/空数组/全删除）返回空串
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/quota-cookie-merge.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mergeCookieHeader } from '../quota-types'

describe('mergeCookieHeader · Set-Cookie 合并回当前 Cookie 头', () => {
  it('同名覆盖（值更新、位置留在当前头原顺序处），其余 cookie 原序原值保留', () => {
    expect(mergeCookieHeader('sid=old; theme=dark; lang=zh', ['sid=new']))
      .toBe('sid=new; theme=dark; lang=zh')
  })

  it('属性段只取第一段 name=value（Path=/; HttpOnly; Expires=... 不是值的一部分）', () => {
    expect(mergeCookieHeader('sid=old', ['sid=x9; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT']))
      .toBe('sid=x9')
  })

  it('值为空的 Set-Cookie（name=）= 服务端删除标记，该 cookie 从结果移除', () => {
    expect(mergeCookieHeader('sid=old; keep=1', ['sid=; Path=/; Max-Age=0'])).toBe('keep=1')
  })

  it('当前头不存在的新 cookie 按行序追加尾部', () => {
    expect(mergeCookieHeader('a=1', ['b=2; Path=/', 'c=3'])).toBe('a=1; b=2; c=3')
  })

  it('多行 Set-Cookie 同名（服务端同响应内多次下发）→ 后行覆盖前行', () => {
    expect(mergeCookieHeader('', ['sid=first; Path=/', 'sid=second'])).toBe('sid=second')
  })

  it('值内 = 与引号原样保留（只按第一个 = 切分，不做解码）', () => {
    expect(mergeCookieHeader('tok=base64', ['tok="a=b=="; Path=/'])).toBe('tok="a=b=="')
  })

  it('值未变时输出与当前头逐字相同（调用方据此跳过写盘）', () => {
    expect(mergeCookieHeader('a=1; b=2', ['a=1'])).toBe('a=1; b=2')
  })

  it('当前头带空白伪影照常解析（与服务端值合并时顺带归一化）', () => {
    expect(mergeCookieHeader(' sid = old ;  keep = 1 ', ['sid=new'])).toBe('sid=new; keep=1')
  })

  it('无 name=value 段的 Set-Cookie 行（空串/空白行）无 cookie 语义，跳过', () => {
    expect(mergeCookieHeader('a=1', ['', '   '])).toBe('a=1')
  })

  it('空输入边界：空头 + 空数组 → 空串；全删除 → 空串', () => {
    expect(mergeCookieHeader('', [])).toBe('')
    expect(mergeCookieHeader('a=1; b=2', ['a=', 'b=; Path=/'])).toBe('')
  })
})
