/**
 * LLM 网络代理配置域（runtime 侧：配置 RMW 读写 + 统计读侧聚合 + 测试连接两段探测）。
 *
 * 配置文件 = ${PI_CODING_AGENT_DIR}/config/network-proxy-ext-config.json（与
 * @zhushanwen/pi-network-proxy extension 的 llm-shared getConfigPath('network-proxy')
 * 路径契约对齐）；RMW / 锁协议走共享基建 ext-config-rmw.ts（与 smart-context / rename
 * 同款跨进程形态，写入 mode 0o600——凭据与 pi auth.json 同安全模型，设计
 * llm-network-proxy §3.3 决策 3）。
 *
 * 统计文件 = ${PI_CODING_AGENT_DIR}/network-proxy-stats.jsonl（extension 按 turn flush
 * 增量行 + runtime 追加重置水位行；两侧追加/截断共用 <stats>.lock 文件锁）。读侧聚合：
 * 逆序分块冷读（utils/history-reverse-read.ts 仓内惯例）+ 时间范围提前终止 + 只累计最后
 * 一个 reset 水位之后的行 + 坏行跳过记 warn；文件超 5MB 触发保尾 1MB 截断（runtime 是
 * 唯一截断执行主体，extension 写侧纯追加——设计 §3.1 卡 3 / §3.3 决策 4）。
 *
 * 测试连接两段探测（设计 §3.1 卡 1）：第一段 TCP 连代理地址（可达性 + 往返耗时，三协议
 * 同构）；规则非空时第二段经代理探规则首条主机名 443——http/https 代理 = CONNECT 隧道
 * 探测，socks5 = RFC 1928 握手（凭据非空含 RFC 1929 用户名密码认证）+ 连接请求。net 模块
 * 手写，零新依赖。归因文案区分「代理不可达」与「代理可达但经代理出站失败」两种失败段，
 * 各附恢复指引。
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import net from 'node:net'
import {
  DEFAULT_NETWORK_PROXY_CONFIG,
  NETWORK_PROXY_PROTOCOLS,
  normalizeHostname,
  validateNetworkProxyConfig,
  type NetworkProxyConfig,
  type NetworkProxyProtocol,
  type NetworkProxyServer,
  type NetworkProxyStats,
  type NetworkProxyStatsRange,
  type NetworkProxyTestResult,
  type NetworkProxyValidationResult,
} from '@taiji/shared'
import { getPiAgentDir } from '../infra/pi/pi-paths.js'
import { rmwExtConfigField } from './ext-config-rmw.js'
import { withFileLockSync } from '../utils/file-lock.js'
import { atomicWrite } from '../utils/fs-utils.js'
import { forEachReversedLineChunk } from '../utils/history-reverse-read.js'

// ──────────────────────── 常量 ────────────────────────

/** 配置文件相对路径（与 extension 侧 llm-shared getConfigPath('network-proxy') 契约一致）。 */
const NETWORK_PROXY_CONFIG_REL = join('config', 'network-proxy-ext-config.json')

/** 统计文件相对路径（<piAgentDir> 根，与 extension flush 落点同源——设计 §3.3 决策 4）。 */
const NETWORK_PROXY_STATS_REL = 'network-proxy-stats.jsonl'

/** 配置文件落盘权限（含代理凭据，对齐 pi auth.json 的文件级安全模型；§3.3 决策 3）。 */
const NETWORK_PROXY_CONFIG_FILE_MODE = 0o600

/* eslint-disable no-magic-numbers -- 以下常量为设计标定文本值（设计 §3.1 卡 3 定量截断
 * 阈值/保留量、统计档位时长），命名即语义，字面值不抽象 */
/** 截断触发阈值：stats 文件超过 5MB 在读聚合入口触发保尾截断（设计 §3.1 卡 3 定量）。 */
const STATS_TRUNCATE_THRESHOLD_BYTES = 5 * 1024 * 1024

/** 截断保留量：保尾最近 1MB（行边界对齐；每行约 100B ≈ 最近约一万条增量记录）。 */
const STATS_TAIL_KEEP_BYTES = 1024 * 1024

/** 24h 统计档的毫秒数（读侧时间过滤窗口）。 */
const STATS_RANGE_24H_MS = 24 * 60 * 60 * 1000

