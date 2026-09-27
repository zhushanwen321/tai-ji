/**
 * 诊断包导出——收集清单 + zip 打包主体（crash-forensics-and-watchdog §3.3 D6，实施计划 u3a）。
 *
 * 【收集清单（D6 明文）】双台账现档（crashes/main.jsonl + crashes/runtime.jsonl）+
 * 触发条件状态表（D2 评估器输出，进 summary.md）+ 各层日志尾部（runtime-* / main-* /
 * renderer-error-* / pi-* 各家族最新一份取末 256KB，非全量）+ 近 24h 水位行摘录（runtime
 * 日志 5min 明细行）+ 版本/平台/pi 版本/marker 状态 + 台账事件 detailPath 引用的深查文件
 * （D1 schema 字段：detailDigest 摘要与 detailPath 深查是配对设计，包内不含则归因链断）。
 * zip 内置 summary.md（人读首屏：最近 10 条台账事件表格 + 触发状态表 + 各文件清单说明）。
 *
 * 【隐私判定（D6）】不脱敏——路径与会话标识正是归因线索；补偿 = 导出确认对话框知情提示
 * （DIAGNOSTIC_EXPORT_PRIVACY_NOTICE，shared SSOT，渲染侧消费在 u3b）。
 *
 * 【产物落点（D6）】用户自选保存位置——本模块只接受 outPath 绝对路径；保存对话框由
 * IPC 层（./diagnostics-export-ipc.ts）经 dialog.showSaveDialog 弹出后传入。
 *
 * 【zip 实现选型】零新依赖——zip 容器构造与解析拆至 ./minimal-zip.ts（手写 minimal
 * writer，选型理由见该文件头）：apps/electron 既有依赖无 zip 容器能力（extract-zip /
 * unzipper 只解压；tar 是 tar 容器非 zip；electron-builder 的 zip 能力在 app-builder-bin
 * 内部 CLI，非运行时库），而 main bundle 策略是「第三方 npm 包一律打进 main.cjs」
 * （vite.config.main.ts [HISTORICAL]），新增 zip 库会直接进产物且需动 lock。
 *
 * 【纯度分层】收集清单计算（buildDiagnosticEntries）/ summary 渲染（buildSummaryMarkdown）/
 * 水位行摘录（extractRecentWatermarkLines）/ zip 字节构造（minimal-zip.ts buildZipArchive）
 * 与 IO 编排（exportDiagnosticBundle）分离；副作用面收敛在后者，deps 全部可注入
 * （main 池 vitest 直测，夹具 mkdtemp tmpdir 自建自删，禁触真实数据目录）。
 *
 * 【失败降级】清单项缺失（如首事件前台账尚未建立）= 降级跳过不抛错，进 missing 显式
 * 清单（summary.md「各文件清单说明」标注缺失原因，设计 §3.1「数据缺失显式标注而非
 * 静默空白」）；打包 IO 失败（磁盘满/权限/目录不存在）归一为具体 errno（不吞成布尔，
 * IPC 层零 rejection 面）。
 */
import { release as osRelease } from 'node:os'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RUN_DIR_NAME,
  RUN_MARKER_FILENAME,
  RUN_CHECKPOINT_FILENAME,
  RUN_CHECKPOINT_FAILED_PREFIX,
  getDataDir,
} from '@taiji/shared/paths'
import type { DiagnosticExportBundleResult, DiagnosticExportSummary } from '@taiji/shared'
import { DIAGNOSTIC_EXPORT_PRIVACY_NOTICE } from '@taiji/shared'
import { mainLogger } from '../logs/main-logger.js'
import { buildZipArchive } from './minimal-zip.js'
import { readJournalLines } from './journal-io.js'
import { evaluateTriggerConditions, parseJournalLines } from './trigger-evaluator.js'
import type { DatedEvent, TriggerConditionRow, TriggerEvaluationResult } from './trigger-evaluator.js'

