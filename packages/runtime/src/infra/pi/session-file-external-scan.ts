/**
 * 外部目录 pi session 扫描（import-session D3 / U1；2026-09-02 Gate B 二次修订：提取管线换外部侧专用轻量版）。
 *
 * 从 session-file-utils.ts 抽出的原因：后者有效行数撞 max-lines 预算（500），外部扫描域
 * （scanExternalSessions 及其独立 TTL 缓存 / 异步枚举辅助）整体迁出独立成档。与太极根
 * 扫描的共用原语（isScannableSessionFile / SCAN_DIR_TTL_MS）仍由 session-file-utils 提供，
 * 本模块单向依赖；session-file-utils 不 re-export 本模块（避免循环依赖），消费方直接 import 本文件。
 *
 * 为何不复用 scanSessionMeta（Gate B P-scan-perf 实测回填，D3 二次修订）：scanSessionMeta
 * 多读合一（header/name/outcome/handoff/preset/project/agent binding 七处提取），外部
 * 候选仅消费 header+name+stat 三项，其余五读零消费；且 findLastEntryField 尾读未命中即 fallback 全量
 * readFileSync——未 rename 的 session 其 session_info 在文件头部，触发整文件读（本机实测
 * 4,616 文件/2.1GB：23.3s 首扫 + maxBlock 1,947ms 双超标）。本模块改走外部侧专用轻量提取
 * （全 async：stat + header 首行 + name 三级定位），IO 总量从「全量读」收敛到每文件
 * 4KB(header) + 64KB(尾块，miss 时再读 64KB 头块)。
 */
import { open, readdir as readdirAsync, stat as statAsync } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SCAN_DIR_TTL_MS,
  isScannableSessionFile,
  type ScanSessionsOptions,
} from './session-file-utils.js'

// ── 外部目录扫描（import-session D3 / U1）────────────────────

/**
 * 外部扫描的单条 session 元信息（轻量字段集，D3 二次修订）。
 *
 * 与 ScannedSessionMeta 的关系：字段名对齐的保留同名（id/filePath/cwd/timestamp/name/
 * lastModified/size），但无 outcome/handedOffTo/launchPresetId/projectId/spawnSource 等
 * 太极根侧字段——外部候选列表（matchesQuery/排序/alreadyImported/dirLabel）只消费轻量集，
 * 提取它们意味着零消费的整文件读。
 */
export interface ExternalSessionMeta {
  id: string
  filePath: string
  cwd: string
  timestamp: string
  /** 三级定位（尾块→头块→null）取到的当前名称；未命中为 null（UI 回退目录名显示）。 */
  name: string | null
  lastModified: number
  size: number
}

/** 外部根扫描 TTL 缓存有效期：对齐太极根 SCAN_DIR_TTL_MS 惯例（1s），独立常量以容各自演化。 */
const SCAN_EXTERNAL_TTL_MS = SCAN_DIR_TTL_MS

/** 分批让出事件循环的批大小（D3/MF-3：每批 100 个文件后 setImmediate 让出）。 */
const SCAN_EXTERNAL_BATCH_SIZE = 100

/**
 * header 首行读块大小（4KB）。与 parseSessionHeader / readFirstLineAsync 同策略：4KB 覆盖
 * 正常 header（cwd 长路径）；块读满仍无换行（首行超长）继续续读，等价于全量读首行语义。
 */
const HEADER_CHUNK_BYTES = 4096

/**
 * name 定位的块预算（尾块 / 头块各 64KB，D3 二次修订）。pi 侧 session_info 只经
 * `appendSessionInfo` 写入且恒为尾部 append（锚点：@earendil-works/pi-coding-agent 0.84.4
 * dist/core/session-manager.js appendSessionInfo → _appendEntry；全部调用点 main.js:555 /
 * core/agent-session.js:2445 / modes/interactive/interactive-mode.js:4479 均为 rename 语义，
 * 不存在「创建期写头部」的写入路径）——故尾块覆盖 rename 后再未增长的 session；头块命中的
 * 真实成因是「session 早期即被 rename、其后文件增长超 64KB」的分布现象（数据集实测，非
 * pi 写入行为断言）。中段（头尾块之间）出现 session_info 的分布接受 name=null 降级
 * （显示用字段，UI 有目录名回退）。
 */
