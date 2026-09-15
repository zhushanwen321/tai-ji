/**
 * 远程模型目录 overlay（settings-provider 页进入时按需刷新）。
 *
 * 背景：展示层模型列表来自编译期快照 builtin-providers.json，恒反映打包时刻的
 * pi-ai 内置 catalog，上游新模型（如 glm-5.3）不会出现。pi 官方机制是「内置 catalog
 * baseline + pi.dev 远程目录 overlay」两层（remote-catalog-provider.js），且执行侧
 * pi binary 在 --mode rpc 启动时已自动刷新并经 PI_CODING_AGENT_DIR 落盘到
 * <getPiAgentDir()>/models-store.json。本模块补齐展示侧：
 *
 * - 读：自刷缓存（<getDataDir()>/provider-catalog-overlay.json）⊕ pi 已刷的
 *   models-store.json，按 lastModified 新者胜（同源语义，零网络）。
 * - 刷：进入 Settings Provider 页时由 renderer 触发 config.refreshProviderCatalogs，
 *   对列表内 catalog provider 向 pi.dev 发 ETag 协商请求（304 仅更新 checkedAt，
 *   404/501 视为远程声明无此 provider，永久失效其 overlay）。
 * - 合并语义对齐 pi mergeModels：baseline 在前，overlay 同 id 覆盖、新 id 追加；
 *   lastModified <= 快照 catalogGeneratedAt 的条目忽略（内置数据已更新，保护基准
 *   必须用数据构建时刻而非提取时刻——见 gen-builtin-providers.mjs catalogGeneratedAt）。
 *
 * 铁律：只读 <getPiAgentDir()>（taiji 数据目录内的 pi 隔离区），禁止触碰
 * 用户全局 ~/.pi/agent/。全部 IO fail-safe：文件缺失/损坏/网络失败一律回退快照，
 * 不抛错拖垮 Settings。零新依赖（Node 24 全局 fetch），无 tsup noExternal 改动。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getDataDir, getPiAgentDir } from '@taiji/shared/paths'
import builtinData from '../generated/builtin-providers.json'
import { logger } from '../infra/logger.js'

const CATALOG_BASE_URL = 'https://pi.dev'
const REQUEST_TIMEOUT_MS = 4000
const CACHE_VERSION = 1
/** JSON 落盘缩进（全仓 JSON_INDENT = 2 约定）。 */
const JSON_INDENT = 2
// 远程目录协商的状态码语义（对齐 pi remote-catalog-provider，详见 refreshProviderCatalogs 注释）
const HTTP_NOT_MODIFIED = 304
const HTTP_NOT_FOUND = 404
const HTTP_NOT_IMPLEMENTED = 501

/** overlay 条目模型（pi.dev 返回形状的宽松子集，仅要求 merge/展示所需字段存在）。 */
export type OverlayModel = {
  id: string
  name?: string
  api?: string
  baseUrl?: string
  reasoning?: boolean
  input?: string[]
  cost?: unknown
  compat?: Record<string, unknown> | null
  contextWindow?: number
  maxTokens?: number | null
  thinkingLevelMap?: Record<string, string | null> | null
  [key: string]: unknown
}

type OverlayEntry = {
  models: OverlayModel[]
  checkedAt: number
  lastModified?: number
  etag?: string
}

type OverlayCache = { version: number; entries: Record<string, OverlayEntry> }

/** 自刷缓存路径（taiji 数据目录，与 pi store 分离：写入方只有本模块）。 */
function overlayCachePath(): string {
  return join(getDataDir(), 'provider-catalog-overlay.json')
}

/** pi store 路径（执行侧 pi binary 经 PI_CODING_AGENT_DIR 落盘，本模块只读）。 */
function piModelsStorePath(): string {
  return join(getPiAgentDir(), 'models-store.json')
}

/** 快照 catalog 数据构建时刻（ms）。旧快照无此字段 → 0（不做 staleness 过滤，override 仍最高优先）。 */
export function getCatalogGeneratedAt(): number {
  const v = (builtinData as { catalogGeneratedAt?: number }).catalogGeneratedAt
  return typeof v === 'number' ? v : 0
}

/** 解析单份缓存文件为 entries，任何损坏返回 {}（fail-safe）。 */
function parseCacheFile(path: string): Record<string, OverlayEntry> {
  try {
    if (!existsSync(path)) return {}
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    // 自刷缓存带 version 包装；pi store 是顶层 providerId 分桶——两者取 entries 语义一致
    const entries = (parsed as { entries?: unknown }).entries ?? parsed
    if (typeof entries !== 'object' || entries === null) return {}
    const out: Record<string, OverlayEntry> = {}
    for (const [id, entry] of Object.entries(entries as Record<string, unknown>)) {
      const e = entry as OverlayEntry
      if (Array.isArray(e?.models)) out[id] = { ...e, models: e.models.filter(m => m && typeof m.id === 'string') }
    }
    return out
  } catch {
    return {}
  }
}