// ── 常量（D6 定值）────────────────────────────────────────────────────────────

const BYTES_PER_KB = 1024
/** 日志尾部截取量 KB 数（D6「各取末 256KB，非全量」）。 */
const DIAGNOSTIC_TAIL_KB = 256
/** 各层日志尾部截取量（D6「各取末 256KB，非全量」）。 */
export const DIAGNOSTIC_TAIL_BYTES = DIAGNOSTIC_TAIL_KB * BYTES_PER_KB
// 时间量纲换算基数（与 trigger-patrol.ts / log-retention.ts 同款命名常量，非魔数）。
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
/** 水位行摘录窗口（D6「近 24h 水位行摘录」）。 */
export const WATERMARK_WINDOW_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND
/** summary.md 首屏台账事件表格行数（D6「最近 10 条台账事件表格」）。 */
export const SUMMARY_RECENT_EVENT_COUNT = 10
/** 首屏表格 detailDigest 单元格最大字符数（≤2KB digest 截断展示，防表格撑爆首屏）。 */
const SUMMARY_DETAIL_DIGEST_MAX_CHARS = 200
/** detailPath 深查文件收集上限（防极端台账把包撑爆；超出部分在清单中标注）。 */
const MAX_DETAIL_FILES = 10
/** 每家族取 mtime 最新的一份（尾部语义 = 当前活跃日志；历史日期文件不在「尾部」内）。 */
const LOG_FAMILIES: ReadonlyArray<{ prefix: string; note: string }> = [
  { prefix: 'runtime-', note: 'runtime 主日志尾部（含 5min 水位明细行，最后 256KB）' },
  { prefix: 'main-', note: 'main 进程日志尾部（最后 256KB）' },
  { prefix: 'renderer-error-', note: 'renderer JS 错误落盘尾部（最后 256KB）' },
  { prefix: 'pi-', note: 'pi stdout tee 尾部（最后 256KB；含 relay 镜像 / 崩溃取证同名前缀家族）' },
]

// run 目录运行态文件名族走 @taiji/shared/paths RUN_* SSOT（【oe-audit C8】：
// 原四行手抄字面量与 main.ts / runtime-checkpoint.ts「跨文件显式对齐」收敛单点）。

// ── 收集清单（纯函数）────────────────────────────────────────────────────────

/** 清单单条目：生成条目带 content，来源条目带 sourcePath + tailBytes（尾部截取语义）。 */
export interface DiagnosticEntry {
  /** zip 内虚拟路径（POSIX 分隔符——zip 规范用 '/'，禁 path.join 在 win 产生 '\'） */
  archivePath: string
  /** 来源文件绝对路径（生成条目省略） */
  sourcePath?: string
  /** 直接内容（summary.md / 水位摘录等生成条目） */
  content?: string
  /** 来源条目的尾部截取字节数（省略 = 全量；台账现档全量 ≤10MB 由 writer 轮转保证） */
  tailBytes?: number
  /** 清单说明（summary.md「包内文件清单」段落逐条展示） */
  note: string
}

/** 降级跳过项（显式非静默：进 summary.md 清单说明 + IPC summary.missingEntries）。 */
export interface DiagnosticMissingEntry {
  archivePath: string
  reason: string
}

/** 环境信息（版本/平台/pi 版本/marker 状态，D6）。 */
export interface DiagnosticEnvironment {
  appVersion: string
  piVersion: string
  platform: string
  platformRelease: string
  arch: string
  nodeVersion: string
  markerPresent: boolean
  checkpointPresent: boolean
  checkpointFailedCount: number
}

/** 一次清单收集的完整产物（entries + 降级记录 + 评估器状态表）。 */
export interface DiagnosticCollectResult {
  entries: DiagnosticEntry[]
  missing: DiagnosticMissingEntry[]
  environment: DiagnosticEnvironment
  evaluated: TriggerEvaluationResult
  exportedAt: string
}

