/**
 * pi stdout tee 单文件 size 轮转测试（crash-forensics-and-watchdog §3.3 D7，单元 u9；
 * dev-0.9.17 合并后对齐 .1.gz gzip 口径——u9 的 .1 平面滚动实现被对方取代）。
 *
 * 收口 198MB 实证问题（持续活跃 session 单文件无界累积）的行为验证。阈值经 env
 * `TAIJI_LOG_MAX_BYTES` 注入（pi tee 与主日志共用 MAX_FILE_BYTES，模块 import 时读取，
 * 每用例 resetModules + 动态 import 拿新实例；u9 的 opts.maxBytes 注入面已随合并移除）：
 * 1. 超限旋段：旧段 gzip 归档 `.jsonl.1.gz`（单代，多轮轮转后 rename 原子覆盖）+ 主档
 *    截断续写（flags 'w'）
 * 2. `pi-` 前缀不变量：旋段文件名保持 pi- 开头——cleanExpiredLogs 白名单只认顶层
 *    pi-* 前缀，旋段逃出白名单 = 新的无清理写入面（架构 D6③ 原文约束）
 * 3. 跨段行级连续：.1.gz 解压段 + 主档拼接行序连续无缺行（轮转边界无在途写丢失）
 * 4. 尾部 flush 走新流：轮转完成后写入的尾部行经 closeLogger 落在新主档（A5 通过标准，
 *    openPiStreams 注册表 stream 引用轮转后更新）
 * 5. relay 形态同款：createPiRelayLog（D7 复刻点③ `pi-relay-*` 同款，与 session tee
 *    共享 createPiStreamWriter）
 *
 * [合并裁决 2026-09] u9 的「打开时预滚（跨重启 stat 超阈值先滚动）」用例已删除：对方
 * 实现的 pi 流无打开时预滚（仅主日志 openMainStream 有），语义随 .1 实现被取代失去宿主。
 *
 * 真实 fs + mkdtempSync 自建自删目录（fs-guard 白名单合规，禁止触碰真实数据目录）；
 * 写流 flush 是异步的，断言前轮询等待（对齐 test/logger.test.ts 既有形态）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

type LoggerModule = typeof import('../logger.js')

let logger: LoggerModule | undefined
let dataDir: string
let logsDirPath: string
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
  debug: console.debug,
}
/** logger 模块 import 时读取的全部 env 快照（beforeEach 保存 / afterEach 恢复）。 */
const LOG_ENV_KEYS = ['TAIJI_LOG_MAX_BYTES', 'TAIJI_LOG_KEEP_DAYS', 'TAIJI_LOG_LEVEL'] as const
let savedEnv: Record<string, string | undefined>

/** 让事件循环转一圈：WriteStream 异步 fd open / flush / close 在 tick 间完成（生产节奏）。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 写入后等两个 tick：让在途 flush 完成，下一行写入前轮转窗口已收敛（确定性）。 */
async function settleWrite(): Promise<void> {
  await tick()
  await tick()
}

