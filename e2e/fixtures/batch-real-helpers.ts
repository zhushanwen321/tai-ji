/**
 * batch-real 系 spec 共享 helpers —— 真实 LLM 轨「凭证门与播种 / 诊断与扫描 / run 介质锚」
 * 的单一实现（原 batch-s1/s3/s4、batch-window-*、batch-zsl、batch-cr、btw-turn-isolation
 * 各自头注「同款范式」的拷贝收敛单点）。
 *
 * 逐文件差异全部参数化，行为与拆出前逐字段一致：
 * - diag 落点两种现状都保留：tmpDiag → /tmp/<name>（窗口/进程族 spec 现状）；
 *   testInfoDiag → testInfo.outputPath（Playwright 托管产物位——诊断载荷含 session entry
 *   正文的 s1/s3/s4 走此落点，ADR-0063 I2）。
 * - console 前缀 tag（[batch-s1] / [batch-wl] / [s7] …）。
 * - 凭证源 env 覆盖键：TAIJI_BATCH_CREDENTIAL_SOURCE（batch 族缺省）/ TAIJI_S7_CREDENTIAL_SOURCE
 *   （btw-turn-isolation）。
 * - seed 附加播种（batch-chat-revive 的 worker agent .md）经 extraSeed 挂钩。
 *
 * 凭证播种纪律：只读源目录，写侧恒为临时 dataDir（不触碰真实数据目录）。
 */
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page, type TestInfo } from '@playwright/test'
import {
  openListenWs,
  readPiLogs,
  readRuntimeLogs,
  waitForExtensionsReady,
  waitForRuntime,
  type WsFrame,
} from './launch-app-real'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 仓根 / e2e 采样项目路径（real 轨 spec 共享——原各 spec 头部同构派生收敛单点）。 */
export { REPO_ROOT }
export const SAMPLE_PROJECT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sample-project')

// ── 扫描/诊断缺省参数（launch-app-real 的 JSON_INDENT 同款命名收敛） ──────────

const JSON_INDENT = 2
const DEFAULT_POLL_INTERVAL_MS = 200
const MAX_SCAN_DEPTH = 8
const READY_WAIT_TIMEOUT_MS = 30_000
const DIAG_LOG_TAIL_CHARS = 3_000
const DIAG_SESSION_TAIL_CHARS = 4_000

// ── 凭证门与播种 ──────────────────────────────────────────────────────────

/** 本机 provider 凭证源目录（taiji 数据目录的 agent 子树，运行时动态推导）。 */
export function sourceAgentDir(envVar = 'TAIJI_BATCH_CREDENTIAL_SOURCE'): string {
  const override = process.env[envVar]
  if (override && override.trim() !== '') return override
  return path.join(os.homedir(), '.taiji', 'agent')
}

/** 凭证 + 默认模型门：任一 source 在位且有非空 key 才可跑（缺 → skip 理由，不 fail）。 */
export function realCredentialSkipReason(tag: string, envVar = 'TAIJI_BATCH_CREDENTIAL_SOURCE'): string | null {
  const src = sourceAgentDir(envVar)
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(src, 'auth.json'), 'utf8')) as Record<string, { key?: unknown }>
    if (Object.values(auth).some((c) => typeof c?.key === 'string' && c.key.trim() !== '')) return null
  } catch {
    // 降级策略（best-effort 门禁）：auth.json 缺席/坏 JSON → 继续探测 models.json，两者全缺才 skip
    console.warn(`[${tag}] auth.json 不可读，继续探测 models.json：${src}`)
  }
  try {
    const models = JSON.parse(fs.readFileSync(path.join(src, 'models.json'), 'utf8')) as {
      providers?: Record<string, { apiKey?: unknown }>
    }
    if (Object.values(models.providers ?? {}).some((p) => typeof p?.apiKey === 'string' && p.apiKey.trim() !== '')) {
      return null
    }
  } catch {
    // 降级策略（best-effort 门禁）：models.json 也不可读 → 返回 skip 理由（不 fail）
    console.warn(`[${tag}] models.json 不可读：${src}`)
  }
  return `${src} 的 auth.json / models.json 均无非空 key（本机 provider 凭证缺失）`
}

