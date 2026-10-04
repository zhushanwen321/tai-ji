/**
 * 移动壳静态托管（remote-access D3/E4/E5）——独立静态面 module（S3 拆分：原实现在
 * ConnectionManager 内，静态托管与连接生命周期是正交变化轴，抽出后 CM 只持可空
 * handler 引用）。
 *
 * 职责边界：
 * - 本 module 只管「给定 distRoot，把 HTTP 请求服务掉」：Content-Type 映射、白名单化
 *   路径判定防目录穿越（E4）、目录请求回退 index.html（D3）、404/405/500 兜底。
 * - **不感知开态**：不读 remoteTokenProvider、不读 env——开态判定（remote-access
 *   flag → 是否探测 dist / 构造 handler）归组合根（index.ts，resolveMobileStaticRoot
 *   的 remoteAccess 入参），关态零挂载零探测由组合根「不调用不注入」构造性保证。
 *
 * 对外三件套：
 * - resolveMobileStaticRoot：启动期一次探测（E5），返回 dist 绝对路径或 null（禁用静态面）；
 * - createMobileStaticHandler：由 distRoot 构造 (req,res) handler，注入 ConnectionManager；
 * - resolveMobileStaticPath：穿越判定纯函数（单测锚定）。
 *
 * 日志纪律（D3）：访问/拒绝日志只记剥除 query 后的 pathname——`GET /?token=...` 的
 * 完整 URL 不落盘，防 remote token 经静态面日志形成第三落盘通道。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as fs from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { errorCodeOf, toErrorMessage } from '../utils/errors.js'

const HTTP_OK = 200
const HTTP_NOT_FOUND = 404
const HTTP_BAD_REQUEST = 400
const HTTP_METHOD_NOT_ALLOWED = 405
const HTTP_INTERNAL_ERROR = 500

const MOBILE_INDEX_FILENAME = 'index.html'

/**
 * 移动壳产物扩展名 → Content-Type 映射。按 mobile dist 实测产物维护（html/js/css
 * + katex 字体 ttf/woff/woff2 六类），新产物形态出现时补 1 行即可——映射外走
 * octet-stream 兜底，不会静默坏（浏览器按字节流下载，不会渲染成错误页面）。
 */
const MOBILE_STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/**
 * 把 HTTP 请求的 URL path（query 已由调用方剥除）解析为 dist 内绝对路径；
 * 白名单外返回 null（调用方 400）。
 *
 * 安全自审（穿越防护判定逻辑，E4）：
 * 1. 输入是调用方剥除 query 后的**原始编码 pathname**（刻意不经过 URL parser——其
 *    dot-segment 归一化会把 `/../`、`/%2e%2e/` 洗白成 `/`，见 createMobileStaticHandler
 *    注释；token 不进本函数也不进日志）；
 * 2. 先 decodeURIComponent 再做白名单判定——`/%2e%2e/`、`/%2e%2e%2f` 等编码变体解码后
 *    才暴露 `..` 段，判定置于解码之后使编码绕过无效；畸形百分号序列（decode 抛
 *    URIError）与 NUL 字节直接拒绝。
 * 3. 非 `/` 前缀的 decoded 直接拒绝（HTTP pathname 恒以 `/` 开头，其余形态不存在合法
 *    产物，显式早返回而非借白名单间接拒绝）；`path.resolve(distRoot, '.' + decoded)` 消解
 *    全部 `..`/`.` 段得到绝对路径，再做前缀白名单判定：结果必须恰为 distRoot，或以
 *    `distRoot + sep` 为前缀（带分隔符防 `/dist-evil` 对 `/dist` 的前缀误命中）。
 * 4. 白名单外一律返回 null 且本函数不发起任何 fs 调用——不读白名单外任何路径（E4）。
 *    读取目标只可能是判定通过的 resolved 路径或 distRoot/index.html 兜底，无其他拼点。
 * 已知不防：dist 内 symlink 指向外部——产物由本仓构建链生成、无 symlink，且非网络
 * 输入面；产物来源变化时需复审。
 */
export function resolveMobileStaticPath(distRoot: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  if (!decoded.startsWith('/')) return null
  const resolved = resolve(distRoot, `.${decoded}`)
  if (resolved !== distRoot && !resolved.startsWith(distRoot + sep)) return null
  return resolved
}

/** resolveMobileStaticRoot 输入：开态判据 + dist 目录，均来自组合根 argv 解析（D9）。 */
export interface MobileStaticMountOptions {
  /**
   * 远程访问开态（--remote-access flag 解析值）。false 时 mobileDist 单独出现（手工只传
   * --mobile-dist 不开 flag）不构成开态：不探测、不日志，直接 null——开态守卫在此，
   * 组合根直传 argv 布尔，不经 remoteTokenProvider 装配痕迹推断。
   */
  remoteAccess: boolean
  /** 移动壳 dist 目录（D3）：argv `--mobile-dist=<path>` 解析值；开态未传走 E5 禁用。 */
  mobileDist?: string
}

/**
 * 解析移动壳静态托管根（启动期一次探测，remote-access D3/E5；组合根构造
 * ConnectionManager 前调用）。
 * - 关态（remoteAccess=false）→ null 且零 IO 零日志：静态 handler 不构造，HTTP 分派
 *   与无远程访问形态逐字节一致。
 * - 开态但未传 --mobile-dist / 目录不存在 / 指向普通文件 → 响亮 error（含 pnpm build
 *   与打包配置指引）+ null：静态面禁用，WS 与桌面面不受影响、不拒启（E5）。
 * 返回 resolve 后的绝对路径（argv 值可能相对 cwd，统一规范化后作白名单判定基准）。
 */
