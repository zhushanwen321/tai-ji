/**
 * 网络错误分类与代理可达性判定（D1 契约基建）。
 *
 * 收敛三条 fetch 路径（单段 download-asset / 多段 downloadPart / testProxyConnection）
 * 的 cause 提取与分类逻辑，消除多处实现 drift 风险。
 *
 * 设计决策：docs/design/update-observability.md §3.3 D1/D2。
 *
 * 依赖方向：net-errors → update/types（UpdateError）+ node:os（网络判定）。
 * 本模块不依赖 electron / undici，纯逻辑可测。
 */

import { UpdateError } from './types.js'
import type { UpdateStage } from '@taiji/shared'

/**
 * 从错误链中提取网络错误码（如 EHOSTUNREACH / ECONNREFUSED 等）。
 *
 * undici 的 fetch 抛错时，外层 Error 只带 'fetch failed'，真实网络错误
 * （含 .code 如 EHOSTUNREACH）挂在 err.cause。本函数逐层下钻 cause 链，
 * 优先取 Node errno code（cause.code），其次取 cause.message 前缀匹配。
 *
 * @returns 错误码字符串（如 'EHOSTUNREACH'），未找到返回 undefined
 */
export function extractNetErrorCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined

  // 1. 直接在 err 上找 code（原生 Node fs 错误直接有）
  const directCode = (err as NodeJS.ErrnoException).code
  if (directCode) return directCode

  // 2. 逐层下钻 cause 链
  let current: unknown = (err as { cause?: unknown }).cause
  const visited = new Set<unknown>()
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current)
    // cause.code（Node errno 风格）
    const causeCode = (current as NodeJS.ErrnoException).code
    if (causeCode) return causeCode
    // cause.message 前缀匹配（部分 undici 错误把 code 放在 message 开头）
    const prefix = current.message.match(/^([A-Z][A-Z0-9_]+)[\s:]/)
    if (prefix) return prefix[1]
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * 读取 Node 错误的 errno code（如 'ENOSPC'、'EACCES'）。
 *
 * 原生 Node fs 错误把 code 放在 `err.code`；包裹层有时会把底层原因包到
 * `err.cause` 里（cause.code）。两者都查，命中其一即返回。
 * 不能用 `err.code` 直接判断：传入值可能非 NodeJS.ErrnoException（无 code 字段）。
 *
 * 与 extractNetErrorCode 的区别：本函数只查 direct code + 一层 cause.code，
 * 不做 message 前缀匹配、不再深钻。这是刻意保留的单段路径原始判定语义——
 * classifyNetError 的磁盘分支必须与单段路径（download-asset stream catch 的
 * isDiskError）用同一判定，保证同一磁盘错误在单段/多段两条下载路径上报同一分类。
 */
export function getNodeErrnoCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  // 先看 err.code（原生 Node fs 错误）
  const directCode = (err as NodeJS.ErrnoException).code
  if (directCode) return directCode
  // 再看 cause.code（包裹层挂的底层原因）
  const cause = (err as { cause?: unknown }).cause
  if (cause instanceof Error) {
    return (cause as NodeJS.ErrnoException).code
  }
  return undefined
}

/**
 * 从错误中提取最内层 cause 的 message（raw cause 字符串）。
 *
 * 用于落盘 update-error.log 的 rawCause 字段，保留完整诊断信息。
 */
export function extractRawCause(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  let current: unknown = err
  const visited = new Set<unknown>()
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current)
    const next = (current as { cause?: unknown }).cause
    if (!next) {
      // 已到最内层，返回此层的 message（如果非外层则有意义）
      if (current !== err) return current.message
      return undefined
    }
    current = next
  }
  return undefined
}

// ── IPv4 私网/特殊地址段判定常量（点分十进制各段的段值；见 isPrivateHost）──

