/**
 * MarkdownRenderer v-html 内链接/路径处理纯函数（从 MarkdownRenderer.vue 提取的镜像纯函数
 * 模块，设计 markdown-html-sanitize-render D4）：②路 data-path base64 解码、④路相对链接
 * 判定与 resolve、⑤路浮层浏览器链接判定。均无组件状态，独立模块便于镜像守卫与单测对照；
 * 组件侧只保留依赖 props/deps 的事件路由（handleAnchorClick 等）。
 *
 * ui 包镜像纪律（ui→renderer 依赖禁令不可直接 import，两侧注释互指，改动需同批同步——
 * 镜像纪律同 markdown-types.ts 协议镜像）：
 * - isRelativeHref / resolveHrefPath ↔ renderer composables/logic/markdown-sanitize.ts 的
 *   isRelativeResourcePath / resolveResourcePath（resolveHrefPath 函数体与
 *   html-preview-path.ts resolvePosixPath 三份逐字同款，漂移由
 *   scripts/check-posix-resolve-mirror-sync.mjs 源文本字面量对拍机检拦截）
 * - decodeB64 ↔ renderer composables/logic/markdown.ts 的 decodeBase64
 * 行为守卫：renderer 侧 mirror-guard-relative-path.test.ts / mirror-guard-base64.test.ts
 * 经 helpers/markdown-renderer-mirror.ts 源码提取本模块导出做行为对拍——改本文件语义，
 * 守卫下一次运行提取到的就是新语义。
 */

/** data-path 解码（renderer 壳 linkify 产出 base64 编码路径，HISTORICAL：迁移时丢 decodeBase64 致点击打开错误路径） */
export function decodeB64(b64: string): string {
  try {
    const binary = atob(b64)
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
  } catch {
    return b64
  }
}

/** scheme 前缀正则（http: / data: / mailto: 等带协议头的 URL——非相对路径，与 sanitize 侧同款） */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

/** ⑤路浮层浏览器白名单主机（display-containers §7.4 URL 注入链，§11-3 校准点：
 * localhost / 127.0.0.1 默认进浮层，其余维持系统浏览器） */
const OVERLAY_BROWSER_HOSTS = new Set(['localhost', '127.0.0.1'])

/** 浮层浏览器链接判定：http(s) + 白名单主机。非绝对 URL / 其他 scheme / 其他主机 = false。 */
export function isOverlayBrowserHref(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && OVERLAY_BROWSER_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

/** 相对资源路径判定：非 # 开头（页内锚点）、非 // 开头（协议相对 = 远程）、无 scheme 前缀。空串非路径。 */
export function isRelativeHref(value: string): boolean {
  if (value === '') return false
  if (value.startsWith('#')) return false
  if (value.startsWith('//')) return false
  return !SCHEME_RE.test(value)
}

/** POSIX resolve（Node path.resolve 语义的纯函数实现；renderer 运行时无 node:path，两侧同款镜像） */
export function resolveHrefPath(base: string, rel: string): string {
  const joined = rel.startsWith('/') ? rel : `${base}/${rel}`
  const parts: string[] = []
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return `/${parts.join('/')}`
}
