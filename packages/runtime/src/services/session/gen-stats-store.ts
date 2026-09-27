/**
 * gen-stats-store.ts — Composer 生成指标存储内核（纯函数族，实施计划 u2-store / P2）
 *
 *   - §3.3 D3 存储布局：`<dataDir>/gen-stats/{speed,cache-ratio}/<safe-model>.json`，
 *     文件格式 `{"YYYY-MM-DD": [[v1, v2], ...], ...}`；safeModelFileName = safeBase
 *     （`(provider + '__' + model)` 替换 `[/\\空格:]` → `_`）截断 64 字符 + hash8 后缀
 *     （sha256 前 8 位十六进制，单射性由 hash 保证——纯字符替换对 `a b`/`a_b`、
 *     macOS 大小写不敏感 FS 的 `Glm`/`GLM` 均碰撞）；30 天 GC（写入时顺带清理）；
 *     日 key 本地时区（对蓝本 pi-statusline 的 UTC **有意偏离**：UTC 日边界对中文用户
 *     是本地 08:00，「今日」与直觉相悖）；tmp+rename 原子写。
 *   - §3.3 D6 聚合口径（对齐 pi-statusline）：速度 = 加权平均 Σtokens÷Σduration×1000
 *     （非算术平均）；命中率 = ΣcacheRead÷ΣpromptTotal×100，
 *     promptTotal = input + cacheRead + cacheWrite（不含 output，蓝本同）。
 *   - §3.3 D7 bogus guard 阈值（照抄蓝本 pi-statusline index.ts:61-62，不自行放宽）：
 *     outputTokens > 50 && durationMs < 100ms 的速度样本判定为 bogus（缓存回放型异常）。
 *     本文件只提供阈值常量 + 纯判定谓词（SSOT），丢弃动作在 u3 GenStatsService
 *     recordSample 采样入口执行。
 *   - 缓存命中率归因降噪（2026-09-19）：展示 0% 的样本在**已知成因**（会话首个请求 /
 *     空闲超 provider 缓存 TTL / compaction 后前缀重建）下由服务侧附归因，UI 渲染成因
 *     文案而非裸 0%；分类 SSOT = 本文件 classifyCacheMiss + isDisplayedZeroCacheRatio
 *     + hasReportedCacheFields（纯函数，状态判定在服务侧）。
 *   - §3.3 D8 同步 API：read→append→write 必须在同一同步临界段内完成（runtime 单进程
 *     + 单线程事件循环 + 同步 fs 天然串行化）——本模块全部 fs 操作为同步 API，即为此
 *     前提的结构性保证；将来改 async 必须引入互斥，否则多 session 并发写同一模型文件
 *     竞丢样本。
 *
 * 消费方：gen-stats-service.ts（u3-wiring）。本文件不感知事件流，纯存储 + 聚合。
 *
 * null 编码纪律（§3.3 D4）：聚合无有效样本返回 **null**（禁止 0 充数）——蓝本
 * avgSpeed 空记录返回 0，此处有意偏离；0 只允许作为真实测量值出现（如冷启动全 miss
 * 的 0% 命中率）。聚合值经 Math.round 取整，与蓝本显示口径一致。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getDataDir } from '@taiji/shared/paths'
import type { GenStatsCacheMiss } from '@taiji/shared'
import { logger } from '../../infra/logger.js'
import { atomicWrite } from '../../utils/fs-utils.js'

// ── 类型 ─────────────────────────────────────────────────────────────

/** 速度样本记录：[outputTokens, durationMs]（设计 §3.3 D3 speed 文件条目） */
export type SpeedRecord = [outputTokens: number, durationMs: number]

/** 命中率样本记录：[cacheRead, promptTotal]（设计 §3.3 D3 cache-ratio 文件条目；
 *  promptTotal = input + cacheRead + cacheWrite，不含 output——由调用方组装） */
export type CacheRatioRecord = [cacheRead: number, promptTotal: number]

/** 存储层通用条目（speed / cache-ratio 两类文件同为二元数字组，读写共用） */
export type GenStatsRecord = SpeedRecord | CacheRatioRecord

/** 日记录文件形状：`{"YYYY-MM-DD": [GenStatsRecord, ...], ...}` */
export type GenStatsDayRecords = Record<string, GenStatsRecord[]>

// ── 常量 ─────────────────────────────────────────────────────────────

/** 速度样本 bogus 判定：output 严格大于该值（蓝本 BOGUS_OUTPUT_THRESHOLD = 50） */
export const BOGUS_OUTPUT_THRESHOLD = 50

