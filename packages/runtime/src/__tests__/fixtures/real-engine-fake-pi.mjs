#!/usr/bin/env node
/**
 * 真实引擎集成用例的假 pi 子进程（A4/DC-1：control server × pi-subagent-cli × 假 pi）。
 *
 * 被测对象是「runtime control 通道 → 真实 pi-subagent-cli 引擎 → 引擎 spawn 的 pi
 * 子进程」三跳链路；本 fixture 只承担 pi `--mode rpc` 的最小应答面，保证零 LLM、零 GUI：
 *   - `--version`：版本行（探针语义）；
 *   - `get_state`：应答 sessionFile/sessionId（真实 session 文件落 sessionDir，供
 *     引擎的身份回填/LC-4 兜底链有据可依）；
 *   - `prompt`：回 prompt response（success + disposition started）→ 回放
 *     text_delta / turn_end / message_end(usage) / agent_end / agent_settled；
 *   - 其余命令忽略。
 *
 * 运行期只写调用方给的 --session-dir（测试 mkdtemp 注入），不触任何真实数据目录。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'

if (process.argv.includes('--version')) {
  process.stdout.write('fake-pi-real-engine 0.0.0\n')
  process.exit(0)
}

const SESSION_ID = 'fake-pi-real-session'
const sessionDir = (() => {
  const i = process.argv.indexOf('--session-dir')
  return i >= 0 ? process.argv[i + 1] : undefined
})()
const sessionFile = sessionDir !== undefined
  ? path.join(sessionDir, `2026-10-18T00-00-00-000Z_${SESSION_ID}.jsonl`)
  : undefined

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function ensureSessionFile() {
  if (sessionFile === undefined) return
  try {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: 'message',
        id: 'real-engine-user-1',
        parentId: null,
        timestamp: '2026-10-18T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'real engine e2e prompt' }] },
      })}\n`,
    )
  } catch {
    // 身份回填是排障面：落盘失败不阻断 run（引擎走 LC-4/无 sessionFile 兜底）
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let cmd
  try {
    cmd = JSON.parse(text)
  } catch {
    return
  }
  if (cmd.type === 'get_state') {
    ensureSessionFile()
    write({
      type: 'response',
      id: cmd.id,
      command: 'get_state',
      success: true,
      data: { sessionFile, sessionId: SESSION_ID },
    })
    return
  }
  if (cmd.type !== 'prompt') return
  // prompt 送达回执（M2 D3：唯一成功回执 = success + disposition）
  write({ type: 'response', id: cmd.id, command: 'prompt', success: true, data: { disposition: 'started' } })
  write({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'real-engine-' } })
  write({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } })
  write({ type: 'turn_end' })
  write({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'real-engine-ok' }],
      usage: { input: 12, output: 3 },
      stopReason: 'stop',
    },
  })
  write({ type: 'agent_end', willRetry: false, reason: 'end_turn' })
  // 轮收敛：引擎在此 resolve run 并收割本进程
  write({ type: 'agent_settled' })
})

// stdin 打开的常驻形态由 readline 持有；显式兜底防挂死（测试正常路径远快于此）。
setTimeout(() => process.exit(4), 120_000).unref()
