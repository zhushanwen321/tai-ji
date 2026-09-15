/**
 * u-diagnostics 验收测试：error-log 诊断面扩展（多源改造 S1-S3 观测面）。
 *
 * 覆盖：三类成功登记（source-selection / source-failover / download-success）
 * 各落一条 JSONL 且字段齐 / releaseSource 字段透传 / source-selection 降频
 * 变化检测（首条必写、写失败不推进快照）/ 512KB×2 轮转通道复用不回退 /
 * 写入失败不抛（对齐既有容错语义）。
 *
 * 隔离：vi.mock constants 将日志路径重定向到 tmpdir 唯一子目录（写法对齐
 * update/__tests__/update.test.ts 的 W1-error-log-append 组），目录自建自删，
 * 不触碰真实数据目录。
 *
 * 注意：source-selection 降频快照是模块内状态，同文件用例按定义顺序串行执行，
 * 各用例的输入值已错开（tags 版本号递增）保证「首步必写」断言不依赖隐式顺序。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import {
  appendUpdateError,
  logSourceSelection,
  logSourceFailover,
  logDownloadSuccess,
} from '../update/error-log.js'
import type {
  SourceSelectionLogInput,
  SourceFailoverLogInput,
  DownloadSuccessLogInput,
} from '../update/error-log.js'

// constants 路径函数重定向到 tmpdir 唯一目录。hoisted 工厂执行时 import 绑定尚未
// 初始化，用 process.env 构造等价路径（TMPDIR 与 os.tmpdir() 在 macOS 指向同一目录）。
const { TEST_LOG_DIR, TEST_LOG_PATH } = vi.hoisted(() => {
  const base = process.env.TMPDIR || '/tmp'
  const dir = `${base}/error-log-diagnostics-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return { TEST_LOG_DIR: dir, TEST_LOG_PATH: `${dir}/update-error.log` }
})

vi.mock('../update/constants.js', () => ({
  getUpdateErrorLog: () => TEST_LOG_PATH,
  getUpdateDir: () => TEST_LOG_DIR,
}))

interface ProbeShape {
  executed: boolean
  reason?: string
  results?: Array<{ source: string; reachable: boolean; basis: string }>
}

function readLogLines(): string[] {
  if (!existsSync(TEST_LOG_PATH)) return []
  return readFileSync(TEST_LOG_PATH, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
}

function readEntries(): Array<Record<string, unknown>> {
  return readLogLines().map(l => JSON.parse(l) as Record<string, unknown>)
}

/** 基础 source-selection 输入（auto 探测形态）。 */
function selectionInput(overrides?: Partial<SourceSelectionLogInput>): SourceSelectionLogInput {
  return {
    order: ['github', 'atomgit'],
    winner: 'github',
    probe: {
      executed: true,
      results: [
        { source: 'github', reachable: true, basis: 'undici-resolve' },
        { source: 'atomgit', reachable: true, basis: 'curl-200' },
      ],
    },
    tags: { github: 'v0.9.15', atomgit: 'v0.9.15' },
    ...overrides,
  }
}

function failoverInput(overrides?: Partial<SourceFailoverLogInput>): SourceFailoverLogInput {
  return {
    segment: 'check',
    from: 'github',
    to: 'atomgit',
    errorCode: 'UPDATE_NETWORK_FAILED',
    manifestFrom: 'atomgit',
    ...overrides,
  }
}

function downloadSuccessInput(overrides?: Partial<DownloadSuccessLogInput>): DownloadSuccessLogInput {
  return {
    multiPart: true,
    engine: 'undici',
    releaseSource: 'atomgit',
    ...overrides,
  }
}