/** buildDiagnosticEntries 注入面：dataDir 可注入（测试 mkdtemp），其余为动态推导。 */
export interface CollectDiagnosticOptions {
  dataDir?: string
  /** app 版本（IPC 层注入 app.getVersion()；缺省 unknown——纯收集层不依赖 electron） */
  appVersion?: string
  /** 锚定时刻（水位窗口 / 导出时间戳；缺省 Date.now()，测试注入固定值） */
  now?: number
}

/**
 * 读取文本文件；不存在返回 null（清单降级），其余 IO 错误也降级并经 reason 说明
 * （诊断导出是归因旁路，单文件读失败不得中断整个包）。
 */
function readTextIfExists(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    // ENOENT（未建立）与其他读取失败统一降级——缺失进 missing 清单显式呈现（归因旁路不中断）
    return null
  }
}

// 台账读取统一走 ./journal-io.ts（【oe-audit C5】：原本地全静默吞版本违反设计 §3.1
// 「读取失败 → 显式 no-data 而非静默空白」——现与 patrol 共用 ENOENT 常态空 + 失败 warn 口径）。

/**
 * 从台账事件提取最近一次出现的 piVersion（runtime 事件按 D1 schema 携带）。main 进程无
 * pi 二进制的同步版本查询面（runtime 侧是 spawn `pi --version` 异步获取），台账是
 * main 侧唯一已落盘的权威来源；全空返回 unknown（显式非静默）。
 * 【oe-audit C5】入参从原始行改为共享 parse 产物（events，与 detailPaths/首屏表格
 * 同一次 parseJournalLines 输出）——消除家族内并行 JSONL 循环。
 */
export function extractLatestPiVersion(events: readonly DatedEvent[]): string {
  let latest: { tsMs: number; version: string } | null = null
  for (const event of events) {
    const version = event.raw.piVersion
    if (typeof version !== 'string' || version === '') continue
    // 无 ts 的事件不会出现（parseJournalLines 的 ts 守卫已滤）；tsMs 直接可用
    if (latest === null || event.tsMs >= latest.tsMs) latest = { tsMs: event.tsMs, version }
  }
  return latest?.version ?? 'unknown'
}

/**
 * 目录下匹配前缀的 mtime 最新文件（跳过子目录）；目录不存在/无匹配返回 null。
 * mtime 而非文件名日期（log-retention 同款裁决：活跃文件 mtime 持续刷新）。
 */
function pickLatestFile(dir: string, prefix: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null // logs 目录尚未建立（首次启动常态）
  }
  let latest: { path: string; mtimeMs: number } | null = null
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    const full = join(dir, name)
    try {
      const st = statSync(full)
      if (!st.isFile()) continue
      if (latest === null || st.mtimeMs > latest.mtimeMs) latest = { path: full, mtimeMs: st.mtimeMs }
      // eslint-disable-next-line taste/no-silent-catch -- 单条 stat 失败（并发删除）best-effort 跳过该候选，不影响其余文件
    } catch {
      // no-op
    }
  }
  return latest?.path ?? null
}

/** ② 各层日志家族尾部入清单：每家族 mtime 最新一份取末 256KB；无该家族文件 → missing 显式降级（顺序追加，与主清单其余段落串行）。 */
function collectLogFamilyTails(logsDir: string, entries: DiagnosticEntry[], missing: DiagnosticMissingEntry[]): void {
  for (const family of LOG_FAMILIES) {
    const latest = pickLatestFile(logsDir, family.prefix)
    if (latest === null) {
      missing.push({ archivePath: `logs/${family.prefix}*`, reason: 'logs 目录无该家族文件（未产生过该类日志）' })
      continue
    }
    entries.push({
      archivePath: `logs/${latest.split('/').pop() ?? latest}`,
      sourcePath: latest,
      tailBytes: DIAGNOSTIC_TAIL_BYTES,
      note: family.note,
    })
  }
}