/** 文件 mtime（ms），不存在返回 -1。内存缓存失效检测用。 */
function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return -1
  }
}

type OverlaySnapshot = {
  own: { mtime: number; entries: Record<string, OverlayEntry> }
  pi: { mtime: number; entries: Record<string, OverlayEntry> }
}

let overlaySnapshot: OverlaySnapshot | null = null

/**
 * 读两份落盘 overlay（内存缓存 + mtime 失效检测）。
 * 同 provider 两份都有 → lastModified 新者胜（缺 lastModified 视为最旧）。
 */
function loadOverlay(): OverlaySnapshot {
  const ownPath = overlayCachePath()
  const piPath = piModelsStorePath()
  const ownMtime = mtimeOf(ownPath)
  const piMtime = mtimeOf(piPath)
  if (
    overlaySnapshot &&
    overlaySnapshot.own.mtime === ownMtime &&
    overlaySnapshot.pi.mtime === piMtime
  ) {
    return overlaySnapshot
  }
  const next: OverlaySnapshot = {
    own: { mtime: ownMtime, entries: parseCacheFile(ownPath) },
    pi: { mtime: piMtime, entries: parseCacheFile(piPath) },
  }
  overlaySnapshot = next
  return next
}

/** 同 provider 两份 overlay 新者胜（缺 lastModified 视为最旧；单边存在时直接取有值一边）。 */
function newerEntry(a?: OverlayEntry, b?: OverlayEntry): OverlayEntry | undefined {
  if (!a) return b
  if (!b) return a
  return (a.lastModified ?? -1) >= (b.lastModified ?? -1) ? a : b
}

/**
 * overlay 对某 provider 的数据状态（D5 三态语义）。
 *
 * 旧 getCatalogOverlayModels 把四种情况（无条目/文件损坏/staleness 过滤/空 models）
 * 全折叠成 []，导致「从未见过」与「见过但过期」不可区分——后者是远程的明确否定信号
 * （404 = 远程声明无此目录），允许 auto-fix；前者必须 pass-through 不改写用户配置。
 * 三态正是要把这个歧义拆开：
 *
 * - fresh（见过且新鲜）：lastModified 晚于快照 catalogGeneratedAt（或旧格式无
 *   lastModified 字段，不过滤）→ models 参与「快照 ⊕ overlay」合并，参与默认模型
 *   合法性判定，overlay-only 模型合法
 * - expired（见过但过期）：staleness 过滤（lastModified <= catalogGeneratedAt，
 *   含 404/501 落盘的 lastModified:0）→ 该条目按快照裁定，快照没有则视为无效，
 *   允许 auto-fix 修复
 * - never-seen（从未见过）：own 缓存与 pi store 均无该 provider 条目（或文件损坏）
 *   → pass-through：不改写用户 settings，原值直传 pi 由执行侧自行判定
 */
export type CatalogOverlayState =
  | { state: 'fresh'; models: OverlayModel[] }
  | { state: 'expired' }
  | { state: 'never-seen' }

/** 取某 provider 的 overlay 三态（判定依据见 CatalogOverlayState 注释）。 */
export function getCatalogOverlayState(providerId: string): CatalogOverlayState {
  const { own, pi } = loadOverlay()
  const entry = newerEntry(own.entries[providerId], pi.entries[providerId])
  if (!entry || !Array.isArray(entry.models)) return { state: 'never-seen' }
  // staleness 保护：远程条目不比内置 catalog 数据新 → 内置已覆盖，忽略（对齐 pi remoteModels）
  const generatedAt = getCatalogGeneratedAt()
  if (entry.lastModified !== undefined && entry.lastModified <= generatedAt) return { state: 'expired' }
  return { state: 'fresh', models: entry.models }
}

/**
 * 取某 provider 的有效 overlay 模型（已做 staleness 过滤与新者胜合并）。
 * 三态的展平视图（fresh → models；expired/never-seen → []）。需要区分「过期」与
 * 「从未见过」的消费方（合并视图单点 provider-catalog）应改用 getCatalogOverlayState，
 * 展平会丢失 auto-fix / pass-through 的裁决材料。
 */
export function getCatalogOverlayModels(providerId: string): OverlayModel[] {
  const state = getCatalogOverlayState(providerId)
  return state.state === 'fresh' ? state.models : []
}

/** 刷新结果（config.refreshProviderCatalogs reply 载荷）。 */
export type CatalogRefreshResult = {
  refreshed: string[]
  failed: Array<{ providerId: string; reason: string }>
}

