/**
 * taiji 远程配置 — 通用拉取器（GitHub main 固定 raw 地址热更新基建）。
 *
 * 配置源：仓库 `configs/remote/<domain>.json`（PUBLIC 仓，raw 匿名可拉，跟随 main 最新，
 * raw CDN 缓存约 5 分钟）。fail-safe 链：远程失败/guard 拒绝 → 上次落盘缓存 → 无缓存
 * 返回 undefined（域消费方按「无远程覆盖」运行——quota 域另有编译期基线兜底）。
 *
 * 架构对齐 provider-catalog-refresh.ts（同一「远程目录 overlay」家族）：mtime 内存缓存
 * 失效检测、ETag 协商（304 仅顺延 checkedAt）、checkedAt 节流窗、tmp+rename 原子落盘、
 * 全程 log 不抛错。差异：本模块的数据经域 guard 整体校验后才可落盘（guard 拒绝 = 整体
 * 拒用，不部分采纳——坏配置的最坏后果是停留在上次可用数据）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getDataDir } from '@taiji/shared/paths'
import { logger } from '../../infra/logger.js'

export const REMOTE_CONFIG_BASE_URL =
  'https://raw.githubusercontent.com/zhushanwen321/tai-ji/main/configs/remote'

/** 新鲜度窗口 4h = 14_400_000ms（窗口内直接用缓存，不发网络请求；对齐 pi remote-catalog 的 4h 节奏）。 */
const REFRESH_INTERVAL_MS = 14_400_000
const REQUEST_TIMEOUT_MS = 8000
const CACHE_VERSION = 1
/** JSON 落盘缩进（全仓 JSON_INDENT = 2 约定）。 */
const JSON_INDENT = 2
const HTTP_NOT_MODIFIED = 304

/** 当前已接入的配置域（quota-fetchers = quota presets + fetcher 声明式配置，域 2；
 * v2-plugins = 可安装插件清单，provider-plugin-access U5 域 3，guard 归 plugin-catalog.ts；
 * retry-rules = 重试规则远程覆盖层，域 4，subagent-observability §3.3.12）。 */
export type RemoteConfigDomain = 'builtin-providers' | 'quota-fetchers' | 'v2-plugins' | 'retry-rules'

/** 落盘缓存 envelope（元数据与域数据分离；内容比较只比 data）。 */
interface RemoteCacheEnvelope { // oe-exempt:20261019:framework:taiji 远程配置域内形状/依赖注入面——接口先立单实现常态（本仓架构偏好），W3 quota-fetchers 域将复用同族形状
  version: number
  /** 最近一次完成检查（含 304）的时刻（ms）。节流窗的承载字段。 */
  checkedAt: number
  etag?: string
  /** guard 校验通过后的域数据（未校验的原始响应永不落盘）。 */
  data: unknown
}

/** 域拉取结果：data = 本次可用数据（缓存优先语义）；refreshed = 本次发生了网络刷新且
 * 内容有变化（消费方据此触发合并写盘等下游动作）；reason = 未刷新原因（排障可见）。
 * 「无缓存且拉不到」不设独立 reason——「无数据」由 data===undefined 表达，reason
 * 恒取真实未刷新原因（network / invalid / throttled）。 */
export interface RemoteRefreshOutcome<T> { // oe-exempt:20261019:framework:taiji 远程配置域内形状/依赖注入面——接口先立单实现常态（本仓架构偏好），W3 quota-fetchers 域将复用同族形状
  data: T | undefined
  refreshed: boolean
  reason?: 'throttled' | 'network' | 'invalid'
}

function remoteCachePath(domain: RemoteConfigDomain): string {
  return join(getDataDir(), 'remote-config', `${domain}.json`)
}

/** 落盘缓存解析：文件缺失 → null；JSON/结构损坏 → null + warn（fail-safe 回退）。 */
function parseCacheFile(domain: RemoteConfigDomain): RemoteCacheEnvelope | null {
  const path = remoteCachePath(domain)
  try {
    if (!existsSync(path)) return null
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    const env = parsed as RemoteCacheEnvelope
    if (typeof env.checkedAt !== 'number' || !('data' in env)) throw new Error('missing fields')
    return env
  } catch (e) {
    logger.warn('[remote-config] cache file unreadable, treating as absent', {
      path,
      error: e instanceof Error ? e.message : String(e),
    })
    return null
  }
}

/** mtime（ms），不存在返回 -1。内存缓存失效检测用（外部无写方，理论恒命中——保留对齐
 * 家族模式，成本一次 statSync）。 */
function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return -1
  }
}

// @data-owner #68（data-source-registry.md）：remote-config 落盘缓存的读侧内存快照（mtime
// 失效检测），持久权威是磁盘 envelope 文件——persistCache 落盘后同步刷新本快照，非第二写方。
const cacheSnapshots = new Map<string, { mtime: number; envelope: RemoteCacheEnvelope | null }>()

/** 读域缓存（内存快照 + mtime 失效检测）。 */
function loadCache(domain: RemoteConfigDomain): RemoteCacheEnvelope | null {
  const path = remoteCachePath(domain)
  const mtime = mtimeOf(path)
  const snap = cacheSnapshots.get(domain)
  if (snap && snap.mtime === mtime) return snap.envelope
  const envelope = parseCacheFile(domain)
  cacheSnapshots.set(domain, { mtime, envelope })
  return envelope
}