/** 只保留文件末 maxBytes 字节（subarray 零复制视图——日志是给 grep 用的，UTF-8 边界不齐无妨）。 */
export function tailBytes(content: Buffer<ArrayBufferLike>, maxBytes: number): Buffer<ArrayBufferLike> {
  return content.length <= maxBytes ? content : content.subarray(content.length - maxBytes)
}

/**
 * 从日志文本提取时间戳在窗口内的 [watermark] 行（runtime 日志行格式
 * `[ISO] [LEVEL] message`，logger.ts writeLogEntry 唯一格式源）。无时间戳前缀的行
 * 不猜窗口归属（跳过）——「近 24h」按行首权威时间戳判定，非行数近似。
 */
export function extractRecentWatermarkLines(content: string, now: number, windowMs: number = WATERMARK_WINDOW_MS): string[] {
  const out: string[] = []
  for (const line of content.split('\n')) {
    if (!line.includes('[watermark]')) continue
    const match = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/.exec(line)
    if (!match) continue
    const tsMs = Date.parse(match[1])
    if (Number.isNaN(tsMs)) continue
    if (tsMs > now - windowMs && tsMs <= now) out.push(line)
  }
  return out
}

/** run 目录运行态（marker/checkpoint 存在性 + 失败现场家族计数——状态进 summary.md）。 */
function readRunState(dataDir: string): Pick<DiagnosticEnvironment, 'markerPresent' | 'checkpointPresent' | 'checkpointFailedCount'> {
  const runDir = join(dataDir, RUN_DIR_NAME)
  let failedCount = 0
  try {
    failedCount = readdirSync(runDir).filter((n) => n.startsWith(RUN_CHECKPOINT_FAILED_PREFIX)).length
  } catch {
    failedCount = 0 // run 目录未建立 = 全新安装常态（存在性由 existsSync 单独判定）
  }
  return {
    markerPresent: existsSync(join(runDir, RUN_MARKER_FILENAME)),
    checkpointPresent: existsSync(join(runDir, RUN_CHECKPOINT_FILENAME)),
    checkpointFailedCount: failedCount,
  }
}

/**
 * 计算诊断包收集清单（纯函数：除 statSync/readdirSync/readFileSync 只读探测外无副作用，
 * 不写任何文件）。缺文件逐项降级进 missing，不抛错（A1 验收：缺 runtime.jsonl 清单降级）。
 */
