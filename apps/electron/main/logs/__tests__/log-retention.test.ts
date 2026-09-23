/**
 * log-retention 单测（u5a-main-logging 验收条款）。
 *
 * 覆盖：
 * - 清理扫描只删「超龄 + 匹配清理前缀」的文件（runtime- / pi- / plugin-crash- / main- / renderer-error- / renderer-console- 前缀族）
 * - 固定名 stderr 文件（electron-runtime-stderr.log / zcode-appserver-stderr.log）不进超龄清单
 *   ——mtime 超龄也必须存活（设计 D6-⑦：unlink 后 writer 持有 fd 写孤儿 inode，静默丢证据）
 * - 活跃文件 mtime 刷新不误删（文件名日期老但 mtime 新——跨天长寿命 tee 场景）
 * - 目录不存在静默跳过；子目录与其他前缀文件跳过
 * - runLogRetentionNow 消费 shared readLogKeepDays()（TAIJI_LOG_KEEP_DAYS env 覆盖 || 默认 7）
 *
 * 全部夹具 mkdtempSync(tmpdir) 自建自删（fs-guard 生效中，禁触真实数据目录）。
 * 运行：cd apps/electron/main && npx vitest run logs/__tests__/log-retention.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanExpiredLogs, runLogRetentionNow } from '../log-retention.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** n 天前的 Date（mtime 注入用）。 */
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * MS_PER_DAY)
}

describe('cleanExpiredLogs', () => {
  let tmpDir: string
  let logsDir: string
  /** 测试前保存 / afterEach 恢复的 env（隔离外部进程污染，对齐 runtime logger.test.ts 惯例）。 */
  const ENV_KEYS = ['TAIJI_LOG_KEEP_DAYS'] as const
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'log-retention-test-'))
    logsDir = join(tmpDir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    // maxRetries 对齐 runtime logger.test.ts：与刚 close 的写流在途 flush 竞争时重试删除
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 写入一个文件并把 mtime 设为 n 天前。 */
  function touch(name: string, ageDays: number): string {
    const full = join(logsDir, name)
    writeFileSync(full, `${name}-content`)
    utimesSync(full, daysAgo(ageDays), daysAgo(ageDays))
    return full
  }

  it('只删超龄且匹配清理前缀的文件；保留超龄固定名 stderr、超龄无关文件与活跃文件', () => {
    // 超龄（10 天前）匹配前缀——六族前缀各一，全部应删
    const staleTargets = [
      touch('runtime-2026-01-01.log', 10),
      touch('runtime-2026-01-01.log.1', 10),
      touch('pi-2026-01-01-abc.jsonl', 10),
      touch('pi-crash-2026-01-01-abc.log', 10),
      touch('pi-relay-2026-01-01-r1.jsonl', 10),
      touch('plugin-crash-2026-01-01-w1.log', 10),
      touch('main-2026-01-01.log', 10),
      touch('renderer-error-2026-01-01.log', 10),
      touch('renderer-console-2026-01-01.log', 10),
    ]
    // 固定名 stderr 文件：mtime 超龄也必须存活（D6-⑦ 验收断言）
    const fixedStderr = [touch('electron-runtime-stderr.log', 10), touch('zcode-appserver-stderr.log', 10)]
    // 超龄但不匹配前缀（其他文件）——跳过不删。注意夹具不能选 'runtime-*' 形态名
    // （前缀语义是 startsWith，'runtime-token.bak' 也命中清理前缀——对齐 runtime logger）
    const unrelated = [touch('unrelated.txt', 10), touch('session-cache.bin', 10)]
    // 活跃文件：文件名日期老但 mtime 新（mtime 刷新）——不误删
    const fresh = touch('runtime-2020-01-01.log', 0)

    const result = cleanExpiredLogs(logsDir, 7)

    for (const f of staleTargets) expect(existsSync(f), `应删除超龄文件 ${f}`).toBe(false)
    for (const f of fixedStderr) expect(existsSync(f), `固定名 stderr 不得清理 ${f}`).toBe(true)
    for (const f of unrelated) expect(existsSync(f), `非日志前缀文件不得清理 ${f}`).toBe(true)
    expect(existsSync(fresh), 'mtime 活跃文件不得误删').toBe(true)
    expect(result).toEqual({ scanned: staleTargets.length + 1, removed: staleTargets.length })
  })

  it('目录不存在时静默跳过（不抛错、不创建目录）', () => {
    const missing = join(tmpDir, 'no-such-logs-dir')
    expect(() => cleanExpiredLogs(missing, 7)).not.toThrow()
    expect(existsSync(missing)).toBe(false)
  })

  it('子目录匹配前缀也不删（清理只处理文件，跳过目录）', () => {
    const subDir = join(logsDir, 'runtime-archive')
    mkdirSync(subDir, { recursive: true })
    const result = cleanExpiredLogs(logsDir, 7)
    expect(existsSync(subDir)).toBe(true)
    expect(result.scanned).toBe(0)
  })

  it('mtime 判定严格性：cutoff 之前删、cutoff 之后不删（注入同一 now 排除时钟偏移）', () => {
    // 显式注入同一 now，±5ms 夹逼「mtimeMs < cutoff 严格小于」语义——不做 1ms 钉子
    // 断言（utimes/stat 的 mtimeMs 浮点表示存在平台级微差，卡等值会 flaky）
    const now = Date.now()
    const cutoffMs = now - 7 * MS_PER_DAY
    const before = join(logsDir, 'runtime-before-cutoff.log')
    const after = join(logsDir, 'runtime-after-cutoff.log')
    writeFileSync(before, 'before')
    writeFileSync(after, 'after')
    utimesSync(before, new Date(cutoffMs - 5), new Date(cutoffMs - 5))
    utimesSync(after, new Date(cutoffMs + 5), new Date(cutoffMs + 5))
    const result = cleanExpiredLogs(logsDir, 7, now)
    expect(existsSync(before)).toBe(false)
    expect(existsSync(after)).toBe(true)
    expect(result.removed).toBe(1)
  })
})