/** 写自刷缓存（tmp + rename 原子替换；目录不存在则创建）。 */
async function persistOwnCache(entries: Record<string, OverlayEntry>): Promise<void> {
  const path = overlayCachePath()
  await mkdir(dirname(path), { recursive: true })
  const payload: OverlayCache = { version: CACHE_VERSION, entries }
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(payload, null, JSON_INDENT), 'utf-8')
  await rename(tmp, path)
}

/** 解析远程目录响应体（pi.dev 现用 id-keyed object map；parseCatalog 同款容错：数组 / {models:[...]} / map）。 */
function parseCatalogBody(body: unknown): OverlayModel[] {
  if (Array.isArray(body)) {
    return body as OverlayModel[]
  }
  if (typeof body === 'object' && body !== null) {
    if (Array.isArray((body as { models?: unknown }).models)) {
      return (body as { models: OverlayModel[] }).models
    }
    return Object.values(body) as OverlayModel[]
  }
  return []
}

/** 由 200 响应构造 overlay 条目。last-modified 缺失/非法时置 0（stale）——与 pi
 * 0.84.4 实装（core/remote-catalog-provider.js：`Date.parse(...) ?? ""` →
 * `Number.isNaN(lastModified) ? 0 : lastModified`）逐字对齐：pi 侧 0 视为 stale、
 * 执行期忽略该 entry，若此处用 Date.now() 兜底会把 pi 判 stale 的 entry 标成
 * fresh，重演「展示可用 ≠ 执行可用」漂移。 */
function buildEntryFromResponse(res: globalThis.Response, body: unknown): OverlayEntry {
  const models = parseCatalogBody(body).filter(m => m && typeof m.id === 'string')
  const lastModified = Date.parse(res.headers.get('last-modified') ?? '')
  return {
    models,
    checkedAt: Date.now(),
    lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
    etag: res.headers.get('etag') ?? undefined,
  }
}

/**
 * 对单个 catalog provider 发起远程刷新并写入 entries/refreshed/failed（共享可变状态
 * 由 refreshProviderCatalogs 持有，语义见其注释）。单点失败记入 failed 不抛出。
 */
async function refreshOneProvider(
  providerId: string,
  entries: Record<string, OverlayEntry>,
  refreshed: string[],
  failed: CatalogRefreshResult['failed'],
): Promise<void> {
  try {
    const prev = entries[providerId]
    const url = `${CATALOG_BASE_URL}/api/models/providers/${encodeURIComponent(providerId)}`
    const headers: Record<string, string> = { accept: 'application/json' }
    // 仅当缓存有 body 时才带 validator，避免 304 落在空缓存上得到空 overlay
    if (prev?.etag && prev.models.length > 0) headers['if-none-match'] = prev.etag
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (res.status === HTTP_NOT_MODIFIED && prev) {
      entries[providerId] = { ...prev, checkedAt: Date.now() }
      refreshed.push(providerId)
      return
    }
    if (res.status === HTTP_NOT_FOUND || res.status === HTTP_NOT_IMPLEMENTED) {
      // 远程声明无此 provider 目录：永久失效 overlay（回纯快照），直到远程恢复
      entries[providerId] = { models: [], checkedAt: Date.now(), lastModified: 0 }
      refreshed.push(providerId)
      return
    }
    if (!res.ok) {
      failed.push({ providerId, reason: `HTTP ${res.status}` })
      return
    }
    const body: unknown = await res.json()
    entries[providerId] = buildEntryFromResponse(res, body)
    refreshed.push(providerId)
  } catch (err) {
    failed.push({ providerId, reason: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * 对指定 catalog provider 集合发起远程目录刷新（ETag 协商，单请求 4s 超时）。
 *
 * 状态码语义对齐 pi remote-catalog-provider：200 全量替换 + 记录 etag/lastModified；
 * 304 仅顺延 checkedAt（4h 窗口语义的承载点）；404/501 持久化 lastModified:0
 * （远程声明无此 provider 的目录，永久失效其 overlay 直到远程恢复）。任何单点失败
 * 不影响其他 provider（allSettled），失败方保留原缓存条目。
 */
export async function refreshProviderCatalogs(providerIds: string[]): Promise<CatalogRefreshResult> {
  const { own } = loadOverlay()
  const entries: Record<string, OverlayEntry> = { ...own.entries }
  const refreshed: string[] = []
  const failed: CatalogRefreshResult['failed'] = []

  await Promise.allSettled(
    providerIds.map(providerId => refreshOneProvider(providerId, entries, refreshed, failed)),
  )

  if (refreshed.length > 0) {
    try {
      await persistOwnCache(entries)
    } catch (e) {
      // 落盘失败不阻断 reply：本次内存外无持久化，下次进入页面重刷
      logger.warn('[provider-catalog-refresh] persist overlay cache failed', {
        error: e instanceof Error ? e.message : String(e),
      })
    }
    overlaySnapshot = null // 失效内存缓存，合并展示立即读到新数据
  }
  return { refreshed, failed }
}