export function buildDiagnosticEntries(options: CollectDiagnosticOptions = {}): DiagnosticCollectResult {
  const now = options.now ?? Date.now()
  const dataDir = options.dataDir ?? getDataDir()
  const logsDir = join(dataDir, 'logs')
  const crashesDir = join(logsDir, 'crashes')
  const entries: DiagnosticEntry[] = []
  const missing: DiagnosticMissingEntry[] = []

  // ① 双台账现档（D6；轮转段不在清单——「（现档）」明文，历史窗口由评估器按留存判定）
  for (const name of ['main.jsonl', 'runtime.jsonl'] as const) {
    const full = join(crashesDir, name)
    if (existsSync(full)) {
      entries.push({ archivePath: `crashes/${name}`, sourcePath: full, note: `崩溃台账现档（${name}，main/runtime 双文件 D1）` })
    } else {
      missing.push({ archivePath: `crashes/${name}`, reason: '台账文件尚未建立（首事件前常态）' })
    }
  }
  // 【oe-audit C5】读取 1 次 + parse 1 次，三消费方（detailPaths/piVersion/首屏表格）
  // 共享同一 events（评估器内部另行 parse 的口径与 parseJournalLines 同源）
  const journalWarn = (line: string): void => mainLogger.warn(line)
  const mainLines = readJournalLines(join(crashesDir, 'main.jsonl'), journalWarn)
  const runtimeLines = readJournalLines(join(crashesDir, 'runtime.jsonl'), journalWarn)
  const journalEvents = [...parseJournalLines(mainLines).events, ...parseJournalLines(runtimeLines).events]

  // ② 各层日志家族尾部（每家族 mtime 最新一份取末 256KB）
  collectLogFamilyTails(logsDir, entries, missing)

  // ③ 近 24h 水位行摘录（从最新 runtime 日志提取；[watermark] 5min 明细行不在台账）
  const runtimeLog = pickLatestFile(logsDir, 'runtime-')
  const watermarkContent = runtimeLog === null ? null : extractRecentWatermarkLines(readTextIfExists(runtimeLog) ?? '', now).join('\n')
  if (watermarkContent !== null && watermarkContent !== '') {
    entries.push({
      archivePath: 'watermark-recent-24h.log',
      content: watermarkContent + '\n',
      note: `近 24h 内存水位行摘录（runtime 日志 [watermark] 5min 明细，窗口截止 ${new Date(now).toISOString()}）`,
    })
  } else {
    missing.push({ archivePath: 'watermark-recent-24h.log', reason: '最新 runtime 日志中窗口内无水位行（runtime 未运行或日志缺失）' })
  }

  // ④ 台账事件 detailPath 引用的深查文件（D1 schema 配对设计；尾部同口径防全量 stderr 撑包）
  const detailPaths = collectDetailPaths(journalEvents)
  for (const detail of detailPaths.included) {
    const full = join(dataDir, detail)
    if (existsSync(full)) {
      entries.push({
        archivePath: detail.split('\\').join('/'),
        sourcePath: full,
        tailBytes: DIAGNOSTIC_TAIL_BYTES,
        note: '台账事件 detailPath 引用的崩溃取证深查文件（尾部 256KB）',
      })
    } else {
      missing.push({ archivePath: detail, reason: 'detailPath 指向的文件不存在（可能已被保留期清理）' })
    }
  }
  if (detailPaths.excluded > 0) {
    missing.push({ archivePath: '(detailPath)', reason: `detailPath 引用超过 ${MAX_DETAIL_FILES} 个，仅收最新 ${MAX_DETAIL_FILES} 个` })
  }

  // ⑤ 触发条件状态表 + summary.md（D2 评估器每次导出必算；D6「每次导出必算」）
  const evaluated = evaluateTriggerConditions({ mainLines, runtimeLines })
  const environment: DiagnosticEnvironment = {
    appVersion: options.appVersion ?? 'unknown',
    piVersion: extractLatestPiVersion(journalEvents),
    platform: process.platform,
    platformRelease: osRelease(),
    arch: process.arch,
    nodeVersion: process.version,
    ...readRunState(dataDir),
  }
  const exportedAt = new Date(now).toISOString()
  const collectResult: Omit<DiagnosticCollectResult, 'entries'> = { missing, environment, evaluated, exportedAt }
  entries.push({
    archivePath: 'summary.md',
    content: buildSummaryMarkdown({ entries, journalEvents, ...collectResult }),
    note: '人读摘要（最近 10 条台账事件 + 触发状态表 + 包内清单说明 + DiagnosticReports 指引）',
  })

  return { entries, ...collectResult }
}

/**
 * 台账事件中 detailPath 字段抽取（去重，最新事件优先，帽 MAX_DETAIL_FILES）。
 * 只收相对路径形态（D1 schema 例：logs/pi-crash-….log）；绝对路径/越界路径不收
 * （诊断包不读 dataDir 之外的任何文件）。【oe-audit C5】入参 = 共享 parse 产物。
 */
function collectDetailPaths(events: readonly DatedEvent[]): { included: string[]; excluded: number } {
  const seen: string[] = []
  let excluded = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const detail = events[i]?.raw.detailPath
    if (typeof detail !== 'string' || detail === '') continue
    const normalized = detail.split('\\').join('/')
    if (normalized.startsWith('/') || normalized.includes('..')) continue // 越界路径不收
    if (seen.includes(normalized)) continue
    if (seen.length >= MAX_DETAIL_FILES) {
      excluded++
      continue
    }
    seen.push(normalized)
  }
  return { included: seen.reverse(), excluded }
}