/** 轮询直到 predicate 为真（写流 flush / 异步轮转续体落盘时机不定，固定 sleep 不可靠）。 */
async function waitFor(desc: string, predicate: () => boolean, deadlineMs = 5000): Promise<void> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    try {
      if (predicate()) return
    } catch { /* 目录/文件尚未就绪，继续轮询 */ }
    if (Date.now() >= deadline) throw new Error(`waitFor timeout (${deadlineMs}ms): ${desc}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** logs 目录下文件名含 marker 的全部条目（排序；main 日志 runtime-* 不含 sid marker 天然排除）。 */
function filesWithMarker(marker: string): string[] {
  return readdirSync(logsDirPath).filter((f) => f.includes(marker)).sort()
}

/** 以指定 env 重新加载 logger 模块（MAX_FILE_BYTES 等模块级常量在 import 时读 env）。 */
async function loadLogger(env: Record<string, string> = {}): Promise<LoggerModule> {
  vi.resetModules()
  for (const key of LOG_ENV_KEYS) delete process.env[key]
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  return import('../logger.js')
}

/** 读主档按行拆分（trim 后过滤空行）。 */
function readLines(name: string): string[] {
  return readFileSync(join(logsDirPath, name), 'utf8').trim().split('\n').filter((l) => l.trim())
}

/** 解压 .1.gz 旋段并按行拆分（轮转产物必须仍是逐行可解析的诊断证据）。 */
function gunzipLines(name: string): string[] {
  return gunzipSync(readFileSync(join(logsDirPath, name))).toString('utf8').trim().split('\n').filter((l) => l.trim())
}

/** 按行提取 JSON 行内 "i":N 序号（行级连续性断言用）。 */
function extractIndices(content: string): number[] {
  const numbers: number[] = []
  for (const line of content.trim().split('\n')) {
    const m = line.match(/"i":(\d+)/)
    if (m) numbers.push(Number(m[1]))
  }
  return numbers
}

beforeEach(() => {
  vi.resetModules()
  dataDir = mkdtempSync(join(tmpdir(), 'logger-tee-rot-'))
  logsDirPath = join(dataDir, 'logs')
  savedEnv = Object.fromEntries(LOG_ENV_KEYS.map((k) => [k, process.env[k]]))
  // 屏蔽测试中 console 的终端输出（initLogger 会 monkey-patch console）
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  console.info = () => {}
  console.debug = () => {}
})

afterEach(async () => {
  console.log = originalConsole.log
  console.warn = originalConsole.warn
  console.error = originalConsole.error
  console.info = originalConsole.info
  console.debug = originalConsole.debug
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  // 未显式 close 的测试在此兜底收尾；已 close 的重复调用幂等（closeLogger 后写入为 no-op）
  await logger?.closeLogger().catch(() => {})
  // maxRetries 对齐 test/logger.test.ts 先例：与刚 close 的真实写流在途 flush 竞争时重试删除
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('pi tee size 轮转（D7，.1.gz 口径）', () => {
  it('超限旋段：旧段 gzip 单代 .1.gz + 主档截断续写，pi- 前缀保持，跨段行级连续止于尾行', async () => {
    // 阈值/行数口径（flake 根修 2026-09-15）：行 ~28B、600B 阈值 → 轮转边界落在
    // i≈21 / i≈41，末段（主档）≈20 行。轮转窗口的 pending 回放时序会让边界漂移
    // ±数行（真实 fs flush 时机不定，200B/40 行口径下实测幸存尾行数 9..15 波动，
    // 「≥10」断言余量被吃穿）——600B/61 行让末段相对断言下限留 10 行余量，两个
    // 轮转边界仍覆盖「单代 gzip rename 原子覆盖」语义。行级不变式（连续 / 止于
    // 尾行 / 恰 2 文件）与边界位置无关，不受漂移影响。
    logger = await loadLogger({ TAIJI_LOG_MAX_BYTES: '600' })
    logger.initLogger(dataDir)
    const sid = 'rot-sid-1'
    const sessionLog = logger.createPiSessionLog(sid)
    for (let i = 0; i < 61; i++) {
      sessionLog.write(JSON.stringify({ i, pad: 'x'.repeat(10) }))
      await settleWrite()
    }
    sessionLog.end()
    await logger.closeLogger()

    const files = filesWithMarker(sid)
    const rolled = files.filter((f) => f.endsWith('.jsonl.1.gz'))
    const main = files.filter((f) => f.endsWith('.jsonl') && !f.endsWith('.1.gz'))
    expect(rolled).toHaveLength(1) // gzip 单代：多轮轮转后 rename 原子覆盖，不无限累积
    expect(main).toHaveLength(1)
    expect(files).toHaveLength(2)
    // pi- 前缀不变量（架构 D6③）：旋段以 pi- 开头 = cleanExpiredLogs 白名单
    // （startsWith('pi-')）可命中，旋段不会成为无清理写入面
    for (const f of files) expect(f.startsWith('pi-')).toBe(true)
    expect(rolled[0]).toMatch(/^pi-.*\.jsonl\.1\.gz$/)
    // 跨段行级连续：.1.gz 解压段（旧段）+ 主档（新段）拼接无缺行、单调递增、止于最后写入行
    const indices = [...gunzipLines(rolled[0]), ...readLines(main[0])].flatMap((l) => extractIndices(l))
    expect(indices.length).toBeGreaterThanOrEqual(10) // 末段 ≈20 行（余量见上方口径注释）
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBe(indices[i - 1] + 1)
    }
    expect(indices[indices.length - 1]).toBe(60)
  })

  it('尾部 flush 走新流：轮转完成后写入的尾部行经 closeLogger 落在新主档（A5）', async () => {
    logger = await loadLogger({ TAIJI_LOG_MAX_BYTES: '200' })
    logger.initLogger(dataDir)
    const sid = 'tail-sid-2'
    const sessionLog = logger.createPiSessionLog(sid)
    for (let i = 0; i < 10; i++) {
      sessionLog.write(JSON.stringify({ i, pad: 'x'.repeat(10) }))
      await settleWrite()
    }
    // 等 .1.gz 旋段出现且轮转续体收敛（新流已重开、窗口行已回放）
    await waitFor(`.jsonl.1.gz segment for ${sid}`, () => filesWithMarker(sid).some((f) => f.endsWith('.jsonl.1.gz')))
    await settleWrite()
    // 轮转之后的尾部行必须写进轮转后的新流（注册表 stream 引用已更新）
    sessionLog.write('{"tail":"after-rotation-final-line"}')
    sessionLog.end()
    await logger.closeLogger()

    const rolled = filesWithMarker(sid).find((f) => f.endsWith('.jsonl.1.gz'))!
    const main = filesWithMarker(sid).find((f) => f.endsWith('.jsonl') && !f.endsWith('.1.gz'))!
    const rolledContent = gunzipLines(rolled).join('\n')
    const mainContent = readLines(main).join('\n')
    expect(rolledContent).toContain('"i":0') // 早期行在旧段
    expect(rolledContent).not.toContain('after-rotation-final-line')
    expect(mainContent).toContain('after-rotation-final-line') // 尾部行在新段（flush 走新流）
    expect(mainContent.split('\n').flatMap((l) => extractIndices(l)).at(-1)).toBe(9) // 轮转窗口回放 + 后续行无丢失
  })

  it('relay 形态同款：createPiRelayLog 旋段 pi-relay-*.jsonl.1.gz，pi- 前缀白名单覆盖保持', async () => {
    logger = await loadLogger({ TAIJI_LOG_MAX_BYTES: '150' })
    logger.initLogger(dataDir)
    const recordId = 'relay-rec-3'
    const relayLog = logger.createPiRelayLog(recordId)
    // string 行级写入 + Uint8Array 原始字节镜像（relay up 方向 chunk 形态）混合写入
    for (let i = 0; i < 20; i++) {
      relayLog.write(JSON.stringify({ i, pad: 'y'.repeat(8) }))
      await settleWrite()
    }
    relayLog.write(new TextEncoder().encode('{"raw":"bytes-chunk"}\n'))
    relayLog.end()
    await logger.closeLogger()

    const files = filesWithMarker(recordId)
    const rolled = files.filter((f) => f.endsWith('.jsonl.1.gz'))
    const main = files.filter((f) => f.endsWith('.jsonl') && !f.endsWith('.1.gz'))
    expect(rolled).toHaveLength(1)
    expect(main).toHaveLength(1)
    // pi-relay- 前缀保持（旋段仍以 pi- 开头 = 保留期清理白名单可命中）
    for (const f of files) expect(f.startsWith('pi-relay-')).toBe(true)
    for (const f of rolled) expect(f.startsWith('pi-')).toBe(true)
    const all = [...rolled.map((f) => gunzipLines(f).join('\n')), ...main.map((f) => readLines(f).join('\n'))].join('\n')
    expect(all).toContain('"raw":"bytes-chunk"') // Uint8Array chunk 亦随轮转落盘不丢
  })
})
