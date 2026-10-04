/**
 * local-file:// 协议路径白名单构造（纯函数，integrity-hardening §3.2 D2a）。
 *
 * 白名单只含可信子集（各项的为什么）：
 *   - appPath（app.getAppPath()）：app 资源目录（dev 装配下 = apps/electron 子目录，
 *     非项目根——见 projectRoot 条目）
 *   - dataDir（getDataDir()）：taiji 数据目录（动态推导，dev=~/.taiji-dev，
 *     符合架构约定 #2）+ <dataDir>/attachments：会话级图片附件目录（runtime
 *     session-service 持久化路径，按 sessionId 分区。放行整个 attachments 目录——
 *     全是用户自粘图片非敏感，安全粒度等同 tmpdir；protocol handler 无状态拿不到
 *     session 上下文，无法按 session 推导）
 *   - projectRoot（仅 dev + 装配器注入）：worktree 项目根。dev-instance.mjs 装配的
 *     electron cwd/appPath 都指向 apps/electron 子目录，对话流 <img src="docs/...">
 *     等相对路径解析出的项目根下用户文件命中不了前两者——本成员恢复「项目根」语义
 *     （local-file 图片预览主场景）。是否注入由 main.ts 调用侧条件展开裁决
 *     （isDev && TAIJI_DEV_PROJECT_ROOT），本纯函数不按 isPackaged 过滤——打包态
 *     env 不会被装配器注入，泄漏防线在调用侧双保险
 *   - cwd（仅 dev）：当前项目工作目录。
 *     [HISTORICAL] W3→D2a：打包态剔除 cwd——macOS 打包版从 Finder/Dock 启动时进程
 *     cwd 是 /，前缀匹配 startsWith('/') 对任意绝对路径恒真，白名单塌缩为全盘，
 *     原 [HISTORICAL] 注释「绝不放行 ~ 本身」的护栏被运行时环境击穿。不变量的
 *     守护从注释移到单测：main/test/local-file-prefixes.test.ts
 *     （打包态不含文件系统根 / 不含 homedir 本身）
 *   - tmpdir（os.tmpdir()）：临时文件（导出/截图等 + landing 态图片降级路径）
 *   - 特定用户子目录：~/Documents / ~/Desktop / ~/Downloads（用户内容常见位置）。
 *     绝不放行 ~ 本身（含 ~/.ssh、~/.aws 等敏感文件）——同上由单测守护
 *
 * 每项追加 path.sep 后缀，防止前缀误判（/Users/foo 匹配到 /Users/foobar）。
 *
 * 依赖方向：无下游（纯函数，node:path / node:os / node:fs）；白名单前缀判定
 * isPathInAllowedPrefixes 与构造 computeLocalFilePrefixes 是同一白名单域的「判定/构造」
 * 两半，同居本文件（原在 gateway/input-validators 属历史位置，下沉消解
 * gateway→utils→gateway 模块环）。被 main.ts 的协议 handler 与
 * gateway/local-file-handlers 的 servable/read IPC 共用（chat-html-support §6.4 D4
 * 「同一谓词」/ §6.9 D9）。
 */
import path from 'node:path'
import { readFileSync as fsReadFileSync, statSync as fsStatSync } from 'node:fs'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { expandLocalFilePath } from './path.js'
import type {
  LocalFileReadReason,
  LocalFileReadResult,
  LocalFileServableReason,
  LocalFileServableResult,
} from '@taiji/shared'

// local-file 两条 IPC 通道的 payload 类型定义 SSOT = `@taiji/shared`
// （packages/shared/src/ipc-payloads.ts，C-comm-22 唯一类型源）；此处 re-export 保持
// gateway/local-file-handlers 与单测的既有消费面（本地探测结果 LocalFileProbeResult
// 仍在本模块扩展）。
export type {
  LocalFileReadReason,
  LocalFileReadResult,
  LocalFileServableReason,
  LocalFileServableResult,
}