/** 7d 统计档的毫秒数（读侧时间过滤窗口）。 */
const STATS_RANGE_7D_MS = 7 * STATS_RANGE_24H_MS
/* eslint-enable no-magic-numbers */

/** 测试连接单段探测超时（控制面单请求秒级量级，AGENTS.md 超时粒度纪律；测试可注入小值）。 */
const PROBE_TIMEOUT_MS = 5_000

// ──────────────────────── 路径 ────────────────────────

/** 网络代理配置文件完整路径（${PI_CODING_AGENT_DIR}/config/network-proxy-ext-config.json）。 */
function getNetworkProxyConfigPath(): string {
  return join(getPiAgentDir(), NETWORK_PROXY_CONFIG_REL)
}

/** 网络代理统计文件完整路径（${PI_CODING_AGENT_DIR}/network-proxy-stats.jsonl）。 */
function getNetworkProxyStatsPath(): string {
  return join(getPiAgentDir(), NETWORK_PROXY_STATS_REL)
}

// ──────────────────────── 配置读写 ────────────────────────

/**
 * 落盘默认基底工厂（文件缺失/损坏时用，与 shared DEFAULT_NETWORK_PROXY_CONFIG 一致）。
 * 工厂形态保证每次全新对象/数组，各 RMW 写点不共享嵌套引用（smart-context 同款纪律）。
 */
function networkProxyDefaultBase(): Record<string, unknown> {
  return {
    enabled: DEFAULT_NETWORK_PROXY_CONFIG.enabled,
    proxy: { ...DEFAULT_NETWORK_PROXY_CONFIG.proxy },
    noProxy: [...DEFAULT_NETWORK_PROXY_CONFIG.noProxy],
    rules: [...DEFAULT_NETWORK_PROXY_CONFIG.rules],
    ipv4Only: [...DEFAULT_NETWORK_PROXY_CONFIG.ipv4Only],
  }
}

/** 代理服务器字段归一（读侧防御：字段非法回默认值，与 validate 的写侧校验分离）。 */
function normalizeProxyServer(raw: unknown): NetworkProxyServer {
  const fallback = DEFAULT_NETWORK_PROXY_CONFIG.proxy
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...fallback }
  const r = raw as Record<string, unknown>
  const protocol = typeof r['protocol'] === 'string' && NETWORK_PROXY_PROTOCOLS.includes(r['protocol'] as NetworkProxyProtocol)
    ? (r['protocol'] as NetworkProxyProtocol)
    : fallback.protocol
  const host = typeof r['host'] === 'string' && r['host'].trim() !== '' ? r['host'] : fallback.host
  const port = isLegalPort(r['port']) ? (r['port'] as number) : fallback.port
  const username = typeof r['username'] === 'string' ? r['username'] : ''
  const password = typeof r['password'] === 'string' ? r['password'] : ''
  // 凭据成对归一：单边（校验错误形态，手改文件可能出现）双清——成对才有效
  const paired = (username !== '') === (password !== '')
  return { protocol, host, port, username: paired ? username : '', password: paired ? password : '' }
}

/** 端口白名单判定（与 shared validateNetworkProxyConfig 同一合法域：1-65535 整数）。 */
function isLegalPort(raw: unknown): boolean {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 65535 // eslint-disable-line no-magic-numbers -- TCP 端口合法域上界（与 shared validateNetworkProxyConfig 同一白名单语义）
}

/** 主机名条目列表归一（读侧防御：过滤非字符串与空白条目；条目原样保留，匹配函数自行归一化）。 */
function normalizeHostList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
}

/**
 * 主机名条目写侧去重（设计 §3.1 文件不变量「同一主机名只存在一条规则」在保存侧的执行点）：
 * 归一化后同键保留首条（大小写/末尾点变体算同一条，与匹配语义同一归一化函数）。匹配幂等
 * 所以重复无行为差异，但文件形态按不变量收敛。
 */
