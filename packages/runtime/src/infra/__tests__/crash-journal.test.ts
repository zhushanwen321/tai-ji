/**
 * crash-journal.ts 测试（crash-forensics-and-watchdog §3.3 D1，实施单元 u1b）。
 *
 * 真实 IO（不 mock node:fs）：全部写删目标位于 mkdtempSync 自建 tmp 目录（fs-guard
 * 白名单 #1），不触碰真实数据目录。轮转等待经 writer.close()（等轮转续体 + 流 flush
 * 落盘）取得确定性断言点，不依赖 timer——本文件不使用 fake timers。
 *
 * 断言对照验收条款：
 * - 注入小阈值写满触发 `.jsonl` → `.jsonl.1` → `.jsonl.2` 级联轮转、末 3 段保留最旧删除
 * - 单行 JSONL：逐行 JSON.parse 可解析（无截断行）
 * - append 在轮转边界不丢行：跨段行序守恒（保留行 = 写入行的连续尾部、序号无缺无重）
 * - best-effort：目录创建失败时 append 不抛、close 可 await
 * - 历史超档弥合：打开时盘上既有档已超限 → 同步级联（跨重启 size 上限）
 * - runtime 侧单例：init/get/close 生命周期（未初始化 no-op）
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CrashJournalEvent } from '@taiji/shared'
import { createCrashJournalWriter, type CrashJournalFileWriter } from '../crash-journal.js'

let dataDir: string
const createdDirs: string[] = []

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'crash-journal-'))
  createdDirs.push(dataDir)
})

afterAll(() => {
  // maxRetries+retryDelay（教训 d9ad39cb8）：teardown 递归删除与在途异步写竞争，满载下
  // ENOTEMPTY 一次瞬态失败即抛——重试吞掉瞬态窗口
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 固定形态事件（detailDigest 定长 → 行字节数稳定，每档行数可推算）。 */
function makeEvent(i: number): CrashJournalEvent {
  return {
    layer: 'pi',
    event: 'crash',
    sessionId: `s-${String(i).padStart(3, '0')}`,
    exitCode: 1,
    detailDigest: 'x'.repeat(80),
  }
}

/** 读一个段文件的行（不存在返回空数组）。 */
function readSegment(name: string): string[] {
  const p = join(dataDir, 'logs', 'crashes', name)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter((l) => l !== '')
}

/** 旧 → 新聚合全部段（.2 最旧 → .1 → 活跃档最新）。 */
function readAllOldToNew(): string[] {
  return [...readSegment('runtime.jsonl.2'), ...readSegment('runtime.jsonl.1'), ...readSegment('runtime.jsonl')]
}

/** 逐行 JSON.parse（任何截断/半行都会在此抛出）。 */
function parseLines(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>)
}

/**
 * 让出事件循环（真实 timer）等待轮转续体落地：轮转是异步的（end 旧流须等真实
 * WriteStream 'close' 的 IO 轮次），同步密集 append 会全部进 pendingLines 由首次
 * 轮转窗口吞并（logger.ts 既有形态）——周期性 tick 让每次轮转在下一次 append 判定
 * 前真实完成，多段级联才逐次发生。
 */
