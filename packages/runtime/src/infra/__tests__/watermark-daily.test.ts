/**
 * u1e watermark-daily 自然日聚合测试（crash-forensics-and-watchdog §3.3 D1 watermark-daily 行）。
 *
 * 覆盖映射（impl-plan u1e 验收条款）：
 * - 聚合数值正确：构造样本序列断言 rss/heapUsed min/max/avg（构造样本手工算期望值）
 * - 日翻转才写：同日任意多样本 0 行；跨日首个样本把前一日完整窗口写出恰 1 行
 * - 重启后 coverage 起点重置：vi.resetModules + 动态 import 模拟新进程（聚合态随模块
 *   图重建清零），coverageStart = 新进程内首个样本时刻
 * - 当日尚未完结时不写（写完整窗口）：最后一个未翻转的窗口无台账行
 * - coverage 起止戳随条目落盘（评估器对 coverage<50% 降权的数据前提，附录 A #4/#5）
 * - 采样入口 = formatMemoryWatermarkLine（既有 5min 水位定时器的每拍消费点，钩子挂接面）
 * - 台账未初始化时聚合不抛（no-op 单例兜底，聚合前进无行）
 *
 * 真实 IO（不 mock fs/writer）：写删目标 mkdtempSync 自建 tmp 自删（fs-guard 白名单）；
 * 时间经 recordWatermarkDailySample 第二参注入（不与 fake timers / 真实流 IO 交互）；
 * 断言经 writer.close() 后读 runtime.jsonl。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryWatermarkSample } from '../logger.js'

const createdDirs: string[] = []
let dataDir: string

beforeEach(() => {
  // 每用例重置模块图 = 一次「新进程」：聚合态与 crash-journal 单例随之清零
  vi.resetModules()
  dataDir = mkdtempSync(join(tmpdir(), 'watermark-daily-'))
  createdDirs.push(dataDir)
})

afterEach(async () => {
  // close 当前模块图的 writer（beforeEach 已重置图，此处 re-import 拿到的是用例用过的图）
  const mod = await import('../crash-journal.js')
  await mod.closeCrashJournal()
})

afterAll(() => {
  // maxRetries+retryDelay（crash-journal.test.ts 同款）：teardown 与在途异步写竞争吞瞬态
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function makeSample(rss: number, heapUsed: number): MemoryWatermarkSample {
  return { rss, heapUsed, heapTotal: rss, external: 0, activeSessions: 1, piProcesses: 1 }
}

/** 固定测试时刻（UTC 日期直接可读：08:00Z / 12:00Z 同日，次日 +1）。 */
function at(iso: string): Date {
  return new Date(iso)
}