function dedupeHostList(entries: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of entries) {
    const key = normalizeHostname(entry)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

/**
 * 读取网络代理配置。文件不存在/坏 JSON/字段非法 → 对应字段回默认值（与 extension 读取侧
 * 回退语义一致）。不抛错（防御性读侧，getSmartContextConfig 同款）。
 */
export function getNetworkProxyConfig(): NetworkProxyConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getNetworkProxyConfigPath(), 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return networkProxyDefaultBase() as unknown as NetworkProxyConfig
    }
    const r = parsed as Record<string, unknown>
    return {
      enabled: typeof r['enabled'] === 'boolean' ? r['enabled'] : DEFAULT_NETWORK_PROXY_CONFIG.enabled,
      proxy: normalizeProxyServer(r['proxy']),
      noProxy: normalizeHostList(r['noProxy']),
      rules: normalizeHostList(r['rules']),
      // 后加字段：旧配置文件无此键（undefined 非数组）→ normalizeHostList 回空数组
      ipv4Only: normalizeHostList(r['ipv4Only']),
    }
  } catch {
    return networkProxyDefaultBase() as unknown as NetworkProxyConfig
  }
}

/**
 * 写入网络代理配置（整份配置的 RMW：只覆盖 enabled/proxy/noProxy/rules/ipv4Only 五字段，
 * 保留文件内其他字段——extension 侧未来扩展字段不丢）。校验失败返回错误清单不落盘（错误信封
 * 由 handler 转发）；成功经 rmwExtConfigField 持跨进程锁写入，mode 0o600，序列化与
 * extension llm-shared saveConfig 逐字一致（2 空格缩进 + 尾换行）。
 */
export function setNetworkProxyConfig(next: NetworkProxyConfig): NetworkProxyValidationResult {
  const result = validateNetworkProxyConfig(next)
  if (!result.ok) return result
  rmwExtConfigField(getNetworkProxyConfigPath(), {}, networkProxyDefaultBase, (base) => {
    base['enabled'] = next.enabled
    base['proxy'] = next.proxy
    base['noProxy'] = dedupeHostList(next.noProxy)
    base['rules'] = dedupeHostList(next.rules)
    // ipv4Only：直连 + 强制 IPv4 清单（后加字段；缺省空数组写回，保证配置文件形态稳定）
    base['ipv4Only'] = dedupeHostList(next.ipv4Only ?? [])
  }, NETWORK_PROXY_CONFIG_FILE_MODE)
  return { ok: true }
}

// ──────────────────────── 统计读侧 ────────────────────────

/** stats 文件数据行（extension flush 增量片段，设计 §3.1 行为序列 4）。 */
interface StatsDataLine { // oe-exempt:20261019:framework:stats JSONL 行判别联合的成员形状（文件协议契约，单实现为常态）

  kind: 'data'
  ts: number
  host: string
  proxied: number
  direct: number
}

/** stats 文件重置水位行（runtime resetNetworkProxyStats 追加）。 */
interface StatsResetLine { // oe-exempt:20261019:framework:stats JSONL 行判别联合的成员形状（文件协议契约，单实现为常态）

  kind: 'reset'
}

type ParsedStatsLine = StatsDataLine | StatsResetLine

/** 数据行字段白名单判定（parseStatsLine 的子步骤）：ts/host 有限值 + 计数字段非负有限数。 */
function parseStatsDataLine(r: Record<string, unknown>): StatsDataLine | null {
  const ts = r['ts']
  const host = r['host']
  const proxied = r['proxied']
  const direct = r['direct']
  if (
    typeof ts !== 'number' || !Number.isFinite(ts) ||
    typeof host !== 'string' || host === '' ||
    typeof proxied !== 'number' || !Number.isFinite(proxied) || proxied < 0 ||
    typeof direct !== 'number' || !Number.isFinite(direct) || direct < 0
  ) {
    return null
  }
  return { kind: 'data', ts, host, proxied, direct }
}

/**
 * 解析单个 stats 行。数据行 = { ts, host, proxied, direct }；重置水位行 = { type:'reset', ts }。
 * 解析失败 / 字段形态非法返回 null（坏行，调用方跳过）；空行静默跳过（不 warn）。
 */
function parseStatsLine(line: string): ParsedStatsLine | null {
  if (line.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return badStatsLine(line)
    const r = parsed as Record<string, unknown>
    if (r['type'] === 'reset') return { kind: 'reset' }
    return parseStatsDataLine(r) ?? badStatsLine(line)
  } catch {
    return badStatsLine(line)
  }
}

