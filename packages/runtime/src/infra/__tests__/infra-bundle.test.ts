import { SPAWN_ENV_OUTBOUND_DENY_LIST } from '../../../../shared/src/spawn-env-contract.js';
import { ModelDiscoveryError, ModelService } from '../../services/model-service.js';
import type { IModelSource } from '../../services/ports/model.js';
import { MACHINE_PI_BIN_MARKER, MACHINE_PI_DIGEST_MAX_CHARS, UNIFIED_LOG_MAX_LINES, UNIFIED_LOG_WINDOW_MS, parseMachinePiRows, formatMachinePiSnapshotSection, formatMachinePiDigest, captureMachinePiSnapshotSection, captureMachinePiDigest, extractCorrelationLines, formatLogShowTime, buildLogShowArgs, collectUnifiedLogCorrelation } from '../crash-correlation.js';
import { NpmGitInstaller } from '../installers/npm-git-installer.js';
import { DEFAULT_MEM_PRESSURE_THRESHOLDS, isMemPressureHigh, parseLinuxMemInfoSwap, parseMacSwapUsage, queryMemPressure, type MemPressureSample } from '../mem-pressure.js';
import { ModelApiDiscoverer } from '../model-api-discoverer.js';
import { buildOutboundChildEnv } from '../spawn-env.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/infra/__tests__/crash-correlation.test.ts
// ======================================================================

// 采样门可控化：crash-correlation 从 logger 模块 import isPiCrashLogEnabled——
// 此处 mock 成可翻转移（真实 logger 未初始化态恒 false，无法正向验证采集路径）
const gate = vi.hoisted(() => ({ enabled: false }))

