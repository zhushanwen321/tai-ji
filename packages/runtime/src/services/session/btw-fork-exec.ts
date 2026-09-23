/**
 * btw fork 链路面：session 文件 header 只读解析 + fork 源状态三分支判定（D3）+
 * 一次性 fork bootstrap 执行（V2① 双旗标实测通道）。
 *
 * 内聚段抽自 btw-service.ts（max-lines 同目录内聚拆分，2026-09-22，纯移动零行为变更）：
 * 三段同属 createLine 的 fork 分支一体（读源 → 判状态 → 执行 fork；readSessionHeader
 * 兼作 createLine 的 fork 文件验收与 rebuild 的线文件 header 读取）。全部为
 * fixture 可驱动的纯函数/一次性执行体，不触服务状态；btw-service 保持原样 re-export
 *（导出面零变更），`from '.../btw-service.js'` 消费路径零改动
 *（inspectSourceState / forkViaCliPi 的既有测试同）。
 *
 * 关键红线呼应（AGENTS.md 关键规则）：
 *   #6 pi session 延迟写入：宿主只读源/线文件，fork 文件由 pi fork 链路写；
 *   #19 超时默认原则：fork bootstrap 属「控制面单请求」量级 → 秒级有界（10s）；
 *   #12 打包约束：本模块只 spawn（经注入 piCommand），不拼 ESM 模块元数据 URL 类路径
 *      （该属性在 CJS bundle 下恒为 undefined——原文随段从 btw-service 迁入此处）；
 *      bootstrap 出站 env 经 buildOutboundChildEnv（C-proc-09）。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildOutboundChildEnv } from '../../infra/spawn-env.js'
import { getPiAgentDir } from '../../infra/pi/pi-paths.js'
import { toErrorMessage } from '../../utils/errors.js'
import { BtwError } from './btw-error.js'

/**
 * fork bootstrap 就绪上限（控制面单请求量级，规则 #19）：实测双旗标 fork 落盘 206ms
 *（V2 探针 A），10s 覆盖慢机/冷缓存；超时 → 回落无 fork 分支（不静默：pill 标 no-source）。
 */
export const BTW_FORK_TIMEOUT_MS = 10_000

/** fork bootstrap 目录轮询节拍（扫到新增 .jsonl 即收进程；控制面内部采样间隔，规则 #19 秒级量级）。 */
const FORK_POLL_INTERVAL_MS = 50

/**
 * SIGTERM 宽限上限：bootstrap 收进程后等退出的兜底（node 默认 SIGTERM 即终止，
 * 目标注册 handler 吞信号属极端形态——超时升级 SIGKILL，不可捕获即保证返回）。
 */
export const BTW_FORK_KILL_GRACE_MS = 5_000

/** fork 失败诊断保留的 stderr 尾行数。 */
const STDERR_TAIL_LINES = 3

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数 helper（fixture 可驱动，独立可测）
// ─────────────────────────────────────────────────────────────────────────────

/** session 文件 header（首行 type:"session"）。 */
export interface BtwSessionHeader {
  id: string
  cwd?: string
  timestamp?: string
}

/**
 * 读线/源会话文件 header（宿主只读——规则 #6 零直写；读侧容忍首 flush 前文件缺失）。
 * 非法/缺失 throw（调用方按分支处置：源 → 回落；线文件 → line_not_found 系错误）。
 */
export function readSessionHeader(sessionFile: string): BtwSessionHeader {
  let raw: string
  try {
    raw = readFileSync(sessionFile, 'utf8')
  } catch (e) {
    throw new BtwError('spawn_state_invalid', `[btw] session file unreadable (${sessionFile}): ${toErrorMessage(e)}`)
  }
  const firstLine = raw.split('\n', 1)[0] ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(firstLine)
  } catch {
    throw new BtwError('spawn_state_invalid', `[btw] session header unparsable: ${sessionFile}`)
  }
  const header = parsed as { type?: string; id?: unknown; cwd?: unknown; timestamp?: unknown }
  if (header.type !== 'session' || typeof header.id !== 'string' || header.id.length === 0) {
    throw new BtwError('spawn_state_invalid', `[btw] session header invalid (type/id): ${sessionFile}`)
  }
  return {
    id: header.id,
    cwd: typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined,
    timestamp: typeof header.timestamp === 'string' ? header.timestamp : undefined,
  }
}

/** 源状态检查结果。 */
export type BtwSourceState =
  | { state: 'ok'; hasDanglingToolCall: boolean }
  | { state: 'unavailable'; reason: 'unresolved' | 'missing' | 'unparsable' | 'empty' | 'io' }