/** 坏行 warn（含截断预览防日志注入；返回 null 供 parseStatsLine 尾部统一返回）。 */
function badStatsLine(line: string): null {
  console.warn(`[network-proxy-config] stats 文件存在无法解析的行，已跳过：${JSON.stringify(line.slice(0, 80))}`) // eslint-disable-line no-magic-numbers -- 80 字符日志预览截断（防日志注入的显示上限，非业务常量）
  return null
}

/**
 * stats 文件超 5MB 时的保尾截断（读聚合入口调用）：持 <stats>.lock 跨进程锁，锁内重检
 * （防检查-执行间隙对端追加），读尾部 1MB、对齐行边界（丢弃首个 \n 前的半行段，不截半行），
 * atomicWrite 原子重写。extension 写侧纯追加、截断主体只有 runtime——锁互斥保证截断不丢
 * 在途增量（设计 §3.1 卡 3）。
 *
 * @returns 是否执行了截断（供「累计」档 truncatedNote 判定）。
 */
function truncateStatsIfOversized(statsPath: string): boolean {
  let size: number
  try {
    size = statSync(statsPath).size
  } catch {
    return false // 文件不存在：无可截断
  }
  if (size <= STATS_TRUNCATE_THRESHOLD_BYTES) return false
  let truncated = false
  withFileLockSync(statsPath, () => {
    let fd: number
    try {
      fd = openSync(statsPath, 'r')
    } catch {
      return // 锁内文件已消失（对端截断/删除）：放弃本次截断
    }
    try {
      // 锁内重检 size（防外层 stat 后对端已追加/截断）
      const stat = statSync(statsPath)
      if (stat.size <= STATS_TRUNCATE_THRESHOLD_BYTES) return
      const keepLen = Math.min(stat.size, STATS_TAIL_KEEP_BYTES)
      const buf = Buffer.alloc(keepLen)
      const readStart = stat.size - keepLen
      const bytesRead = readSync(fd, buf, 0, keepLen, readStart)
      let text = buf.subarray(0, bytesRead).toString('utf-8')
      // 行边界对齐：保留段起点（readStart > 0 恒真——触发前提 size > 5MB > 1MB）切在
      // 某行中间，丢弃首个 \n（含）前的半行段。整段无换行（单行超 1MB 的损坏形态）时
      // 丢弃全部（宁可多丢一行也不保留残行，readTailBytes INVAR-tail-3 同款取舍）。
      const nl = text.indexOf('\n')
      if (nl >= 0) text = text.slice(nl + 1)
      else text = ''
      if (stat.size > 0 && !text.endsWith('\n') && text !== '') text = `${text}\n`
      mkdirSync(dirname(statsPath), { recursive: true })
      atomicWrite(statsPath, text, `truncate_${process.pid}`)
      truncated = true
    } finally {
      closeSync(fd)
    }
  }, {})
  return truncated
}

/**
 * 读取并聚合网络代理请求统计（设计 §3.1 卡 3）：
 * - 入口检测超阈值执行保尾截断（truncated=true 时「累计」档返回 truncatedNote 标注）；
 * - 逆序分块冷读（forEachReversedLineChunk，仓内既有冷读惯例）：24h / 7d 档按行内 ts
 *   过滤并越界提前终止，all 档全文件（截断保尾窗口为扫描量上界）；
 * - 只累计最后一个 reset 水位之后的行（逆序扫描遇到首个 reset 行即终止——水位前的旧行
 *   仅被聚合忽略）；
 * - 坏行跳过记 warn，不因损坏行失败；
 * - 按主机名聚合（host 字母序，确定性输出）。
 */
