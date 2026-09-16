#!/usr/bin/env node
/**
 * P-reason 探针（设计 delivery-ownership-kernel.md §3.5；交付单元 u4）。
 *
 * 断言（逐条 exit 非 0 即红）：
 * - **P-reason(a) manual 可判**：空闲会话经 RPC `compact`（pi 手动路径，= runtime `/compact`
 *   与 extension `ctx.compact()` 的同一条 `AgentSession.compact()`）→ `compaction_start` /
 *   `compaction_end` 事件 payload 的 `reason === 'manual'`。
 * - **P-reason(b) 自动可区分**：pi 内建 threshold 自动压缩（`shouldCompact` 命中：
 *   contextTokens > contextWindow − reserveTokens）→ 两事件 `reason === 'threshold'`
 *   （与 manual 逐字可区分；overflow 同族，由 pi 实装 `_runAutoCompaction("overflow")`
 *   分支给出，本探针不构造溢出）。
 * - **P-reason(c) 掐断序（条件③的机制基础，u4 判定依赖）**：活跃 run 进行中调 `compact`
 *   （= smart-context `compact_context` 工具的 pi 侧语义：abort 当前 run 再压缩）→
 *   `agent_end`（runtime turn-end 的来源事件）先于 `compaction_start` 到达，且该
 *   agent_end 末条 assistant message 的 `stopReason === 'aborted'`——runtime 侧的
 *   `turn-end{stopReason:'aborted'}` 判据由此成立（`await abort()` 保证序）。
 *
 * 驱动方式：真 pi 进程 + faux LLM（零网络零 token，凭证无关；同 p-f9 探针范式）。
 *
 * 运行：cd packages/runtime && node src/__tests__/probes/p-reason-compaction-reason.mjs
 * 退出码：0 全绿 / 1 断言失败 / 2 环境不可用（pi binary 缺失）
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** faux LLM 测试 extension（真 pi 进程加载；本脚本只作 --extension 参数注入）。 */
const FAUX_EXT = resolve(HERE, '../fixtures/faux-llm-ext.ts')
const FAUX_MODEL = 'faux/faux-1'
/** faux 模型 contextWindow（faux-llm-ext.ts 模型清单：128_000）。 */
const FAUX_CONTEXT_WINDOW = 128_000

/** pi binary 探测（与生产 process-manager 同款 which/where 形态）。 */
function detectPi() {
  const probe = spawn(process.platform === 'win32' ? 'where' : 'which', ['pi'], { stdio: ['ignore', 'pipe', 'ignore'] })
  return new Promise((res) => {
    let out = ''
    probe.stdout.on('data', (d) => { out += String(d) })
    probe.on('error', () => res(null))
    probe.on('close', (code) => res(code === 0 && out.trim() ? out.trim().split('\n')[0] : null))
  })
}

const failures = []
function check(ok, label, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 起一个探针 pi 进程（真 pi + faux LLM）。
 * @param {object} opts
 * @param {string} opts.prefix tmp 目录前缀
 * @param {Array<object>} opts.script faux 响应步骤
 * @param {object} [opts.settings] 写入 <agentDir>/settings.json 的覆盖（compaction 阈值构造）
 * @param {Record<string, string>} [opts.env] 追加 env（TAIJI_FAUX_TPS 等）
 */
function startPi({ prefix, script, settings, env = {} }) {
  const sessionDir = mkdtempSync(join(tmpdir(), `${prefix}-session-`))
  const agentDir = mkdtempSync(join(tmpdir(), `${prefix}-agent-`))
  mkdirSync(join(agentDir, 'config'), { recursive: true })
  const scriptPath = join(agentDir, 'faux-responses.json')
  writeFileSync(scriptPath, JSON.stringify(script))
  if (settings) writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(settings))

  const proc = spawn(
    detectPiPath,
    ['-ne', '--mode', 'rpc', '--session-dir', sessionDir, '--model', FAUX_MODEL, '--approve', '--extension', FAUX_EXT],
    {
      cwd: sessionDir,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TAIJI_FAUX_SCRIPT: scriptPath, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )

  const pending = new Map()
  const events = []
  let stdoutBuf = ''
  let stderrBuf = ''
  proc.stderr.on('data', (d) => { stderrBuf += String(d) })
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += String(chunk)
    let nl = stdoutBuf.indexOf('\n')
    while (nl >= 0) {
      const line = stdoutBuf.slice(0, nl)
      stdoutBuf = stdoutBuf.slice(nl + 1)
      nl = stdoutBuf.indexOf('\n')
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.type === 'response' && msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.success === false) p.reject(new Error(msg.error ?? 'rpc failed'))
        else p.resolve(msg)
      } else {
        events.push(msg)
      }
    }
  })

  let seq = 0
  const rpc = (type, params = {}, timeoutMs = 60_000) =>
    new Promise((resolveP, rejectP) => {
      const id = `probe_${++seq}`
      const timer = setTimeout(() => { pending.delete(id); rejectP(new Error(`timeout: ${type}`)) }, timeoutMs)
      pending.set(id, { resolve: resolveP, reject: rejectP, timer })
      proc.stdin.write(JSON.stringify({ id, type, ...params }) + '\n')
    })

  const waitEvent = async (type, fromIdx = 0, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const idx = events.findIndex((e, i) => i >= fromIdx && e.type === type)
      if (idx >= 0) return { idx, event: events[idx] }
      await sleep(25)
    }
    return null
  }

  const stop = async () => {
    try { proc.stdin.end() } catch {}
    await sleep(300)
    try { proc.kill('SIGTERM') } catch {}
    await sleep(500)
    try { proc.kill('SIGKILL') } catch {}
    rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }

  return {
    proc, events, rpc, waitEvent, stop,
    getStderr: () => stderrBuf,
    eventTypes: (from) => events.slice(from).map((e) => e.type).join(','),
  }
}

