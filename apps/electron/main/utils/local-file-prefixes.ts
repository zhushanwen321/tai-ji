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
 * 依赖方向：无下游（纯函数，node:path / node:os / node:fs + gateway/input-validators 的
 * 白名单前缀判定）；被 main.ts 的协议 handler 与 gateway/local-file-handlers 的 servable
 * 预检 IPC 共用（chat-html-support §6.4 D4「同一谓词」/ §6.9 D9）。
 */
import path from 'node:path'
import { statSync as fsStatSync } from 'node:fs'
import { homedir } from 'node:os'
import { isPathInAllowedPrefixes } from '../gateway/input-validators.js'
import { expandLocalFilePath } from './path.js'

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

// ── local-file servable 预检谓词（chat-html-support §6.4 D4 子决策 / §6.9 D9）──────
// 卡片（经 deps probeArtifact?）与抽屉渲染态挂载前经 `localFile:servable` IPC 预检；
// 协议 handler 与预检必须复用本模块的同一谓词——边缘路径（.. 穿越 / // 冗余斜杠 /
// %2e2e 编码遍历 / 含 % # 空格的文件名）上两份平行实现必然分叉。

/** servable 预检失败原因（preload/index.d.ts 的 LocalFileServableResult.reason 同枚举） */
export type LocalFileServableReason = 'not_found' | 'is_dir' | 'out_of_whitelist'

/** servable 预检结果（IPC 出参面） */
export interface LocalFileServableResult {
  servable: boolean
  reason?: LocalFileServableReason
  /** servable=true 时的文件字节数（卡片显示大小） */
  size?: number
}

/** 内部探测结果：比 IPC 出参多带规范化后的绝对路径（协议 handler 的 net.fetch 需要） */
export interface LocalFileProbeResult extends LocalFileServableResult {
  /** 规范化后的绝对路径；out_of_whitelist 短路返回空串（未进入文件系统面） */
  resolvedPath: string
}

/** 探测用 fs 切面（缺省 node:fs；单测注入记录桩以断言「越界短路不触 fs」） */
export interface LocalFileProbeFs {
  statSync?: (filePath: string) => { isDirectory(): boolean; size: number } | undefined
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

function defaultStat(filePath: string): { isDirectory(): boolean; size: number } | undefined {
  try {
    // throwIfNoEntry:false：不存在返回 undefined 而非抛错（存在性判定不靠异常）
    return fsStatSync(filePath, { throwIfNoEntry: false })
  } catch {
    // 权限等异常同样降级为「不可服务」，不让协议 handler/IPC 抛错
    return undefined
  }
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
  const stat = (fs.statSync ?? defaultStat)(resolvedPath)
  if (!stat) return { servable: false, reason: 'not_found', resolvedPath }
  if (stat.isDirectory()) return { servable: false, reason: 'is_dir', resolvedPath }
  return { servable: true, size: stat.size, resolvedPath }
}

/** 协议 handler 入口：URL pathname 解码后走同一谓词（与 IPC 入口判定一致） */
export function probeLocalFileUrlPathname(
  pathname: string,
  allowedPrefixes: readonly string[],
  fs: LocalFileProbeFs = {},
): LocalFileProbeResult {
  return probeLocalFileServable(decodeLocalFileUrlPathname(pathname), allowedPrefixes, fs)
}
