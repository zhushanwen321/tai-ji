/**
 * crash-journal 单测（crash-forensics-and-watchdog §3.3 D1，实施计划 u1c 验收条款）。
 *
 * 覆盖（验收条款「main 池 vitest 绿：注入小阈值级联轮转、末 3 段保留、单行 JSONL、
 * 轮转边界不丢行、写目标全在 mkdtempSync 自建目录」）：
 * - append 单行 JSONL 落盘 + 字段 JSON 往返 + ts 缺省补写
 * - 注入小阈值触发级联轮转（.jsonl → .jsonl.1 → .jsonl.2）
 * - 末 3 段保留（最老段删除，不出现第 4 段；三段拼接近尾部行连续无缺口）
 * - 轮转边界不丢行（单代轮转内行数守恒 + 每行完整 JSON + 全局顺序递增）
 * - 跨重启 size 弥合：既有超阈主文件在下条 append 时先滚动
 * - 序列化失败 best-effort：循环引用 event 不抛不落盘，writer 状态不污染
 * - fs 失败 best-effort：目录不可建时 append 不抛（连续调用容错）
 * - 单例：未 init no-op、init 幂等、getCrashJournalDir 从 TAIJI_AGENT_DATA_DIR 推导
 *
 * 全部夹具 mkdtempSync(tmpdir) 自建自删（guarded 池 fs-guard 生效中）；同步写无
 * flush 等待问题（实现为 appendFileSync，与 main-logger.test 的轮询等待形态分叉）。
 * 运行：cd apps/electron/main && npx vitest run logs/__tests__/crash-journal.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CrashJournalEvent } from '@taiji/shared'

/** 写入事件构造：sessionId 携带零填充序号（轮转断言的行标识，零填充防子串误匹配）。 */
function makeEvent(seq: number): CrashJournalEvent {
  return { layer: 'main', event: 'crash', sessionId: `sid-${String(seq).padStart(4, '0')}` }
}

/** 目录下全部台账段文件（主文件 + 滚动段），按「最老 → 最新」排序返回，逐行 JSON.parse。 */
function readSegmentsOldestFirst(dir: string): Array<{ name: string; events: Array<Record<string, unknown>> }> {
  // 段代数：滚动段 .1 是第 1 代（次新）、.2 是第 2 代（最老）——代数越大越老，
  // 「最老 → 最新」= 代数降序；主文件恒最新，排末位
  const isMain = (name: string): boolean => name === 'main.jsonl'
  const generation = (name: string): number => Number(name.slice('main.jsonl.'.length))
  const names = readdirSync(dir)
    .filter((f) => f.startsWith('main.jsonl'))
    .sort((a, b) => {
      if (isMain(a)) return 1
      if (isMain(b)) return -1
      return generation(b) - generation(a)
    })
  return names.map((name) => ({
    name,
    // 逐行 parse 本身即「单行合法 JSON」断言：任何半截行/脏行在此抛错
    events: readFileSync(join(dir, name), 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>),
  }))
}