const NAME_BLOCK_KB = 64
const BYTES_PER_KB = 1024
const NAME_BLOCK_BYTES = NAME_BLOCK_KB * BYTES_PER_KB

/** 外部根扫描缓存条目。rootDir 作等值校验字段：外部根可变，切根即整体失效。 */
interface ScanExternalCacheEntry {
  rootDir: string
  items: ExternalSessionMeta[]
  expiresAt: number
}
/** @data-owner #22（纯派生可重建读缓存，失效语义见登记表主表 #22） */
let scanExternalCache: ScanExternalCacheEntry | null = null
/** 上次 scanExternalSessions 观测的 Date.now()（时钟回拨检测，与 scanPiSessions 同防护）。 */
let scanExternalLastNow = 0

/**
 * 轻量版文件级缓存（键 = filePath + (mtimeMs, size)，与 sessionMetaCache 同键语义，
 * D3 二次修订：轻量提取不共用 sessionMetaCache——该缓存条目类型是多读合一的
 * ScannedSessionMeta，混存轻量形态会污染太极根扫描路径，故模块内独立存放）。
 * 命中免读：同文件二次扫描（TTL 过期后的重扫 / force 重扫）只付一次 stat 的代价。
 */
interface CachedExternalMeta {
  mtimeMs: number
  size: number
  meta: ExternalSessionMeta
}
/** @data-owner #22（纯派生可重建读缓存，失效语义见登记表主表 #22）
 * 2026-09-14 内存审计复核：量级维持可控，维持不治裁决（docs/design/memory-leak-remediation.md §2.5） */
const externalMetaCache = new Map<string, CachedExternalMeta>()

/**
 * 扫描外部目录下的 pi session 文件（导入候选扫描原语，import-session D3 / U1）。
 *
 * 与太极根扫描（scanPiSessions → scanPiSessionsFromDisk）同构的收录语义：顶层 + 一层
 * 子目录、isScannableSessionFile 过滤（含 `.tmp-migrate-` / `.tmp-import-` 残留家族）、
 * 首行合法 session header 才收录（按内容识别）。
 *
 * 执行模型（D3/MF-3 + 二次修订）：全 async（fs/promises）+ 分批执行——每批
 * SCAN_EXTERNAL_BATCH_SIZE 个文件后 await setImmediate 让出事件循环，万级目录首扫被
 * 切成数十个短批，批间 WS 消息与流式广播照常处理。单文件提取失败静默跳过（与
 * scanPiSessionsFromDisk 同容错语义）。
 *
 * 缓存两层：独立于太极根 scanDirCache 的单条目 TTL 缓存（1s，dir 作等值校验字段不能
 * 承载可变 rootDir 故独立存放）+ 文件级 externalMetaCache（键 filePath+(mtimeMs,size)，
 * 跨根复用，同文件二次扫描零读）。TTL 锚定在扫描完成时刻：锚定开始时刻会使耗时超过
 * TTL 的首扫产出一个「出生即过期」的缓存条目（大目录下 TTL 永不命中），完成时刻锚定
 * 让 1s 重查窗口（D5 的 250ms debounce 搜索）真正命中。opts.force 绕过 TTL 缓存强制
 * 重扫（导入成功后传 force——保守动作，无消费者依赖其效果，D3 实现层注记）。
 *
 * @param rootDir 外部根目录（不存在/不可读 → items 为空数组，不抛错，与太极根同容错）
 * @param opts.force true 绕过 TTL 缓存强制重扫
 * @returns items 按 lastModified 降序（与 scanPiSessions 一致）+ 回显 rootDir
 */