// ── summary.md 渲染（纯函数）──────────────────────────────────────────────────

/** 环境块 + 状态表 + 首屏表格 + 清单说明 + DiagnosticReports 指引（D6 summary.md 三段明文）。 */
export function buildSummaryMarkdown(
  collected: Omit<DiagnosticCollectResult, 'entries'>
    & { entries: DiagnosticEntry[]; journalEvents: readonly DatedEvent[] },
): string {
  const { environment, evaluated, exportedAt, missing } = collected
  const lines: string[] = []
  lines.push('# TaiJi 诊断包')
  lines.push('')
  lines.push(`导出时刻：${exportedAt}`)
  lines.push('')
  lines.push(`> ${DIAGNOSTIC_EXPORT_PRIVACY_NOTICE}`)
  lines.push('')
  lines.push('## 环境信息')
  lines.push('')
  lines.push(`- app 版本：${environment.appVersion}`)
  lines.push(`- pi 版本：${environment.piVersion}`)
  lines.push(`- 平台：${environment.platform} ${environment.platformRelease} (${environment.arch})，Node ${environment.nodeVersion}`)
  lines.push(`- 运行状态：main 存活 marker ${environment.markerPresent ? '存在' : '不存在'}；runtime checkpoint ${environment.checkpointPresent ? '存在' : '不存在'}（失败现场 ${environment.checkpointFailedCount} 份）`)
  lines.push(`- 台账解析：main ${evaluated.parsedEventCount.main} 条 / runtime ${evaluated.parsedEventCount.runtime} 条（坏行 main ${evaluated.skippedLineCount.main} / runtime ${evaluated.skippedLineCount.runtime}）`)
  lines.push('')
  lines.push('## 最近台账事件')
  lines.push('')
  lines.push(recentEventsTable(collected.journalEvents))
  lines.push('')
  lines.push('## 触发条件状态表')
  lines.push('')
  if (evaluated.trippedIds.length > 0) {
    lines.push(`**WARN：${evaluated.trippedIds.length} 条越线（#${evaluated.trippedIds.join('、#')}）**`)
    lines.push('')
  }
  lines.push('| # | 条件 | 阈值 | 当前值 | 状态 | 标注 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const row of evaluated.rows) lines.push(conditionRowLine(row))
  lines.push('')
  lines.push('## 包内文件清单')
  lines.push('')
  for (const entry of collected.entries) lines.push(`- \`${entry.archivePath}\` — ${entry.note}`)
  for (const item of missing) lines.push(`- \`${item.archivePath}\` — 缺失：${item.reason}`)
  lines.push('')
  lines.push('## DiagnosticReports 指引（进程级系统崩溃报告）')
  lines.push('')
  lines.push('macOS：进程级崩溃（renderer OOM / SIGTRAP 等）的系统报告在 `~/Library/Logs/DiagnosticReports/`，')
  lines.push('文件为 `.ips` 格式，文件名含进程名与时刻（如 `Electron Helper (Renderer)-<日期>-<时刻>.ips`）。')
  lines.push('系统会自动清理旧报告——崩溃后尽早取用。')
  lines.push('Windows：事件查看器（eventvwr）→ Windows 日志 → 应用程序（来源 Electron）；Linux：journalctl / coredumpctl。')
  lines.push('')
  return lines.join('\n')
}

/**
 * 首屏表格：两本台账合并按 ts 降序取前 N 条。【oe-audit C5】消费共享 parse 产物
 * （journalEvents，与 detailPaths/piVersion 同一次 parseJournalLines 输出）——不再
 * 对已读过的台账文件二次 readFileSync + 逐行 parse。
 */
function recentEventsTable(events: readonly DatedEvent[]): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const rows = [...events]
    .sort((a, b) => b.tsMs - a.tsMs)
    .slice(0, SUMMARY_RECENT_EVENT_COUNT)
    .map((event) => {
      const raw = event.raw
      return {
        ts: str(raw.ts),
        layer: str(raw.layer),
        event: str(raw.event),
        sessionId: str(raw.sessionId),
        reason: str(raw.reason),
        detail: str(raw.detailDigest).replace(/\|/g, '\\|').slice(0, SUMMARY_DETAIL_DIGEST_MAX_CHARS),
      }
    })
  const head = '| 时间 | 层 | 事件 | sessionId | 原因 | 详情摘要 |'
  const sep = '| --- | --- | --- | --- | --- | --- |'
  const body = rows.map((r) => `| ${r.ts} | ${r.layer} | ${r.event} | ${r.sessionId} | ${r.reason} | ${r.detail} |`)
  return [head, sep, ...(body.length > 0 ? body : ['| （台账为空） | | | | | |'])].join('\n')
}