describe('runLogRetentionNow（shared readLogKeepDays 消费）', () => {
  let tmpDir: string
  let logsDir: string
  let savedDataDir: string | undefined
  let savedKeepDays: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'log-retention-now-test-'))
    logsDir = join(tmpDir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    savedDataDir = process.env.TAIJI_AGENT_DATA_DIR
    savedKeepDays = process.env.TAIJI_LOG_KEEP_DAYS
    // env 注入重定向（getDataDir 动态推导）：logsDir = <dataDir>/logs
    process.env.TAIJI_AGENT_DATA_DIR = tmpDir
  })

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = savedDataDir
    if (savedKeepDays === undefined) delete process.env.TAIJI_LOG_KEEP_DAYS
    else process.env.TAIJI_LOG_KEEP_DAYS = savedKeepDays
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function touchStale(name: string): string {
    const full = join(logsDir, name)
    writeFileSync(full, 'stale')
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(full, old, old)
    return full
  }

  it('TAIJI_LOG_KEEP_DAYS=1：2 天前的文件被清（env 覆盖生效）', () => {
    process.env.TAIJI_LOG_KEEP_DAYS = '1'
    const stale = touchStale('runtime-stale.log')
    const result = runLogRetentionNow()
    expect(existsSync(stale)).toBe(false)
    expect(result.removed).toBe(1)
  })

  it('env 未设：默认保留 7 天，2 天前的文件存活（DEFAULT_LOG_KEEP_DAYS 兜底）', () => {
    delete process.env.TAIJI_LOG_KEEP_DAYS
    const stale = touchStale('runtime-stale.log')
    const result = runLogRetentionNow()
    expect(existsSync(stale)).toBe(true)
    expect(result.removed).toBe(0)
  })

  it('env 设为非法值（非数字）：回退默认 7 天（Number() falsy 回退语义与 runtime 等价提升一致）', () => {
    process.env.TAIJI_LOG_KEEP_DAYS = 'not-a-number'
    const stale = touchStale('runtime-stale.log')
    const result = runLogRetentionNow()
    expect(existsSync(stale)).toBe(true)
    expect(result.removed).toBe(0)
  })
})