let detectPiPath = null

/** 场景 A：空闲 manual compact（runtime `/compact` 与 extension `ctx.compact()` 的共同 pi 侧路径）。 */
async function scenarioManualIdle() {
  console.log('\n[P-reason(a)] 空闲 manual compact → compaction_start/end reason === "manual"')
  // settings：keepRecentTokens 压到 1，使小会话也能算出 cut point（prepareCompaction 非空）
  const pi = startPi({
    prefix: 'u4-reason-a',
    script: [{ text: 'ACK-1' }, { text: 'SUMMARY-A' }, { text: 'ACK-2' }],
    settings: { compaction: { keepRecentTokens: 1 } },
  })
  try {
    await pi.rpc('get_state', {}, 20_000)
    await pi.rpc('prompt', { message: 'P-reason 会话内容（manual compact 前置轮次）' })
    const settled = await pi.waitEvent('agent_settled', 0, 60_000)
    check(!!settled, '前置 turn 已 settle（会话有内容可供压缩）')

    const from = pi.events.length
    await pi.rpc('compact', {})
    const start = await pi.waitEvent('compaction_start', from, 60_000)
    check(!!start, 'compaction_start 事件到达', start ? `reason=${String(start.event.reason)}` : pi.eventTypes(from))
    check(start?.event.reason === 'manual', 'compaction_start.reason === "manual"', `实际=${String(start?.event.reason)}`)
    const end = await pi.waitEvent('compaction_end', from, 60_000)
    check(!!end, 'compaction_end 事件到达', end ? `reason=${String(end.event.reason)} aborted=${String(end.event.aborted)}` : pi.eventTypes(from))
    check(end?.event.reason === 'manual', 'compaction_end.reason === "manual"', `实际=${String(end?.event.reason)}`)
    // 旁证：空闲期压缩无掐断 turn（runtime 条件③ 不成立 → 不投递）
    const abortedTurnEnd = pi.events.slice(from).some(
      (e) => e.type === 'agent_end' && lastStopReason(e) === 'aborted',
    )
    check(!abortedTurnEnd, '空闲 manual compact 无 abort 掐断（对照：条件③ 不成立）')
  } finally {
    await pi.stop()
  }
}