function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('crash-journal writer（真实 IO，tmp 隔离）', () => {
  let writer: CrashJournalFileWriter
  afterEach(() => {
    // afterEach 保证失败用例也收口（close 幂等）
    return writer?.close().catch(() => {})
  })

  it('目录不存在自动创建；append 单行 JSONL 逐行可解析；ts 缺省补全、显式值/null 不覆盖', async () => {
    expect(existsSync(join(dataDir, 'logs', 'crashes'))).toBe(false) // 前置：mkdtemp 只有根目录
    writer = createCrashJournalWriter({ role: 'runtime', dataDir })
    expect(existsSync(join(dataDir, 'logs', 'crashes'))).toBe(true) // 构造即自动创建
    writer.append(makeEvent(0))
    writer.append({ ...makeEvent(1), ts: '2000-01-01T00:00:00Z' })
    writer.append({ ...makeEvent(2), ts: null })
    await writer.close()

    const file = join(dataDir, 'logs', 'crashes', 'runtime.jsonl')
    expect(existsSync(file)).toBe(true)
    const records = parseLines(readSegment('runtime.jsonl'))
    expect(records).toHaveLength(3)
    // ts 缺省 → writer 补写入时刻（合法 ISO）
    expect(typeof records[0]!.ts).toBe('string')
    expect(Number.isNaN(new Date(records[0]!.ts as string).getTime())).toBe(false)
    // 显式值 / 显式 null 原样保留（writer 不改写调用方声明）
    expect(records[1]!.ts).toBe('2000-01-01T00:00:00Z')
    expect(records[2]!.ts).toBeNull()
    // 字段往返不丢
    expect(records[0]).toMatchObject({ layer: 'pi', event: 'crash', sessionId: 's-000', exitCode: 1 })
  })

  it('注入小阈值写满触发级联轮转：.jsonl/.1/.2 三段存在、末 3 段保留、最旧滚出删除、留下行 = 连续尾部', async () => {
    // 行 ~193B：threshold 500 → 每 2 行写满（2×193≤500 < 3×193）；30 行 = 15 档 → 留末 3 档
    writer = createCrashJournalWriter({ role: 'runtime', dataDir, maxFileBytes: 500 })
    for (let i = 0; i < 30; i++) {
      writer.append(makeEvent(i))
      if (i % 3 === 2) await tick() // 周期性让轮转续体真实落地（详见 tick 注释）
    }
    await writer.close()

    expect(existsSync(join(dataDir, 'logs', 'crashes', 'runtime.jsonl'))).toBe(true)
    expect(existsSync(join(dataDir, 'logs', 'crashes', 'runtime.jsonl.1'))).toBe(true)
    expect(existsSync(join(dataDir, 'logs', 'crashes', 'runtime.jsonl.2'))).toBe(true)
    // 不存在第 4 段（.3）——级联最旧删除
    expect(existsSync(join(dataDir, 'logs', 'crashes', 'runtime.jsonl.3'))).toBe(false)

    const records = parseLines(readAllOldToNew())
    const ids = records.map((r) => r.sessionId) as string[]
    // 末 3 段保留 = 早期档已被滚出删除（30 行只余尾部若干档）
    expect(ids.length).toBeLessThan(30)
    expect(ids[0]).not.toBe('s-000')
    // 留下的行是写入序列的连续尾部、无中间丢失（pendingLines 回放正确性的证据）
    expect(ids[ids.length - 1]).toBe('s-029')
    const nums = ids.map((s) => Number(s.slice(2)))
    for (let i = 1; i < nums.length; i++) expect(nums[i]).toBe(nums[i - 1] + 1)
    // 段间级联次序正确：.2 最旧、顶档最新
    expect(Number(readSegment('runtime.jsonl.2')[0]!.match(/s-(\d+)/)![1])).toBeLessThan(
      Number(readSegment('runtime.jsonl')[0]!.match(/s-(\d+)/)![1]),
    )
  })

  it('append 在轮转边界不丢行：轮转窗口并发写入后聚合 = 写入行全量连续尾部、无缺无重、无截断行', async () => {
    // threshold 2000 → 每档 10 行；25 行触发 2 次轮转后仍全部落在 3 档内（容量 30 ≥ 25）
    writer = createCrashJournalWriter({ role: 'runtime', dataDir, maxFileBytes: 2000 })
    for (let i = 0; i < 25; i++) {
      writer.append(makeEvent(i))
      if (i % 5 === 4) await tick() // 让 2 次轮转（行 11 / 行 21 处触发）在下轮判定前落地
    }
    await writer.close()

    // 2 次轮转确实发生（边界形态真实命中）
    expect(readSegment('runtime.jsonl.1').length).toBeGreaterThan(0)
    expect(readSegment('runtime.jsonl.2').length).toBeGreaterThan(0)
    const lines = readAllOldToNew()
    expect(lines).toHaveLength(25) // 总行守恒（pendingLines 回放零丢失）
    const ids = parseLines(lines).map((r) => r.sessionId)
    expect(ids).toEqual(Array.from({ length: 25 }, (_, i) => `s-${String(i).padStart(3, '0')}`)) // 连续无缺无重
  })

  it('best-effort：crashes 目录创建失败时 append 不抛、close 可 await（旁路设施不放大为调用链故障）', async () => {
    // dataDir 指向普通文件 → mkdirSync(recursive) ENOTDIR → writer 降级永久 no-op
    const notADir = join(dataDir, 'not-a-dir')
    writeFileSync(notADir, 'x')
    writer = createCrashJournalWriter({ role: 'runtime', dataDir: notADir })
    expect(() => {
      for (let i = 0; i < 5; i++) writer.append(makeEvent(i))
    }).not.toThrow()
    await expect(writer.close()).resolves.toBeUndefined()
  })

  it('历史超档弥合：打开时盘上既有档已超阈值 → 同步级联，旧内容滚入 .1、新行写新档（跨重启 size 上限）', async () => {
    const crashesDir = join(dataDir, 'logs', 'crashes')
    mkdirSync(crashesDir, { recursive: true })
    // 模拟上次运行崩溃遗留的超大档（500B 上限，盘上 600B）
    const stale = makeEvent(99)
    writeFileSync(join(crashesDir, 'runtime.jsonl'), `${JSON.stringify({ ...stale, detailDigest: 'y'.repeat(500) })}\n`)

    writer = createCrashJournalWriter({ role: 'runtime', dataDir, maxFileBytes: 500 })
    writer.append(makeEvent(100))
    await writer.close()

    expect(existsSync(join(crashesDir, 'runtime.jsonl.1'))).toBe(true)
    expect(readSegment('runtime.jsonl.1')).toHaveLength(1) // 旧档整体滚下
    expect(readSegment('runtime.jsonl.1')[0]).toContain('s-099')
    expect(readSegment('runtime.jsonl')).toHaveLength(1) // 新档从新行开始
    expect(readSegment('runtime.jsonl')[0]).toContain('s-100')
  })
})