export function getNetworkProxyStats(range: NetworkProxyStatsRange): { stats: NetworkProxyStats[]; truncatedNote?: string } {
  const statsPath = getNetworkProxyStatsPath()
  const truncated = truncateStatsIfOversized(statsPath)
  const cutoffMs = range === '24h'
    ? Date.now() - STATS_RANGE_24H_MS
    : range === '7d'
      ? Date.now() - STATS_RANGE_7D_MS
      : undefined
  const acc = new Map<string, { proxied: number; direct: number }>()
  forEachReversedLineChunk(statsPath, undefined, (chunk) => {
    // 块内行是文件正序（从旧到新），逆序遍历（从新到旧）让 reset 水位与时间越界的
    // 「遇即终止」语义正确：终止点之后的行（更早）不交付也不应计入。
    for (let i = chunk.lines.length - 1; i >= 0; i--) {
      const entry = parseStatsLine(chunk.lines[i])
      if (entry === null) continue
      if (entry.kind === 'reset') return false
      if (cutoffMs !== undefined && entry.ts < cutoffMs) return false
      const slot = acc.get(entry.host) ?? { proxied: 0, direct: 0 }
      slot.proxied += entry.proxied
      slot.direct += entry.direct
      acc.set(entry.host, slot)
    }
  })
  const stats: NetworkProxyStats[] = [...acc.entries()]
    .map(([host, counts]) => ({ host, proxied: counts.proxied, direct: counts.direct }))
    .sort((a, b) => a.host.localeCompare(b.host))
  if (truncated && range === 'all') {
    return { stats, truncatedNote: '累计统计基于保留的历史窗口（文件超限已截断，仅保留最近记录）' }
  }
  return { stats }
}

/**
 * 追加重置水位行（{ type:'reset', ts }）：持 <stats>.lock 跨进程锁，与 extension flush
 * 同一追加通道（appendFileSync 单行 write，O_APPEND 原子）。读侧只累计最后一个水位之后
 * 的行——多 pi 进程重置后在途内存增量 flush 落在标记之后，正确计入（设计 §3.1 卡 3）。
 */
export function resetNetworkProxyStats(): void {
  const statsPath = getNetworkProxyStatsPath()
  withFileLockSync(statsPath, () => {
    mkdirSync(dirname(statsPath), { recursive: true })
    appendFileSync(statsPath, `${JSON.stringify({ type: 'reset', ts: Date.now() })}\n`)
  }, {})
}

// ──────────────────────── 测试连接（两段探测） ────────────────────────

/** 探测失败（携带面向用户的归因短语；区别于意外异常的直接上抛）。 */
class ProxyProbeError extends Error {}

/** 连接阶段系统错误的中文归因（错误码白名单映射，其余透出 message）。 */
function describeConnectError(err: NodeJS.ErrnoException): string {
  switch (err.code) {
    case 'ECONNREFUSED': return '连接被拒绝'
    case 'ETIMEDOUT': return '连接超时'
    case 'EHOSTUNREACH':
    case 'ENETUNREACH': return '网络不可达'
    case 'ENOTFOUND':
    case 'EAI_AGAIN': return '主机名无法解析'
    case 'EACCES': return '无权限访问该端口'
    default: return err.message
  }
}

/** 第一段：TCP 连接代理服务器地址（三协议同构；resolve 即建连完成，耗时由此段计）。 */
function connectToProxy(server: NetworkProxyServer, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: server.host, port: server.port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new ProxyProbeError('连接超时'))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(new ProxyProbeError(describeConnectError(err)))
    })
  })
}

/**
 * 在已建连 socket 上读满 n 字节（SOCKS5 定长响应用）。超时销毁 socket 并以 ProxyProbeError
 * 拒绝；连接关闭/出错同样拒绝。
 *
 * TCP 粘包保留：同一 data chunk 内超出本次需求的字节存入 per-socket 残余缓冲（WeakMap），
 * 下次 readExactly 优先消费——否则定长多次读（reply 头 4 字节 → 变长 BND.ADDR 段）会把
 * 同 chunk 后续字节吞掉，第二次读永远等不到数据而误超时。
 */
const socketReadBuffers = new WeakMap<net.Socket, Buffer>()

