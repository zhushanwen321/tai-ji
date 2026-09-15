/**
 * Gateway 输入校验（纯函数）。
 *
 * 对应 spec §4.2 M4「特权 handler 每个单独做输入校验」。
 * 把校验逻辑抽成纯函数，handler 调用后决定放行/拒绝。
 *
 * [HISTORICAL] 不变量：
 * - openExternal 必须校验 http/https 协议（防 file:// / javascript: 等）
 * - 路径类校验用 path.resolve 规范化 + 前缀匹配（防 ../ 穿越）
 *   追加 path.sep 后缀防止前缀误判（/Users/foo 匹配到 /Users/foobar）
 * - will-navigate 只放行应用自身源（isAllowedAppNavigation，integrity-hardening D2b）
 *
 * 这是纯函数文件——签名即设计，不深化骨架。
 *
 * 依赖方向：无下游（纯函数，import node:path + node:url）
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 校验 URL 是否允许 openExternal。
 * 只允许 http/https 协议。
 *
 * @param url 待校验 URL
 * @returns true=安全可打开 / false=危险协议
 */
export function isValidExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/**
 * 校验路径是否在允许的前缀目录内（防目录穿越）。
 * 用于 local-file:// 协议 handler。
 *
 * 两次匹配：resolved.startsWith(prefix) 或精确等于（resolved + sep === prefix）。
 *
 * @param filePath 待校验路径
 * @param allowedPrefixes 允许的根目录列表（调用方负责追加 path.sep 后缀）
 * @returns true=在白名单内 / false=越界
 */
export function isPathInAllowedPrefixes(filePath: string, allowedPrefixes: readonly string[]): boolean {
  const sep = path.sep
  const resolved = path.resolve(filePath)
  // 前缀匹配（allowedPrefixes 已带 trailing sep）+ 精确匹配（resolved 本身就是允许目录）
  return allowedPrefixes.some(p => resolved.startsWith(p))
    || allowedPrefixes.some(p => resolved + sep === p)
}

/**
 * 校验 reveal-in-folder 输入是否为绝对路径（IPC 边界无类型保障，防御非 string 输入）。
 * 来源是 runtime 快照透传的 session JSONL 绝对路径；相对路径在 main 进程 cwd 下解析
 * 有歧义，直接拒绝（handler 返回 false，renderer 侧降级）。
 */
export function isValidAbsolutePath(filePath: unknown): filePath is string {
  return typeof filePath === 'string' && filePath.length > 0 && path.isAbsolute(filePath)
}

/**
 * D2b 导航拦截（integrity-hardening §3.2）：判定主窗口 will-navigate 目标是否应用自身源。
 *
 * 为什么拦截：renderer 一旦被注入（XSS），`window.location = 'https://evil.com'` 整页
 * 导航会让 preload 对新页面重新注入 electronAPI——攻击页拿到 runtime token/port 连本机
 * WS，一次性注入升级为持久接管。in-page/hash 导航不触发 will-navigate（Electron 语义），
 * SPA 路由不受影响；loadURL/loadFile 程序化导航同样不触发。
 *
 * 允许两类（OR，缺省的参数不参与判定）：
 *  - devOrigin：dev 态 Vite dev server（origin 形式，如 http://localhost:1420）。
 *    HMR full-reload 同源放行
 *  - fileRoot：file:// 且路径在 fileRoot 目录内（prod/E2E 态 loadFile 自源）。
 *    两条件同时启用而非按 isDev 二选一：E2E 是「构建产物 + isDev=true」形态（TAIJI_E2E），
 *    loadFile 自源在任何模式都要放行；fileRoot 限定 appPath（应用安装目录/项目根），
 *    不放行任意 file:// 页（防 preload 注入到不可信本地页）
 *
 * @param url will-navigate 目标 URL
 * @param opts.devOrigin dev 态 dev server origin（origin 形式字符串）
 * @param opts.fileRoot prod/E2E 态允许的 file:// 根目录（app.getAppPath()）
 * @returns true=应用自身源放行 / false=调用方应 preventDefault
 */
export function isAllowedAppNavigation(
  url: string,
  opts: { devOrigin?: string; fileRoot?: string },
): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (opts.devOrigin && parsed.origin === opts.devOrigin) return true
  if (opts.fileRoot && parsed.protocol === 'file:') {
    // fileURLToPath 统一平台差异（Windows file URL 带 /C:/ 前导斜杠）+ 解码 %xx
    let filePath: string
    try {
      filePath = fileURLToPath(parsed)
    } catch {
      return false
    }
    const root = opts.fileRoot.endsWith(path.sep) ? opts.fileRoot : opts.fileRoot + path.sep
    return filePath.startsWith(root)
  }
  return false
}
