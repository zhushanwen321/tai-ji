/**
 * 前端路径工具（预览场景）。
 *
 * 跨平台识别 Unix / Windows / ~/ 路径，并在需要时把 cwd 内绝对路径转成相对路径
 * 供 gitOverlay 查询和 git diff 请求使用。
 *
 * 注意：~ 路径在前端不展开（无 homedir 信息），标记为绝对路径并保持原样展示；
 * 文本预览由 runtime 侧 expandHome 处理。
 */

/** 判断路径是否为绝对路径（Unix / Windows / ~/ 家目录）。 */
export function isAbsolutePath(path: string): boolean {
  if (!path) return false
  return path.startsWith('/') || path.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(path)
}

interface ResolvePreviewPathResult {
  /** 用于展示和 local-file:// URL 的绝对路径（~ 路径保持原样）。 */
  absolute: string
  /**
   * 用于 gitOverlay 查询和 git diff 请求的相对 cwd 路径。
   * 当输入是绝对路径且位于 cwd 下时，从绝对路径推导；
   * 当输入是相对路径时，为原始输入；
   * 当输入在 cwd 外或是 ~ 路径时，为 null。
   */
  relative: string | null
}

/** 解析预览路径：返回展示用 absolute 和 git 查询用 relative。 */
export function resolvePreviewPath(cwd: string, path: string): ResolvePreviewPathResult {
  // 统一分隔符：Windows 反斜杠在计算前缀时转成正斜杠，结果仍保持原始展示
  const normalizedCwd = cwd.replace(/\\/g, '/')
  const normalizedPath = path.replace(/\\/g, '/')

  if (isAbsolutePath(path)) {
    // ~ 路径：保持原样展示，无法确定与 cwd 关系 → relative 为 null
    if (path.startsWith('~')) {
      return { absolute: path, relative: null }
    }
    // Unix / Windows 绝对路径
    const prefix = normalizedCwd.endsWith('/') ? normalizedCwd : `${normalizedCwd}/`
    const relative = normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : null
    return { absolute: path, relative }
  }
  // 相对路径
  const absolute = normalizedCwd.endsWith('/') ? `${normalizedCwd}${path}` : `${normalizedCwd}/${path}`
  return { absolute, relative: path }
}