beforeEach(() => {
  mkdirSync(TEST_LOG_DIR, { recursive: true })
  // 写失败用例会触发 console.error/warn 兜底，静音避免刷屏
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  try { unlinkSync(TEST_LOG_PATH) } catch {}
  try { unlinkSync(`${TEST_LOG_PATH}.1`) } catch {}
  try {
    rmSync(TEST_LOG_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } catch {}
})

// ─── source-selection ─────────────────────────────────────────────

describe('source-selection 登记', () => {
  it('首条必写且字段齐（order/winner/probe/tags）', () => {
    logSourceSelection(selectionInput())

    const entries = readEntries()
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry.source).toBe('source-selection')
    expect(entry.at).toEqual(expect.any(String))
    expect(entry.order).toEqual(['github', 'atomgit'])
    expect(entry.winner).toBe('github')
    const probe = entry.probe as ProbeShape
    expect(probe.executed).toBe(true)
    expect(probe.results).toEqual([
      { source: 'github', reachable: true, basis: 'undici-resolve' },
      { source: 'atomgit', reachable: true, basis: 'curl-200' },
    ])
    expect(entry.tags).toEqual({ github: 'v0.9.15', atomgit: 'v0.9.15' })
  })

  it('降频：同输入不重复写；tags/探测结果/排序/胜出源任一变化才写', () => {
    // 起点输入与上一用例错开（winner + order 相异保证首步必写），本用例自含完整状态序列
    const base = selectionInput({ winner: 'atomgit', order: ['atomgit', 'github'] })
    logSourceSelection(base)
    expect(readLogLines()).toHaveLength(1)

    // 完全相同输入：不写
    logSourceSelection(selectionInput({ winner: 'atomgit', order: ['atomgit', 'github'] }))
    expect(readLogLines()).toHaveLength(1)

    // tags 变化：写（F5 观测面依赖维度）
    logSourceSelection(
      selectionInput({
        winner: 'atomgit',
        order: ['atomgit', 'github'],
        tags: { github: 'v0.9.16', atomgit: 'v0.9.15' },
      }),
    )
    let entries = readEntries()
    expect(entries).toHaveLength(2)
    expect(entries[1].tags).toEqual({ github: 'v0.9.16', atomgit: 'v0.9.15' })

    // 探测结果变化：写
    logSourceSelection(
      selectionInput({
        winner: 'atomgit',
        order: ['atomgit', 'github'],
        tags: { github: 'v0.9.16', atomgit: 'v0.9.15' },
        probe: {
          executed: true,
          results: [{ source: 'atomgit', reachable: true, basis: 'curl-200' }],
        },
      }),
    )
    entries = readEntries()
    expect(entries).toHaveLength(3)
    expect((entries[2].probe as ProbeShape).results).toHaveLength(1)

    // 排序变化：写
    logSourceSelection(
      selectionInput({
        winner: 'atomgit',
        order: ['github', 'atomgit'],
        tags: { github: 'v0.9.16', atomgit: 'v0.9.15' },
        probe: {
          executed: true,
          results: [{ source: 'atomgit', reachable: true, basis: 'curl-200' }],
        },
      }),
    )
    entries = readEntries()
    expect(entries).toHaveLength(4)
    expect(entries[3].order).toEqual(['github', 'atomgit'])

    // 胜出源变化：写
    logSourceSelection(
      selectionInput({
        winner: 'github',
        order: ['github', 'atomgit'],
        tags: { github: 'v0.9.16', atomgit: 'v0.9.15' },
        probe: {
          executed: true,
          results: [{ source: 'atomgit', reachable: true, basis: 'curl-200' }],
        },
      }),
    )
    entries = readEntries()
    expect(entries).toHaveLength(5)
    expect(entries[4].winner).toBe('github')
  })

  it('非 auto / 代理短路：probe 记 skipped 原因（executed=false + reason）', () => {
    logSourceSelection(
      selectionInput({
        winner: 'github',
        tags: { github: 'v0.9.17', atomgit: 'v0.9.15' },
        probe: { executed: false, reason: 'proxy-short-circuit' },
      }),
    )

    const entry = readEntries()[0]
    const probe = entry.probe as ProbeShape
    expect(probe.executed).toBe(false)
    expect(probe.reason).toBe('proxy-short-circuit')
    expect(probe.results).toBeUndefined()
    expect(entry.winner).toBe('github')
  })

  it('无胜出源时 winner 落 null（S4 双源皆败形态）', () => {
    logSourceSelection(
      selectionInput({
        winner: null,
        tags: {},
        probe: {
          executed: true,
          results: [
            { source: 'github', reachable: false, basis: 'undici-connect-error' },
            { source: 'atomgit', reachable: false, basis: 'curl-timeout' },
          ],
        },
      }),
    )

    const entry = readEntries()[0]
    expect(entry.winner).toBeNull()
    expect(entry.tags).toEqual({})
  })
})

