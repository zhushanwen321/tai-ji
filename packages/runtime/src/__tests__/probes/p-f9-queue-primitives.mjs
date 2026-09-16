#!/usr/bin/env node
/**
 * P-F9a / P-F9b / 检查点 4 探针（设计 delivery-ownership-kernel.md §3.5，u2）。
 *
 * 独立 pi RPC 驱动脚本（不经 runtime）：spawn 真实 `pi --mode rpc` 子进程，用 faux LLM
 * 通道（真 pi 进程 + 真 extension 加载 + 假 LLM，零网络零 token，凭证无关）驱动最小 turn。
 *
 * 断言（逐条 exit 非 0 即红）：
 * - **P-F9a**：`steer` 入队（空闲 pi 不报错，F11）→ `clear_queue` 返回 `{steering, followUp}`
 *   **全文数组**且含该文本、清空后 `get_state.pendingMessageCount === 0`。
 * - **P-F9b**：`prompt` 带裸标记 `<!--taiji:msg:<uuid>-->` 文本 → 等 turn 结束 → `get_entries`
 *   可读到含该标记的 user message entry（标记扫描可行性 = reattach 判重锚的机制基础）。
 * - **检查点 4**（settling 窗口空闲判定精确性）：turn_end 边沿立即 steer → 等 agent_settled
 *   + 1.5s → `get_state.pendingMessageCount`：≥1 = settling 不是 drain 窗口（保守档
 *   「settling 一律 queued」成立）；0 = pi 在 settling 期间仍 drain（结论记入汇报）。
 *   同点旁证：完全空闲 pi 的 steer 滞留（F11）——滞留即无人 drain，必须由对账器收回。
 *
 * 运行：cd packages/runtime && node src/__tests__/probes/p-f9-queue-primitives.mjs
 * 退出码：0 全绿 / 1 断言失败 / 2 环境不可用（pi binary 缺失）
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** faux LLM 测试 extension（真 pi 进程加载；本脚本只作 --extension 参数注入）。 */
const FAUX_EXT = resolve(HERE, '../fixtures/faux-llm-ext.ts')
const FAUX_MODEL = 'faux/faux-1'

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