describe('crash-journal writer', () => {
  let tmpDir: string
  let crashesDir: string
  let savedDataDir: string | undefined

  beforeEach(() => {
    vi.resetModules()
    tmpDir = mkdtempSync(join(tmpdir(), 'crash-journal-test-'))
    crashesDir = join(tmpDir, 'logs', 'crashes')
    savedDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = tmpDir
  })

  afterEach(() => {
    // 恢复（而非仅删除）原值：外部环境若设了该变量，测试不得吞掉后不还
    if (savedDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = savedDataDir
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('append 单条落盘 main.jsonl：单行合法 JSON、字段往返一致、ts 缺省补写为 ISO 时刻', async () => {
    const { CrashJournalFileWriter } = await import('../crash-journal.js')
    const writer = new CrashJournalFileWriter({ role: 'main', dir: crashesDir })
    writer.append(makeEvent(1))

    expect(readdirSync(crashesDir)).toEqual(['main.jsonl'])
    const raw = readFileSync(join(crashesDir, 'main.jsonl'), 'utf-8')
    // 单行 JSONL：恰一行且以换行结尾
    expect(raw.endsWith('\n')).toBe(true)
    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>
    expect(parsed).toMatchObject({ layer: 'main', event: 'crash', sessionId: 'sid-0001' })
    // ts 缺省补写：ISO 8601 UTC 形态（评估器窗口统计的时间轴，实现「ts 缺省补写」语义）
    expect(typeof parsed['ts']).toBe('string')
    expect(parsed['ts']).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  })

  it('event.ts 显式提供时原样保留；字段显式 null 合法落盘（字段全可空原则）', async () => {
    const { CrashJournalFileWriter } = await import('../crash-journal.js')
    const writer = new CrashJournalFileWriter({ role: 'main', dir: crashesDir })
    const event: CrashJournalEvent = { ts: '2026-09-12T02:57:03Z', layer: 'renderer', event: 'reload', exitCode: null }
    writer.append(event)

    const parsed = readSegmentsOldestFirst(crashesDir)[0].events[0]
    expect(parsed['ts']).toBe('2026-09-12T02:57:03Z')
    expect(parsed['layer']).toBe('renderer')
    expect(parsed['event']).toBe('reload')
    expect(parsed['exitCode']).toBeNull()
  })

  it('注入小阈值触发级联轮转：主文件 → .jsonl.1 → .jsonl.2，段数封顶末 3 段，尾部行连续无缺口', async () => {
    const { CrashJournalFileWriter } = await loadWriter()
    // 每行 ~96B（ts 补写定长）；240B 帽 → 每段恰 2 行，20 条翻越 .2 多代（最老段被删）
    const writer = new CrashJournalFileWriter({ role: 'main', dir: crashesDir, maxFileBytes: 240 })
    for (let i = 1; i <= 20; i++) writer.append(makeEvent(i))

    const segments = readSegmentsOldestFirst(crashesDir)
    // 末 3 段保留：恰 main.jsonl.2 / .1 / 主文件三个，无第 4 段
    expect(segments.map((s) => s.name)).toEqual(['main.jsonl.2', 'main.jsonl.1', 'main.jsonl'])
    // 尾部行连续无缺口：三段拼接（最老 → 最新）sessionId 严格递增且恰为最后 M 条写入
    const sids = segments.flatMap((s) => s.events).map((e) => e['sessionId'] as string)
    const expected = Array.from({ length: sids.length }, (_, k) => `sid-${String(20 - sids.length + 1 + k).padStart(4, '0')}`)
    expect(sids).toEqual(expected)
    // 每段自身不超帽（行级表述：帽 240B / 行 ~96B → 每段至多 2-3 行；单行 > 帽的固有
    // 边缘除外，本用例行远小于帽）
    for (const s of segments) {
      expect(s.events.length).toBeLessThanOrEqual(3)
    }
  })

  it('轮转边界不丢行：写入总数不溢出保留段数时全部行守恒、跨段顺序全局递增、末行无半截', async () => {
    const { CrashJournalFileWriter } = await loadWriter()
    // 帽 200B / 行 ~96B → 每段恰 2 行；5 行 = 2 次轮转 → .2 + .1 + 主文件，无段被删
    const writer = new CrashJournalFileWriter({ role: 'main', dir: crashesDir, maxFileBytes: 200 })
    for (let i = 1; i <= 5; i++) writer.append(makeEvent(i))

    const segments = readSegmentsOldestFirst(crashesDir)
    // 用例有效性前提：轮转确实发生（存在滚动段）
    expect(segments.length).toBeGreaterThan(1)
    // 全部 5 行守恒：无丢行、无重复、顺序不乱（.2 → .1 → 主拼接后严格递增）
    const sids = segments.flatMap((s) => s.events).map((e) => e['sessionId'] as string)
    expect(sids).toEqual(Array.from({ length: 5 }, (_, k) => `sid-${String(k + 1).padStart(4, '0')}`))
    // 每行完整：段文件以换行结尾（无被 rename 切断的半截行）
    for (const s of segments) {
      expect(readFileSync(join(crashesDir, s.name), 'utf-8').endsWith('\n')).toBe(true)
    }
  })

  it('跨重启 size 弥合：既有主文件已超阈值时，新 writer 首条 append 先滚动再写', async () => {
    const { CrashJournalFileWriter } = await loadWriter()
    // 模拟「上次运行崩溃未轮转」：直接落盘一个超阈（>240B）主文件
    mkdirSync(crashesDir, { recursive: true })
    const staleLines = Array.from({ length: 5 }, (_, k) =>
      JSON.stringify({ ts: '2026-09-11T00:00:00Z', layer: 'main', event: 'shutdown', sessionId: `stale-${k}` }) + '\n',
    ).join('')
    writeFileSync(join(crashesDir, 'main.jsonl'), staleLines)

    const writer = new CrashJournalFileWriter({ role: 'main', dir: crashesDir, maxFileBytes: 240 })
    writer.append(makeEvent(99))

    // 超阈旧文件整体滚入 .1（原样保留），新主文件只有新行
    const segments = readSegmentsOldestFirst(crashesDir)
    expect(segments.map((s) => s.name)).toEqual(['main.jsonl.1', 'main.jsonl'])
    expect(segments[0].events).toHaveLength(5)
    expect(segments[0].events[0]['sessionId']).toBe('stale-0')
    expect(segments[1].events).toHaveLength(1)
    expect(segments[1].events[0]['sessionId']).toBe('sid-0099')
  })

  it('序列化失败 best-effort：循环引用 event 不抛且不落盘（JSON.stringify 失败路径，与 fs 失败同归 best-effort）', async () => {
    const { CrashJournalFileWriter } = await loadWriter()
    const writer = new CrashJournalFileWriter({ role: 'main', dir: crashesDir })
    const circular: Record<string, unknown> = { layer: 'main', event: 'crash' }
    circular['self'] = circular // JSON.stringify 必抛 TypeError 的形态

    expect(() => writer.append(circular as unknown as CrashJournalEvent)).not.toThrow()
    // 本行放弃：目录/文件均不产生（serialize 失败发生在惰性打开之前）
    expect(existsSync(crashesDir)).toBe(false)
    // 后续合法 event 正常落盘：单条失败不污染 writer 状态
    writer.append(makeEvent(1))
    expect(readSegmentsOldestFirst(crashesDir)[0].events).toHaveLength(1)
  })

  it('fs 失败 best-effort：目录不可建（路径被同名文件占据）时 append 不抛，连续调用容错', async () => {
    const { CrashJournalFileWriter } = await loadWriter()
    // 用一个「已存在的文件路径」充当目录：mkdirSync(recursive) 必败（EEXIST/ENOTDIR）
    const blocker = join(tmpDir, 'not-a-dir')
    writeFileSync(blocker, 'occupied')
    const writer = new CrashJournalFileWriter({ role: 'main', dir: blocker })

    expect(() => writer.append(makeEvent(1))).not.toThrow()
    expect(() => writer.append(makeEvent(2))).not.toThrow()
    // 失败路径不制造任何台账文件
    expect(existsSync(join(blocker, 'main.jsonl'))).toBe(false)
  })

  it('单例：未 init 时 crashJournal.append no-op 不建目录；init 后落盘；init 幂等', async () => {
    const { initCrashJournal, crashJournal, getCrashJournalDir } = await import('../crash-journal.js')
    // 路径推导锚点：env 注入的 tmp 数据目录（fs-guard 白名单内），纯字符串断言不触碰文件系统
    expect(getCrashJournalDir()).toBe(join(tmpDir, 'logs', 'crashes'))

    crashJournal.append(makeEvent(1))
    expect(existsSync(crashesDir)).toBe(false) // 未 init：no-op

    initCrashJournal() // 生产缺省：dir 从 getCrashJournalDir() 推导（现指向 tmp 注入）
    initCrashJournal() // 幂等：二次 init 不替换实例
    crashJournal.append(makeEvent(2))

    expect(existsSync(join(crashesDir, 'main.jsonl'))).toBe(true)
    const events = readSegmentsOldestFirst(crashesDir)[0].events
    expect(events).toHaveLength(1) // 首条 no-op 未落盘，仅 init 后的一条
    expect(events[0]['sessionId']).toBe('sid-0002')
  })
})

/** 动态 import 拿当前模块实例（vi.resetModules 后为全新状态单例，main-logger.test 同款）。 */
async function loadWriter(): Promise<typeof import('../crash-journal.js')> {
  return await import('../crash-journal.js')
}