/** computeLocalFilePrefixes 入参（全部环境参数显式注入，便于单测） */
export interface LocalFilePrefixOptions {
  /** app.isPackaged：打包态剔除 cwd（cwd 语义已失效） */
  isPackaged: boolean
  /** process.cwd()：dev 态的项目工作目录 */
  cwd: string
  /** app.getAppPath()：app 资源目录（缺省跳过该项） */
  appPath?: string
  /**
   * dev 装配器（dev-instance.mjs）注入的项目根（worktree 根）——electron
   * cwd/getAppPath 在 dev 装配下是 apps/electron，白名单需要项目根成员才能放行
   * session cwd 下的用户文件（对话流 <img src="docs/..."> 相对路径解析）。仅 dev
   * 态由 main.ts 调用侧条件展开传入（isDev && TAIJI_DEV_PROJECT_ROOT），打包态
   * 必须缺省（装配器不注入 + 调用侧 isDev 双重防泄漏）。
   */
  projectRoot?: string
  /** getDataDir()：taiji 数据目录（缺省跳过该两项） */
  dataDir?: string
  /** os.tmpdir()（缺省跳过该项） */
  tmpdir?: string
  /** 用户 home（缺省回退 os.homedir()，与 expandLocalFilePath 同范式） */
  home?: string
}

/**
 * 构造 local-file:// 协议的允许前缀列表（每项带 trailing path.sep）。
 *
 * 打包态剔除 cwd（D2a 守卫）；dev 态保留。home 缺省回退 os.homedir()。
 * 可选路径参数缺省时跳过对应项（测试可用最小入参驱动）。
 * projectRoot 是 dev-only 成员，本函数对传入值无条件拼入——是否传（即打包态
 * 不出现该成员）由 main.ts 调用侧 isDev && TAIJI_DEV_PROJECT_ROOT 条件展开裁决。
 */
export function computeLocalFilePrefixes(opts: LocalFilePrefixOptions): string[] {
  const sep = path.sep
  const home = opts.home ?? homedir()
  const userContentSubdirs = ['Documents', 'Desktop', 'Downloads'].map(d => path.join(home, d))
  const prefixes: string[] = [
    ...(opts.appPath ? [opts.appPath] : []),
    // attachments：会话粘贴图片（runtime 持久化）；cache/images：toolResult 图片缓存
    // （D6-⑨，main 经 IPC 落盘后 renderer 以 local-file:// 引用渲染）。
    // 两者均为用户自产图片目录，安全粒度等同 tmpdir，整前缀放行（protocol handler
    // 无状态拿不到 session 上下文，无法按 session 推导）。
    ...(opts.dataDir
      ? [opts.dataDir, path.join(opts.dataDir, 'attachments'), path.join(opts.dataDir, 'cache', 'images')]
      : []),
    // projectRoot：dev 装配器注入的 worktree 根（cwd/appPath 在 dev 装配下都是
    // apps/electron 子目录，命中不了项目根下的用户文件）。dev-only 职责在调用侧。
    ...(opts.projectRoot ? [opts.projectRoot] : []),
    // D2a：打包态 cwd 不可信（Finder 启动时 = /，全盘放行），dev 态保留
    ...(opts.isPackaged ? [] : [opts.cwd]),
    ...(opts.tmpdir ? [opts.tmpdir] : []),
    ...userContentSubdirs,
  ]
  return prefixes.map(p => (p.endsWith(sep) ? p : p + sep))
}

/**
 * 校验路径是否在允许的前缀目录内（防目录穿越）。
 * 用于 local-file:// 协议 handler 与 local-file 两条 IPC 通道的准入判定。
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
 * localFile:servable / localFile:read 两条 IPC 通道的准入前缀（读/预检通道单独收窄）。
 *
 * 两条 IPC 的消费域 = 会话产物子树 `<dataDir>/artifacts/`（HtmlPreviewInline 挂载前
 * size 预检 + 源码态读取、useDetailPane 抽屉产物源码读取——全部调用链只消费产物路径）。
 * 与渲染面协议 handler 的全量白名单（computeLocalFilePrefixes）分离：通道入参含模型消息
 * 文本承载的路径载荷（html-preview fence），全量白名单含 `<dataDir>` 整前缀（含 pi agent
 * 目录的 auth.json 等凭据文件），读通道复用全量白名单 = 渲染进程可直读数据目录内任意
 * 文件文本。cwd 外非产物路径返回 `out_of_whitelist`，由调用方回落既有通道（useDetailPane
 * 的 cwd 通道 / 容器降级占位），不构成功能回退。
 */