export async function scanExternalSessions(
  rootDir: string,
  opts?: ScanSessionsOptions,
): Promise<{ items: ExternalSessionMeta[]; rootDir: string }> {
  const now = Date.now()
  const clockWentBackwards = now < scanExternalLastNow
  scanExternalLastNow = now
  if (
    !opts?.force &&
    !clockWentBackwards &&
    scanExternalCache &&
    scanExternalCache.rootDir === rootDir &&
    now < scanExternalCache.expiresAt
  ) {
    // 浅拷贝数组：消费者可安全 sort/splice，不污染缓存本体（与 scanPiSessions 同契约）
    return { items: [...scanExternalCache.items], rootDir }
  }

  // 阶段 1（异步）：枚举候选文件路径。目录遍历结果不缓存——readdir/stat 开销小，
  // 缓存只收 meta 提取结果，重扫时 externalMetaCache 兜底零读。
  const files = await listExternalSessionFiles(rootDir)

  // 阶段 2（分批 async）：逐文件轻量提取，每批后让出事件循环。批内 Promise.all 并发
  //（D3/MF-3 分批模型不变：每批 SCAN_EXTERNAL_BATCH_SIZE 个文件后 await setImmediate
  // 让出；批内 IO 走 fs/promises 线程池，await 期间事件循环照常处理 WS 消息与流式广播。
  // 并发化消除串行 await 的逐 op 事件循环往返——3,689 文件 × ~5 次线程池 op 的串行
  // 往返是 force 二扫路径的主要成本，并发后该路径也进 50ms 预算）。
  const items: ExternalSessionMeta[] = []
  for (let start = 0; start < files.length; start += SCAN_EXTERNAL_BATCH_SIZE) {
    if (start > 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const batch = files.slice(start, start + SCAN_EXTERNAL_BATCH_SIZE)
    // 批内各文件独立，逐个吞错降级 null（单文件失败不中断，与 scanPiSessionsFromDisk
    // 同容错语义）；allSettled 对齐 taste 规则（映射函数自身已全量捕获，理论上不会 reject）
    const settled = await Promise.allSettled(
      batch.map(async (filePath) => {
        try {
          return await extractExternalMeta(filePath)
        } catch {
          return null
        }
      }),
    )
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) items.push(result.value)
    }
  }

  items.sort((a, b) => b.lastModified - a.lastModified)
  // force 刷新同样写缓存：随后 1s 内的候选列表消费方零 IO 读到最新视图（与 scanPiSessions 同策略）。
  const completedAt = Date.now()
  scanExternalLastNow = Math.max(scanExternalLastNow, completedAt)
  scanExternalCache = { rootDir, items, expiresAt: completedAt + SCAN_EXTERNAL_TTL_MS }
  return { items: [...items], rootDir }
}

/**
 * 枚举外部根下的候选 session 文件路径：顶层文件 + 一层子目录内文件（与
 * scanPiSessionsFromDisk 同深度假设，更深层静默跳过——D3/S8，UI tooltip 声明）。
 * isScannableSessionFile 过滤在此应用：候选列表从机制上看不到任何非 final 名文件。
 * 根目录不存在/不可读 → 空数组（不抛错）；子目录 readdir 失败跳过不影响其余。
 */
async function listExternalSessionFiles(rootDir: string): Promise<string[]> {
  let topEntries: string[]
  try {
    topEntries = await readdirAsync(rootDir)
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of topEntries) {
    const entryPath = join(rootDir, entry)
    let entryStat
    try {
      entryStat = await statAsync(entryPath)
    } catch {
      continue
    }
    if (entryStat.isDirectory()) {
      let subEntries: string[]
      try {
        subEntries = await readdirAsync(entryPath)
      } catch {
        continue // skip unreadable dir
      }
      for (const name of subEntries) {
        if (isScannableSessionFile(name)) files.push(join(entryPath, name))
      }
    } else if (isScannableSessionFile(entry)) {
      files.push(entryPath)
    }
  }
  return files
}

// ── 单文件轻量提取（D3 二次修订）──────────────────────────────

/**
 * 单文件轻量元数据提取：stat（mtimeMs/size）→ header 首行 → name 三级定位。
 *
 * stat 先行供养文件级缓存：命中（filePath + mtimeMs + size 一致）直接返回缓存 meta，
 * 不 open 不读。miss 才 open 句柄做两次定位读，读毕写缓存。
 * 文件不存在/不可读 → 清 stale 缓存条目返回 null（与 scanSessionMeta 的 INVAR-cache-4 同语义）。
 */