describe('错误/降级路径（review S-12a：写错误自愈；【oe-audit C3】同步形态）', () => {
  it('同步写错误（档位是目录 → EISDIR）→ append 不抛、warn 出口 once、后续 append 不放大', async () => {
    // vi.resetModules + 动态 import：拿到干净的模块级 failureReported once 状态（既有
    // 单例 describe 同款形态），并经 initCrashJournal 第二参注入可观测 sink
    vi.resetModules()
    const mod = await import('../crash-journal.js')
    const warn = vi.fn()
    // 目标档预建为目录：appendFileSync EISDIR 同步抛错 → append catch → warn once
    mkdirSync(join(dataDir, 'logs', 'crashes', 'runtime.jsonl'), { recursive: true })
    mod.initCrashJournal(dataDir, { warn })
    expect(() => mod.getCrashJournal().append(makeEvent(0))).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('append failed')
    // once 语义：继续 append（仍失败）不再刷 warn（防失败风暴）
    expect(() => mod.getCrashJournal().append(makeEvent(1))).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    // close 可 await：同步形态收口不挂起、不向调用链放大
    await expect(mod.closeCrashJournal()).resolves.toBeUndefined()
  })

  it('轮转边界同步收口：触发轮转的行直接写新档（无 pending 窗口），close 后行不丢', async () => {
    // 【oe-audit C3】同步形态下轮转即时生效（append 完成即落盘），原「轮转窗口内 close
    // 等 pending 回放」机制已删；本用例保留同一断言面：轮转边界的行序与归属不因 close 时序变化
    const w = createCrashJournalWriter({ role: 'runtime', dataDir, maxFileBytes: 500 })
    w.append(makeEvent(0))
    w.append(makeEvent(1))
    w.append(makeEvent(2)) // 2×~193B 后第三行超 500 → 触发轮转，本行直接写新档
    await w.close() // 同步形态 close 即完成
    expect(parseLines(readSegment('runtime.jsonl.1')).map((r) => r.sessionId)).toEqual(['s-000', 's-001'])
    expect(parseLines(readSegment('runtime.jsonl')).map((r) => r.sessionId)).toEqual(['s-002'])
  })
})

describe('runtime 侧单例（initCrashJournal / getCrashJournal / closeCrashJournal）', () => {
  // 模块级单例状态经 vi.resetModules + 动态 import 隔离（logger-rotation.test.ts 同款）
  vi.resetModules()

  it('未初始化为 no-op；init 后 get 返回同实例并落盘 runtime.jsonl；close 后回 no-op', async () => {
    const mod = await import('../crash-journal.js')
    // 未 init：no-op 不产生任何目录/文件
    expect(() => mod.getCrashJournal().append(makeEvent(0))).not.toThrow()
    expect(existsSync(join(dataDir, 'logs', 'crashes'))).toBe(false)

    const w1 = mod.initCrashJournal(dataDir)
    const w2 = mod.getCrashJournal()
    expect(w2).toBe(w1) // 单例
    // init 幂等
    expect(mod.initCrashJournal(dataDir)).toBe(w1)
    w2.append(makeEvent(1))
    await mod.closeCrashJournal()

    const records = parseLines(readSegment('runtime.jsonl'))
    expect(records).toHaveLength(1)
    expect(records[0]!.sessionId).toBe('s-001')

    // close 后 get 回到 no-op（再 append 不抛、不复活文件）
    expect(() => mod.getCrashJournal().append(makeEvent(2))).not.toThrow()
    expect(readSegment('runtime.jsonl')).toHaveLength(1)
    await expect(mod.closeCrashJournal()).resolves.toBeUndefined() // 二次 close 幂等
  })

  it('单例固定写 runtime 角色：文件名为 runtime.jsonl（非 main.jsonl）', async () => {
    const mod = await import('../crash-journal.js')
    mod.initCrashJournal(dataDir)
    mod.getCrashJournal().append(makeEvent(3))
    await mod.closeCrashJournal()
    expect(existsSync(join(dataDir, 'logs', 'crashes', 'runtime.jsonl'))).toBe(true)
    expect(existsSync(join(dataDir, 'logs', 'crashes', 'main.jsonl'))).toBe(false)
  })
})