/** 场景 B：活跃 run 中 compact（= compact_context 工具的 pi 侧语义）→ 掐断序 + aborted 判据。 */
async function scenarioDuringActiveRun() {
  console.log('\n[P-reason(c)] 活跃 run 中 compact → agent_end(aborted) 先于 compaction_start（条件③ 判据）')
  // 长文本 + 限速流：给「run 仍然活跃时调 compact」留出窗口
  const longText = 'X'.repeat(2400)
  const pi = startPi({
    prefix: 'u4-reason-c',
    script: [{ text: 'ACK-WARM' }, { text: longText }, { text: 'SUMMARY-C' }, { text: 'ACK-C' }],
    settings: { compaction: { keepRecentTokens: 1 } },
    env: { TAIJI_FAUX_TPS: '60' },
  })
  try {
    await pi.rpc('get_state', {}, 20_000)
    // 预热一个已完成 turn：压缩摘要有内容可取（prepareCompaction 非空）
    await pi.rpc('prompt', { message: 'P-reason 掐断场景预热轮次' })
    const warmed = await pi.waitEvent('agent_settled', 0, 60_000)
    check(!!warmed, '预热 turn 已 settle（压缩有可摘要内容）')
    const from = pi.events.length
    // 不 await prompt（流式进行中才有掐断窗口）
    void pi.rpc('prompt', { message: 'P-reason 活跃 run 场景' }).catch(() => {})
    const streaming = await pi.waitEvent('agent_start', from, 30_000)
    check(!!streaming, 'run 已启动（agent_start）', streaming ? '' : pi.eventTypes(from))
    // 等首个已提交内容块，确保 abort 落在流式窗口内
    const contentStarted = await pi.waitEvent('message_update', from, 30_000)
    check(!!contentStarted, '流式内容已开始（message_update）', contentStarted ? '' : pi.eventTypes(from))
    void pi.rpc('compact', {}).catch(() => {})
    const end = await pi.waitEvent('compaction_end', from, 60_000)
    check(!!end, 'compaction_end 到达', end ? `reason=${String(end.event.reason)}` : pi.eventTypes(from))
    check(end?.event.reason === 'manual', '掐断式压缩 reason === "manual"', `实际=${String(end?.event.reason)}`)

    const idxAgentEnd = pi.events.findIndex((e, i) => i >= from && e.type === 'agent_end')
    const idxCompactionStart = pi.events.findIndex((e, i) => i >= from && e.type === 'compaction_start')
    check(idxAgentEnd >= 0, 'agent_end（runtime turn-end 来源）到达')
    check(idxCompactionStart >= 0, 'compaction_start 到达')
    check(
      idxAgentEnd >= 0 && idxCompactionStart >= 0 && idxAgentEnd < idxCompactionStart,
      'agent_end 先于 compaction_start（await abort() 保证序）',
      `agent_end idx=${idxAgentEnd} / compaction_start idx=${idxCompactionStart}`,
    )
    const agentEnd = pi.events[idxAgentEnd]
    const stopReason = lastStopReason(agentEnd)
    check(
      stopReason === 'aborted',
      '被掐断 turn 的 stopReason === "aborted"（runtime 条件③ 的判据）',
      `实际=${String(stopReason)}`,
    )
    console.log(`  [meas] 事件序：${pi.eventTypes(from)}`)
  } finally {
    await pi.stop()
  }
}

/** 场景 C：pi 内建 threshold 自动压缩 → reason === 'threshold'（与 manual 可区分）。 */
async function scenarioAutoThreshold() {
  console.log('\n[P-reason(b)] 自动 threshold 压缩 → compaction_start/end reason === "threshold"')
  // 构造：reserveTokens 压到窗口极限（faux 模型 contextWindow 128000），使 shouldCompact
  // （contextTokens > window − reserve）在首轮后即命中；keepRecentTokens=1 保证 cut point 非空。
  const pi = startPi({
    prefix: 'u4-reason-b',
    script: [{ text: 'ACK-AUTO-1' }, { text: 'SUMMARY-AUTO' }, { text: 'ACK-AUTO-2' }],
    settings: { compaction: { reserveTokens: FAUX_CONTEXT_WINDOW - 1, keepRecentTokens: 1 } },
  })
  try {
    await pi.rpc('get_state', {}, 20_000)
    const from = pi.events.length
    void pi.rpc('prompt', { message: 'P-reason 自动压缩场景（首轮后 threshold 命中）' }).catch(() => {})
    const start = await pi.waitEvent('compaction_start', from, 60_000)
    check(!!start, '自动压缩 compaction_start 到达（threshold 命中）', start ? `reason=${String(start.event.reason)}` : pi.eventTypes(from))
    check(
      start?.event.reason === 'threshold',
      'compaction_start.reason === "threshold"（与 manual 逐字可区分）',
      `实际=${String(start?.event.reason)}`,
    )
    const end = await pi.waitEvent('compaction_end', start ? start.idx : from, 60_000)
    check(!!end, 'compaction_end 到达', end ? `reason=${String(end.event.reason)}` : pi.eventTypes(from))
    check(end?.event.reason === 'threshold', 'compaction_end.reason === "threshold"', `实际=${String(end?.event.reason)}`)
    if (start?.event.reason !== 'threshold') {
      console.log(`  [meas] 事件序：${pi.eventTypes(from)}`)
    }
  } finally {
    await pi.stop()
  }
}

/** agent_end 事件末条 assistant message 的 stopReason（runtime turn-end 判据同源）。 */
function lastStopReason(agentEndEvent) {
  const messages = agentEndEvent?.messages
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return messages[i]?.stopReason
  }
  return undefined
}

async function main() {
  detectPiPath = await detectPi()
  if (!detectPiPath) {
    console.error('[probe] pi binary 不可达（which/where pi）——环境不可用')
    process.exit(2)
  }
  console.log('[probe] pi rpc:', detectPiPath)
  await scenarioManualIdle()
  await scenarioDuringActiveRun()
  await scenarioAutoThreshold()

  console.log(`\n[probe] 结果：${failures.length === 0 ? 'PASS（全部断言绿）' : `FAIL（${failures.length} 条）: ${failures.join(' | ')}`}`)
  process.exit(failures.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('[probe] 未捕获异常：', e)
  process.exit(1)
})