/** 速度样本 bogus 判定：耗时严格小于该值 ms（蓝本 BOGUS_DURATION_THRESHOLD_MS = 100） */
export const BOGUS_DURATION_THRESHOLD_MS = 100

/** 记录保留天数（设计 §3.3 D3：30 天 GC，写入时顺带清理） */
export const SPEED_RETENTION_DAYS = 30

/** safeBase 截断上限（设计 §3.3 D3：64 字符） */
const SAFE_MODEL_BASE_MAX = 64

/** hash 后缀长度（sha256 hex 前 8 位） */
const MODEL_KEY_HASH_LEN = 8

const MS_PER_SEC = 1000
const PERCENT_SCALE = 100
const MS_PER_DAY = 86_400_000

/** 合法日 key 形状（YYYY-MM-DD；GC 的字典序比较依赖该规范形） */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 日 key 月/日段补零宽度（YYYY-MM-DD 规范形） */
const DATE_PAD_WIDTH = 2

/** 样本记录二元组长度（SpeedRecord / CacheRatioRecord 同形，读写校验共用） */
const RECORD_TUPLE_LENGTH = 2

/**
 * provider 前缀缓存 TTL 参考值（300_000 ms = 5 分钟，对齐 pi cache-stats 的 CACHE_TTL_MS；
 * idle-expiry 归因阈值——空闲超过该值后的首个请求，缓存大概率已被 provider 淘汰，0% 属预期内）。
 * 刻意不改用配置：蓝本同款常量，且阈值只影响归因文案（真值仍由 provider 上报）。
 */
export const CACHE_TTL_MS = 300_000

/** atomicWrite 的 tmp 后缀（utils/fs-utils 同名约定；孤儿清扫匹配用） */
const TMP_SUFFIX = '.tmp'

// ── 样本有效性（D7 bogus guard，阈值 SSOT）───────────────────────────

/**
 * 速度样本 bogus 判定（D7 ①）：巨量 output 在极短耗时内完成 = 缓存回放型异常样本，
 * 应在采样入口丢弃（不得进落盘/聚合，否则一次 bogus 即拉荒谬 day 均值）。
 * 阈值照抄蓝本，边界为严格不等：output=50 或 duration=100ms 均非 bogus。
 */
export function isBogusSpeedSample(outputTokens: number, durationMs: number): boolean {
  return outputTokens > BOGUS_OUTPUT_THRESHOLD && durationMs < BOGUS_DURATION_THRESHOLD_MS
}

// ── 命中率无值 / 归零判定（归因降噪 2026-09-19，SSOT）─────────────────

/**
 * provider 是否上报了 cache 计量字段：两字段（cacheRead / cacheWrite）全缺省 → 无缓存计量。
 * 无缓存能力的 provider（或单次请求未带 cache 字段）恒缺省——命中率样本整体不采（null
 * 编码纪律：无数据 ≠ 0% miss；此前按 0 计入 promptTotal 会把它恒写成 0%）。
 * 任一字段有值即视为有计量（如只上报 cacheRead 的 provider）。
 */
export function hasReportedCacheFields(cacheRead: number | null, cacheWrite: number | null): boolean {
  return cacheRead !== null || cacheWrite !== null
}

/**
 * 展示归零判定（**与 UI 显示口径同源**）：round(cacheRead ÷ promptTotal × 100) === 0。
 * 归因只对「UI 会渲染成 0%」的样本触发——极小命中（如 0.1%，四舍五入后同样是刺眼的 0%）
 * 一并覆盖。promptTotal ≤ 0（无有效分母）返回 false：那不是测量值，是无效样本。
 */
export function isDisplayedZeroCacheRatio(cacheRead: number, promptTotal: number): boolean {
  if (promptTotal <= 0) return false
  return Math.round((cacheRead / promptTotal) * PERCENT_SCALE) === 0
}

/**
 * 展示 0% 的归因分类（纯函数，SSOT；状态（前序请求时刻 / compaction 标记）由调用方提供）。
 *
 * 只覆盖**预期内的 miss**（三值均非故障，UI 以中性色呈现）：
 *  - 无前序请求 → cold-start（会话首个请求 / 新会话）；
 *  - compaction 标记在场 → context-rewrite（优先级高于空闲：前缀被重写是结构性成因，
 *    即使同时空闲超时，本次 miss 也无法靠 TTL 解释口径消化）；
 *  - 空闲严格大于 CACHE_TTL_MS → idle-expiry（携带实际空闲时长）；
 *  - 其余 → undefined（未知成因的真实 miss：如 provider 服务端淘汰——保留裸 0%，不降噪）。
 */