function readJournalRecords(dir: string): Array<Record<string, unknown>> {
  const p = join(dir, 'logs', 'crashes', 'runtime.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

interface DailyDigest {
  coverageStart: string
  coverageEnd: string
  rssMin: number
  rssMax: number
  rssAvg: number
  // heap 族键名对齐 d2 评估器取值链（trigger-evaluator extractWatermarkSample 读
  // digest.heapMax 作当日峰值；键名不符则静默回退顶层均值）——键名契约漂移即测试红。
  heapMin: number
  heapMax: number
  heapAvg: number
  samples: number
}

function digestOf(record: Record<string, unknown>): DailyDigest {
  return JSON.parse(record.detailDigest as string) as DailyDigest
}

/** 初始化台账并返回被测模块（同一模块图：聚合 flush 经 getCrashJournal 单例落到 dataDir）。 */
async function setup(): Promise<{
  logger: typeof import('../logger.js')
  crashJournal: typeof import('../crash-journal.js')
}> {
  const logger = await import('../logger.js')
  const crashJournal = await import('../crash-journal.js')
  crashJournal.initCrashJournal(dataDir)
  return { logger, crashJournal }
}

/**
 * 中途确定性 flush 点：close 当前 writer（缓冲落盘）+ 立即 re-init 同 dataDir 续写
 * （flags 'a'，聚合态在 logger 侧不受影响）——用例中间读盘断言的同步手段。
 */
async function flushJournal(crashJournal: typeof import('../crash-journal.js')): Promise<void> {
  await crashJournal.closeCrashJournal()
  crashJournal.initCrashJournal(dataDir)
}

describe('watermark-daily 自然日聚合（u1e）', () => {
  it('聚合数值正确：3 样本 → avg 落顶层 rss/heapUsed，min/max/samples 落 digest（构造样本手算期望）', async () => {
    const { logger, crashJournal } = await setup()
    // day1：rss 100/200/300 → min 100 max 300 avg 200；heap 10/20/30 → min 10 max 30 avg 20
    logger.recordWatermarkDailySample(makeSample(100, 10), at('2026-09-10T08:00:00Z'))
    logger.recordWatermarkDailySample(makeSample(200, 20), at('2026-09-10T12:00:00Z'))
    logger.recordWatermarkDailySample(makeSample(300, 30), at('2026-09-10T20:00:00Z'))
    // 日翻转触发 day1 窗口写出
    logger.recordWatermarkDailySample(makeSample(999, 999), at('2026-09-11T08:00:00Z'))
    await crashJournal.closeCrashJournal()

    const records = readJournalRecords(dataDir)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ layer: 'runtime', event: 'watermark-daily' })
    expect(records[0]!.rss).toBe(200)
    expect(records[0]!.heapUsed).toBe(20)
    const d = digestOf(records[0]!)
    expect(d.rssMin).toBe(100)
    expect(d.rssMax).toBe(300)
    expect(d.rssAvg).toBe(200)
    expect(d.heapMin).toBe(10)
    expect(d.heapMax).toBe(30)
    expect(d.heapAvg).toBe(20)
    expect(d.samples).toBe(3)
    // d2 评估器 #4 取值链的键名契约（digest.heapMax 为当日峰值，缺失则回退顶层均值）
    expect(Object.keys(d)).toContain('heapMax')
  })

  it('日翻转才写：同日多样本 0 行；跨日样本写出前一日恰 1 行；最后一个未完结窗口不写', async () => {
    const { logger, crashJournal } = await setup()
    // day1 三个样本：无翻转 → 台账无行
    logger.recordWatermarkDailySample(makeSample(100, 10), at('2026-09-10T08:00:00Z'))
    logger.recordWatermarkDailySample(makeSample(150, 15), at('2026-09-10T12:00:00Z'))
    logger.recordWatermarkDailySample(makeSample(120, 12), at('2026-09-10T23:59:00Z'))
    expect(readJournalRecords(dataDir)).toHaveLength(0) // 当日尚未完结不写

    // day2 首个样本：day1 完整窗口写出
    logger.recordWatermarkDailySample(makeSample(200, 20), at('2026-09-11T08:00:00Z'))
    await flushJournal(crashJournal) // 中途 flush 落盘（re-init 续写同文件）
    let records = readJournalRecords(dataDir)
    expect(records).toHaveLength(1)
    expect(records[0]!.event).toBe('watermark-daily')
    // coverage 戳 = day1 窗口首末样本时刻（非写入时刻）
    const d1 = digestOf(records[0]!)
    expect(d1.coverageStart).toBe('2026-09-10T08:00:00.000Z')
    expect(d1.coverageEnd).toBe('2026-09-10T23:59:00.000Z')

    // day2 窗口在测试结束时仍未翻转 → 不写（写完整窗口）；day3 样本才写出 day2
    logger.recordWatermarkDailySample(makeSample(300, 30), at('2026-09-12T08:00:00Z'))
    await crashJournal.closeCrashJournal()
    records = readJournalRecords(dataDir)
    expect(records).toHaveLength(2)
    const d2 = digestOf(records[1]!)
    expect(d2.coverageStart).toBe('2026-09-11T08:00:00.000Z')
    expect(d2.coverageEnd).toBe('2026-09-11T08:00:00.000Z') // 单样本窗口：起止同点
    expect(records[1]!.rss).toBe(200) // day2 窗口唯一样本 rss=200（day3 的 300 属于 day3 窗口，未完结不写）

    await crashJournal.closeCrashJournal()
    expect(readJournalRecords(dataDir)).toHaveLength(2) // close 不补写未完结窗口
  })

  it('重启清零：resetModules 后 coverage 起点从新进程内首个样本重算（不延续旧窗口）', async () => {
    const { logger, crashJournal } = await setup()
    // 「旧进程」：day1 首样本后进程死亡（窗口未完结、从未落盘）
    logger.recordWatermarkDailySample(makeSample(100, 10), at('2026-09-10T08:00:00Z'))
    await crashJournal.closeCrashJournal()

    // 新进程（同 dataDir——台账文件续写，聚合态随模块图重建清零）
    vi.resetModules()
    const fresh = await setup()
    fresh.logger.recordWatermarkDailySample(makeSample(500, 50), at('2026-09-10T14:00:00Z')) // 同日重启：剩余窗口从重启时刻起算
    fresh.logger.recordWatermarkDailySample(makeSample(600, 60), at('2026-09-10T18:00:00Z'))
    fresh.logger.recordWatermarkDailySample(makeSample(1, 1), at('2026-09-11T08:00:00Z')) // 翻日写出
    await fresh.crashJournal.closeCrashJournal()

    const records = readJournalRecords(dataDir)
    expect(records).toHaveLength(1) // 旧进程窗口未完结已随进程消亡，不伪装成已落盘
    const d = digestOf(records[0]!)
    // coverage 起点重置 = 新进程首个样本时刻（08:00 旧样本不混入）
    expect(d.coverageStart).toBe('2026-09-10T14:00:00.000Z')
    expect(d.coverageEnd).toBe('2026-09-10T18:00:00.000Z')
    expect(records[0]!.rss).toBe(550) // (500+600)/2——聚合态确为新窗口独立累积
    expect(d.samples).toBe(2)
  })

  it('采样入口 = formatMemoryWatermarkLine：经既有水位行函数驱动同样聚合（钩子挂接面回归）', async () => {
    const { logger, crashJournal } = await setup()
    const line1 = logger.formatMemoryWatermarkLine(makeSample(100, 10))
    expect(line1).toContain('[watermark] rss=0.0MB') // 格式化输出不受聚合副作用影响（100B → 0.0MB）
    logger.formatMemoryWatermarkLine(makeSample(300, 30))
    // 未翻日：水位行照产、台账无行
    expect(logger.formatMemoryWatermarkLine(makeSample(200, 20))).toContain('[watermark]')
    expect(readJournalRecords(dataDir)).toHaveLength(0)

    // 翻日：聚合经本入口同样落台账（真实驱动链 = index.ts 定时器回调的同款调用）。
    // 翻日样本用远离当前的固定日期（前 3 样本经 formatMemoryWatermarkLine 用真实 now——
    // day 值无所谓，只要与翻转日不同必然触发 flush）。
    logger.recordWatermarkDailySample(makeSample(400, 40), at('2027-01-01T00:00:00Z'))
    await crashJournal.closeCrashJournal()
    const records = readJournalRecords(dataDir)
    expect(records).toHaveLength(1)
    expect(records[0]!.rss).toBe(200) // (100+300+200)/3
    expect(digestOf(records[0]!).samples).toBe(3)
  })

  it('台账未初始化（no-op 单例）：聚合不抛、聚合态正常前进，翻日后无行', async () => {
    const logger = (await import('../logger.js'))
    expect(() => {
      logger.recordWatermarkDailySample(makeSample(100, 10), at('2026-09-10T08:00:00Z'))
      logger.recordWatermarkDailySample(makeSample(300, 30), at('2026-09-11T08:00:00Z'))
      logger.formatMemoryWatermarkLine(makeSample(200, 20))
    }).not.toThrow()
    expect(readJournalRecords(dataDir)).toHaveLength(0) // no-sink 窗口丢弃，不产生文件
  })
})