export function computeLocalFileReadPrefixes(dataDir: string): string[] {
  const artifactsPrefix = path.join(dataDir, 'artifacts')
  return [artifactsPrefix.endsWith(path.sep) ? artifactsPrefix : artifactsPrefix + path.sep]
}

// ── local-file servable 预检谓词（chat-html-support §6.4 D4 子决策 / §6.9 D9）──────
// 内联预览容器 HtmlPreviewInline（经 deps probeArtifact?）挂载前经 `localFile:servable` IPC
// 预检（v16 唯一渲染面）；协议 handler 与预检必须复用本模块的同一谓词——边缘路径（.. 穿越 /
// // 冗余斜杠 / %2e2e 编码遍历 / 含 % # 空格的文件名）上两份平行实现必然分叉。

/** 内部探测结果：比 IPC 出参多带规范化后的绝对路径（协议 handler 的 net.fetch 需要） */
export interface LocalFileProbeResult extends LocalFileServableResult {
  /** 规范化后的绝对路径；out_of_whitelist 短路返回空串（未进入文件系统面） */
  resolvedPath: string
}

/**
 * 探测用 fs 切面（缺省 node:fs；单测注入记录桩以断言「越界短路不触 fs」）。
 *
 * `statSync` 允许抛错（缺省实现 `throwIfNoEntry:false` 下「不存在」返回 undefined 不抛错，
 * 能抛出的即 EACCES / EIO / ENOTDIR 等真异常）；谓词统一捕获并交 `onError` 旁路。
 */
export interface LocalFileProbeFs {
  statSync?: (filePath: string) => { isDirectory(): boolean; size: number } | undefined
  /**
   * 探测 / 读取异常旁路（EACCES / EIO 等读不到，非「不存在」）。
   *
   * 本模块是纯函数（无日志依赖），错误可见性由调用方注入：main 侧协议 handler 与
   * servable IPC 注入 `mainLogger.warn`（chat-html-support §6.4 D4 子决策③「诊断细分由
   * main 日志承载」）。`probeLocalFileServable` 的 stat 异常与 `readLocalFileContent`
   * 的读取异常共用本旁路（catch 不静默吞掉）。reason 枚举仍是设计定义的三值，非 ENOENT
   * 异常**就地映射**为 `not_found`（枚举内就近映射，不扩枚举）——UI 文案说「文件不存在」
   * 时，真实原因（errno + 路径）只在此旁路可见。
   */
  onError?: (err: unknown, filePath: string) => void
}

/**
 * URL pathname → 文件系统路径（协议 handler 入口专用）。
 *
 * 与 IPC 入口（probeLocalFileServable 直接收文件系统路径）的唯一差异是这一步：URL 路径段
 * 是百分号编码形态（renderer 侧按路径段编码后拼入），而 IPC 入参已是明文路径——对明文
 * 再解码会把文件名里的字面 `%` 吃掉（`report%20x.html` 变 `report x.html`）。
 * 解码异常（非法 % 序列）回退原文，交由白名单短路成 403，不向调用方抛异常。
 */
export function decodeLocalFileUrlPathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}

/** `~` 展开 + path.resolve 规范化（两条入口共用的规范化收尾） */
export function resolveLocalFilePath(rawPath: string): string {
  return path.resolve(expandLocalFilePath(rawPath))
}