/**
 * 播种临时 dataDir 的 agent 子树：拷 models.json/auth.json（存在才拷）+ 写 settings 最小子集
 * （defaultProvider/defaultModel——过 runtime getDefaultModel 门禁；retry 关闭保预算确定性）。
 * 刻意剥 packages/skills：用户扩展/skill 清单不进 e2e（pi-fixture 同款防漂移理由）。
 * extraSeed：调用方附加播种挂钩（如 batch-chat-revive 的 worker agent .md），拿到 agentDir。
 */
export function seedRealCredentials(
  dataDir: string,
  tag: string,
  opts: { envVar?: string; extraSeed?: (agentDir: string) => void } = {},
): void {
  const src = sourceAgentDir(opts.envVar)
  const dst = path.join(dataDir, 'agent')
  fs.mkdirSync(dst, { recursive: true })
  for (const f of ['models.json', 'auth.json']) {
    const p = path.join(src, f)
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dst, f))
  }
  let source: Record<string, unknown> = {}
  try {
    source = JSON.parse(fs.readFileSync(path.join(src, 'settings.json'), 'utf8')) as Record<string, unknown>
  } catch {
    // 降级策略（best-effort 播种）：settings.json 不可读 → 缺省字段由 runtime getDefaultModel 门禁拦截
    console.warn(`[${tag}] settings.json 不可读，defaultProvider/defaultModel 缺失将由门禁拦截：${src}`)
  }
  const defaultProvider = source['defaultProvider']
  const defaultModel = source['defaultModel']
  if (typeof defaultProvider !== 'string' || !defaultProvider
    || typeof defaultModel !== 'string' || !defaultModel) {
    throw new Error(`[${tag}] ${src}/settings.json 缺 defaultProvider/defaultModel——先在太极设置页完成 provider 配置`)
  }
  fs.writeFileSync(
    path.join(dst, 'settings.json'),
    JSON.stringify({ defaultProvider, defaultModel, retry: source['retry'] ?? { enabled: false } }, null, JSON_INDENT),
  )
  opts.extraSeed?.(dst)
}

// ── 诊断落盘（两种落点现状共用核心） ──────────────────────────────────────

/** /tmp 落点 diag 工厂（窗口/进程族 spec 现状——载荷为帧型/日志尾，无 entry 正文）。 */
export function tmpDiag(tag: string): (name: string, data: Record<string, unknown>) => void {
  return (name, data) => {
    fs.writeFileSync(`/tmp/${name}`, JSON.stringify(data, null, JSON_INDENT))
    console.log(`[${tag}] diag → /tmp/${name}`)
  }
}

/** Playwright 托管产物位 diag 工厂（testInfo.outputPath——载荷可含 session entry 正文，
 *  /tmp 不是其合法落盘位置，ADR-0063 I2）。 */
export function testInfoDiag(
  tag: string,
): (testInfo: TestInfo, name: string, data: Record<string, unknown>) => void {
  return (testInfo, name, data) => {
    const target = testInfo.outputPath(name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(data, null, JSON_INDENT))
    console.log(`[${tag}] diag → ${target}`)
  }
}

// ── 轮询与扫描 ────────────────────────────────────────────────────────────

/** 轮询等待（真实外部事件必须轮询 + deadline，禁固定 sleep 硬等）。 */
export async function waitUntil(pred: () => boolean, deadlineMs: number, intervalMs = DEFAULT_POLL_INTERVAL_MS): Promise<boolean> {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return pred()
}

/** 递归列 suffix 匹配文件（depth 防失控）。 */
export function listFilesRecursive(root: string, suffix: string, depth = 0, acc: string[] = []): string[] {
  if (depth > MAX_SCAN_DEPTH || !fs.existsSync(root)) return acc
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name)
    if (fs.statSync(p).isDirectory()) listFilesRecursive(p, suffix, depth + 1, acc)
    else if (name.endsWith(suffix)) acc.push(p)
  }
  return acc
}

/** pi session JSONL 行解析（宽容：坏行跳过计数——与 W1 tail 契约的坏行语义一致）。 */
export function parseJsonlLines(file: string): { entries: Record<string, unknown>[]; badLines: number } {
  const entries: Record<string, unknown>[] = []
  let badLines = 0
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      badLines += 1
    }
  }
  return { entries, badLines }
}

/** 主 session JSONL 内指定 customType 的 entry data 集（v2 条目/ledger/ack 断言的取数面）。 */
export function extractCustomEntries(file: string, customType: string): Record<string, unknown>[] {
  const { entries } = parseJsonlLines(file)
  return entries
    .filter((e) => e['type'] === 'custom' && e['customType'] === customType)
    .map((e) => (e['data'] ?? {}) as Record<string, unknown>)
}