export function resolveMobileStaticRoot(options: MobileStaticMountOptions): string | null {
  if (!options.remoteAccess) return null
  if (!options.mobileDist) {
    console.error(
      '[runtime] remote access: 已开启远程访问但未提供移动壳 dist（--mobile-dist），静态托管面已禁用（WS 与桌面面不受影响）。' +
        '恢复：pnpm --filter @taiji/mobile-renderer build 产出移动壳产物，再经桌面端以 --mobile-dist=<绝对路径> 启动 runtime' +
        '（正常由 supervisor 自动拼参；打包形态检查 electron-builder.yml 的 mobile-dist extraResources 条目）',
    )
    return null
  }
  const distRoot = resolve(options.mobileDist)
  let isDirectory = false
  try {
    isDirectory = fs.statSync(distRoot).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) {
    console.error(
      `[runtime] remote access: 移动壳 dist 目录不存在: ${distRoot}，静态托管面已禁用（WS 与桌面面不受影响）。` +
        '恢复：pnpm --filter @taiji/mobile-renderer build 产出移动壳产物（vite outDir = packages/mobile-renderer/dist）后重启；' +
        '打包形态检查 electron-builder.yml 的 mobile-dist extraResources 条目与打包编排是否先行执行移动壳构建',
    )
    return null
  }
  return distRoot
}

/** ConnectionManager 注入形态的静态 handler（S3：CM 只持本类型引用，不感知静态细节）。 */
export type MobileStaticHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/**
 * 由 distRoot 构造静态文件服务 handler。distRoot 必须来自 resolveMobileStaticRoot 的
 * 非空返回（组合根已探测通过），本闭包无 null 分支可走；/health 探针先于本 handler
 * （ConnectionManager 分派顺序，探针行为不受静态托管影响）。
 * 所有分支（405/400/404/200/500）都写完响应——调用方一旦分派即视为已服务。
 */
export function createMobileStaticHandler(distRoot: string): MobileStaticHandler {
  return async (req, res): Promise<void> => {
    try {
      const method = req.method ?? 'GET'
      // 仅 GET/HEAD（D3）：静态面无写语义；其余方法 405 + Allow 头指明合法方法。
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(HTTP_METHOD_NOT_ALLOWED, { Allow: 'GET, HEAD' })
        res.end()
        return
      }
      // 剥 query string：路径判定与日志都只用 pathname——`?token=` 从这里开始就不进
      // 路径也不进日志。手工 split 而非 new URL().pathname：URL parser 会做 dot-segment
      // 归一化（/../ 与 /%2e%2e/ 被洗白成 /），把穿越请求降级成 404、削弱 E4 的 400
      // 拒绝语义，也让拒绝日志丢失攻击形态；白名单判定需要原始编码形态。
      const pathname = (req.url ?? '/').split('?')[0] || '/'
      const filePath = resolveMobileStaticPath(distRoot, pathname)
      if (filePath === null) {
        console.warn(`[runtime] mobile static: rejected (path traversal): ${pathname}`)
        res.writeHead(HTTP_BAD_REQUEST)
        res.end()
        return
      }
      // 目录（含 `/`）回 index.html（D3 兜底）。不存在的普通路径 404——移动壳无前端
      // 路由，不做任意路径 SPA fallback（那会把错误资产路径也回 HTML，Content-Type 混淆）。
      // stat 失败（ENOENT/EACCES 等）→ null → 视为非目录，交由下方 readFile 走 404。
      const stat = await fs.promises.stat(filePath).catch(() => null)
      const target = stat?.isDirectory() ? join(distRoot, MOBILE_INDEX_FILENAME) : filePath
      let content: Buffer
      try {
        content = await fs.promises.readFile(target)
      } catch (error) {
        // 探测与读取之间文件消失（race）或 index.html 缺失（产物被删）→ 404 兜底。
        // 日志只记 fs error code（如 ENOENT）——error.message 形如
        // "ENOENT: no such file or directory, open '<dist 绝对路径>'"，会泄漏服务端
        // 绝对路径，违反本模块「日志只记 basename」纪律（code-harden P2）。
        console.warn(`[runtime] mobile static: not found: ${pathname}（fs error code: ${errorCodeOf(error) ?? 'unknown'}）`)
        res.writeHead(HTTP_NOT_FOUND)
        res.end()
        return
      }
      const contentType = MOBILE_STATIC_CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream'
      // 访问日志只含 pathname（query 已剥）与产物内文件名（basename，非完整服务端路径）。
      console.log(`[runtime] mobile static: ${method} ${pathname} -> ${basename(target)} (${content.length} bytes)`)
      res.writeHead(HTTP_OK, { 'Content-Type': contentType, 'Content-Length': String(content.length) })
      res.end(method === 'HEAD' ? undefined : content)
    } catch (error) {
      // request handler 内抛错会成 uncaughtException——失败路径收敛到这里回 500。
      console.error(`[runtime] mobile static: internal error: ${toErrorMessage(error)}`)
      try {
        res.writeHead(HTTP_INTERNAL_ERROR)
        res.end()
      // eslint-disable-next-line taste/no-silent-catch -- socket may already be closed（自 connection-manager.ts 原样搬运）
      } catch { /* 响应头可能已发出，无法补救 */ }
    }
  }
}