/** 缺省探测：`throwIfNoEntry:false` 让「不存在」返回 undefined 而非抛错（存在性判定不靠异常）。
 *  EACCES / EIO 等真异常不在此吞掉——向上抛给 probeLocalFileServable 统一旁路 `onError`。 */
function defaultStat(filePath: string): { isDirectory(): boolean; size: number } | undefined {
  return fsStatSync(filePath, { throwIfNoEntry: false })
}

/**
 * 规范化后的绝对路径 → `net.fetch` 取文件用的 `file://` URL（协议 handler 专用；§6.4 D4 编码规格）。
 *
 * **必须是编码形态**：预检拿到的是解码后的明文路径，裸拼 `file://${resolvedPath}` 会被 URL
 * 解析吞掉 `#`（fragment 起点）/ `?`（query 起点）或错解码字面 `%`——`report#1.html` 裸拼后
 * `net.fetch` 实际取 `report`（§11 检查点 4 实测：`new URL('file:///tmp/dir/hash#1.html').pathname
 * === '/tmp/dir/hash'`）。`pathToFileURL` 按 file URL 规则逐段编码（`#`→`%23` / `%`→`%25` /
 * `?`→`%3F`），与 renderer 侧路径段编码 + handler 侧 `decodeURIComponent` 构成完整来回。
 */
export function buildLocalFileFetchUrl(resolvedPath: string): string {
  return pathToFileURL(resolvedPath).href
}

/**
 * servable 谓词：白名单成员资格（先行短路）→ 存在性 → 目录性。
 *
 * **检查顺序是安全性质**：越界路径一律返回 out_of_whitelist 且不触 fs——否则
 * 「越界不存在」与「越界存在」的响应差异会成为任意路径的存在性探测通道。
 *
 * @param rawPath 绝对路径或 `~` 形态路径（IPC 入参）
 * @param allowedPrefixes computeLocalFilePrefixes 产出（已带 trailing path.sep）
 * @param fs 探测切面（缺省 node:fs）
 */
export function probeLocalFileServable(
  rawPath: string,
  allowedPrefixes: readonly string[],
  fs: LocalFileProbeFs = {},
): LocalFileProbeResult {
  const resolvedPath = resolveLocalFilePath(rawPath)
  if (!isPathInAllowedPrefixes(resolvedPath, allowedPrefixes)) {
    return { servable: false, reason: 'out_of_whitelist', resolvedPath: '' }
  }
  let stat: { isDirectory(): boolean; size: number } | undefined
  try {
    stat = (fs.statSync ?? defaultStat)(resolvedPath)
  } catch (err) {
    // 非 ENOENT 真异常（EACCES/EIO/ENOTDIR）：就地映射为 not_found（reason 三值枚举不扩），
    // 真因交 onError 旁路承载（§6.4 D4 子决策③），不静默吞掉
    fs.onError?.(err, resolvedPath)
    return { servable: false, reason: 'not_found', resolvedPath }
  }
  if (!stat) return { servable: false, reason: 'not_found', resolvedPath }
  if (stat.isDirectory()) return { servable: false, reason: 'is_dir', resolvedPath }
  return { servable: true, size: stat.size, resolvedPath }
}

/**
 * URL 入口规范化：百分号解码 + `~` 形态前导 `/` 归一（两条入口共享同一套规范化管线的入口段）。
 *
 * URL pathname 恒带前导 `/`（renderer `encodeLocalFilePath` 把任意形态规范化为单个前导
 * `/`，`~` 形态 → `/~...`），而 `expandLocalFilePath` 只认 `~` / `~/` 开头——不归一就会出现
 * 「IPC 预检（明文 `~/...`）说可服务、iframe URL 入口 403」的分叉，违反 §6.4 D4 子决策②
 * 「URL 入口与 IPC 入口共享同一套规范化管线（`~` 展开 + 解码 + resolve + 白名单判定）」。
 *
 * 只剥 `/~` / `/~/...` 的前导 `/`；绝对路径首 `/` 保留（`path.resolve` 依赖），其余原样交
 * 白名单短路。renderer 不展开 `~`（不知道 home），展开职责在主进程谓词。
 */