/** 送达标签通道：type=custom_message（pi.sendMessage 落盘形态，进 LLM 上下文——
 *  notify-ledger-helpers.ts collectDeliveredNotifyIds 是该形态的权威消费方：
 *  entry.type==='custom_message' + entry.customType + 顶层 entry.details.notifyId。
 *  与 plain custom entry（type=custom，data 平铺——ledger/ack/record 族）是两条
 *  不同的落盘通道，customType 同名也不能混用 extractor。 */
export function extractCustomMessageEntries(file: string, customType: string): Record<string, unknown>[] {
  const { entries } = parseJsonlLines(file)
  return entries.filter((e) => e['type'] === 'custom_message' && e['customType'] === customType)
}

/** run journal 帧解析：{ type, seq, ts, ...载荷 }（坏行宽容跳过）。 */
export function readJournalFrames(file: string): Record<string, unknown>[] {
  return parseJsonlLines(file).entries
}

// ── console 抓取 ──────────────────────────────────────────────────────────

/** console 抓取（renderer 主窗口）：errors 单列，失败诊断必带（全量变体）。 */
export function attachConsoleCapture(page: Page): { all: string[]; errors: string[] } {
  const all: string[] = []
  const errors: string[] = []
  page.on('console', (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`
    all.push(line)
    if (msg.type() === 'error') errors.push(line)
  })
  page.on('pageerror', (err) => {
    const line = `[pageerror] ${String(err)}`
    all.push(line)
    errors.push(line)
  })
  return { all, errors }
}

/** console 抓取（仅 error 面——窗口族 spec 现状变体）。 */
export function attachConsoleErrorCapture(page: Page): { errors: string[] } {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`)
  })
  page.on('pageerror', (err) => errors.push(`[pageerror] ${String(err)}`))
  return { errors }
}

// ── 进程计数（孤儿/在途核对的差分锚） ────────────────────────────────────

/** 指定 sleep 秒数的成员保活进程计数（差分锚——特征串含秒数，长短成员互不串扰；
 *  ps 不可读降级 -1 哨兵）。 */
export function countMemberSleeperProcesses(sleepS: number, tag: string): { count: number; lines: string[] } {
  let out = ''
  try {
    out = execSync('ps -axo command=', { encoding: 'utf8', timeout: 10_000 })
  } catch (err) {
    console.warn(`[${tag}] ps 不可读（进程核对降级为 -1 哨兵）：${String(err)}`)
    return { count: -1, lines: [] }
  }
  const marker = `sleep ${sleepS}`
  const lines = out.split('\n').filter((line) =>
    line.includes(marker) && !line.includes('playwright') && !line.includes('Electron.app'),
  )
  return { count: lines.length, lines }
}

/** count-engine-shell-processes.mjs JSON 原语（薄壳计数/快照两形态的共用执行步；不可读时抛错——
 *  降级语义由调用方决定）。 */
export function engineShellProcessSnapshot(): { count: number; processes: { pid: number; command: string }[] } {
  const out = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts', 'count-engine-shell-processes.mjs')],
    { encoding: 'utf8', timeout: 10_000 },
  )
  return JSON.parse(out) as { count: number; processes: { pid: number; command: string }[] }
}

/** 引擎宿主薄壳计数（'pi-subagent-cli' / '/engines/' 特征并集）。特征串权威单源 =
 *  scripts/count-engine-shell-processes.mjs；ps/脚本不可读降级 -1 哨兵。基线差分由调用方做
 *  （zcode 常驻单例与测试进程 cmdline 噪声被基线吸收）。 */
export function countEngineShellProcesses(tag: string): { count: number; lines: string[] } {
  try {
    const parsed = engineShellProcessSnapshot()
    return { count: parsed.count, lines: parsed.processes.map((p) => `${p.pid} ${p.command}`) }
  } catch (err) {
    console.warn(`[${tag}] 引擎宿主计数不可读（降级 -1 哨兵）：${String(err)}`)
    return { count: -1, lines: [] }
  }
}