/**
 * 收集 entry 集中的悬空 tool-call（有 toolCall 无对应 toolResult）——分支③「源含
 * 进行中 turn 的已落盘部分」的文件级判定（P-fork-source）。形状容忍多代 pi 消息
 * 结构（content item `toolResult.toolCallId` / message role toolResult 的
 * `toolCallId` 字段），判定只影响 pill 标注不影响 fork 内容（fork 逐字节复制）。
 *
 * 分解件（metrics-gate 复杂度偿还）：单 entry 形状守卫归 asPiMessageEntry、单
 * content item 判定归 collectContentItemIds，本函数只做两集合收集与差集判定。
 */
export function hasDanglingToolCall(entries: readonly unknown[]): boolean {
  const { callIds, resultIds } = collectToolCallIds(entries)
  return [...callIds].some(id => !resultIds.has(id))
}

/** 单个 pi message entry 的最小形状面（悬空判定的消费字段）。 */
interface DanglingCheckMessage {
  toolCallId?: unknown
  content?: unknown
}

/** entry 形状守卫：非 message entry / message 非对象 → undefined（判定面外，跳过）。 */
function asPiMessageEntry(raw: unknown): DanglingCheckMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const entry = raw as { type?: string; message?: DanglingCheckMessage | null }
  if (entry.type !== 'message' || typeof entry.message !== 'object' || entry.message === null) return undefined
  return entry.message
}

/** 单 content item 的 id 归集：toolCall 计入 callIds；toolResult（toolCallId 缺省回落 id）计入 resultIds。 */
function collectContentItemIds(item: unknown, callIds: Set<string>, resultIds: Set<string>): void {
  if (typeof item !== 'object' || item === null) return
  const part = item as { type?: string; id?: unknown; toolCallId?: unknown }
  if (part.type === 'toolCall' && typeof part.id === 'string') callIds.add(part.id)
  if (part.type === 'toolResult') {
    const tid = typeof part.toolCallId === 'string' ? part.toolCallId : part.id
    if (typeof tid === 'string') resultIds.add(tid)
  }
}

/** 单轮收集：逐 entry 取 message（含 role toolResult 的顶层 toolCallId 字段）+ 逐 content item 归集。 */
function collectToolCallIds(entries: readonly unknown[]): { callIds: Set<string>; resultIds: Set<string> } {
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const raw of entries) {
    const message = asPiMessageEntry(raw)
    if (!message) continue
    if (typeof message.toolCallId === 'string') resultIds.add(message.toolCallId)
    if (!Array.isArray(message.content)) continue
    for (const item of message.content) {
      collectContentItemIds(item, callIds, resultIds)
    }
  }
  return { callIds, resultIds }
}

/**
 * 检查 fork 源状态（D3 分支② 判定；语义对齐 pi `forkFrom` 守卫——缺失/空/无 header
 * 即不可 fork——并**更严**一档：header-only（零非 header entry）也判不可用，构造性
 * 杜绝「空上下文线」击穿 G2；pi 对 header-only 会产出空快照文件，宿主前置拦截）。
 * pi 守卫与 header-only 行为断言登记 PS-51（锚点 pi@0.84.4
 * dist/core/session-manager.js forkFrom :1237-1246 守卫 throw / :1271-1275 循环
 * 对 header-only 源零 append 仍产出文件），durable 探针 = btw-pi-fork-semantics.test.ts。
 * 读侧容忍尾部半行（append 中读到未写完的行直接丢弃，不整文件判废）。
 */
export function inspectSourceState(sourceFile: string | undefined): BtwSourceState {
  if (!sourceFile) return { state: 'unavailable', reason: 'unresolved' }
  let raw: string
  try {
    raw = readFileSync(sourceFile, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { state: 'unavailable', reason: 'missing' }
    console.warn(`[btw] fork source read failed (${sourceFile}): ${toErrorMessage(e)}`)
    return { state: 'unavailable', reason: 'io' }
  }
  const entries: unknown[] = []
  let header: unknown
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if ((parsed as { type?: string }).type === 'session' && header === undefined) header = parsed
      else entries.push(parsed)
    } catch {
      // 尾部半行（并发 append 中）容忍丢弃；非尾部坏行不阻断（pi fork 自会整读复判）。
      const isLastNonEmpty = lines.slice(i + 1).every(l => !l || !l.trim())
      if (!isLastNonEmpty) console.warn(`[btw] fork source corrupt line ${i + 1} (${sourceFile}) — tolerated for inspection`)
    }
  }
  if (header === undefined) return { state: 'unavailable', reason: 'unparsable' }
  if (entries.length === 0) return { state: 'unavailable', reason: 'empty' }
  return { state: 'ok', hasDanglingToolCall: hasDanglingToolCall(entries) }
}

// ─────────────────────────────────────────────────────────────────────────────
// fork bootstrap（V2① 双旗标实测通道；导出供组合根/测试复用）
// ─────────────────────────────────────────────────────────────────────────────

