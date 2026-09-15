/**
 * 代理配置存储读写 SSOT（Single Source Of Truth）。
 *
 * 收敛自原 orchestrator.ts 与 gateway/update-handlers.ts 的重复实现，
 * 消除凭证加解密两处实现因 drift 导致的降级不对称 bug（B-1）。
 *
 * 关键修复（B-1）：
 * - 旧 orchestrator 侧 rehydrateCredentials 无明文 base64 降级，safeStorage 由不可用变可用后
 *   解密失败 → 静默丢凭证 → 下载链路代理 407。本模块 decryptCredential 统一了降级逻辑：
 *   safeStorage 可用时先尝试 decryptString，**失败则降级为明文 base64 解码**，保证读对称。
 *
 * 依赖方向（单向不变）：gateway 层（update-handlers）→ update 层（本模块）→ @taiji/shared。
 * 本模块只依赖 @taiji/shared（getDataDir + IProxyConfig）+ node:fs/node:path
 * + 动态 require electron（safeStorage），不静态依赖 electron。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IProxyConfig } from '@taiji/shared'
import { getDataDir } from '@taiji/shared/paths'

/** 落盘文件名（消除原两处 'proxy-config.json' 硬编码） */
const PROXY_CONFIG_FILENAME = 'proxy-config.json'

/**
 * 代理配置落盘结构（SSOT 定义，原两处 IStoredProxyConfig 收敛于此）。
 *
 * URL 字段（httpProxy/httpsProxy）只保留 `protocol://host:port`，
 * 凭证经 {@link encryptCredential} 加密成 base64 后存到 credentials，读取时还原。
 * credentials 可选：无凭证时缺省；兼容无凭证的旧文件（无此字段）。
 */
export interface IStoredProxyConfig {
  mode: IProxyConfig['mode']
  httpProxy?: string
  httpsProxy?: string
  /** 加密后的凭证（base64），key 为 'http' / 'https' */
  credentials?: Record<string, string>
}

/**
 * 代理配置文件路径（SSOT）。每次调用内部再算 getDataDir，**延迟计算**，
 * 修复原 orchestrator 顶层 `PROXY_CONFIG_FILE = join(getDataDir(), ...)` 在模块加载时即绑定
 * 的 module-eager-binding 问题（reviewer W-4）。
 */
export function getProxyConfigPath(): string {
  return join(getDataDir(), PROXY_CONFIG_FILENAME)
}

/**
 * 获取 Electron safeStorage API（运行时动态 require，不引入静态依赖）。
 *
 * 返回 safeStorage 或 null（环境无 electron / app 未 ready / 无此 API）。
 * 保留 orchestrator 原有的动态 require 模式：本模块属 update 纯逻辑层，
 * safeStorage 是 electron API，用 require 避免把 electron 变成静态硬依赖；
 * 测试环境未 mock electron 时返回 null，由调用方降级处理。
 */
function getSafeStorage(): {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (b: Buffer) => string
} | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- update 纯逻辑层需规避静态依赖 electron；safeStorage 仅运行时可用，require 失败时返回 null 降级
    const electron = require('electron') as {
      safeStorage?: {
        isEncryptionAvailable: () => boolean
        encryptString: (plain: string) => Buffer
        decryptString: (b: Buffer) => string
      }
    }
    const ss = electron.safeStorage
    if (
      ss &&
      typeof ss.isEncryptionAvailable === 'function' &&
      typeof ss.encryptString === 'function' &&
      typeof ss.decryptString === 'function'
    ) {
      return ss
    }
    return null
  } catch {
    return null
  }
}

/**
 * 加密代理凭证为 base64 字符串（写盘前调用）。
 *
 * - safeStorage 可用 → encryptString 后转 base64
 * - safeStorage 不可用 → 明文 base64（warn 提示，文件系统权限仍提供基础保护）
 *
 * 两种形态都用 base64 外壳，落盘结构一致，便于解密侧统一处理。
 */
export function encryptCredential(plain: string): string {
  const ss = getSafeStorage()
  if (ss && ss.isEncryptionAvailable()) {
    return ss.encryptString(plain).toString('base64')
  }
  console.warn('[proxy] safeStorage unavailable, storing credential as plain base64')
  return Buffer.from(plain, 'utf-8').toString('base64')
}

/**
 * 解密代理凭证（读取时调用）。**B-1 修复核心：读侧降级对称**。
 *
 * - safeStorage 可用 → 先尝试 decryptString；**失败时降级为明文 base64 解码**
 *   （关键：兼容历史「safeStorage 不可用时写入的明文 base64」凭证，避免 drift 后丢凭证）
 * - safeStorage 不可用 → 明文 base64 解码
 *
 * 这样无论凭证是在 safeStorage 可用还是不可用环境下写入的，都能正确还原，
 * 消除原 orchestrator 侧缺明文降级导致的「写读不对称 → 代理 407 → 下载失败」。
 */
export function decryptCredential(enc: string): string {
  const ss = getSafeStorage()
  if (ss && ss.isEncryptionAvailable()) {
    try {
      return ss.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      // 降级：可能是历史「safeStorage 不可用时写入的明文 base64」凭证，
      // safeStorage 后来变可用后 decryptString 解不了 → 按明文 base64 解码兜底。
      return Buffer.from(enc, 'base64').toString('utf-8')
    }
  }
  return Buffer.from(enc, 'base64').toString('utf-8')
}