/** 真机 app 就绪三连（窗口标题 / runtime 端口 / extensions resolver）。返回 runtime 端口。 */
export async function waitRealAppReady(page: Page, dataDir: string, tag: string, timeoutMs = READY_WAIT_TIMEOUT_MS): Promise<number> {
  await expect(page).toHaveTitle(/太极/)
  const port = await waitForRuntime(dataDir, timeoutMs)
  expect(port).toBeGreaterThan(0)
  const resolved = await waitForExtensionsReady(dataDir)
  if (resolved === 0) console.warn(`[${tag}] extensions not ready within timeout, continue anyway`)
  return port
}

/**
 * 真实 LLM 轨双凭证门（在 test 体内调用）：预算 + TAIJI_PI_LIVE 门 + 本机 provider 凭证门
 * （缺一 skip 不 fail——防全量扫跑烧 token；CI/PR/merge 门禁不跑本轨）。
 */
export function applyRealTrackGate(
  testFn: { setTimeout(ms: number): void; skip(condition: unknown, description?: string): void },
  opts: { timeoutMs: number; tag: string; envVar?: string },
): void {
  testFn.setTimeout(opts.timeoutMs)
  testFn.skip(
    process.env['TAIJI_PI_LIVE'] !== '1',
    '真实 LLM 轨门：TAIJI_PI_LIVE=1 才执行（e2e 执行准则——开发期按改动范围手动触发，CI/门禁不跑）',
  )
  const credSkip = realCredentialSkipReason(opts.tag, opts.envVar)
  testFn.skip(credSkip !== null, credSkip ?? '')
}

// ── session / journal / notify 锚 ─────────────────────────────────────────

/** real 轨 spec 共享收尾（各 spec finally 单行调用）：listener 关闭 → app cleanup →
 *  临时 dataDir 清理（PLAYWRIGHT_DEBUG_KEEP_DATA 置位时保留现场）。listener 关闭
 *  异常不阻断后续清理（swallow——清理链继续）。 */