export function classifyCacheMiss(input: {
  /** 本会话此前是否已有请求样本（false = 本样本是本会话首条） */
  hasPreviousRequest: boolean
  /** 距上一次请求的空闲毫秒数（无前序请求时 null） */
  idleMs: number | null
  /** 上一次请求之后是否发生过成功 compaction（前缀整体重写） */
  contextRewritten: boolean
}): GenStatsCacheMiss | undefined {
  if (!input.hasPreviousRequest) return { reason: 'cold-start' }
  if (input.contextRewritten) return { reason: 'context-rewrite' }
  if (input.idleMs !== null && input.idleMs > CACHE_TTL_MS) return { reason: 'idle-expiry', idleMs: input.idleMs }
  return undefined
}

// ── 日 key（本地时区）────────────────────────────────────────────────

/**
 * 本地时区日 key `YYYY-MM-DD`（设计 §3.3 D3：禁止 UTC 切日，与 usage-stats「本机时区」
 * 口径一致；蓝本 toISOString 的 UTC 口径被有意偏离）。
 */
export function localDayKey(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(DATE_PAD_WIDTH, '0')
  const d = String(date.getDate()).padStart(DATE_PAD_WIDTH, '0')
  return `${y}-${m}-${d}`
}

// ── 聚合（D6，蓝本口径 + null 纪律）──────────────────────────────────

/**
 * 加权平均速度（t/s）：ΣoutputTokens ÷ ΣdurationMs × 1000（非算术平均）。
 * 无有效样本（空 / ΣdurationMs ≤ 0）→ null；0 只在真实测量下出现。
 * 前置条件：条目形状已由 readDayRecords / 采样入口校验（本函数不再过滤）。
 */
export function aggregateSpeed(records: readonly SpeedRecord[]): number | null {
  let totalTokens = 0
  let totalDuration = 0
  for (const record of records) {
    totalTokens += record[0]
    totalDuration += record[1]
  }
  if (totalDuration <= 0) return null
  return Math.round((totalTokens / totalDuration) * MS_PER_SEC)
}

/**
 * 加权命中率（%）：ΣcacheRead ÷ ΣpromptTotal × 100（非算术平均）。
 * 无有效样本（空 / ΣpromptTotal ≤ 0，如非 cache 模型全 0）→ null；全 miss 是真实 0。
 */
export function aggregateCacheRatio(records: readonly CacheRatioRecord[]): number | null {
  let totalRead = 0
  let totalPrompt = 0
  for (const record of records) {
    totalRead += record[0]
    totalPrompt += record[1]
  }
  if (totalPrompt <= 0) return null
  return Math.round((totalRead / totalPrompt) * PERCENT_SCALE)
}

// ── GC（30 天，本地时区日 key）───────────────────────────────────────

/**
 * 纯 GC：删除早于 cutoff（now - 30 天的本地日 key）的日键。
 * YYYY-MM-DD 规范形的字典序 = 时间序；cutoff 当天键保留（>= 边界）。
 * 不改入参（返回新对象）。writeDayRecords 写入前自动调用（设计 D3「写入时顺带清理」）。
 */
export function pruneExpiredDays(records: GenStatsDayRecords, now: Date = new Date()): GenStatsDayRecords {
  const cutoff = localDayKey(new Date(now.getTime() - SPEED_RETENTION_DAYS * MS_PER_DAY))
  const pruned: GenStatsDayRecords = {}
  for (const [key, value] of Object.entries(records)) {
    if (key >= cutoff) pruned[key] = value
  }
  return pruned
}

// ── 路径派生（getDataDir 动态推导，禁硬编码——设计 D3 / G4）──────────

/** `<dataDir>/gen-stats`（TAIJI_AGENT_DATA_DIR 可覆盖，测试注入后天然隔离） */
export function getGenStatsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getDataDir(env), 'gen-stats')
}

/** `<dataDir>/gen-stats/speed` */
export function getSpeedDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getGenStatsDir(env), 'speed')
}

/** `<dataDir>/gen-stats/cache-ratio` */
export function getCacheRatioDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getGenStatsDir(env), 'cache-ratio')
}

/**
 * 模型 key → 文件名安全化（**单射**，设计 D3）：
 * `(provider + '__' + model)` 字符替换截断 64 作 safeBase，再追加 raw key 的
 * sha256 前 8 位十六进制后缀——替换对 `a b`/`a_b`、大小写变体（macOS 大小写不敏感
 * FS）、超长截断均不保证单射，hash 后缀消解；hex 小写进一步排除 hash 段内大小写碰撞。
 */