export interface ForkViaCliRequest {
  piCommand: string
  sourceFile: string
  threadDir: string
  cwd: string
  timeoutMs?: number
  /** SIGTERM 宽限上限（超时升级 SIGKILL 的触发线；秒级量级，测试注入缩短用）。 */
  killGraceMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 一次性 fork bootstrap：`pi --mode rpc --fork <源> --session-dir <线目录>` 起进程，
 * pi 在启动期同步完成 forkFrom 落盘（写 header + 逐条复制全树，V2 探针 A 实测 206ms；
 * 写序断言登记 PS-51，锚点 pi@0.84.4 dist/core/session-manager.js forkFrom :1237），
 * 宿主轮询到**新增** .jsonl 即 SIGTERM 收掉 bootstrap 并等其退出（文件可见先于内容
 * 写完，退出即写入侧封闭）再返回（该进程不承载线——线进程由
 * ensureProcess 另行惰性 spawn，避免污染进程表）。
 *
 * 失败语义（调用方按 D3 分支② 回落）：源缺失/空 → pi exit 1（不产空文件，V2 探针 D）；
 * 超时/异因退出 → throw（携带 stderr 尾，调用方 warn 后回落 no-source，pill 不静默）。
 * 出站 env 经 buildOutboundChildEnv（C-proc-09），PI_CODING_AGENT_DIR 与线进程同源隔离。
 */
export async function forkViaCliPi(req: ForkViaCliRequest): Promise<string> {
  const timeoutMs = req.timeoutMs ?? BTW_FORK_TIMEOUT_MS
  const existing = new Set(existsSync(req.threadDir) ? readdirSync(req.threadDir).filter(f => f.endsWith('.jsonl')) : [])
  const env = buildOutboundChildEnv({ parentEnv: process.env, extras: { PI_CODING_AGENT_DIR: getPiAgentDir() } })
  const args = ['--mode', 'rpc', '--fork', req.sourceFile, '--session-dir', req.threadDir]
  let spawnError: Error | undefined
  let child
  try {
    child = spawn(req.piCommand, args, { cwd: req.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    // spawn 同步抛（参数面异常）：包成 fork_failed，调用方回落分支②。
    throw new BtwError('fork_failed', `[btw] pi fork bootstrap spawn failed: ${toErrorMessage(e)}`)
  }
  child.stdout.on('data', () => {}) // bootstrap 进程 stdout 不消费（fork 后即收）
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
  // 'error' 必须监听并入 exited 汇合口：spawn 失败（ENOENT：pi 缺失 / cwd 死路径）只发
  // error 不发 exit——漏听会 uncaughtException 崩 runtime 且轮询空等到超时（M1-b 实测教训）。
  const exited = new Promise<number>(resolve => {
    child.on('exit', code => resolve(code ?? -1))
    child.on('error', (e: Error) => { spawnError = e; resolve(-1) })
  })

  const deadline = Date.now() + timeoutMs
  for (;;) {
    const files = existsSync(req.threadDir) ? readdirSync(req.threadDir).filter(f => f.endsWith('.jsonl') && !existing.has(f)) : []
    if (files.length > 0) {
      const file = join(req.threadDir, files[0])
      child.kill('SIGTERM')
      // 等退出再返回：pi forkFrom 先 writeFileSync(header) 后逐条 appendFileSync，
      // 文件可见先于内容写完；Node 信号不打断同步复制循环，进程退出即写入侧封闭，
      // 下游 switchSession 读到的是完整静止文件（构造性保证，非时序依赖）。
      // 写序断言登记 PS-51（锚点 pi@0.84.4 dist/core/session-manager.js:1237 定义 /
      // :1269 wx 写 / :1271-1275 append 循环）——pi 改异步落盘即漂移，重验见该条目 guard。
      // SIGTERM 极端形态（目标注册 handler 吞信号不退，node 默认即终止故罕见）→ 宽限
      // 后升级 SIGKILL（不可捕获，写入侧随进程消亡封闭），保证 await 不无限 pending。
      await Promise.race([
        exited,
        sleep(req.killGraceMs ?? BTW_FORK_KILL_GRACE_MS).then(() => {
          child.kill('SIGKILL')
          return exited
        }),
      ])
      return file
    }
    if (await Promise.race([exited.then(() => true), sleep(FORK_POLL_INTERVAL_MS).then(() => false)])) {
      const code = await exited
      if (spawnError) throw new BtwError('fork_failed', `[btw] pi fork bootstrap spawn failed: ${spawnError.message} — source=${req.sourceFile}`)
      const tail = stderr.trim().split('\n').slice(-STDERR_TAIL_LINES).join(' | ')
      throw new BtwError('fork_failed', `[btw] pi fork bootstrap exited (code ${code}) — source=${req.sourceFile} stderr=${tail}`)
    }
    if (Date.now() > deadline) {
      child.kill('SIGTERM')
      throw new BtwError('fork_failed', `[btw] pi fork bootstrap timed out after ${timeoutMs}ms — source=${req.sourceFile}`)
    }
  }
}