function readExactly(socket: net.Socket, n: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const buf = Buffer.alloc(n)
    // 先同步消费残余缓冲（上次调用留下的同 chunk 字节）——满足需求时无需等待新 data 事件
    let pending = socketReadBuffers.get(socket) ?? Buffer.alloc(0)
    let filled = Math.min(pending.length, n)
    pending.copy(buf, 0, 0, filled)
    pending = pending.subarray(filled)
    if (filled === n) {
      socketReadBuffers.set(socket, pending)
      resolve(buf)
      return
    }
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const timer = setTimeout(() => {
      cleanup()
      socket.destroy()
      reject(new ProxyProbeError('响应超时'))
    }, timeoutMs)
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      const take = Math.min(pending.length, n - filled)
      pending.copy(buf, filled, 0, take)
      pending = pending.subarray(take)
      filled += take
      if (filled === n) {
        socketReadBuffers.set(socket, pending)
        cleanup()
        resolve(buf)
      }
    }
    const onError = (err: Error) => {
      cleanup()
      reject(new ProxyProbeError(err.message))
    }
    const onClose = () => {
      cleanup()
      reject(new ProxyProbeError('连接被代理关闭'))
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

/* eslint-disable no-magic-numbers -- SOCKS5 RFC 1928/1929 协议字面值（版本 0x05、方法码、
 * 回复码、ATYP、端口 443 大端 0x01bb），命名抽象反而掩盖位语义（history-reverse-read 先例同款豁免） */

/** SOCKS5 回复码（RFC 1928 §6）到归因短语的映射（其余码透出编号）。 */
function describeSocks5Reply(rep: number): string {
  switch (rep) {
    case 1: return '代理通用失败'
    case 2: return '代理不允许该连接'
    case 3: return '代理侧网络不可达'
    case 4: return '代理侧主机不可达'
    case 5: return '代理侧连接被拒绝'
    default: return `代理返回错误码 ${rep}`
  }
}

/**
 * 流写防护（relay-registry writeFrame 同款）：半关闭/destroyed 流上 write 同步抛
 * EPIPE/ERR_STREAM_DESTROYED，事件回调中逃逸即 uncaughtException——转探测失败信封。
 */
function writeProbe(socket: net.Socket, payload: string | Buffer): void {
  try {
    socket.write(payload)
  } catch (err) {
    throw new ProxyProbeError(err instanceof Error ? err.message : String(err))
  }
}

/**
 * http/https 代理第二段：在已建连 socket 上发 CONNECT 隧道请求（凭据非空带
 * Proxy-Authorization Basic 头），读到响应头判定 2xx 为通。
 */
async function httpConnectProbe(socket: net.Socket, server: NetworkProxyServer, targetHost: string, timeoutMs: number): Promise<void> {
  const hasAuth = server.username !== '' && server.password !== ''
  const authLine = hasAuth
    ? `Proxy-Authorization: Basic ${Buffer.from(`${server.username}:${server.password}`).toString('base64')}\r\n`
    : ''
  writeProbe(socket, `CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n${authLine}\r\n`)
  const statusLine = await new Promise<string>((resolve, reject) => {
    let head = ''
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const timer = setTimeout(() => {
      cleanup()
      socket.destroy()
      reject(new ProxyProbeError('响应超时'))
    }, timeoutMs)
    const onData = (chunk: Buffer) => {
      head += chunk.toString('utf-8')
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) return
      cleanup()
      resolve(head.slice(0, end).split('\r\n')[0] ?? '')
    }
    const onError = (err: Error) => {
      cleanup()
      reject(new ProxyProbeError(err.message))
    }
    const onClose = () => {
      cleanup()
      reject(new ProxyProbeError('连接被代理关闭'))
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
  const statusCode = Number.parseInt(statusLine.split(' ')[1] ?? '', 10)
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) {
    throw new ProxyProbeError(statusLine === '' ? '代理返回空响应' : `代理拒绝隧道请求（${statusLine.slice(0, 60)}）`)
  }
}

/**
 * socks5 代理第二段：RFC 1928 握手（凭据非空时只提议 RFC 1929 用户名密码方法——严格
 * 验证配置的凭据可用）+ 连接请求（ATYP=domain，目标 = 规则首条主机名 443）。
 */
async function socks5Probe(socket: net.Socket, server: NetworkProxyServer, targetHost: string, timeoutMs: number): Promise<void> {
  const hasAuth = server.username !== '' && server.password !== ''
  // 方法协商：greeting 版本 5；凭据非空只提议 0x02（用户名密码），否则 0x00（无认证）
  writeProbe(socket, hasAuth ? Buffer.from([0x05, 0x01, 0x02]) : Buffer.from([0x05, 0x01, 0x00]))
  const methodReply = await readExactly(socket, 2, timeoutMs)
  if (methodReply[0] !== 0x05) throw new ProxyProbeError('代理响应不是 SOCKS5 协议')
  if (methodReply[1] === 0xff) {
    throw new ProxyProbeError(hasAuth ? '代理不接受用户名密码认证' : '代理要求认证但未配置凭据')
  }
  if (methodReply[1] === 0x02) {
    // RFC 1929 用户名密码子协商：ver=1 + ulen + user + plen + pass；status 0 = 成功
    const user = Buffer.from(server.username, 'utf-8')
    const pass = Buffer.from(server.password, 'utf-8')
    writeProbe(socket, Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
    const authReply = await readExactly(socket, 2, timeoutMs)
    if (authReply[1] !== 0x00) throw new ProxyProbeError('代理认证失败（用户名或密码错误）')
  } else if (methodReply[1] !== 0x00) {
    throw new ProxyProbeError(`代理选择了不支持的方法 ${methodReply[1]}`)
  }
  // 连接请求：CMD=CONNECT(1)，ATYP=domain(3)，端口 443 大端两字节
  const host = Buffer.from(targetHost, 'utf-8')
  writeProbe(socket, Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
    host,
    Buffer.from([0x01, 0xbb]),
  ]))
  const reply = await readExactly(socket, 4, timeoutMs)
  if (reply[0] !== 0x05) throw new ProxyProbeError('代理连接响应不是 SOCKS5 协议')
  if (reply[1] !== 0x00) throw new ProxyProbeError(describeSocks5Reply(reply[1]))
  // 消费剩余变长绑定地址段（BND.ADDR + BND.PORT）后即成功；类型决定地址长度
  const atyp = reply[3]
  const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? (await readExactly(socket, 1, timeoutMs))[0] : 0
  await readExactly(socket, addrLen + 2, timeoutMs)
}
/* eslint-enable no-magic-numbers */

/**
 * 测试连接两段探测（设计 §3.1 卡 1）：
 * 1. 第一段 TCP 连代理地址（可达性 + 往返耗时 elapsedMs 取此段）；
 * 2. 规则非空时第二段经代理探规则首条主机名 443（http/https = CONNECT 隧道；socks5 =
 *    RFC 1928 握手 + 连接请求）。
 *
 * 失败归因两段可区分：proxy 段失败 =「代理不可达」（恢复指引：启动代理或关闭开关）；
 * outbound 段失败 =「代理可达但经代理出站失败」（恢复指引：检查代理出口网络或核对规则）。
 *
 * @param timeoutMs 单段探测超时（控制面秒级缺省；测试注入小值压缩用例时长）。
 */
export async function testNetworkProxyConnection(config: NetworkProxyConfig, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<NetworkProxyTestResult> {
  const server = config.proxy
  const startedAt = Date.now()
  // 第一段：代理本身可达
  let socket: net.Socket
  try {
    socket = await connectToProxy(server, timeoutMs)
  } catch (e) {
    const reason = e instanceof ProxyProbeError ? e.message : describeConnectError(e as NodeJS.ErrnoException)
    return {
      ok: false,
      stage: 'proxy',
      message: `无法连接代理 ${server.host}:${server.port}：${reason}。恢复指引：启动代理软件后重试，或关闭网络代理开关恢复直连`,
      elapsedMs: Date.now() - startedAt,
    }
  }
  const elapsedMs = Date.now() - startedAt
  // 第二段：规则非空时经代理探规则首条主机名 443（规则条目归一化后探测）
  const targetHost = normalizeHostname(config.rules[0] ?? '')
  if (targetHost === '') {
    socket.destroy()
    return {
      ok: true,
      stage: 'done',
      message: `代理可达，往返耗时 ${elapsedMs}ms（未配置代理规则，仅测试代理服务器连通性）`,
      elapsedMs,
    }
  }
  try {
    if (server.protocol === 'socks5') await socks5Probe(socket, server, targetHost, timeoutMs)
    else await httpConnectProbe(socket, server, targetHost, timeoutMs)
    socket.destroy()
    return {
      ok: true,
      stage: 'done',
      message: `连接成功：代理可达，经代理访问 ${targetHost}:443 正常，往返耗时 ${elapsedMs}ms`,
      elapsedMs,
    }
  } catch (e) {
    socket.destroy()
    const reason = e instanceof ProxyProbeError ? e.message : (e as Error).message
    return {
      ok: false,
      stage: 'outbound',
      message: `代理可达，但经代理访问 ${targetHost}:443 失败：${reason}。恢复指引：检查代理出口网络，或核对代理规则配置`,
      elapsedMs,
    }
  }
}
