/**
 * local-file 响应头装饰单测（chat-html-support §6.5 D5 / §11 检查点 3）。
 *
 * 覆盖：全部响应带 `Cache-Control: no-store`；`.html`/`.htm` 带内容级 CSP（指令集逐字
 * 与设计一致、不含 `'self'`、放行 local-file 子资源源）；非 HTML 不带 CSP；装饰保留
 * status/body；错误响应可读（403/404 HTML 文档）且带 no-store。
 *
 * 运行：cd apps/electron/main && npx vitest run test/local-file-response.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  LOCAL_FILE_CACHE_CONTROL,
  PREVIEW_DOCUMENT_CSP,
  buildLocalFileErrorResponse,
  decorateLocalFileResponse,
  isHtmlLocalFilePath,
} from '../gateway/local-file-response'

describe('local-file 响应头：Cache-Control: no-store（全部响应）', () => {
  it('图片 / 文本 / 无扩展名等全部响应都附加 no-store', () => {
    for (const filePath of ['/a/x.html', '/a/x.htm', '/a/x.txt', '/a/pic.png', '/a/noext', '/a/x.css', '/a/f.woff2']) {
      const response = decorateLocalFileResponse(new Response('body', { status: 200 }), filePath)
      expect(response.headers.get('cache-control'), filePath).toBe(LOCAL_FILE_CACHE_CONTROL)
    }
  })

  it('非 200 响应（如 304/404 透传形态）同样附加 no-store', () => {
    for (const status of [304, 404, 500]) {
      const response = decorateLocalFileResponse(new Response(null, { status }), '/a/pic.png')
      expect(response.headers.get('cache-control'), String(status)).toBe(LOCAL_FILE_CACHE_CONTROL)
      expect(response.status).toBe(status)
    }
  })
})

describe('local-file 响应头：.html/.htm 内容级 CSP', () => {
  it('.html / .htm（大小写不敏感）附加设计指令集', () => {
    for (const filePath of ['/a/report.html', '/a/REPORT.HTM', '/a/x.Html']) {
      const response = decorateLocalFileResponse(new Response('<html></html>'), filePath)
      expect(response.headers.get('content-security-policy'), filePath).toBe(PREVIEW_DOCUMENT_CSP)
    }
  })

  it('非 HTML 响应不带 CSP（不误伤图片/音频消费方）', () => {
    for (const filePath of ['/a/pic.png', '/a/x.txt', '/a/x.htmz']) {
      const response = decorateLocalFileResponse(new Response('body'), filePath)
      expect(response.headers.get('content-security-policy'), filePath).toBeNull()
    }
  })

  it('指令集与设计 §6.5 逐条一致：default-src none / 脚本可跑 / 子资源 local-file / 字体只 data: / 无 self', () => {
    // 逐指令精确比对（非子串包含）——防 `font-src data: local-file:` 回潮绕过
    // 「包含 font-src data:」式断言（旧值是该子串的超集）。
    const directives = new Map(
      PREVIEW_DOCUMENT_CSP.split('; ').map((d) => {
        const i = d.indexOf(' ')
        return [d.slice(0, i), d.slice(i + 1)] as const
      }),
    )
    expect(directives.get('default-src')).toBe("'none'")
    expect(directives.get('script-src')).toBe("'unsafe-inline' local-file:")
    expect(directives.get('style-src')).toBe("'unsafe-inline' local-file:")
    expect(directives.get('img-src')).toBe('data: blob: local-file:')
    // P-1：@font-face 是 CORS-mode 子资源，opaque origin 下 local-file: 对字体实际无效
    expect(directives.get('font-src')).toBe('data:')
    expect(directives.get('media-src')).toBe('local-file: data:')
    expect(directives.size).toBe(6)
    // opaque origin 下 'self' 恒不匹配任何 URL——指令集不含它
    expect(PREVIEW_DOCUMENT_CSP).not.toContain("'self'")
    // 网络出站被 default-src 'none' 封死（无 connect-src）
    expect(PREVIEW_DOCUMENT_CSP).not.toContain('connect-src')
  })

  it('装饰保留 status / statusText / body', async () => {
    const response = decorateLocalFileResponse(
      new Response('hello', { status: 201, statusText: 'Created' }),
      '/a/x.txt',
    )
    expect(response.status).toBe(201)
    expect(response.statusText).toBe('Created')
    expect(await response.text()).toBe('hello')
  })

  it('isHtmlLocalFilePath 仅命中 .html/.htm', () => {
    expect(isHtmlLocalFilePath('/a/x.html')).toBe(true)
    expect(isHtmlLocalFilePath('/a/x.HTM')).toBe(true)
    expect(isHtmlLocalFilePath('/a/x.html.txt')).toBe(false)
    expect(isHtmlLocalFilePath('/a/x')).toBe(false)
    expect(isHtmlLocalFilePath('/a/dir.html/file')).toBe(false)
  })
})

describe('local-file 错误响应可读性（§11 检查点 3 实施项）', () => {
  it('out_of_whitelist → 403、可读 HTML、带 no-store', async () => {
    const response = buildLocalFileErrorResponse('out_of_whitelist')
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe(LOCAL_FILE_CACHE_CONTROL)
    expect(response.headers.get('content-type')).toContain('text/html')
    const body = await response.text()
    expect(body).toContain('<h1>403</h1>')
    expect(body.toLowerCase()).toContain('whitelist')
  })

  it('not_found / is_dir → 404、可读 HTML、带 no-store', async () => {
    for (const reason of ['not_found', 'is_dir'] as const) {
      const response = buildLocalFileErrorResponse(reason)
      expect(response.status, reason).toBe(404)
      expect(response.headers.get('cache-control'), reason).toBe(LOCAL_FILE_CACHE_CONTROL)
      const body = await response.text()
      expect(body).toContain('<h1>404</h1>')
      expect(body).toContain('Not found')
    }
  })

  it('错误文档不回显请求路径（无反射注入面）', async () => {
    const body = await buildLocalFileErrorResponse('not_found').text()
    expect(body).not.toContain('/Users/')
    expect(body).not.toContain('%')
  })
})