vi.mock('../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger.js')>()
  return { ...actual, isPiCrashLogEnabled: () => gate.enabled }
})
const PS_FIXTURE = [
  '  33889  40842 /Applications/TaiJi.app/Contents/Resources/pi/pi-darwin-arm64 --mode rpc --no-extensions --approve',
  '  34100  33889 /Applications/TaiJi.app/Contents/Resources/pi/pi-darwin-arm64 --mode rpc --session sub',
  '  34101     1 /Users/dev/worktree/apps/electron/resources/pi/pi-darwin-arm64 --mode rpc --no-extensions',
  '    520     1 /usr/sbin/SomeDaemon',
  '  34200   40842 node /usr/local/bin/pi --mode rpc',
  'garbage-line-no-pid',
  'abc def not-enough-columns /x/pi-darwin-arm64',
].join('\n')

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('crash-correlation', () => {
describe('parseMachinePiRows：ps 输出解析 + taiji 家族过滤', () => {
  it('只保留含 pi-darwin-arm64 的合法行，pid/ppid 数值化', () => {
    const rows = parseMachinePiRows(PS_FIXTURE)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ pid: 33889, ppid: 40842 })
    expect(rows[2]).toMatchObject({ pid: 34101, ppid: 1 })
    expect(rows.every((r) => r.command.includes(MACHINE_PI_BIN_MARKER))).toBe(true)
  })

  it('npm 安装的裸 pi（二进制名不含 pi-darwin-arm64）不匹配——只关心 taiji 家族', () => {
    const rows = parseMachinePiRows('  34200   40842 node /usr/local/bin/pi --mode rpc')
    expect(rows).toHaveLength(0)
  })

  it('非法行跳过（fail-open），空输出返回空数组', () => {
    expect(parseMachinePiRows('garbage\n\nabc def /x/pi-darwin-arm64')).toHaveLength(0)
    expect(parseMachinePiRows('')).toHaveLength(0)
  })
})
describe('渲染：快照 section / journal digest', () => {
  const rows = parseMachinePiRows(PS_FIXTURE)

  it('快照 section：每行 [machine-pi-snapshot] 前缀 + aliveCount 显式（空集也是证据）', () => {
    const section = formatMachinePiSnapshotSection(rows, 40842, '2026-09-20T05:37:13.200Z')
    const lines = section.split('\n')
    expect(lines[0]).toBe('[machine-pi-snapshot] capturedAt=2026-09-20T05:37:13.200Z selfPid=40842 aliveCount=3')
    expect(lines[1]).toContain('[machine-pi-snapshot] pid=33889 ppid=40842 cmd=')

    const empty = formatMachinePiSnapshotSection([], null, '2026-09-20T05:37:13.200Z')
    expect(empty.split('\n')[0]).toContain('selfPid=null aliveCount=0')
  })

  it('快照 section：超 16 行截断并标注省略数', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      pid: 1000 + i,
      ppid: 1,
      command: `/x/pi-darwin-arm64 --session s${i}`,
    }))
    const section = formatMachinePiSnapshotSection(many, null, '2026-09-20T05:37:13.200Z')
    expect(section).toContain('truncated=true (+4 rows omitted)')
    expect(section.split('\n')).toHaveLength(1 + 16 + 1)
  })

  it('journal digest：alive=N 头 + [pid/ppid] 行形态，装不下的行丢弃并保留 more 尾注', () => {
    const digest = formatMachinePiDigest(rows)
    expect(digest).toMatch(/^alive=3; \[33889\/40842\] /)
    expect(digest.length).toBeLessThanOrEqual(MACHINE_PI_DIGEST_MAX_CHARS)

    const big = Array.from({ length: 40 }, (_, i) => ({
      pid: i,
      ppid: 1,
      command: `x`.repeat(200) + ' pi-darwin-arm64',
    }))
    const bigDigest = formatMachinePiDigest(big)
    expect(bigDigest.length).toBeLessThanOrEqual(MACHINE_PI_DIGEST_MAX_CHARS)
    expect(bigDigest).toMatch(/^alive=40; /)
    expect(bigDigest).toMatch(/; \+\d+ more$/)
  })
})
describe('captureMachinePiSnapshotSection：采样门 + best-effort', () => {
  it('crash log sink 未启用：不采样（结构性惰性，不 spawn ps）', () => {
    gate.enabled = false
    const runPs = vi.fn(() => PS_FIXTURE)
    const section = captureMachinePiSnapshotSection(1, runPs)
    expect(section).toBe('')
    expect(runPs).not.toHaveBeenCalled()
  })

  it('ps 失败：显式 unavailable 行，不抛', () => {
    gate.enabled = true
    const section = captureMachinePiSnapshotSection(1, () => {
      throw new Error('ps disappeared')
    })
    expect(section).toContain('[machine-pi-snapshot]')
    expect(section).toContain('unavailable: ps disappeared')
  })

  it('ps 成功：幸存者行 + selfPid 在场', () => {
    gate.enabled = true
    const section = captureMachinePiSnapshotSection(40842, () => PS_FIXTURE)
    expect(section).toContain('aliveCount=3')
    expect(section).toContain('pid=33889 ppid=40842')
  })
})
describe('captureMachinePiDigest：journal 扩展字段采集', () => {
  it('ps 失败返回空串（journal 字段全可空语义），不抛', () => {
    expect(captureMachinePiDigest(() => {
      throw new Error('no ps')
    })).toBe('')
  })

  it('ps 成功返回紧凑摘要', () => {
    expect(captureMachinePiDigest(() => PS_FIXTURE)).toMatch(/^alive=3; /)
  })
})
describe('extractCorrelationLines：三类证据命中 + 噪声丢弃 + 截断', () => {
  it('命中 pi-darwin / Electron proc_exit / signaled service，丢弃无关行', () => {
    const stdout = [
      '2026-09-20 05:37:13.168 mDNSResponder DNSServiceCreateConnection STOP PID[33224](pi-darwin-arm64)',
      '2026-09-20 05:37:13.463 runningboardd [anon<Electron>(501):32442] termination reported by proc_exit',
      '2026-09-20 05:37:13.144 launchd [pid/32924/com.apple.MTLCompilerService...] signaled service: Killed: 9',
      '2026-09-20 05:37:13.001 WindowServer noise line',
      '2026-09-20 05:37:13.002 runningboardd [osservice<com.apple.contactsd>:33431] termination reported by launchd (0, 0, 0)',
    ].join('\n')
    const { lines, truncated } = extractCorrelationLines(stdout)
    expect(lines).toHaveLength(3)
    expect(truncated).toBe(false)
    expect(lines[0]).toContain('pi-darwin-arm64')
    expect(lines[1]).toContain('<Electron>(501):32442')
    expect(lines[2]).toContain('signaled service')
  })

  it('超 60 行截断标注', () => {
    const many = Array.from({ length: 70 }, (_, i) => `line ${i} pi-darwin-arm64 x`).join('\n')
    const { lines, truncated } = extractCorrelationLines(many)
    expect(lines).toHaveLength(UNIFIED_LOG_MAX_LINES)
    expect(truncated).toBe(true)
  })
})
describe('formatLogShowTime / buildLogShowArgs：窗口与形态', () => {
  it('本地 naive 形态 YYYY-MM-DD HH:MM:SS（补零）', () => {
    // 2026-09-20 05:37:13 本地（构造经本地组件，锁定格式而非时区数学）
    const d = new Date()
    d.setFullYear(2026, 8, 20)
    d.setHours(5, 37, 13, 0)
    expect(formatLogShowTime(d.getTime())).toBe('2026-09-20 05:37:13')

    const d2 = new Date()
    d2.setFullYear(2026, 0, 3)
    d2.setHours(7, 8, 9, 0)
    expect(formatLogShowTime(d2.getTime())).toBe('2026-01-03 07:08:09')
  })

  it('buildLogShowArgs：±5s 窗口 + compact + 谓词', () => {
    const base = Date.UTC(2026, 8, 19, 21, 37, 13)
    const args = buildLogShowArgs(base)
    const start = new Date(base - UNIFIED_LOG_WINDOW_MS)
    const end = new Date(base + UNIFIED_LOG_WINDOW_MS)
    const p = (n: number): string => String(n).padStart(2, '0')
    const fmt = (d: Date): string =>
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    expect(args[0]).toBe('show')
    expect(args).toContain('--style')
    expect(args).toContain('compact')
    expect(args).toContain(fmt(start))
    expect(args).toContain(fmt(end))
    expect(args.join(' ')).toContain('runningboardd')
    expect(args.join(' ')).toContain('pi-darwin-arm64')
  })
})
describe('collectUnifiedLogCorrelation：门 + 失败显式化', () => {
  it('非 darwin：未采样（空串，不调 log show）', async () => {
    const runLogShow = vi.fn(() => Promise.resolve(''))
    const section = await collectUnifiedLogCorrelation(Date.now(), {
      isDarwin: () => false,
      sinkEnabled: () => true,
      runLogShow,
    })
    expect(section).toBe('')
    expect(runLogShow).not.toHaveBeenCalled()
  })

  it('sink 未启用：未采样', async () => {
    const runLogShow = vi.fn(() => Promise.resolve(''))
    const section = await collectUnifiedLogCorrelation(Date.now(), {
      isDarwin: () => true,
      sinkEnabled: () => false,
      runLogShow,
    })
    expect(section).toBe('')
    expect(runLogShow).not.toHaveBeenCalled()
  })

  it('log show 成功：匹配行渲染为 section（含窗口 ISO）', async () => {
    const stdout = '2026-09-20 05:37:13.463 runningboardd [anon<Electron>(501):32442] termination reported by proc_exit'
    const section = await collectUnifiedLogCorrelation(Date.now(), {
      isDarwin: () => true,
      sinkEnabled: () => true,
      runLogShow: () => Promise.resolve(stdout),
    })
    expect(section).toContain('[unified-log-correlation] matched=1 truncated=false')
    expect(section).toContain('[unified-log-correlation] 2026-09-20 05:37:13.463')
    expect(section).toContain('window=')
  })

  it('log show 失败（超时等）：unavailable 行显式落盘，不 reject', async () => {
    const section = await collectUnifiedLogCorrelation(Date.now(), {
      isDarwin: () => true,
      sinkEnabled: () => true,
      runLogShow: () => Promise.reject(new Error('timeout exceeded')),
    })
    expect(section).toContain('[unified-log-correlation]')
    expect(section).toContain('unavailable: timeout exceeded')
  })

  it('零匹配也是显式阴性证据（matched=0）', async () => {
    const section = await collectUnifiedLogCorrelation(Date.now(), {
      isDarwin: () => true,
      sinkEnabled: () => true,
      runLogShow: () => Promise.resolve('nothing relevant'),
    })
    expect(section).toContain('matched=0 truncated=false')
  })
})
});

