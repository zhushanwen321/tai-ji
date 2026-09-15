/**
 * 文件类型判定纯函数（R2 logic 层）。
 *
 * 按文件扩展名判定文件归属的「渲染类别」（FileKind），供 DetailPane 选择渲染器。
 * 零 IO、纯函数——判定基于扩展名字符串匹配，便于单测。
 *
 * 设计取舍（前端纯函数 vs 后端返回 MIME）：
 * - 选前端：零网络往返、纯函数易测、符合 useDetailPane 取数据 / 组件渲染的分层。
 *   扩展名对常见开发文件足够准确（.md/.ts/.png 等无歧义）。
 * - binary 不在前端判定：二进制（含真正无扩展名或未知二进制）沿用后端 git.getDiff 返回的
 *   binary 标志（git-service 检测 "Binary files ... differ"），由 DetailPane 的 binary 分支兜底。
 *   前端只负责「已知扩展名 → 渲染器」映射，不试图穷举所有二进制格式。
 *
 * extToLang：扩展名 → shiki 语言名映射，供 CodeBlock 的 codeToHtml 用。
 * 未覆盖的扩展名 fallback 'typescript'（与 markdown.ts highlight 回调一致）。
 */

/** 文件渲染类别（决定 DetailPane 用哪个渲染器） */
export type FileKind = 'markdown' | 'image' | 'code' | 'text'

/** 图片扩展名集合（local-file:// 协议可加载的常见位图/矢量格式） */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'])

/** markdown 扩展名集合 */
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx'])

/** 扩展名 → shiki 语言名映射（code 类文件高亮用）。 */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  vue: 'vue',
  json: 'json',
  tsjson: 'json',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  xml: 'html',
  sql: 'sql',
  dockerfile: 'docker',
  makefile: 'makefile',
}

/**
 * 取文件扩展名（小写、不含点）。无扩展名返回空串。
 * 对 '.eslintrc' 这类 dotfile，整体视为扩展名。
 */
function extOf(path: string): string {
  const base = path.split('/').pop() ?? path
  // dotfile（如 .eslintrc）整体作扩展名
  if (base.startsWith('.') && base.indexOf('.', 1) === -1) {
    return base.slice(1).toLowerCase()
  }
  const dot = base.lastIndexOf('.')
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/**
 * 判定文件渲染类别（按扩展名）。
 * - .md/.markdown/.mdx → markdown
 * - .png/.jpg/... → image
 * - .ts/.js/.vue/.json/... → code
 * - 其余（含无扩展名） → text
 *
 * 注意：不返回 'binary'——二进制判定由后端 git.getDiff 的 binary 标志负责，
 * DetailPane 的 binary 分支优先于本函数结果（state.binary=true 时无论 kind 走占位）。
 */
export function detectFileKind(path: string): FileKind {
  const ext = extOf(path)
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (ext in EXT_TO_LANG) return 'code'
  return 'text'
}

/**
 * 扩展名 → shiki 语言名（供 CodeBlock codeToHtml 用）。
 * 未覆盖的扩展名 fallback 'typescript'（与 markdown.ts highlight 回调一致）。
 */
export function extToLang(path: string): string {
  return EXT_TO_LANG[extOf(path)] ?? 'typescript'
}