/**
 * 剥离 URL 中的凭证（user:pass），写盘前脱敏。
 *
 * @returns safeUrl 含 `protocol://host:port`；credential 为 `user:pass` 或 undefined（无凭证/非法 URL）
 */
export function stripCredential(urlStr: string): {
  safeUrl: string
  credential: string | undefined
} {
  let u: URL
  try {
    u = new URL(urlStr)
  } catch {
    // 非法 URL（理论上调用方已校验，这里防御）：原样返回，不视为含凭证
    return { safeUrl: urlStr, credential: undefined }
  }
  const hasCred = u.username !== '' || u.password !== ''
  if (!hasCred) {
    return { safeUrl: urlStr, credential: undefined }
  }
  const credential = u.password !== '' ? `${u.username}:${u.password}` : u.username
  u.username = ''
  u.password = ''
  return { safeUrl: u.toString(), credential }
}

/**
 * 把凭证拼回代理 URL（读取时还原完整 URL，供 ProxyAgent 使用）。
 *
 * 解密/拼接失败时返回原 safeUrl（不阻断，降级为无认证）。
 */
export function withCredential(safeUrl: string, enc: string | undefined): string {
  if (!enc) return safeUrl
  let cred: string
  try {
    cred = decryptCredential(enc)
  } catch {
    return safeUrl
  }
  try {
    const u = new URL(safeUrl)
    const [username, password] = cred.split(':')
    u.username = username
    if (password !== undefined) u.password = password
    return u.toString()
  } catch {
    return safeUrl
  }
}

/**
 * 读取代理配置并还原完整代理 URL（含凭证）。
 *
 * 容错策略（任意一步失败都降级为默认 system 配置，不阻断升级）：
 *   - 文件不存在 / JSON 解析失败 → { mode: 'system' }
 *   - 解密失败（decryptCredential 内部已降级为明文 base64，极少再抛）→ 该字段凭证缺失
 *
 * 返回完整 {@link IProxyConfig}（凭证已拼回 URL）。
 */
export function readProxyConfig(): IProxyConfig {
  const filePath = getProxyConfigPath()
  if (!existsSync(filePath)) {
    return { mode: 'system' }
  }
  let stored: IStoredProxyConfig
  try {
    stored = JSON.parse(readFileSync(filePath, 'utf-8')) as IStoredProxyConfig
  } catch {
    return { mode: 'system' }
  }
  // 兼容旧格式：直接是 IProxyConfig（无 credentials 字段）→ 原样返回
  const config: IProxyConfig = { mode: stored.mode ?? 'system' }
  config.httpProxy = stored.httpProxy && stored.credentials?.http
    ? withCredential(stored.httpProxy, stored.credentials.http)
    : stored.httpProxy
  config.httpsProxy = stored.httpsProxy && stored.credentials?.https
    ? withCredential(stored.httpsProxy, stored.credentials.https)
    : stored.httpsProxy
  return config
}

/**
 * 写入代理配置（凭证剥离 + 加密，URL 不落明文密码）。
 *
 * 自动 mkdirSync(getDataDir, recursive)，确保目录存在。
 */
export function writeProxyConfig(config: IProxyConfig): void {
  const filePath = getProxyConfigPath()
  mkdirSync(getDataDir(), { recursive: true })

  const stored: IStoredProxyConfig = { mode: config.mode }
  const credentials: Record<string, string> = {}
  if (config.httpProxy) {
    const { safeUrl, credential } = stripCredential(config.httpProxy)
    stored.httpProxy = safeUrl
    if (credential) credentials.http = encryptCredential(credential)
  }
  if (config.httpsProxy) {
    const { safeUrl, credential } = stripCredential(config.httpsProxy)
    stored.httpsProxy = safeUrl
    if (credential) credentials.https = encryptCredential(credential)
  }
  if (Object.keys(credentials).length > 0) {
    stored.credentials = credentials
  }
  // eslint-disable-next-line no-magic-numbers -- 2 = JSON 缩进空格数（人类可读）
  writeFileSync(filePath, JSON.stringify(stored, null, 2))
}

/**
 * 根据 proxyConfig 解析出代理 URL 字符串（供 ProxyAgent 构造）。
 *
 * 消除 download-asset 与 update-handlers 的 resolveDispatcher 重复的「mode→proxyUrl」解析逻辑。
 * 返回 undefined 表示不挂代理（直连）。
 *
 * mode 处理：
 * - manual → `config.httpsProxy ?? config.httpProxy`
 * - system → 读环境变量 `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy`
 * - disabled → undefined
 *
 * [NOTE] 本函数只返回 URL 字符串，不构造 ProxyAgent——构造 dispatcher（含网络依赖）
 * 留给 gateway 层（update-handlers）或下载层（download-asset）负责，保持本模块纯逻辑。
 */
export function resolveProxyUrl(config: IProxyConfig): string | undefined {
  if (config.mode === 'disabled') {
    return undefined
  }
  if (config.mode === 'manual') {
    return config.httpsProxy ?? config.httpProxy
  }
  // system：读环境变量
  return (
    process.env.HTTPS_PROXY ?? process.env.https_proxy ??
    process.env.HTTP_PROXY ?? process.env.http_proxy
  )
}