// ======================================================================
// ← src/infra/__tests__/mem-pressure.test.ts
// ======================================================================

function sample(overrides: Partial<MemPressureSample> = {}): MemPressureSample {
  return {
    swapUsedMB: null,
    swapTotalMB: null,
    freeMB: 4 * 1024,
    totalMB: 16 * 1024,
    ...overrides,
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('mem-pressure', () => {
describe('parseLinuxMemInfoSwap（/proc/meminfo 形态）', () => {
  it('解析 SwapTotal/SwapFree kB 字段并换算 MB（used = total − free）', () => {
    const text = [
      'MemTotal:       16384000 kB',
      'MemFree:          102400 kB',
      'SwapTotal:       2097152 kB',
      'SwapFree:         524288 kB',
      'HugePages_Total:       0',
    ].join('\n')
    expect(parseLinuxMemInfoSwap(text)).toEqual({ swapUsedMB: 1536, swapTotalMB: 2048 })
  })

  it.each([
    ['字段缺失', 'MemTotal: 100 kB'],
    ['空文本', ''],
  ])('%s → null（unknown ≠ 0）', (_label, text) => {
    expect(parseLinuxMemInfoSwap(text)).toBeNull()
  })
})
describe('parseMacSwapUsage（sysctl vm.swapusage 形态）', () => {
  it('解析 total/used M 字段', () => {
    expect(parseMacSwapUsage('total: 2048.00M used: 512.00M free: 1536.00M (encrypted)'))
      .toEqual({ swapUsedMB: 512, swapTotalMB: 2048 })
  })

  it.each([
    ['缺 used 字段', 'total: 2048.00M free: 1536.00M'],
    ['非 swap 输出', 'vm.swapusage: unable to'],
    ['空文本', ''],
  ])('%s → null', (_label, text) => {
    expect(parseMacSwapUsage(text)).toBeNull()
  })
})
describe('isMemPressureHigh 真值表（无历史依赖，单样本判定 = A4 语义）', () => {
  it('swap 占比恰等阈值（0.95）→ 高压；低一分 → 不高压', () => {
    expect(isMemPressureHigh(sample({ swapUsedMB: 950, swapTotalMB: 1000 }))).toBe(true)
    expect(isMemPressureHigh(sample({ swapUsedMB: 949, swapTotalMB: 1000 }))).toBe(false)
  })

  it('空闲占比恰等下限（0.01）→ 高压；高一分 → 不高压', () => {
    expect(isMemPressureHigh(sample({ freeMB: 160, totalMB: 16_000 }))).toBe(true)
    expect(isMemPressureHigh(sample({ freeMB: 161, totalMB: 16_000 }))).toBe(false)
  })

  it('swap 未知（null）时判据收窄，物理空闲判据仍在（不因 unknown 误判或漏判空闲）', () => {
    // swap null + 空闲充足 → 不高压（swap 判据跳过，空闲判据不命中）
    expect(isMemPressureHigh(sample())).toBe(false)
    // swap null + 空闲触底 → 高压（swap unknown 不拖累另一判据）
    expect(isMemPressureHigh(sample({ freeMB: 1, totalMB: 16_000 }))).toBe(true)
  })

  it('swap 总量为 0 / null（无 swap 配置形态）不参与占比判定，不伪造命中', () => {
    expect(isMemPressureHigh(sample({ swapUsedMB: 0, swapTotalMB: 0 }))).toBe(false)
    expect(isMemPressureHigh(sample({ swapUsedMB: 100, swapTotalMB: null }))).toBe(false)
    // swap 用量未知（null）但总量已知 → swap 判据跳过
    expect(isMemPressureHigh(sample({ swapUsedMB: null, swapTotalMB: 1000 }))).toBe(false)
  })

  it('双判据独立：swap 命中即使空闲充足也高压（swap 是溢出信号）', () => {
    expect(isMemPressureHigh(sample({ swapUsedMB: 990, swapTotalMB: 1000, freeMB: 8 * 1024 }))).toBe(true)
  })

  it('阈值注入可覆盖默认（Gate W 校准入口）', () => {
    const s = sample({ swapUsedMB: 900, swapTotalMB: 1000 })
    expect(isMemPressureHigh(s)).toBe(false)
    expect(isMemPressureHigh(s, { ...DEFAULT_MEM_PRESSURE_THRESHOLDS, swapUsedRatio: 0.9 })).toBe(true)
  })
})
describe('queryMemPressure（即时查询契约）', () => {
  it('物理字段来自 os 当前值，swap 字段来自探针（即时，无任何历史状态）', async () => {
    const first = await queryMemPressure({ probeSwap: async () => ({ swapUsedMB: 10, swapTotalMB: 100 }) })
    const second = await queryMemPressure({ probeSwap: async () => ({ swapUsedMB: 20, swapTotalMB: 100 }) })
    expect(first.totalMB).toBeGreaterThan(0)
    expect(first.freeMB).toBeGreaterThanOrEqual(0)
    expect(first.swapUsedMB).toBe(10)
    // 第二次调用 swap 立即反映新探针值——零缓存零采样环，冷启动单次调用即可判定
    expect(second.swapUsedMB).toBe(20)
  })

  it('探针抛错 → swap 字段降级 null，查询不 reject（best-effort 契约）', async () => {
    const s = await queryMemPressure({ probeSwap: async () => { throw new Error('probe boom') } })
    expect(s.swapUsedMB).toBeNull()
    expect(s.swapTotalMB).toBeNull()
    expect(s.totalMB).toBeGreaterThan(0)
  })

  it('真实平台冒烟：默认探针可执行且返回合法样本（平台差异收敛在 probeSwapPressure 内）', async () => {
    const s = await queryMemPressure()
    expect(s.totalMB).toBeGreaterThan(0)
    expect(s.freeMB).toBeGreaterThanOrEqual(0)
    if (s.swapTotalMB !== null) {
      expect(s.swapTotalMB).toBeGreaterThanOrEqual(0)
      expect(s.swapUsedMB ?? 0).toBeLessThanOrEqual(s.swapTotalMB)
    }
  })
})
});

// ======================================================================
// ← src/infra/__tests__/model-discover-errors.test.ts
// ======================================================================

/** 抛指定错误的 modelSource 替身（discoverFromApi 契约：失败 throw 原始错误）。 */
function makeSourceThrow(err: unknown): IModelSource {
  return {
    async discoverFromApi() {
      throw err
    },
  }
}


async function classify(err: unknown): Promise<ModelDiscoveryError> {
  const svc = new ModelService(makeSourceThrow(err))
  try {
    await svc.discoverModelsFromApi('https://api.example.com')
    throw new Error('expected discoverModelsFromApi to throw')
  } catch (e) {
    if (e instanceof ModelDiscoveryError) return e
    throw e
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('model-discover-errors', () => {
afterEach(() => {
  vi.unstubAllGlobals()
})
describe('RT-7#9：discover 错误分类（超时 / 429 单列 code）', () => {
  it('AbortSignal.timeout 的 TimeoutError → TIMEOUT + 中文文案（原落 UNKNOWN 英文直传）', async () => {
    const timeoutErr = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const err = await classify(timeoutErr)
    expect(err.code).toBe('TIMEOUT')
    expect(err.message).toContain('请求超时')
  })

  it('message 带 aborted due to timeout 的普通 Error → TIMEOUT（message 锚兜底）', async () => {
    const err = await classify(new Error('This operation was aborted due to timeout'))
    expect(err.code).toBe('TIMEOUT')
  })

  it('429（discoverer message 前缀锚）→ RATE_LIMITED + 中文文案', async () => {
    const err = await classify(new Error('API 返回 429: Too Many Requests'))
    expect(err.code).toBe('RATE_LIMITED')
    expect(err.message).toContain('429')
  })

  it('JSON 解析失败（SyntaxError）→ UNKNOWN 但带中文前缀（英文技术串不裸传 UI）', async () => {
    const err = await classify(new SyntaxError('Unexpected token < in JSON at position 0'))
    expect(err.code).toBe('UNKNOWN')
    expect(err.message).toContain('发现失败：')
    expect(err.message).toContain('Unexpected token')
  })

  it('既有分类保持：ByteString → INVALID_AUTH_CHARS；fetch failed → UNREACHABLE', async () => {
    expect((await classify(new Error("Failed to construct 'Request': ByteString"))).code).toBe('INVALID_AUTH_CHARS')
    expect((await classify(new TypeError('fetch failed'))).code).toBe('UNREACHABLE')
  })
})
describe('RT-7#9：discoverer 非 2xx 响应体截断', () => {
  it('429 长 body → 错误 message 中 body 截断 ≤ 200 字（单行压缩）', async () => {
    const longBody = '<html>' + 'x'.repeat(5000) + '</html>'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(longBody, { status: 429 })))

    const discoverer = new ModelApiDiscoverer()
    const err: unknown = await discoverer.discoverFromApi('https://api.example.com').then(
      () => new Error('expected throw'),
      (e: unknown) => e,
    )
    const message = err instanceof Error ? err.message : String(err)
    expect(message).toMatch(/^API 返回 429: <html>x+$/)
    // 前缀「API 返回 429: 」+ 截断 200 字 → 总长 ≤ ~215；5000 字原文必然被截
    expect(message.length).toBeLessThanOrEqual(215)
    expect(message).not.toContain('</html>')
  })

  it('错误 body 为空 → 回退 statusText（既有行为保持）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500, statusText: 'Internal Server Error' })))
    const discoverer = new ModelApiDiscoverer()
    await expect(discoverer.discoverFromApi('https://api.example.com')).rejects.toThrowError(
      'API 返回 500: Internal Server Error',
    )
  })
})
});

// ======================================================================
// ← src/infra/__tests__/npm-git-installer-env.test.ts
// ======================================================================

let capturedEnv: Record<string, string> | undefined

let capturedArgs: readonly unknown[] | undefined


vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 形位对齐真实签名便于阅读
  execFileSync: (_cmd: string, args: readonly unknown[], opts?: { env?: Record<string, string> }) => {
    capturedArgs = args
    capturedEnv = opts?.env
    return Buffer.alloc(0)
  }, }
})

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('npm-git-installer-env', () => {
describe('NpmGitInstaller.installGit — 出站 env 契约（C-proc-09 收编）', () => {
  beforeEach(() => {
    capturedEnv = undefined
    capturedArgs = undefined
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('deny 清单两键不出现在 git 子进程 env', async () => {
    vi.stubEnv('TAIJI_AGENT_PACKAGED', '1')
    vi.stubEnv('TAIJI_RUNTIME_TOKEN', 'deadbeef')
    await new NpmGitInstaller().installGit('https://github.com/a/b.git', '/tmp/dest')
    expect(capturedEnv).toBeDefined()
    expect(capturedEnv?.TAIJI_AGENT_PACKAGED).toBeUndefined()
    expect(capturedEnv?.TAIJI_RUNTIME_TOKEN).toBeUndefined()
  })

  it('PATH/HOME 白名单基座保留', async () => {
    vi.stubEnv('PATH', '/usr/local/bin:/usr/bin')
    vi.stubEnv('HOME', '/Users/tester')
    await new NpmGitInstaller().installGit('https://github.com/a/b.git', '/tmp/dest')
    expect(capturedEnv?.PATH).toBe('/usr/local/bin:/usr/bin')
    expect(capturedEnv?.HOME).toBe('/Users/tester')
  })

  it('代理键显式 forward，未设置的代理键不出现', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7890')
    vi.stubEnv('no_proxy', 'localhost,127.0.0.1')
    await new NpmGitInstaller().installGit('https://github.com/a/b.git', '/tmp/dest')
    expect(capturedEnv?.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(capturedEnv?.no_proxy).toBe('localhost,127.0.0.1')
    expect(capturedEnv?.ALL_PROXY).toBeUndefined()
    expect(capturedEnv?.HTTP_PROXY).toBeUndefined()
    expect(capturedEnv?.NO_PROXY).toBeUndefined()
  })

  it('父 env 未设代理键时 extras 为空对象语义（仅基座 + 无残留）', async () => {
    await new NpmGitInstaller().installGit('https://github.com/a/b.git', '/tmp/dest')
    for (const key of [
      'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
      'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
    ]) {
      expect(capturedEnv?.[key]).toBeUndefined()
    }
  })

  it('clone argv 形态锚定（--depth 1 与 url/destDir 不受改造牵连）', async () => {
    await new NpmGitInstaller().installGit('https://github.com/a/b.git', '/tmp/dest-x')
    expect(capturedArgs).toEqual([
      'clone', '--depth', '1', 'https://github.com/a/b.git', '/tmp/dest-x',
    ])
  })
})
});

// ======================================================================
// ← src/infra/__tests__/spawn-env.test.ts
// ======================================================================

/** 模拟污染父 env：白名单合法变量 + 两个实证害项（探针 P1/P2 元凶） */
const POLLUTED_PARENT: Record<string, string | undefined> = {
  PATH: '/usr/bin:/bin:/usr/sbin',
  HOME: '/Users/tester',
  TERM: 'xterm-256color',
  USER: 'tester',
  NODE_OPTIONS: '--max-old-space-size=4096',
  XDG_CACHE_HOME: '/Users/tester/.cache',
  TAIJI_AGENT_DEBUG: '1',
  TAIJI_GLOBAL_AGENTS_DIR: '/tmp/agents',
  TAIJI_AGENT_PACKAGED: '1',
  TAIJI_RUNTIME_TOKEN: 'deadbeef-token',
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('spawn-env', () => {
describe('buildOutboundChildEnv · 出站契约三步语义', () => {
  it('deny 键剔除：基座与 extras 注入的实证害项一律剥除', () => {
    const out = buildOutboundChildEnv({
      parentEnv: POLLUTED_PARENT,
      // 即使调用方经 extras 强行注入，第三步仍兜底剥除
      extras: { TAIJI_AGENT_PACKAGED: '1', TAIJI_RUNTIME_TOKEN: 'renewed-token' },
    })
    for (const denied of SPAWN_ENV_OUTBOUND_DENY_LIST) {
      expect(out).not.toHaveProperty(denied)
    }
    expect(out.TAIJI_AGENT_PACKAGED).toBeUndefined()
    expect(out.TAIJI_RUNTIME_TOKEN).toBeUndefined()
  })

  it('[R2] 白名单基座完整保留：PATH/HOME/TERM/USER/NODE_*/XDG_* 原样透传', () => {
    const out = buildOutboundChildEnv({ parentEnv: POLLUTED_PARENT })
    expect(out.PATH).toBe('/usr/bin:/bin:/usr/sbin')
    expect(out.HOME).toBe('/Users/tester')
    expect(out.TERM).toBe('xterm-256color')
    expect(out.USER).toBe('tester')
    expect(out.NODE_OPTIONS).toBe('--max-old-space-size=4096')
    expect(out.XDG_CACHE_HOME).toBe('/Users/tester/.cache')
    expect(Object.keys(out)).toContain('PATH')
  })

  it('裸 TAIJI_ 前缀放行的功能契约变量保留（不误伤 forward 清单成员）', () => {
    const out = buildOutboundChildEnv({ parentEnv: POLLUTED_PARENT })
    expect(out.TAIJI_AGENT_DEBUG).toBe('1')
    expect(out.TAIJI_GLOBAL_AGENTS_DIR).toBe('/tmp/agents')
  })

  it('缺省 prefixes = shared 入站白名单 SSOT（非白名单键被过滤）', () => {
    const out = buildOutboundChildEnv({
      parentEnv: { ...POLLUTED_PARENT, SOME_RANDOM_VAR: 'noise', DOCKER_HOST: 'tcp://localhost' },
    })
    expect(out.SOME_RANDOM_VAR).toBeUndefined()
    expect(out.DOCKER_HOST).toBeUndefined()
  })

  it('prefixes 可自定义覆盖缺省 SSOT（B2 main 边界 ELECTRON_ 扩展场景）', () => {
    const out = buildOutboundChildEnv({
      parentEnv: { PATH: '/bin', HOME: '/h', ELECTRON_NO_ATTACH_CONSOLE: '1' },
      prefixes: ['PATH', 'HOME', 'ELECTRON_'],
    })
    expect(out.ELECTRON_NO_ATTACH_CONSOLE).toBe('1')
    expect(out.PATH).toBe('/bin')
  })
})
describe('extras merge（undefined = 显式删除，对齐 safe-env.ts 约定）', () => {
  it('值注入：覆盖父 env 同名键，新增键生效', () => {
    const out = buildOutboundChildEnv({
      parentEnv: { PATH: '/old-path', HOME: '/h' },
      extras: { PATH: '/new-path', PI_CODING_AGENT_DIR: '/data/agent' },
    })
    expect(out.PATH).toBe('/new-path')
    expect(out.PI_CODING_AGENT_DIR).toBe('/data/agent')
  })

  it('undefined 删除语义：删掉白名单已继承的父 env 键', () => {
    const out = buildOutboundChildEnv({
      parentEnv: { PATH: '/bin', HOME: '/h', TERM: 'xterm-256color' },
      extras: { TERM: undefined },
    })
    expect(out.TERM).toBeUndefined()
    expect(out).not.toHaveProperty('TERM')
    expect(out.PATH).toBe('/bin')
  })
})
describe('[R1] 纯函数与入参不可变', () => {
  it('返回全新对象，绝不 mutate 入参（parentEnv 与 extras 均不被改写）', () => {
    const parentEnv = { ...POLLUTED_PARENT }
    const extras: Record<string, string | undefined> = { TERM: undefined, FOO: 'bar' }
    const parentSnapshot = JSON.parse(JSON.stringify(parentEnv))
    const extrasSnapshot = JSON.parse(JSON.stringify(extras))

    const out = buildOutboundChildEnv({ parentEnv, extras })

    // deny 剔除/删除只发生在输出副本上，入参保持原样
    expect(parentEnv).toEqual(parentSnapshot)
    expect(extras).toEqual(extrasSnapshot)
    expect(parentEnv.TAIJI_AGENT_PACKAGED).toBe('1')
    expect(out).not.toBe(parentEnv)
  })

  it('冻结入参后调用不抛错（结构性证明内部零写入）', () => {
    const frozenParent = Object.freeze({ ...POLLUTED_PARENT }) as Record<string, string | undefined>
    const frozenExtras = Object.freeze({ TAIJI_AGENT_DATA_DIR: '/d' }) as Record<string, string | undefined>
    expect(() => buildOutboundChildEnv({ parentEnv: frozenParent, extras: frozenExtras })).not.toThrow()
  })
})
describe('幂等稳定性（大输入）', () => {
  it('1200 键大输入两次调用结果深度相等；再次应用构建器于其输出上结果不变', () => {
    const bigParent: Record<string, string | undefined> = { ...POLLUTED_PARENT }
    for (let i = 0; i < 1200; i++) {
      bigParent[`TAIJI_BULK_KEY_${i}`] = `value-${i}`
    }

    const first = buildOutboundChildEnv({ parentEnv: bigParent })
    const second = buildOutboundChildEnv({ parentEnv: bigParent })
    expect(first).toEqual(second)

    // 幂等：对已净化的输出再跑一遍构建器，无新变化（空 extras）
    const rerun = buildOutboundChildEnv({ parentEnv: first })
    expect(rerun).toEqual(first)
  })
})
});
