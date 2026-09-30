#!/usr/bin/env node
/**
 * P-F13 探针（设计 delivery-ownership-kernel.md §3.5；交付单元 u4）。
 *
 * 断言（逐条 exit 非 0 即红）：
 * - **P-F13(a) nextTurn 不自起 run**：加载**真实 smart-context extension**（非替身），驱动其
 *   阈值提醒路径（agent_settled 越档 → sendSmartContextNotice）→ 注入后 30s 观察窗内**无
 *   `agent_start`**（pi 实装：`deliverAs:'nextTurn'` 只入 `_pendingNextTurnMessages`，F13）。
 * - **P-F13(b) 随下一次 prompt 注入且落 entry**：随后发一条 prompt → `get_entries` 断言
 *   custom message entry 在列（customType='smart-context'、正文含提醒文案），且注入后
 *   pending 队列被消费（再次 prompt 不再重复注入）。
 *
 * 驱动方式：真 pi 进程 + faux LLM + 真实 extension（零网络零 token；阈值档位经
 * `<agentDir>/config/smart-context-ext-config.json` 种入 [1]，使首轮后必越档）。
 *
 * 语义登记：docs/pi-semantics.json PS-06（_pendingNextTurnMessages 唯一消费点 = 用户驱动
 * prompt 走到的 _runAgentPrompt 注入段）——nextTurn 不自起 run、随下一次 prompt 注入的
 * pi 侧语义以此承重，本脚本是该语义的行为序实测层。
 *
 * 运行：cd packages/runtime && node src/__tests__/probes/p-f13-nextturn-injection.mjs
 * 退出码：0 全绿 / 1 断言失败 / 2 环境不可用（pi binary 缺失）
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** faux LLM 测试 extension（真 pi 进程加载）。 */
const FAUX_EXT = resolve(HERE, '../fixtures/faux-llm-ext.ts')
/** 真实 smart-context extension 入口（D4① 的实际调用点）。 */
const SMART_CONTEXT_EXT = resolve(HERE, '../../../../../extensions/universal/smart-context/index.ts')
const FAUX_MODEL = 'faux/faux-1'
/** 观察窗（设计 §3.5 P-F13 原文：「观察 30s 无 agent_start」）。 */
const IDLE_OBSERVE_MS = 30_000

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
  const sessionDir = mkdtempSync(join(tmpdir(), 'u4-f13-session-'))
  const agentDir = mkdtempSync(join(tmpdir(), 'u4-f13-agent-'))
  mkdirSync(join(agentDir, 'config'), { recursive: true })
  // smart-context 配置：阈值 [1]（首轮后必越档，必发提醒）；模型不排除 → 门控放行
  writeFileSync(
    join(agentDir, 'config', 'smart-context-ext-config.json'),
    JSON.stringify({ enabled: true, compactModel: { type: 'ref', ref: '' }, reminderThresholds: [1], excludedModels: [] }),
  )
  const scriptPath = join(agentDir, 'faux-responses.json')
  writeFileSync(scriptPath, JSON.stringify([{ text: 'ACK-1' }, { text: 'ACK-2' }, { text: 'ACK-3' }]))

  const proc = spawn(
    piPath,
    ['-ne', '--mode', 'rpc', '--session-dir', sessionDir, '--model', FAUX_MODEL, '--approve',
      '--extension', FAUX_EXT, '--extension', SMART_CONTEXT_EXT],
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

  const textOfContent = (content) => (typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((p) => p?.type === 'text').map((p) => p.text).join('')
      : '')

  try {
    await rpc('get_state', {}, 20_000)
    console.log('[probe] pi rpc 就绪:', piPath)

    // ── 触发真实 smart-context 阈值提醒（首轮 settle 后越档 → sendSmartContextNotice）──
    console.log('\n[P-F13(a)] nextTurn 注入不自起 run（真实 smart-context 提醒路径）')
    await rpc('prompt', { message: 'P-F13 首轮（触发阈值提醒）' })
    const settled = await waitEvent('agent_settled', 0, 60_000)
    check(!!settled, '首轮 agent_settled 到达（提醒回调时机）')
    // 提醒在 agent_settled 回调内同步发出：留 1.5s 让注入落定，再开观察窗
    await sleep(1500)
    const observeFrom = events.length
    await sleep(IDLE_OBSERVE_MS)
    const selfStarted = events.slice(observeFrom).filter((e) => e.type === 'agent_start')
    check(
      selfStarted.length === 0,
      `注入后 ${IDLE_OBSERVE_MS / 1000}s 内无 agent_start（不自起 run，F13）`,
      selfStarted.length > 0 ? `实际 agent_start=${selfStarted.length}` : '',
    )
    const pendingTurnQueueVisible = events.slice(observeFrom).some((e) => e.type === 'turn_start')
    check(!pendingTurnQueueVisible, '观察窗内无 turn_start（未开启新回合）')

    // ── 下一次 prompt 注入 + 落 entry ──
    console.log('\n[P-F13(b)] 随下一次 prompt 注入且可经 get_entries 读回')
    await rpc('prompt', { message: 'P-F13 次轮（消费 nextTurn 注入）' })
    const settled2 = await waitEvent('agent_settled', observeFrom, 60_000)
    check(!!settled2, '次轮 agent_settled 到达（注入已随该轮生效）')
    const entriesResp = await rpc('get_entries', {})
    const entries = entriesResp.data?.entries ?? []
    // pi 实装：custom message 落 entry type='custom_message'{customType, content, display}
    // （session-manager.d.ts CustomMessageEntry；非 message/custom role 嵌套形态）
    const customEntries = entries.filter((e) => e.type === 'custom_message')
    const reminder = customEntries.find((e) => textOfContent(e.content).includes('[smart-context 提示]'))
    check(customEntries.length > 0, 'get_entries 含 custom_message entry（nextTurn 注入落 entry）', `custom_message entry 数=${customEntries.length}`)
    check(
      !!reminder,
      'custom_message entry 为 smart-context 阈值提醒（customType + 文案匹配）',
      reminder ? `customType=${String(reminder.customType)}` : `customTypes=${customEntries.map((e) => String(e.customType)).join(',') || '(无)'}`,
    )
    check(reminder?.customType === 'smart-context', "customType === 'smart-context'（通意识别锚）", `实际=${String(reminder?.customType)}`)

    // ── 一次性消费：pending 队列已清空，再 prompt 不重复注入 ──
    await rpc('prompt', { message: 'P-F13 三轮（验证不重复注入）' })
    await waitEvent('agent_settled', observeFrom, 60_000)
    const entriesResp2 = await rpc('get_entries', {})
    const reminders2 = (entriesResp2.data?.entries ?? []).filter(
      (e) => e.type === 'custom_message' && textOfContent(e.content).includes('[smart-context 提示]'),
    )
    check(reminders2.length === 1, '提醒只注入一次（pending 队列一次性消费）', `实际提醒 entry 数=${reminders2.length}`)
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
    console.error('[probe] pi stderr 尾部：', stderrBuf.slice(-1200))
    process.exit(1)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error('[probe] 未捕获异常：', e)
  process.exit(1)
})