async function extractExternalMeta(filePath: string): Promise<ExternalSessionMeta | null> {
  let fstat
  try {
    fstat = await statAsync(filePath)
  } catch {
    externalMetaCache.delete(filePath)
    return null
  }
  const cached = externalMetaCache.get(filePath)
  if (cached && cached.mtimeMs === fstat.mtimeMs && cached.size === fstat.size) {
    return cached.meta
  }

  // stat 成功但 open 抛错（stat/open 间隙文件被删或权限变化）时同样清 stale 缓存条目
  //（与 stat 失败路径同语义，防陈旧 meta 留存）。
  let fh
  try {
    fh = await open(filePath, 'r')
  } catch {
    externalMetaCache.delete(filePath)
    return null
  }
  let meta: ExternalSessionMeta | null = null
  try {
    const firstLine = await readFirstLineViaHandle(fh)
    if (firstLine !== null) {
      const header = parseHeaderFromFirstLine(firstLine)
      if (header) {
        const name = await extractNameThreeTier(fh, fstat.size)
        meta = {
          id: header.id,
          filePath,
          cwd: header.cwd,
          timestamp: header.timestamp,
          name,
          lastModified: fstat.mtimeMs,
          size: fstat.size,
        }
      }
    }
  } finally {
    await fh.close()
  }
  if (meta) {
    externalMetaCache.set(filePath, { mtimeMs: fstat.mtimeMs, size: fstat.size, meta })
  }
  return meta
}

/**
 * 异步读 JSONL 首行（4KB 块 + 超长首行续读）。
 *
 * 与 import-service.ts 的 readFirstLineAsync 同模式（本模块为 infra 层，不能反向 import
 * services 层抽共用；两处语义由 D3 二次修订锁定同步）。块内无换行且未读满（文件本身小于
 * 块）按无首行终止处理；块读满仍无换行（首行超长）继续续读——等价于全量读首行的语义。
 * 空文件返回 null。
 *
 * 跨块解码（r1-S2）：块以 Buffer 累积、检测换行时 Buffer.concat 后整体 toString——
 * 逐块 toString 会在多字节 UTF-8 字符（CJK）跨 4KB 块边界时拆出 U+FFFD。
 */