async function main() {
  const piPath = await detectPi()
  if (!piPath) {
    console.error('[probe] pi binary 不可达（which/where pi）——环境不可用')
    process.exit(2)
  }
  const sessionDir = mkdtempSync(join(tmpdir(), 'u2-probe-session-'))
  const agentDir = mkdtempSync(join(tmpdir(), 'u2-probe-agent-'))
  // faux 响应脚本：一个纯文本 stop 步骤（探针 turn 用；P-F9a/检查点 4 无需 LLM 轮次）
  const scriptPath = join(agentDir, 'faux-responses.json')
  writeFileSync(scriptPath, JSON.stringify([{ text: 'ACK' }, { text: 'ACK2' }, { text: 'ACK3' }]))

  const proc = spawn(
    piPath,
    ['--mode', 'rpc', '--session-dir', sessionDir, '--model', FAUX_MODEL, '--approve', '--extension', FAUX_EXT],
    {
      cwd: sessionDir,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TAIJI_FAUX_SCRIPT: scriptPath },
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
        if (msg.success === false) {
          p.reject(new Error(msg.error ?? 'rpc failed'))
        } else {
          p.resolve(msg)
        }
      } else {
        events.push(msg)
      }
    }
  })

  let seq = 0
  const rpc = (type, params = {}, timeoutMs = 30_000) =>
    new Promise((resolveP, rejectP) => {
      const id = `probe_${++seq}`
      const timer = setTimeout(() => { pending.delete(id); rejectP(new Error(`timeout: ${type}`)) }, timeoutMs)
      pending.set(id, { resolve: resolveP, reject: rejectP, timer })
      proc.stdin.write(JSON.stringify({ id, type, ...params }) + '\n')
    })

  const waitEvent = async (type, fromIdx = 0, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const idx = events.findIndex((e, i) => i >= fromIdx && e.type === type)
      if (idx >= 0) return { idx, event: events[idx] }
      await sleep(25)
    }
    return null
  }

  try {
    // 冷启动：get_state 应答即就绪
    await rpc('get_state', {}, 20_000)
    console.log('[probe] pi rpc 就绪:', piPath)

    // ── P-F9a：steer（空闲入队，F11 不报错）→ clear_queue 返回全文 ──────────────
    console.log('\n[P-F9a] clear_queue RPC 返回 {steering, followUp} 全文')
    const steerText = 'P-F9a 滞留文本 A'
    await rpc('steer', { message: steerText })
    const stateAfterSteer = await rpc('get_state', {})
    const pendingAfterSteer = stateAfterSteer.data?.pendingMessageCount
    check(pendingAfterSteer === 1, 'F11：空闲 pi 的 steer 被受理入队且滞留（pendingMessageCount=1）', `实际=${String(pendingAfterSteer)}`)
    const cleared = await rpc('clear_queue', {})
    const steering = cleared.data?.steering
    const followUp = cleared.data?.followUp
    check(Array.isArray(steering), 'clear_queue 返回 steering 数组', `类型=${typeof steering}`)
    check(Array.isArray(followUp), 'clear_queue 返回 followUp 数组', `类型=${typeof followUp}`)
    check(Array.isArray(steering) && steering.includes(steerText), 'steering 数组含入队全文（队列级收回的依据）')
    const stateAfterClear = await rpc('get_state', {})
    check(stateAfterClear.data?.pendingMessageCount === 0, 'clear_queue 清空队列（pendingMessageCount=0）', `实际=${String(stateAfterClear.data?.pendingMessageCount)}`)

    // ── P-F9b：prompt 带裸标记 → get_entries 可读且可按 uuid 查找 ──────────────
    console.log('\n[P-F9b] get_entries 可读到含裸标记的 user entry（标记扫描可行性）')
    const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    const marked = `P-F9b 标记文本\n<!--taiji:msg:${uuid}-->`
    // 事件游标：只关心本次 prompt 之后的事件
    const beforeIdx = events.length
    await rpc('prompt', { message: marked })
    const settled = await waitEvent('agent_settled', beforeIdx, 60_000)
    if (!settled) {
      const sawMsgEnd = events.slice(beforeIdx).some((e) => e.type === 'message_end')
      check(false, 'faux turn 未在 60s 内 settle', `已见事件=${events.slice(beforeIdx).map((e) => e.type).join(',') || '(无)'}`)
      if (!sawMsgEnd) throw new Error('pi 无事件产出（faux extension 未生效？）')
    } else {
      check(true, 'faux turn 已 settle（agent_settled 到达）')
    }
    const entriesResp = await rpc('get_entries', {})
    const entries = entriesResp.data?.entries ?? []
    const userEntries = entries.filter((e) => e.type === 'message' && e.message?.role === 'user')
    const textOf = (m) => (typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter((p) => p?.type === 'text').map((p) => p.text).join('')
        : '')
    const hit = userEntries.find((e) => textOf(e.message).includes(`<!--taiji:msg:${uuid}-->`))
    check(userEntries.length > 0, 'get_entries 返回 user message entry', `user entry 数=${userEntries.length}`)
    check(!!hit, `按裸标记 uuid 可查找 user entry（标记随文本进 transcript）`, hit ? `entry id=${String(hit.id)}` : `未命中（entries=${entries.length}）`)
    const rawMatch = entries.some((e) => JSON.stringify(e).includes(uuid))
    check(rawMatch, '标记在 transcript 原文中可见（非渲染层合成）')

    // ── 检查点 4：settling 窗口（turn_end 边沿）steer 是否被 drain ─────────────
    console.log('\n[检查点 4] settling 窗口空闲判定精确性（turn_end 边沿 steer）')
    const beforeIdx2 = events.length
    const settleUuid = '4f2504e0-4f89-41d3-9a0c-0305e82c3302'
    const settleSteer = `settling 窗口投递\n<!--taiji:msg:${settleUuid}-->`
    await rpc('prompt', { message: '触发第二轮 turn' })
    const turnEnd = await waitEvent('turn_end', beforeIdx2, 60_000)
    if (!turnEnd) {
      check(false, '未观测到 turn_end 事件（无法测量 settling 窗口）', `事件=${events.slice(beforeIdx2).map((e) => e.type).join(',')}`)
    } else {
      // turn_end 边沿立即 steer（settling 窗口 = turn_end..agent_settled）
      await rpc('steer', { message: settleSteer })
      const settled2 = await waitEvent('agent_settled', turnEnd.idx, 30_000)
      check(!!settled2, 'settling 窗口已闭合（agent_settled 到达）')
      await sleep(1500) // 观察窗：settling 之后是否有 drain
      const stateAfterSettle = await rpc('get_state', {})
      const pendingAfterSettle = stateAfterSettle.data?.pendingMessageCount
      console.log(`  [meas] settling 期 steer 后 pendingMessageCount=${String(pendingAfterSettle)}（≥1 = 未被 drain：settling 非投递窗口 → 保守档成立）`)
      const cq2 = await rpc('clear_queue', {})
      check(Array.isArray(cq2.data?.steering), '测量后 clear_queue 可收回（槽位滞留由对账器路径处理）')
    }

    // 旁证：完全空闲 pi 的 steer 滞留（F11）——无人 drain，收回是唯一出路
    console.log('\n[检查点 4 旁证] 空闲 pi 的 steer 无 drain（F11）')
    await rpc('steer', { message: '空闲滞留文本' })
    await sleep(1200)
    const idleState = await rpc('get_state', {})
    check(idleState.data?.pendingMessageCount === 1, '空闲期 steer 滞留 ≥1.2s 未被消费（对账器收回是唯一出路）', `实际=${String(idleState.data?.pendingMessageCount)}`)
    await rpc('clear_queue', {})
  } finally {
    try { proc.stdin.end() } catch {}
    await sleep(300)
    try { proc.kill('SIGTERM') } catch {}
    await sleep(500)
    try { proc.kill('SIGKILL') } catch {}
    rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }

  console.log(`\n[probe] 结果：${failures.length === 0 ? 'PASS（全部断言绿）' : `FAIL（${failures.length} 条）: ${failures.join(' | ')}`}`)
  if (failures.length > 0) {
    console.error('[probe] pi stderr 尾部：', stderrBuf.slice(-800))
    process.exit(1)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error('[probe] 未捕获异常：', e)
  process.exit(1)
})