/** IPv4 点分十进制的段数。 */
const IPV4_OCTET_COUNT = 4
/** IPv4 单段合法上界（点分十进制取值 0-255）。 */
const IPV4_OCTET_MAX = 255
/** 127.0.0.0/8 loopback 的首段。 */
const IPV4_LOOPBACK_FIRST_OCTET = 127
/** 10.0.0.0/8 私网的首段。 */
const IPV4_10_PRIVATE_FIRST_OCTET = 10
/** 172.16.0.0/12 私网的首段。 */
const IPV4_172_PRIVATE_FIRST_OCTET = 172
/** 172.16.0.0/12 私网第二段范围下界（172.16-172.31）。 */
const IPV4_172_PRIVATE_SECOND_OCTET_MIN = 16
/** 172.16.0.0/12 私网第二段范围上界（172.16-172.31）。 */
const IPV4_172_PRIVATE_SECOND_OCTET_MAX = 31
/** 192.168.0.0/16 私网的首段。 */
const IPV4_192_PRIVATE_FIRST_OCTET = 192
/** 192.168.0.0/16 私网的第二段。 */
const IPV4_192_PRIVATE_SECOND_OCTET = 168

/**
 * 判断 hostname 是否为私网地址（RFC1918 IPv4 + IPv6 ULA fc00::/7 + loopback）。
 *
 * 已声明局限：hostname 形式（如 'nas.local'、DDNS 域名）不做 DNS 解析，
 * 返回 false → 落通用「无法连接代理」文案（仍可行动，只是少了精确权限指引）。
 *
 * 不解析 DNS（引入解析即引入新失败面与延迟）。
 */
export function isPrivateHost(hostname: string): boolean {
  // 去掉方括号（IPv6 URL 格式 [::1]）
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()

  // IPv6 loopback
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true

  // IPv6 ULA fc00::/7（fc00:: 到 fdff:: 前缀）。必须带 ':' 形态校验：纯前缀匹配
  // 会把 'fcbarcelona.com'、'fd-server.example.com' 等公网域名误判私网——ULA 地址
  // 的 fc/fd 后必跟 hex 组再跟 ':'，域名不可能命中。
  if (/^f[cd]/.test(host) && host.includes(':')) return true

  // IPv4 解析
  const parts = host.split('.')
  if (parts.length !== IPV4_OCTET_COUNT) return false
  const nums = parts.map(Number)
  if (nums.some((n) => isNaN(n) || n < 0 || n > IPV4_OCTET_MAX)) return false

  // 127.0.0.0/8 loopback
  if (nums[0] === IPV4_LOOPBACK_FIRST_OCTET) return true
  // 10.0.0.0/8
  if (nums[0] === IPV4_10_PRIVATE_FIRST_OCTET) return true
  // 172.16.0.0/12
  if (
    nums[0] === IPV4_172_PRIVATE_FIRST_OCTET &&
    nums[1] >= IPV4_172_PRIVATE_SECOND_OCTET_MIN &&
    nums[1] <= IPV4_172_PRIVATE_SECOND_OCTET_MAX
  ) return true
  // 192.168.0.0/16
  if (nums[0] === IPV4_192_PRIVATE_FIRST_OCTET && nums[1] === IPV4_192_PRIVATE_SECOND_OCTET) return true

  return false
}

/**
 * 从代理 URL 中提取 hostname。
 */
function extractHostname(proxyUrl: string): string | undefined {
  try {
    return new URL(proxyUrl).hostname
  } catch {
    return undefined
  }
}

/**
 * 判定错误是否为「代理不可达（本地网络权限）」场景。
 *
 * 条件（D2）：
 *   process.platform === 'darwin'
 *   && err.cause.code === 'EHOSTUNREACH'
 *   && isPrivateHost(proxyUrl.hostname)
 *
 * 不满足条件返回 false（由调用方 fallback 到通用网络错误分类）。
 */
export function classifyProxyUnreachable(err: unknown, proxyUrl: string | undefined): boolean {
  if (process.platform !== 'darwin') return false
  const code = extractNetErrorCode(err)
  if (code !== 'EHOSTUNREACH') return false
  if (!proxyUrl) return false
  const hostname = extractHostname(proxyUrl)
  if (!hostname) return false
  return isPrivateHost(hostname)
}