async function readFirstLineViaHandle(fh: FileHandle): Promise<string | null> {
  const buffer = Buffer.alloc(HEADER_CHUNK_BYTES)
  const chunks: Buffer[] = []
  for (;;) {
    const { bytesRead } = await fh.read(buffer, 0, HEADER_CHUNK_BYTES, null)
    if (bytesRead === 0) {
      return chunks.length > 0 ? Buffer.concat(chunks).toString('utf-8') : null
    }
    // 换行先在原始 Buffer 上定位（与 import-service 的 readFirstLineAsync 同步：避免逐块
    // Buffer.concat 的 O(n²) 复制）；换行前内容才入 chunks，最终一次性 concat 解码
    //（跨块 CJK 多字节字符仍完整）。
    const nl = buffer.subarray(0, bytesRead).indexOf('\n'.charCodeAt(0))
    if (nl >= 0) {
      chunks.push(Buffer.from(buffer.subarray(0, nl)))
      return Buffer.concat(chunks).toString('utf-8')
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    if (bytesRead < HEADER_CHUNK_BYTES) {
      return chunks.length > 0 ? Buffer.concat(chunks).toString('utf-8') : null
    }
  }
}

/**
 * 解析首行为 session header（import-session D1 字段清单对齐：type==='session' 且 id/cwd
 * 均为非空字符串才收录）。缺 id/cwd 的文件不进候选列表——导入侧（import-service 的
 * parseHeaderFromFirstLine）按同清单拒绝（import_invalid_session），收录它们只会产出
 * 导入必失败的候选；且缺 id 的条目会让 matchesQuery 的短 ID 匹配（sessionId.slice）
 * TypeError，令任意搜索词下 listCandidates 整体崩溃。
 * timestamp 是零消费的对齐保留字段（toCandidate 不取），宽松读出：缺省以 '' 读出。
 * 首行非合法 JSON / 非 object / type 非 session → null（该文件不收录）。
 */
export function parseHeaderFromFirstLine(firstLine: string): { id: string; cwd: string; timestamp: string } | null {
  let entry: unknown
  try {
    entry = JSON.parse(firstLine)
  } catch {
    return null
  }
  if (typeof entry !== 'object' || entry === null || (entry as Record<string, unknown>).type !== 'session') {
    return null
  }
  const e = entry as Record<string, unknown>
  if (typeof e.id !== 'string' || e.id === '') return null
  if (typeof e.cwd !== 'string' || e.cwd === '') return null
  return { id: e.id, cwd: e.cwd, timestamp: typeof e.timestamp === 'string' ? e.timestamp : '' }
}

/**
 * name 三级定位（D3 二次修订）：
 * 1. 尾块（最后 64KB）倒序找**最后**一条 session_info——覆盖 rename append 尾部的分布；
 *    命中即全局最后一条（尾块含文件末尾）。
 * 2. 尾块未命中 → 头块（首 64KB）正序找**第一个** session_info——覆盖创建期写入头部的
 *    分布（未 rename 的 session）。文件 ≤ 64KB 时尾块已扫全文件，直接 null 不重读头块。
 * 3. 均未命中 → null（UI 回退目录名显示）。
 *
 * 跨块边界行容错（对齐 readTailEntries 的 INVAR-tail-3 语义）：尾块 offset>0 时首行视为
 * 残行丢弃；头块读满（文件在块后还有内容）时末行视为残行丢弃——残行可能恰好 parse 成
 * 语义错误的 JSON，靠丢弃消除而非 try-catch 吞错。畸形/空行照 parseJsonl 惯例跳过。
 *
 * 空串 name 是合法匹配（与 extractSessionName 的 predicate `typeof e.name === 'string'`
 * 对齐）；本函数用 null 表「无匹配」区分。
 */
async function extractNameThreeTier(fh: FileHandle, size: number): Promise<string | null> {
  if (size <= 0) return null
  // 第 1 级：尾块
  const tailLen = Math.min(size, NAME_BLOCK_BYTES)
  const tailOffset = size - tailLen
  const tailBuf = Buffer.alloc(tailLen)
  const { bytesRead: tailRead } = await fh.read(tailBuf, 0, tailLen, tailOffset)
  const tailLines = tailBuf.toString('utf-8', 0, tailRead).split('\n')
  // offset>0 → 块首行是被切断的残行，丢弃（INVAR-tail-3 同语义）
  const tailStart = tailOffset > 0 ? 1 : 0
  for (let i = tailLines.length - 1; i >= tailStart; i--) {
    const name = sessionInfoNameOfLine(tailLines[i])
    if (name !== null) return name
  }
  // 文件 ≤ 64KB：尾块已扫全文件（且未丢行），头块重读无意义
  if (tailOffset === 0) return null
  // 第 2 级：头块
  const headLen = Math.min(size, NAME_BLOCK_BYTES)
  const headBuf = Buffer.alloc(headLen)
  const { bytesRead: headRead } = await fh.read(headBuf, 0, headLen, 0)
  const headLines = headBuf.toString('utf-8', 0, headRead).split('\n')
  // 块读满（文件在 64KB 后还有内容）→ 末行是被切断的残行，丢弃（镜像 INVAR-tail-3）
  const headEnd = headRead >= NAME_BLOCK_BYTES ? headLines.length - 1 : headLines.length
  for (let i = 0; i < headEnd; i++) {
    const name = sessionInfoNameOfLine(headLines[i])
    if (name !== null) return name
  }
  return null
}

/**
 * 单行解析：是 session_info 且 name 为字符串 → 返回 name；其余（空行/畸形 JSON/非
 * session_info/name 非字符串）→ null。
 */
function sessionInfoNameOfLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let entry: unknown
  try {
    entry = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof entry !== 'object' || entry === null) return null
  const e = entry as Record<string, unknown>
  if (e.type !== 'session_info' || typeof e.name !== 'string') return null
  return e.name
}
