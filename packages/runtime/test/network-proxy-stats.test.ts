/**
 * LLM 网络代理统计读侧测试（聚合求和 / reset 水位 / 坏行跳过 / 时间范围 / 超 5MB 保尾
 * 截断 / 并发追加写原子性——子进程形态多 writer）。
 *
 * llm-network-proxy 设计 §3.1 卡 3 / §3.3 决策 4；数据目录经 TAIJI_AGENT_DATA_DIR 钉到
 * mkdtemp tmp（测试禁触碰真实数据目录）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getNetworkProxyStats,
  resetNetworkProxyStats,
} from '../src/services/network-proxy-config.js'
import { getPiAgentDir } from '../src/infra/pi/pi-paths.js'

let tmpDataDir: string
let savedEnv: string | undefined

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'network-proxy-stats-test-'))
  mkdirSync(join(tmpDataDir, 'agent'), { recursive: true })
  savedEnv = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = tmpDataDir
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = savedEnv
  rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function statsPath(): string {
  return join(getPiAgentDir(), 'network-proxy-stats.jsonl')
}

function writeLines(lines: string[]): void {
  mkdirSync(getPiAgentDir(), { recursive: true })
  writeFileSync(statsPath(), lines.join(''), 'utf-8')
}

function dataLine(host: string, proxied: number, direct: number, ts: number): string {
  return `${JSON.stringify({ ts, host, proxied, direct })}\n`
}

const HOUR_MS = 60 * 60 * 1000

describe('getNetworkProxyStats（聚合 / 水位 / 坏行 / 时间范围）', () => {
  it('文件不存在 → 空 stats 不抛错', () => {
    expect(getNetworkProxyStats('all')).toEqual({ stats: [] })
  })

  it('多行按主机名求和（跨行跨主机），输出按 host 字母序', () => {
    const now = Date.now()
    writeLines([
      dataLine('b.example.test', 1, 0, now),
      dataLine('a.example.test', 2, 3, now),
      dataLine('b.example.test', 0, 1, now),
    ])
    expect(getNetworkProxyStats('all').stats).toEqual([
      { host: 'a.example.test', proxied: 2, direct: 3 },
      { host: 'b.example.test', proxied: 1, direct: 1 },
    ])
  })

  it('reset 水位：只累计最后一个水位之后的行', () => {
    const now = Date.now()
    writeLines([
      dataLine('before.test', 5, 5, now),
      `${JSON.stringify({ type: 'reset', ts: now })}\n`,
      dataLine('after.test', 1, 2, now),
    ])
    expect(getNetworkProxyStats('all').stats).toEqual([
      { host: 'after.test', proxied: 1, direct: 2 },
    ])
  })

  it('多个 reset：只计最后一个水位之后', () => {
    const now = Date.now()
    writeLines([
      dataLine('first.test', 9, 9, now),
      `${JSON.stringify({ type: 'reset', ts: now })}\n`,
      dataLine('second.test', 7, 7, now),
      `${JSON.stringify({ type: 'reset', ts: now })}\n`,
      dataLine('third.test', 3, 4, now),
    ])
    expect(getNetworkProxyStats('all').stats).toEqual([
      { host: 'third.test', proxied: 3, direct: 4 },
    ])
  })

  it('reset 后 runtime 再 reset（连续水位）语义不变', () => {
    const now = Date.now()
    writeLines([dataLine('old.test', 1, 1, now)])
    resetNetworkProxyStats() // 追加水位行
    resetNetworkProxyStats()
    expect(getNetworkProxyStats('all').stats).toEqual([])
  })

  it('坏行跳过记 warn，合法行照常聚合', () => {
    const now = Date.now()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      writeLines([
        dataLine('good.test', 2, 2, now),
        'not-a-json-line\n',
        '{"broken": \n',
        dataLine('good2.test', 1, 0, now),
      ])
      expect(getNetworkProxyStats('all').stats).toEqual([
        { host: 'good.test', proxied: 2, direct: 2 },
        { host: 'good2.test', proxied: 1, direct: 0 },
      ])
      expect(warnSpy.mock.calls.length).toBe(2)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('空行静默跳过（不 warn）', () => {
    const now = Date.now()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      writeLines(['\n', dataLine('h.test', 1, 0, now)])
      expect(getNetworkProxyStats('all').stats).toEqual([{ host: 'h.test', proxied: 1, direct: 0 }])
      expect(warnSpy.mock.calls.length).toBe(0)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('24h 档：窗口内计入、窗口外不计；all 档全量', () => {
    const now = Date.now()
    // 追加式文件物理顺序 = 旧→新（文件头最早追加）；逆序扫描从尾（最新）向前
    writeLines([
      dataLine('week-old.test', 4, 0, now - 8 * 24 * HOUR_MS),
      dataLine('day-old.test', 2, 0, now - 25 * HOUR_MS),
      dataLine('recent.test', 1, 0, now - HOUR_MS),
    ])
    expect(getNetworkProxyStats('24h').stats).toEqual([{ host: 'recent.test', proxied: 1, direct: 0 }])
    expect(getNetworkProxyStats('7d').stats).toEqual([
      { host: 'day-old.test', proxied: 2, direct: 0 },
      { host: 'recent.test', proxied: 1, direct: 0 },
    ])
    expect(getNetworkProxyStats('all').stats).toEqual([
      { host: 'day-old.test', proxied: 2, direct: 0 },
      { host: 'recent.test', proxied: 1, direct: 0 },
      { host: 'week-old.test', proxied: 4, direct: 0 },
    ])
  })

  it('时间提前终止不误杀：越界行之后的窗口内新行仍计入（逆序扫描遇终止点即停）', () => {
    const now = Date.now()
    // 文件顺序：先旧后新。逆序扫描先读 new（计入）、再读 old（越界终止）——old 不计入
    writeLines([
      dataLine('old.test', 9, 9, now - 25 * HOUR_MS),
      dataLine('new.test', 1, 1, now - HOUR_MS),
    ])
    expect(getNetworkProxyStats('24h').stats).toEqual([{ host: 'new.test', proxied: 1, direct: 1 }])
  })

  it('字段形态非法的行按坏行处理（ts 非数 / host 空 / 计数负数）', () => {
    const now = Date.now()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      writeLines([
        `${JSON.stringify({ host: 'x.test', proxied: 1, direct: 0 })}\n`, // 缺 ts
        `${JSON.stringify({ ts: now, host: '', proxied: 1, direct: 0 })}\n`, // 空 host
        `${JSON.stringify({ ts: now, host: 'neg.test', proxied: -1, direct: 0 })}\n`, // 负计数
        dataLine('good.test', 1, 1, now),
      ])
      expect(getNetworkProxyStats('all').stats).toEqual([{ host: 'good.test', proxied: 1, direct: 1 }])
      expect(warnSpy.mock.calls.length).toBe(3)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('超 5MB 保尾截断（读聚合入口触发，runtime 唯一截断主体）', () => {
  function buildBigLines(totalBytes: number, startSeq: number): string[] {
    const lines: string[] = []
    let bytes = 0
    let seq = startSeq
    while (bytes < totalBytes) {
      const line = `${JSON.stringify({ ts: Date.now(), host: `h${seq}.bulk.test`, proxied: 1, direct: 0 })}\n`
      lines.push(line)
      bytes += line.length
      seq++
    }
    return lines
  }

  it('文件 >5MB 时 all 档读聚合触发截断：保尾 1MB 行边界对齐 + truncatedNote', () => {
    const now = Date.now()
    // 头部旧行（截断后应被清理）+ 大批量行 + 尾部标记行
    const head = dataLine('head-old.test', 7, 7, now)
    const bigLines = buildBigLines(6 * 1024 * 1024, 0)
    const tail = dataLine('tail-new.test', 3, 3, now)
    writeLines([head, ...bigLines, tail])
    expect(statSync(statsPath()).size).toBeGreaterThan(5 * 1024 * 1024)

    const result = getNetworkProxyStats('all')
    // 截断后体积：≤ 1MB + 单行余量（行边界对齐不超界）
    const sizeAfter = statSync(statsPath()).size
    expect(sizeAfter).toBeLessThanOrEqual(1024 * 1024 + 200)
    // 标注文案（累计档）
    expect(result.truncatedNote).toBeTruthy()
    // 保尾：尾部行保留、头部行被清理；行边界对齐（聚合解析无坏行即无半行）
    const hosts = result.stats.map((s) => s.host)
    expect(hosts).toContain('tail-new.test')
    expect(hosts).not.toContain('head-old.test')
    expect(hosts).not.toContain('h0.bulk.test') // 最早批量行在尾部窗口外
  })

  it('未超阈值不截断（无 note、文件原样）', () => {
    const now = Date.now()
    writeLines([dataLine('small.test', 1, 0, now)])
    const before = statSync(statsPath()).size
    const result = getNetworkProxyStats('all')
    expect(result.truncatedNote).toBeUndefined()
    expect(statSync(statsPath()).size).toBe(before)
  })

  it('截断后的文件每行完整可解析（不截半行）', () => {
    const bigLines = buildBigLines(6 * 1024 * 1024, 0)
    writeLines(bigLines)
    getNetworkProxyStats('24h') // 任意档都触发入口截断
    const content = readFileSync(statsPath(), 'utf-8')
    const lines = content.split('\n').filter((l) => l.trim() !== '')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })
})

describe('并发追加写（子进程形态 N writer × M 行，O_APPEND 单行原子性）', () => {
  it('4 个并发子进程 writer 各追加 200 行，读侧全部解析无交错坏行', async () => {
    const WRITERS = 4
    const LINES_PER_WRITER = 200
    mkdirSync(getPiAgentDir(), { recursive: true })
    writeFileSync(statsPath(), '', 'utf-8')
    // 子进程脚本：node -e 下 process.argv[1] 起为用户参数——argv[1] = 目标文件，argv[2] =
    // writer 序号；逐行 appendFileSync（与 extension flush 同一追加通道契约：O_APPEND 单行单次 write）
    const script = `
      const { appendFileSync } = require('node:fs');
      const target = process.argv[1];
      const writer = process.argv[2];
      for (let i = 0; i < ${LINES_PER_WRITER}; i++) {
        appendFileSync(target, JSON.stringify({ ts: Date.now(), host: 'w' + writer + '.conc.test', proxied: 1, direct: 0 }) + '\\n');
      }
    `
    const children = Array.from({ length: WRITERS }, (_, w) =>
      spawn(process.execPath, ['-e', script, /* argv[2]= */ statsPath(), String(w)], { stdio: ['ignore', 'ignore', 'pipe'] }),
    )
    const stderrTail: string[] = []
    for (const child of children) {
      child.stderr?.on('data', (d: Buffer) => stderrTail.push(String(d)))
    }
    const exitCodes = await Promise.all(children.map((child) => new Promise<number>((resolve, reject) => {
      child.on('close', (code) => resolve(code ?? -1))
      child.on('error', reject)
    })))
    if (exitCodes.some((code) => code !== 0)) {
      throw new Error(`writer 子进程失败（exit=${exitCodes.join(',')}）：${stderrTail.join('')}`)
    }
    expect(exitCodes).toEqual([0, 0, 0, 0])

    // 读侧解析：行数 = N×M，无交错坏行，各 writer 计数精确
    const result = getNetworkProxyStats('all')
    const totalLines = result.stats.reduce((sum, s) => sum + s.proxied + s.direct, 0)
    expect(totalLines).toBe(WRITERS * LINES_PER_WRITER)
    for (let w = 0; w < WRITERS; w++) {
      expect(result.stats.find((s) => s.host === `w${w}.conc.test`)?.proxied).toBe(LINES_PER_WRITER)
    }
  })
})
