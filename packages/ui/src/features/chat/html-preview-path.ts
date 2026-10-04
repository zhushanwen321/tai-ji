/**
 * html-preview 内联容器的路径矩阵纯函数（chat-html-support §6.3 D3，v16 内联容器）。
 *
 * ui 包镜像纪律（ui→renderer 依赖禁令不可直接 import）：
 * - isAbsolutePath / resolvePosixPath 与 MarkdownRenderer ④路 resolveHrefPath 同标准
 *   （base + rel 后逐段折叠 `.` / `..`）；renderer 侧镜像 = lib/path-utils.resolvePreviewPath，
 *   两侧改动需同批同步（镜像纪律同 markdown-types.ts 协议镜像注释）。
 * - encodeLocalFilePath / buildLocalFileUrl 与原 renderer 抽屉渲染态通道（html-preview.ts，
 *   v16 已随渲染态退役删除）同规格：handler 侧 `decodeURIComponent(new URL(url).pathname)`
 *   解码成对——文件名含 `#` / `?` / `%` / 空格时裸拼会被 URL 解析吞成 fragment/query
 *   或错解码（`report#1.html` 裸拼后 handler 实际收到 `report` 静默 404）。
 */

/** 绝对路径判定（POSIX 根 / Windows 盘符 / `~` 家目录形态）。`~` 归入绝对路径 = 与消费侧
 *  入参域对齐（设计 §6.3 路径解析矩阵「绝对路径直用」）：`~` 展开由主进程
 *  expandLocalFilePath 承担，不认则会拼成 `/cwd/~/x.html` 落错基准。 */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(p)
}

/** POSIX resolve（Node path.resolve 语义的纯函数实现；renderer 运行时无 node:path，两侧同款镜像） */
export function resolvePosixPath(base: string, rel: string): string {
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

/** 取路径末段作显示文件名（解析前按原文取，降级态也能显示「哪个文件」） */
export function basenameOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

const BYTES_PER_KB = 1024
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB

/** 字节数人类可读（B / KB / MB，一位小数）；非法值返回空串（不显示大小） */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < BYTES_PER_KB) return `${bytes} B`
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`
}

/** 按 URL 路径段规则百分号编码（保留 `/` 分隔符，规范化为单个前导 `/`） */
export function encodeLocalFilePath(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/').replace(/^\/+/, '')
  return `/${normalized.split('/').map(encodeURIComponent).join('/')}`
}

/** 拼 iframe src：`local-file:///<编码路径>?r=<n>`——n 仅作重导航触发（query 不参与取文件；
 *  缓存新鲜性由 local-file 响应的 `Cache-Control: no-store` 构造保证，设计 §6.5 D5） */
export function buildLocalFileUrl(absPath: string, revision: number): string {
  return `local-file://${encodeLocalFilePath(absPath)}?r=${revision}`
}