export function safeModelFileName(provider: string, model: string): string {
  const raw = `${provider}__${model}`
  const safeBase = raw.replace(/[/\\\s:]/g, '_').slice(0, SAFE_MODEL_BASE_MAX)
  const hash8 = createHash('sha256').update(raw).digest('hex').slice(0, MODEL_KEY_HASH_LEN)
  return `${safeBase}-${hash8}`
}

/** speed 文件绝对路径：`<dataDir>/gen-stats/speed/<safe-model>.json` */
export function speedFilePath(provider: string, model: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(getSpeedDir(env), `${safeModelFileName(provider, model)}.json`)
}

/** cache-ratio 文件绝对路径：`<dataDir>/gen-stats/cache-ratio/<safe-model>.json` */
export function cacheRatioFilePath(provider: string, model: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(getCacheRatioDir(env), `${safeModelFileName(provider, model)}.json`)
}

// ── 读 / 写（同步 + 原子 + 损坏自愈，D3/D8）──────────────────────────

/** 存储条目有效性：恰为二元有限数字组（JSON 可解析出 Infinity/超大数，一并拦） */
function isValidRecord(entry: unknown): entry is GenStatsRecord {
  return (
    Array.isArray(entry) &&
    entry.length === RECORD_TUPLE_LENGTH &&
    typeof entry[0] === 'number' && Number.isFinite(entry[0]) &&
    typeof entry[1] === 'number' && Number.isFinite(entry[1])
  )
}

/**
 * 读日记录文件（**损坏自愈，不抛**——设计 §3.5）：
 * 文件不存在 → 空；读失败 / JSON 解析失败 / 顶层形状非法 → warn 日志（带路径）+ 空，
 * 下次写入自愈重建；部分键/条目畸形 → 丢弃畸形部分（warn 一次），合法数据照常返回。
 */
export function readDayRecords(filePath: string): GenStatsDayRecords {
  if (!existsSync(filePath)) return {}

  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    logger.warn('[gen-stats] day records read failed, treating as empty', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    })
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logger.warn('[gen-stats] day records corrupted (JSON parse failed), treating as empty', { filePath })
    return {}
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger.warn('[gen-stats] day records shape invalid (not an object), treating as empty', { filePath })
    return {}
  }

  const result: GenStatsDayRecords = {}
  let repaired = false
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!DAY_KEY_RE.test(key) || !Array.isArray(value)) {
      repaired = true
      continue
    }
    const entries = value.filter(isValidRecord)
    if (entries.length !== value.length) repaired = true
    result[key] = entries
  }
  if (repaired) {
    logger.warn('[gen-stats] day records partially malformed, repaired in memory', { filePath })
  }
  return result
}

/**
 * 写日记录文件（D8 同步临界段终点；设计 D3「写入时顺带清理」）：先 GC 30 天前日键，
 * 再经 atomicWrite（tmp + renameSync 原子覆盖）落盘；父目录不存在则递归创建。
 * 写失败由调用方按 §3.5 容错（内存聚合照常、当前帧照常推），本函数不吞异常。
 * 返回实际写盘的 prune 后记录对象——调用方在同一同步临界段内紧接 snapshot 时可直接
 * 复用（单线程无第三方写者，磁盘值 == 返回值），省去 snapshot 的重复全文件读。
 * tmp 孤儿清理（D6 #3）：崩溃（SIGKILL/断电）落在 atomicWrite 的 write→rename 窗口时留下
 * `*.json.tmp` 孤儿——本次写入对**同路径**的孤儿必然自愈（writeFileSync 覆写后 rename 带走），
 * 但换模型后旧模型文件永不重写，孤儿永驻；写入时顺带清扫同目录全部 `.tmp` 孤儿兜底
 * （gen-stats 目录仅本 store 写入，`*.tmp` 只可能是本原子写残留，清扫无旁观者伤害）。
 */
export function writeDayRecords(filePath: string, records: GenStatsDayRecords): GenStatsDayRecords {
  mkdirSync(dirname(filePath), { recursive: true })
  const persisted = pruneExpiredDays(records)
  atomicWrite(filePath, JSON.stringify(persisted))
  sweepTmpOrphans(dirname(filePath))
  return persisted
}

/** 原子写 tmp 孤儿清扫（见 writeDayRecords 注释；失败 warn 不抛——清理是顺带兜底非主路径）。 */
function sweepTmpOrphans(dir: string): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith(TMP_SUFFIX)) continue
    const orphan = join(dir, name)
    try {
      rmSync(orphan, { force: true })
    } catch (err) {
      logger.warn('[gen-stats] tmp orphan cleanup failed', {
        path: orphan,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