export async function cleanupRealTrackApp(opts: {
  closeListeners: () => void
  cleanup: () => Promise<void>
  dataDir: string
}): Promise<void> {
  try {
    opts.closeListeners()
  } finally {
    await opts.cleanup()
    if (!process.env['PLAYWRIGHT_DEBUG_KEEP_DATA']) {
      fs.rmSync(opts.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  }
}

/**
 * 主 session 装配共享步：session.created 回执校验 + sid 提取（非空 fail-fast）+ 订阅。
 * 返回 sid 与 listen 订阅（调用方自行挂 cleanup——各 spec 的 finally 形态各异）。
 */
export async function openMainListenWs(
  port: number,
  createReply: WsFrame,
): Promise<{ sid: string; sub: { ws: { close: () => void }; events: WsFrame[] } }> {
  expect(createReply.type).toBe('session.created')
  const sid = ((createReply.payload ?? {}) as { session?: { id?: string } }).session?.id
  if (typeof sid !== 'string' || sid === '') throw new Error('session.created reply 应携带非空 session.id')
  const sub = await openListenWs(port, sid)
  return { sid, sub }
}

/** run journal（<runId>.record.jsonl）等待：缺席落 diag（runtime/pi 日志尾为基座载荷，
 *  diagExtra 供调用方补 console errors / agentTree 等归因载荷），命中返回首个 journal
 *  文件路径。runId 解析与形态校验留给调用方（各 spec 断言粒度不同）。 */
export async function waitForRunJournal(opts: {
  agentDir: string
  /** dataDir（runtime/pi 日志尾 diag 载荷的取数根） */
  dataDir: string
  timeoutMs: number
  foundMessage: string
  diag: (name: string, data: Record<string, unknown>) => void
  diagName: string
  diagExtra?: Record<string, unknown>
}): Promise<string> {
  const journalFound = await waitUntil(
    () => listFilesRecursive(opts.agentDir, '.record.jsonl').length > 0,
    opts.timeoutMs,
  )
  if (!journalFound) {
    opts.diag(opts.diagName, {
      runtimeLogsTail: readRuntimeLogs(opts.dataDir).slice(-DIAG_LOG_TAIL_CHARS),
      piLogsTail: readPiLogs(opts.dataDir).slice(-DIAG_LOG_TAIL_CHARS),
      ...opts.diagExtra,
    })
  }
  expect(journalFound, opts.foundMessage).toBe(true)
  return listFilesRecursive(opts.agentDir, '.record.jsonl')[0]!
}

/** journal run-settled 恰 1 帧且 outcome 相符（run 终局断言共享形态）。返回该帧。 */
export function assertSingleRunSettled(
  frames: Record<string, unknown>[],
  outcome: string,
  outcomeMessage: string,
): Record<string, unknown> {
  const settledFrames = frames.filter((f) => f['type'] === 'run-settled')
  expect(settledFrames.length, 'run-settled 应恰 1 帧').toBe(1)
  expect(settledFrames[0]?.['outcome'], outcomeMessage).toBe(outcome)
  return settledFrames[0]!
}

/** 主会话 JSONL 定位（含 marker 哨兵；pi 延迟写入语义——flush 后文件必在，轮询等待）。 */
export async function locateMainSessionFile(
  agentDir: string,
  marker: string,
  flushTimeoutMs: number,
  foundMessage: string,
): Promise<string> {
  const found = await waitUntil(
    () => listFilesRecursive(path.join(agentDir, 'sessions'), '.jsonl').some((f) => {
      try { return fs.readFileSync(f, 'utf8').includes(marker) } catch { return false }
    }),
    flushTimeoutMs,
  )
  expect(found, foundMessage).toBe(true)
  return listFilesRecursive(path.join(agentDir, 'sessions'), '.jsonl')
    .find((f) => fs.readFileSync(f, 'utf8').includes(marker))!
}

/**
 * 通知三通道口径（BATCH-06）：①送达恰 1 = type custom_message × customType
 * "workflow-result"（u9 外部通道设计，幂等键单次投递，键在顶层 details.notifyId）；
 * ②ledger 条目写入恰 1 = type custom × "subagent-bg-notify-ledger"（键在 data.notifyId）；
 * ③ack 关闭恰 1 = type custom × "subagent-bg-notify-ack"（at-least-once 幂等闭环）。
 * 「notifyId 字面出现次数」结构性 = 3 ≠ 投递次数。ack 由回执扫描（agent_settled 边沿）
 * 驱动——通知唤醒 turn 结算后才落盘，先等待再计数（r3 实测：送达后立即断言 Received 0）；
 * ack 缺席落 diag（diagExtra 供调用方补 journal 帧序等归因载荷）。
 */
export async function assertNotifyThreeChannels(opts: {
  sessionFile: string
  notifyId: string
  ackTimeoutMs: number
  dataDir: string
  diag: (name: string, data: Record<string, unknown>) => void
  diagName: string
  diagExtra?: Record<string, unknown>
}): Promise<void> {
  const deliveredWorkflowResults = extractCustomMessageEntries(opts.sessionFile, 'workflow-result').filter(
    (e) => ((e['details'] ?? {}) as Record<string, unknown>)['notifyId'] === opts.notifyId,
  )
  expect(
    deliveredWorkflowResults.length,
    'notifyDone 送达通道（custom_message × workflow-result）应恰 1 条（幂等键单次投递）',
  ).toBe(1)
  const countNotifyEntries = (customType: string): number =>
    extractCustomEntries(opts.sessionFile, customType)
      .filter((d) => JSON.stringify(d).includes(opts.notifyId)).length
  expect(
    countNotifyEntries('subagent-bg-notify-ledger'),
    'notifyDone ledger 条目应恰 1 条（at-least-once 幂等闭环——写入/关闭各恰一次，BATCH-06 口径）',
  ).toBe(1)
  const ackArrived = await waitUntil(
    () => countNotifyEntries('subagent-bg-notify-ack') > 0,
    opts.ackTimeoutMs,
  )
  if (!ackArrived) {
    opts.diag(opts.diagName, {
      sessionTail: fs.readFileSync(opts.sessionFile, 'utf8').slice(-DIAG_SESSION_TAIL_CHARS),
      runtimeLogsTail: readRuntimeLogs(opts.dataDir).slice(-DIAG_LOG_TAIL_CHARS),
      ...opts.diagExtra,
    })
  }
  expect(ackArrived, `notifyDone ack 关闭应在 turn 结算后落盘（agent_settled 边沿，${opts.ackTimeoutMs}ms 窗）`).toBe(true)
  expect(
    countNotifyEntries('subagent-bg-notify-ack'),
    'notifyDone ack 关闭应恰 1 条（at-least-once 幂等闭环——写入/关闭各恰一次，BATCH-06 口径）',
  ).toBe(1)
}