/**
 * 根据网络错误和代理信息，确定 UpdateErrorCode 和对应文案。
 *
 * D2 决策：
 * - macOS + EHOSTUNREACH + 私网代理 → UPDATE_PROXY_UNREACHABLE
 * - 其他 EHOSTUNREACH → UPDATE_NETWORK_FAILED（含 EHOSTUNREACH 后缀）
 * - 407/Proxy Authentication → UPDATE_PROXY_ERROR
 * - ECONNREFUSED/ENOTFOUND/ECONNRESET/ETIMEDOUT/ECONNABORTED → UPDATE_NETWORK_FAILED
 * - AbortError/timeout → UPDATE_NETWORK_TIMEOUT
 * - 其他 → UPDATE_NETWORK_FAILED
 *
 * [NOTE] 此处构造的英文 message 从不直接面向用户（toUserFriendly() 的映射表中文
 * 全量覆盖）：它是诊断/落盘通道的原始记录，同时是 toUserFriendly() 错误码后缀
 * (CODE) 的提取源；用户可见文案以 types.ts 的 UPDATE_ERROR_MESSAGES 为准。
 */
export function classifyNetError(
  err: unknown,
  stage: UpdateStage,
  proxyUrl?: string,
): UpdateError {
  const rawCause = extractRawCause(err)
  const code = extractNetErrorCode(err)

  // D2: 代理不可达（macOS 本地网络权限场景）
  if (classifyProxyUnreachable(err, proxyUrl)) {
    return new UpdateError(
      '无法连接代理 (EHOSTUNREACH)',
      stage,
      'UPDATE_PROXY_UNREACHABLE',
      rawCause,
    )
  }

  // [B1] 磁盘错误分类：ENOSPC（磁盘满）原会落进底部兜底分支被报成
  // UPDATE_NETWORK_FAILED，用户看到「网络连接失败，请检查防火墙」被严重误导。
  // 判定与单段路径（download-asset stream catch 的 isDiskError）完全一致：
  // errno 精确匹配优先 + 'disk space' 子串兜底（非英文 OS message 场景），
  // 保证同一磁盘错误在单段/多段路径上报同一分类。
  const diskErrno = getNodeErrnoCode(err)
  if (
    diskErrno === 'ENOSPC' ||
    (err instanceof Error && err.message.toLowerCase().includes('disk space'))
  ) {
    return new UpdateError(
      'insufficient disk space',
      stage,
      'UPDATE_DISK_SPACE',
      rawCause,
    )
  }

  // 超时（AbortError）。message 用语境中性词：本函数被 testProxyConnection 复用，
  // 'download timeout' 在代理测试超时场景语境错位（该场景无下载）——诊断通道原始
  // 记录用通用 timeout，用户可见文案仍由 types.ts UPDATE_ERROR_MESSAGES 按错误码映射。
  if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
    return new UpdateError(
      `timeout (aborted)`,
      stage,
      'UPDATE_NETWORK_TIMEOUT',
      rawCause,
    )
  }

  // 407 / Proxy Authentication
  if (err instanceof Error && /^407\b|[\s(]407\b|Proxy Authentication/i.test(err.message)) {
    return new UpdateError(
      `proxy error: ${err.message}`,
      stage,
      'UPDATE_PROXY_ERROR',
      rawCause,
    )
  }

  // EHOSTUNREACH 但不满足私网代理条件 → 通用网络失败
  if (code === 'EHOSTUNREACH') {
    return new UpdateError(
      `network connection failed (EHOSTUNREACH)`,
      stage,
      'UPDATE_NETWORK_FAILED',
      rawCause,
    )
  }

  // 常见网络错误码
  const NETWORK_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED']
  if (code && NETWORK_CODES.includes(code)) {
    return new UpdateError(
      `network connection failed: ${code}`,
      stage,
      'UPDATE_NETWORK_FAILED',
      rawCause,
    )
  }

  // 兜底
  return new UpdateError(
    `download failed: ${err instanceof Error ? err.message : String(err)}`,
    stage,
    'UPDATE_NETWORK_FAILED',
    rawCause,
  )
}
