/**
 * local-file:// 响应头装饰（chat-html-support §6.5 D5）。
 *
 * 纯函数（无 electron 依赖），协议 handler 调用；单测直接驱动（vitest 无法实例化
 * electron 运行时，见 main/test/local-file-response.test.ts）。
 *
 * 两条构造性保证：
 * ① **全部响应**统一附加 `Cache-Control: no-store`——「改写文件 → 刷新见新版」对主文档与
 *    全部相对子资源（css/js/字体/图片）由构造保证。mtime query cache-buster 不作为机制
 *    存在（D4 不采用③；P-1 证明 no-store 对自定义 scheme 生效后该保证已成立）。
 * ② `.html`/`.htm` 响应再附加**内容级 CSP**——预览文档脚本可跑（交互价值）、网络出站被
 *    `default-src 'none'` 封死、子资源只放行 local-file 协议源（仍受路径白名单守门）。
 *    opaque origin 下 `'self'` 恒不匹配任何 URL，故指令集不含 `'self'`。
 *    字体是唯一例外：`font-src` **只放 `data:`**（不放 `local-file:`）——`@font-face` 是
 *    CORS-mode 子资源，opaque origin（null）对未声明 `corsEnabled` 的 `local-file:` 自定义
 *    scheme 不发 CORS 请求，相对路径字体文件实际被浏览器拦（探针 P-1 实测）；保留
 *    `local-file:` 只会掩盖失败原因，故预览内字体必须由内容方内联为 `data:` URI。
 *   sandbox 属性（D4）与文档 CSP 双重保险：sandbox 管「碰不到主窗口」，文档 CSP 管
 *   「连不出网络」。
 */
import path from 'node:path'

/**
 * 预览文档（.html/.htm）的内容级 CSP 指令集（设计 §6.5 原文，逐字一致）。
 */
export const PREVIEW_DOCUMENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline' local-file:; style-src 'unsafe-inline' local-file:; img-src data: blob: local-file:; font-src data:; media-src local-file: data:"

/** 全部 local-file 响应的缓存控制（含错误响应） */
export const LOCAL_FILE_CACHE_CONTROL = 'no-store'

/** 命中预览文档（HTML）扩展名的路径判定（大小写不敏感） */
export function isHtmlLocalFilePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return ext === '.html' || ext === '.htm'
}

/**
 * 装饰 local-file 响应：附加 no-store（全部）+ 内容级 CSP（.html/.htm）。
 *
 * 用新 Response 包装而非改原对象（Response 头在构造后不可变）；status/body 原样透传，
 * 保证 304/404 等非 200 响应语义不被改写。
 */
export function decorateLocalFileResponse(response: Response, filePath: string): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', LOCAL_FILE_CACHE_CONTROL)
  if (isHtmlLocalFilePath(filePath)) headers.set('Content-Security-Policy', PREVIEW_DOCUMENT_CSP)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** 错误响应可读性（§11 检查点 3 实施项）：403/404 不再只有纯文本 `Forbidden`。 */
const HTTP_FORBIDDEN = 403
const HTTP_NOT_FOUND = 404

const ERROR_DOC: Record<
  'not_found' | 'is_dir' | 'out_of_whitelist',
  { status: typeof HTTP_FORBIDDEN | typeof HTTP_NOT_FOUND; message: string }
> = {
  out_of_whitelist: { status: HTTP_FORBIDDEN, message: 'Forbidden — this path is outside the local preview whitelist.' },
  is_dir: { status: HTTP_NOT_FOUND, message: 'Not found — this path is a directory, not a file.' },
  not_found: { status: HTTP_NOT_FOUND, message: 'Not found — no file at this path.' },
}

/**
 * 最小可读错误文档（iframe 内渲染给用户看；父页面 opaque origin 读不到状态码，错误文档
 * 是用户唯一的可见信号）。消息为固定字面量，不回显请求路径（不引入反射注入面）。
 */
export function buildLocalFileErrorResponse(reason: 'not_found' | 'is_dir' | 'out_of_whitelist'): Response {
  const { status, message } = ERROR_DOC[reason]
  const body = `<!doctype html>
<meta charset="utf-8">
<title>${status}</title>
<h1>${status}</h1>
<p>${message}</p>
`
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': LOCAL_FILE_CACHE_CONTROL,
    },
  })
}