/** 写域缓存（tmp + rename 原子替换；目录不存在则创建）+ 失效内存快照。 */
async function persistCache(domain: RemoteConfigDomain, envelope: RemoteCacheEnvelope): Promise<void> {
  const path = remoteCachePath(domain)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(envelope, null, JSON_INDENT), 'utf-8')
  await rename(tmp, path)
  cacheSnapshots.set(domain, { mtime: mtimeOf(path), envelope })
}

/** 缓存数据过 guard 后返回（guard 拒绝 = 无数据，不部分采纳）。 */
function guardedCacheData<T>(cached: RemoteCacheEnvelope | null, guard: (v: unknown) => v is T): T | undefined {
  return cached && guard(cached.data) ? cached.data : undefined
}

/** 网络请求段：失败/超时归 network（返回 null，调用方回退缓存）。 */
async function fetchRemote(domain: RemoteConfigDomain, cached: RemoteCacheEnvelope | null): Promise<globalThis.Response | null> {
  try {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (cached?.etag) headers['if-none-match'] = cached.etag
    return await fetch(`${REMOTE_CONFIG_BASE_URL}/${domain}.json`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    logger.warn('[remote-config] fetch failed, falling back to cache', {
      domain,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** 200 响应应用段：JSON 解析 + guard 整体校验 + 变更检测 + 落盘（落盘失败不阻断返回）。 */
async function applyRemotePayload<T>(
  domain: RemoteConfigDomain,
  guard: (v: unknown) => v is T,
  cached: RemoteCacheEnvelope | null,
  res: globalThis.Response,
): Promise<RemoteRefreshOutcome<T>> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    logger.warn('[remote-config] response body is not JSON, falling back to cache', { domain })
    return { data: guardedCacheData(cached, guard), refreshed: false, reason: 'invalid' }
  }
  if (!guard(body)) {
    logger.warn('[remote-config] remote payload rejected by domain guard, falling back to cache', { domain })
    return { data: guardedCacheData(cached, guard), refreshed: false, reason: 'invalid' }
  }

  const changed = !cached || JSON.stringify(cached.data) !== JSON.stringify(body)
  const etag = res.headers.get('etag') ?? undefined
  try {
    await persistCache(domain, { version: CACHE_VERSION, checkedAt: Date.now(), etag, data: body })
  } catch (e) {
    // 落盘失败不阻断本次返回（内存数据已可用），下次触发点重刷
    logger.warn('[remote-config] persist cache failed', {
      domain,
      error: e instanceof Error ? e.message : String(e),
    })
  }
  return { data: body, refreshed: changed, reason: changed ? undefined : 'throttled' }
}

/**
 * 拉取域配置并返回可用数据（含节流/ETag/fail-safe 全语义）。
 *
 * - 节流：缓存 checkedAt 在窗口内 → 直接返回缓存数据（reason: throttled）。
 * - 304：仅顺延 checkedAt（节流窗承载点），返回缓存数据。
 * - 200 + guard 通过：内容与缓存一致 → 只顺延元数据；有变化 → 落盘并返回新数据
 *   （refreshed: true，下游触发合并写盘）。
 * - 200 + guard 拒绝：整体拒用（不部分采纳），warn + 返回旧缓存数据。
 * - 网络失败/超时：warn + 返回旧缓存数据。
 * - 全链无数据（无缓存且拉不到）：data undefined，reason 取真实未刷新原因（network / invalid）。
 */
export async function refreshRemoteConfig<T>(
  domain: RemoteConfigDomain,
  guard: (v: unknown) => v is T,
  options?: { force?: boolean },
): Promise<RemoteRefreshOutcome<T>> {
  const cached = loadCache(domain)
  if (!options?.force && cached && Date.now() - cached.checkedAt < REFRESH_INTERVAL_MS) {
    return { data: guardedCacheData(cached, guard), refreshed: false, reason: 'throttled' }
  }

  const res = await fetchRemote(domain, cached)
  if (!res) return { data: guardedCacheData(cached, guard), refreshed: false, reason: 'network' }

  if (res.status === HTTP_NOT_MODIFIED && cached) {
    // 落盘失败不阻断本次返回（缓存数据已可用），下次触发点重刷；留痕与 200 路径同构
    await persistCache(domain, { ...cached, checkedAt: Date.now() }).catch((e) => {
      logger.warn('[remote-config] persist cache failed', {
        domain,
        error: e instanceof Error ? e.message : String(e),
      })
    })
    return { data: guardedCacheData(cached, guard), refreshed: false, reason: 'throttled' }
  }
  if (!res.ok) {
    void res.body?.cancel()
    logger.warn('[remote-config] non-ok response, falling back to cache', { domain, status: res.status })
    return { data: guardedCacheData(cached, guard), refreshed: false, reason: 'network' }
  }

  return applyRemotePayload(domain, guard, cached, res)
}

/** 读域数据（纯缓存，不发网络；域消费方的同步读侧入口）。 */
export function loadRemoteConfig<T>(domain: RemoteConfigDomain, guard: (v: unknown) => v is T): T | undefined {
  const cached = loadCache(domain)
  return cached && guard(cached.data) ? cached.data : undefined
}
