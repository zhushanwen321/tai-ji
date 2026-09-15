/**
 * url-scheme-validators 单测。
 *
 * 覆盖 isDangerousScheme（黑名单，大小写不敏感，前缀匹配）
 * 与 isAllowedNavigateUrl（白名单 http/https）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/url-scheme-validators.test.ts
 */
import { describe, it, expect } from 'vitest'
import { isDangerousScheme, isAllowedNavigateUrl } from '../gateway/url-scheme-validators.js'

describe('isDangerousScheme', () => {
  describe('危险协议命中（true）', () => {
    it('javascript:alert(1)', () => {
      expect(isDangerousScheme('javascript:alert(1)')).toBe(true)
    })
    it('data: base64 payload', () => {
      expect(isDangerousScheme('data:text/html,<script>alert(1)</script>')).toBe(true)
      expect(isDangerousScheme('data:image/png;base64,iVBORw0KG==')).toBe(true)
    })
    it('file:///etc/passwd', () => {
      expect(isDangerousScheme('file:///etc/passwd')).toBe(true)
    })
    it('blob: URL', () => {
      expect(isDangerousScheme('blob:https://example.com/abc-def')).toBe(true)
    })
    it('chrome:// 内部页', () => {
      expect(isDangerousScheme('chrome://settings')).toBe(true)
    })
    it('devtools:// 调试页', () => {
      expect(isDangerousScheme('devtools://devtools/bundled/inspector.html')).toBe(true)
    })
    it('about:blank', () => {
      expect(isDangerousScheme('about:blank')).toBe(true)
    })
    it('vbscript: 脚本（IE 遗留协议）', () => {
      expect(isDangerousScheme('vbscript:msgbox(1)')).toBe(true)
    })
  })

  describe('大小写不敏感', () => {
    it('JavaScript:alert(1) 大小写变体', () => {
      expect(isDangerousScheme('JavaScript:alert(1)')).toBe(true)
      expect(isDangerousScheme('JAVASCRIPT:alert(1)')).toBe(true)
      expect(isDangerousScheme('jAvAsCrIpT:alert(1)')).toBe(true)
    })
    it('DATA: / File: 大小写变体', () => {
      expect(isDangerousScheme('DATA:text/html,xxx')).toBe(true)
      expect(isDangerousScheme('File:///etc/passwd')).toBe(true)
    })
  })

  describe('前后空白容忍', () => {
    it('javascript: 前后带空格仍命中', () => {
      expect(isDangerousScheme('  javascript:alert(1)')).toBe(true)
      expect(isDangerousScheme('javascript:alert(1)  ')).toBe(true)
    })
  })

  describe('非危险 URL（false）', () => {
    it('http(s) URL', () => {
      expect(isDangerousScheme('http://example.com')).toBe(false)
      expect(isDangerousScheme('https://example.com/path?q=1')).toBe(false)
    })
    it('裸域名（无协议前缀）', () => {
      expect(isDangerousScheme('example.com')).toBe(false)
      expect(isDangerousScheme('github.com/user/repo')).toBe(false)
    })
    it('javascriptsubstring 但非前缀', () => {
      // 防误判：'javascript:' 不能在 URL 中段误命中
      expect(isDangerousScheme('http://example.com/path?x=javascript:foo')).toBe(false)
      expect(isDangerousScheme('https://example.com/javascript:safe')).toBe(false)
    })
  })

  describe('边界输入（false，无抛错）', () => {
    it('空串', () => {
      expect(isDangerousScheme('')).toBe(false)
    })
    it('只有空白', () => {
      expect(isDangerousScheme('   ')).toBe(false)
    })
    it('非字符串（类型守卫）', () => {
      // 类型守卫：string 参数下编译期已防，运行时仍兜底 undefined/null 误传
      expect(isDangerousScheme(undefined as unknown as string)).toBe(false)
      expect(isDangerousScheme(null as unknown as string)).toBe(false)
    })
  })
})

describe('isAllowedNavigateUrl', () => {
  describe('允许 http/https（true）', () => {
    it('http:// / https://', () => {
      expect(isAllowedNavigateUrl('http://example.com')).toBe(true)
      expect(isAllowedNavigateUrl('https://example.com/path?q=1')).toBe(true)
    })
    it('大小写不敏感', () => {
      expect(isAllowedNavigateUrl('HTTPS://example.com')).toBe(true)
      expect(isAllowedNavigateUrl('HtTp://example.com')).toBe(true)
    })
    it('前后空白容忍', () => {
      expect(isAllowedNavigateUrl('  https://example.com  ')).toBe(true)
    })
  })

  describe('拒绝非 http/https（false）', () => {
    it('危险协议', () => {
      expect(isAllowedNavigateUrl('javascript:alert(1)')).toBe(false)
      expect(isAllowedNavigateUrl('file:///etc/passwd')).toBe(false)
      expect(isAllowedNavigateUrl('data:text/html,xxx')).toBe(false)
      expect(isAllowedNavigateUrl('blob:https://x/y')).toBe(false)
    })
    it('裸域名', () => {
      expect(isAllowedNavigateUrl('example.com')).toBe(false)
    })
    it('协议相对 URL', () => {
      expect(isAllowedNavigateUrl('//example.com')).toBe(false)
    })
  })

  describe('边界输入（false，无抛错）', () => {
    it('空串 / 非字符串', () => {
      expect(isAllowedNavigateUrl('')).toBe(false)
      expect(isAllowedNavigateUrl(undefined as unknown as string)).toBe(false)
      expect(isAllowedNavigateUrl(null as unknown as string)).toBe(false)
    })
  })
})