function conditionRowLine(row: TriggerConditionRow): string {
  const cell = (v: string): string => v.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  return `| ${row.id} | ${cell(row.description)} | ${cell(row.threshold)} | ${cell(row.currentValue)} | ${row.status} | ${cell(row.note ?? '')} |`
}

// ── IO 编排 ───────────────────────────────────────────────────────────────────

/** fs 错误归一：保留具体 errno（A2 不吞成布尔），无 code 的归 EUNKNOWN 并带原文消息。 */
export function normalizeFsError(err: unknown): { code: string; message: string } {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return { code: (err as { code: string }).code, message: err instanceof Error ? err.message : String(err) }
  }
  return { code: 'EUNKNOWN', message: err instanceof Error ? err.message : String(err) }
}

/** exportDiagnosticBundle 注入面：outPath 必传（D6 用户自选保存位置由 IPC 层先取得）。 */
export interface ExportDiagnosticBundleOptions extends CollectDiagnosticOptions {
  outPath: string
}

/**
 * 导出主入口：收集清单 → 逐条目读源（尾部截取）→ zip 打包 → 落盘。
 * 零抛错：所有失败归一为 status='error' + 具体 errno（IPC 层 invoke 无 rejection 面，
 * 对齐 log-retention-ipc 先例）。
 */
export function exportDiagnosticBundle(options: ExportDiagnosticBundleOptions): DiagnosticExportBundleResult {
  try {
    const collected = buildDiagnosticEntries(options)
    const zipInputs = collected.entries.map((entry) => {
      // 生成条目直接编码内容；来源条目全量（台账现档 ≤10MB 由 writer 轮转保证）或尾部截取
      const data = entry.content !== undefined
        ? Buffer.from(entry.content, 'utf8')
        : entry.tailBytes === undefined
          ? readFileSync(entry.sourcePath!)
          : tailBytes(readFileSync(entry.sourcePath!), entry.tailBytes)
      return {
        archivePath: entry.archivePath,
        data,
        mtime: entry.sourcePath !== undefined ? statSync(entry.sourcePath).mtime : undefined,
      }
    })
    const zip = buildZipArchive(zipInputs)
    writeFileSync(options.outPath, zip)
    const summary: DiagnosticExportSummary = {
      exportedAt: collected.exportedAt,
      appVersion: collected.environment.appVersion,
      piVersion: collected.environment.piVersion,
      platform: collected.environment.platform,
      trippedConditionIds: collected.evaluated.trippedIds,
      evaluatedConditionCount: collected.evaluated.rows.length,
      entryCount: collected.entries.length,
      missingEntries: collected.missing.map((m) => `${m.archivePath}（${m.reason}）`),
      privacyNotice: DIAGNOSTIC_EXPORT_PRIVACY_NOTICE,
    }
    return {
      status: 'exported',
      path: options.outPath,
      bytes: zip.length,
      entryCount: collected.entries.length,
      entryNames: collected.entries.map((e) => e.archivePath),
      summary,
    }
  } catch (err) {
    return { status: 'error', error: normalizeFsError(err) }
  }
}