export function normalizeLocalFileUrlPathname(pathname: string): string {
  const decoded = decodeLocalFileUrlPathname(pathname)
  return decoded === '/~' || decoded.startsWith('/~/') ? decoded.slice(1) : decoded
}

/** 协议 handler 入口：URL pathname 走同一规范化管线后复用同一谓词（与 IPC 入口判定一致） */
export function probeLocalFileUrlPathname(
  pathname: string,
  allowedPrefixes: readonly string[],
  fs: LocalFileProbeFs = {},
): LocalFileProbeResult {
  return probeLocalFileServable(normalizeLocalFileUrlPathname(pathname), allowedPrefixes, fs)
}

// ── local-file 源码内容读取（chat-html-support §8.2 S3「切换『源码』看到 shiki 高亮」）──
// 产物目录 `<dataDir>/artifacts/<sessionId>` 在 session cwd 外（设计 §6.7 D7 自述「产物在
// cwd 外、在白名单内」），runtime `file.read` 的 cwd 守门（file-service.ts 越界抛
// `out_of_cwd`）对主要产物路径不可达——源码态需要一条与 servable 预检**同一谓词函数**的
// 读取通道。准入判定复用 probeLocalFileServable（白名单先行短路 → 存在性 → 目录性）；
// IPC 通道侧前缀集 = computeLocalFileReadPrefixes 的产物子树（非协议 handler 全量白名单
// ——通道入参含模型消息文本路径载荷，文本读取面限定在实际消费域）。读出的内容只经
// CodeBlock 文本插值渲染（禁 v-html），不构成脚本执行面扩大。

/** 源码态读取上限（与 runtime `file.read` 的 MAX_FILE_SIZE 同语义：1 MiB，超出截断） */
export const MAX_LOCAL_FILE_READ_BYTES = 1_048_576

/** 读取用 fs 切面（缺省 node:fs；单测注入桩） */
export interface LocalFileReadFs {
  readFileSync?: (filePath: string) => Uint8Array
}

function defaultReadFile(filePath: string): Uint8Array {
  return fsReadFileSync(filePath)
}

/**
 * 读白名单内文件内容（源码态通道）。
 *
 * 谓词与 servable 预检 / 协议 handler 同源（probeLocalFileServable）——越界路径一律
 * `out_of_whitelist` 且不触 fs（检查顺序是安全性质，不构成存在性探测通道）。准入域由
 * 调用方传入的前缀集裁决：IPC 读通道传 computeLocalFileReadPrefixes 的产物子树（收窄面），
 * 协议 handler 面如需全文读取才传 computeLocalFilePrefixes 全量白名单。
 *
 * @param rawPath 绝对路径或 `~` 形态路径（IPC 入参）
 * @param allowedPrefixes 准入前缀集（已带 trailing path.sep，见上方准入域说明）
 * @param fs 探测 / 读取切面（缺省 node:fs）
 */
export function readLocalFileContent(
  rawPath: string,
  allowedPrefixes: readonly string[],
  fs: LocalFileProbeFs & LocalFileReadFs = {},
): LocalFileReadResult {
  const probe = probeLocalFileServable(rawPath, allowedPrefixes, fs)
  if (!probe.servable) return { ok: false, reason: probe.reason ?? 'not_found' }
  try {
    const buf = (fs.readFileSync ?? defaultReadFile)(probe.resolvedPath)
    const truncated = buf.byteLength > MAX_LOCAL_FILE_READ_BYTES
    const content = new TextDecoder().decode(buf.subarray(0, MAX_LOCAL_FILE_READ_BYTES))
    return { ok: true, content, truncated }
  } catch (err) {
    // 权限 / 读取异常降级为不可读，不让 IPC 边界抛错；真因经调用方注入的 onError
    // 旁路（main 日志承载，与探针同类异常同一通道，不静默吞掉）
    fs.onError?.(err, probe.resolvedPath)
    return { ok: false, reason: 'read_failed' }
  }
}
