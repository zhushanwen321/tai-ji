#!/usr/bin/env node
// fake 引擎 CLI（W8 runtime 协议客户端测试 fixture）。
//
// 形态对齐 engine-protocol v1（stdout 独占 NDJSON；stdin 帧驱动）：
// - initialize：应答 protocolVersion=1 + 最小 capabilities + envEcho（白名单键的
//   process.env 摘要——relay 透传/剥除断言的数据源，非白名单键不回传防泄漏）；
// - read：应答 SessionView（turns=[{text:'fake turn',...}]，sessionId=本进程 pid——
//   两次 read 的 sessionId 相同 = 实例复用断言面）；
//   FAKE_READ_MODE=error → read 回 error 帧（降②级测试）；
//   FAKE_READ_MODE=hang → read 不应答（dispose 上界测试的挂死场景）；
//   FAKE_DISPOSE_MODE=hang → dispose 不应答不退出（聚合上界测试）；
// - dispose：应答 {ok:true} 后 20ms 退出（FAKE_DISPOSE_MODE=hang 时挂住）；
// - spawn 计数（idle 复用断言）：FAKE_SPAWN_LOG 非空时启动即 append 本进程 pid 一行。

import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : (process.env[name] ?? fallback)
}

const ENGINE_ID = argOf('--engine-id', 'fake')
const READ_MODE = argOf('--read-mode', process.env.FAKE_READ_MODE ?? 'ok')
const DISPOSE_MODE = argOf('--dispose-mode', process.env.FAKE_DISPOSE_MODE ?? 'ok')
const SPAWN_LOG = process.env.FAKE_SPAWN_LOG ?? ''
// env 回显白名单：只回传测试断言的协议面键（fixture 不做通用 env 转发）。
const ENV_ECHO_KEYS = [
  'TAIJI_SUBAGENT_RELAY_SOCKET',
  'TAIJI_SUBAGENT_RELAY_NODE',
  'TAIJI_SUBAGENT_RELAY_SCRIPT',
  'TAIJI_SUBAGENT_RELAY_SESSION_ID',
  'TAIJI_SUBAGENT_RELAY_RECORD_ID',
  'TAIJI_AGENT_DATA_DIR',
]

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

if (SPAWN_LOG !== '') {
  try {
    appendFileSync(SPAWN_LOG, `${process.pid}\n`)
  } catch {
    // 计数失败不影响协议面
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return
  }
  const { id, method } = frame
  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          protocolVersion: 1,
          engineId: ENGINE_ID,
          engineVersion: 'fake-1.0.0',
          adapterVersion: 'fake-adapter',
          capabilities: {
            schemaEnforcement: 'emulated',
            steer: 'unsupported',
            conversation: 'unsupported',
            personaInjection: 'prompt',
            eventGranularity: 'coarse',
            sandbox: 'none',
            sessionRead: 'full',
            resume: 'cold',
            interrupt: 'kill-only',
            permissionMode: 'ignored',
            maxTurns: false,
          },
          envEcho: Object.fromEntries(ENV_ECHO_KEYS.map((k) => [k, process.env[k]])),
        },
      })
      break
    case 'read': {
      if (READ_MODE === 'error') {
        send({ id, error: { code: 'engine_read_failed', message: 'fake read failure', recovery: 'fixture scenario' } })
        return
      }
      if (READ_MODE === 'hang') return // 不应答：dispose 上界/超时场景
      send({
        id,
        result: {
          engineId: ENGINE_ID,
          sessionId: String(process.pid),
          turns: [{ text: 'fake turn', thinking: '', toolCalls: [], closed: true }],
          source: 'native',
          // envEcho 白名单摘要随 read 应答透出（SessionView 附加字段，宿主断言面）。
          envEcho: Object.fromEntries(ENV_ECHO_KEYS.map((k) => [k, process.env[k]])),
        },
      })
      break
    }
    case 'dispose':
      if (DISPOSE_MODE === 'hang') {
        send({ id, result: { ok: true } })
        return // 应答但不退出：聚合上界后进程仍活的场景由测试 SIGKILL 收尾
      }
      send({ id, result: { ok: true } })
      setTimeout(() => process.exit(0), 20)
      break
    default:
      send({ id, error: { code: 'engine_unknown_method', message: `unknown method ${method}`, recovery: 'fixture' } })
  }
})
rl.on('close', () => {
  // stdin EOF = 父进程（vitest worker）已退出或管道关闭：立即自退，防孤儿泄漏
  // （2026-09-15 实测整日累积 123 个孤儿——dispose/组杀路径覆盖不了 worker 被强杀、
  // 断言失败提前退出的场景）。hang 模式（READ/DISPOSE）不受影响：那些场景父进程
  // 活着、stdin 开着，close 不触发，仍由测试 SIGKILL 收尾。
  process.exit(0)
})
process.stderr.write('fake engine cli ready\n')