// ─── source-failover ──────────────────────────────────────────────

describe('source-failover 登记', () => {
  it('检查段降级：字段齐（from/to/errorCode/manifestFrom，stage=checking）', () => {
    logSourceFailover(failoverInput())

    const entries = readEntries()
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry.source).toBe('source-failover')
    expect(entry.stage).toBe('checking')
    expect(entry.from).toBe('github')
    expect(entry.to).toBe('atomgit')
    expect(entry.errorCode).toBe('UPDATE_NETWORK_FAILED')
    expect(entry.manifestFrom).toBe('atomgit')
  })

  it('下载段降级：stage=downloading；manifestFrom 缺省时 JSONL 不落该 key', () => {
    logSourceFailover(
      failoverInput({
        segment: 'download',
        from: 'atomgit',
        to: 'github',
        errorCode: 'UPDATE_NETWORK_TIMEOUT',
        manifestFrom: undefined, // 显式抹掉基础值，断言缺省形态不落 key
      }),
    )

    const entry = readEntries()[0]
    expect(entry.stage).toBe('downloading')
    expect(entry.from).toBe('atomgit')
    expect(entry.to).toBe('github')
    expect(entry.errorCode).toBe('UPDATE_NETWORK_TIMEOUT')
    expect('manifestFrom' in entry).toBe(false)
  })
})

// ─── download-success ─────────────────────────────────────────────

describe('download-success 登记', () => {
  it('每次下载成功落一条且字段齐（multiPart/engine/releaseSource）', () => {
    logDownloadSuccess(downloadSuccessInput())

    const entries = readEntries()
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry.source).toBe('download-success')
    expect(entry.stage).toBe('downloading')
    expect(entry.multiPart).toBe(true)
    expect(entry.engine).toBe('undici')
    expect(entry.releaseSource).toBe('atomgit')
  })

  it('curl 引擎形态：multiPart=false 与 engine=curl 同条落盘（S1 注记形态）', () => {
    logDownloadSuccess(downloadSuccessInput({ multiPart: false, engine: 'curl', releaseSource: 'github' }))

    const entry = readEntries()[0]
    expect(entry.multiPart).toBe(false)
    expect(entry.engine).toBe('curl')
    expect(entry.releaseSource).toBe('github')
  })
})

// ─── releaseSource 透传 + 轮转 + 容错 ─────────────────────────────

describe('releaseSource 字段透传（失败登记）', () => {
  it('appendUpdateError 透传 releaseSource 到 JSONL', () => {
    const ok = appendUpdateError({
      at: '2026-09-07T12:00:00Z',
      source: 'download',
      stage: 'downloading',
      errorCode: 'UPDATE_NETWORK_FAILED',
      engine: 'undici',
      releaseSource: 'github',
    })
    expect(ok).toBe(true)

    const entry = readEntries()[0]
    expect(entry.releaseSource).toBe('github')
    expect(entry.engine).toBe('undici')
  })

  it('未传 releaseSource 时 JSONL 不落该 key（既有调用方零影响）', () => {
    appendUpdateError({
      at: '2026-09-07T12:00:00Z',
      source: 'install',
      stage: 'replacing',
      errorCode: 'UPDATE_PERMISSION_DENIED',
    })

    const entry = readEntries()[0]
    expect('releaseSource' in entry).toBe(false)
  })
})

describe('轮转通道复用（512KB×2 语义不回退）', () => {
  it('成功登记写满触发轮转：.1 生成、新条目落当前文件', () => {
    const bigContent = 'x'.repeat(512 * 1024 + 1)
    writeFileSync(TEST_LOG_PATH, bigContent, 'utf-8')

    logDownloadSuccess(downloadSuccessInput())

    expect(existsSync(`${TEST_LOG_PATH}.1`)).toBe(true)
    expect(readFileSync(`${TEST_LOG_PATH}.1`, 'utf-8')).toBe(bigContent)
    const entries = readEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].source).toBe('download-success')
  })

  it('第二次轮转覆盖旧 .1（×2 上界保持）', () => {
    const bigContent = 'x'.repeat(512 * 1024 + 1)
    writeFileSync(TEST_LOG_PATH, bigContent, 'utf-8')
    logSourceFailover(failoverInput())
    expect(readFileSync(`${TEST_LOG_PATH}.1`, 'utf-8')).toBe(bigContent)

    const current = readFileSync(TEST_LOG_PATH, 'utf-8')
    writeFileSync(TEST_LOG_PATH, current + 'y'.repeat(512 * 1024), 'utf-8')
    logSourceFailover(failoverInput({ from: 'atomgit', to: 'github' }))

    // 旧 .1（首轮大内容）被第二轮转覆盖为上一轮主文件内容（failover 条目）
    const rotated = readFileSync(`${TEST_LOG_PATH}.1`, 'utf-8')
    expect(rotated).not.toBe(bigContent)
    expect(rotated.startsWith('{"at"')).toBe(true)
    const entries = readEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].from).toBe('atomgit')
  })

  it('未超阈值不轮转', () => {
    writeFileSync(TEST_LOG_PATH, '{"small":true}\n', 'utf-8')
    logSourceSelection(
      selectionInput({
        winner: null,
        tags: { github: 'v0.9.18' },
        probe: { executed: false, reason: 'explicit-preference' },
      }),
    )

    expect(existsSync(`${TEST_LOG_PATH}.1`)).toBe(false)
    expect(readLogLines()).toHaveLength(2)
  })
})

describe('写入失败不抛（对齐既有容错语义）', () => {
  it('日志路径不可写时三类登记与失败登记均不抛且返回 false', () => {
    // 把日志文件路径变成目录，appendFileSync 必抛 EISDIR
    mkdirSync(TEST_LOG_PATH, { recursive: true })

    expect(() =>
      appendUpdateError({ at: '2026-09-07T12:00:00Z', source: 'download', stage: 'downloading' }),
    ).not.toThrow()
    expect(() => logSourceSelection(selectionInput())).not.toThrow()
    expect(() => logSourceFailover(failoverInput())).not.toThrow()
    expect(() => logDownloadSuccess(downloadSuccessInput())).not.toThrow()
    expect(
      appendUpdateError({ at: '2026-09-07T12:00:00Z', source: 'download', stage: 'downloading' }),
    ).toBe(false)
  })

  it('写失败不推进降频快照：恢复后同状态补写（不因一次落盘失败永久丢观测）', () => {
    mkdirSync(TEST_LOG_PATH, { recursive: true })
    const input = selectionInput({ winner: null, tags: { atomgit: 'v0.9.19' } })

    // 写失败阶段：不抛（快照不推进）
    expect(() => logSourceSelection(input)).not.toThrow()

    // 恢复目录为可写路径后，同状态再次调用应补写（证明快照未被失败推进）
    rmSync(TEST_LOG_PATH, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    logSourceSelection(input)

    const entries = readEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].source).toBe('source-selection')
    expect(entries[0].winner).toBeNull()
  })
})
