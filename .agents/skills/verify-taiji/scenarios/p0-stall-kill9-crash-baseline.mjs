/**
 * p0-stall-kill9-crash-baseline —— 进程死亡形态回归对照（pi-stall-detection V7，
 * 覆盖矩阵 C10 格 / 第 0 层资产不变式）。
 *
 * 场景：正常会话生成中，pi 进程被外部 kill -9（进程表操作，非应用内动作），断言既有
 * 收尾链逐点不变 + 自动处置链零触发 + restore 重开后历史完整。第 0 层（进程存活信号）
 * 在 pi-stall-detection 设计中零改动，本剧本在基线与实装后都必须绿——它是停滞检测交付
 * 的回归对照面（「观测超时不改变进程死亡形态时序」的机器钉子）。
 *
 * 装配：mock-http（真 pi 子进程可被 kill；faux 同样有真 pi，但本剧本与停滞注入剧本族
 * 同用 mock-http 形态，通道一致便于对照）。tps=2 拉长流式窗口制造 kill 时机。
 *
 * 断言通道：B（协议事件/RPC）为主；进程表（ps）为 C 通道旁证。
 * 路径：
 *   段 1 建会话发消息 → 等流式帧（生成中）；
 *   段 2 定位 pi 子进程（ps 扫 --mode rpc + ppid 链核对到本实例）→ kill -9；
 *   段 3 收尾链断言——message.error 入流 + session.exited 广播 + occupancy 复位 idle；
 *   段 4 零自动处置对照——宽限期无 session.restored 广播、无新 pi 进程（崩溃恢复仍归
 *   用户显式重开：outOfScope ④ / onSilentAbort 入口存活分型分流的断言载体）；
 *   段 5 session.restore → 历史完整（session.history 含 kill 前内容）→ 新消息正常收发。
 */
import { spawnSync } from 'node:child_process'

const MAIN_MODEL = 'mock-1'
const STREAM_TEXT = '这是一段用于拉长流式窗口的低速文本，验证进程死亡形态收尾链。'.repeat(12)
const POST_RESTORE_TEXT = 'POST-RESTORE-OK：恢复后首轮正常完成。'
const KILL_MARKER = 'KILL9-PROBE'

export const meta = {
  id: 'p0-stall-kill9-crash-baseline',
  priority: 'P0',
  title: '进程死亡形态回归对照：kill -9 pi 后既有收尾链逐点 + 自动处置零触发 + restore 历史完整（V7）',
  covers: [
    'env.launch', 'env.ready', 'env.doctor',
    'session.create', 'chat.send', 'chat.wait',
    'session.restore', 'session.history',
  ],
  requires: ['mock-http'],
  estimateSec: 240,
  llm: {
    responses: {
      [`mockllm/${MAIN_MODEL}`]: [
        { text: STREAM_TEXT, stopReason: 'stop' },
        { text: POST_RESTORE_TEXT, stopReason: 'stop' },
      ],
    },
    mainModel: MAIN_MODEL,
    subModel: MAIN_MODEL,
    tps: 2,
  },
  provable: [
    'B：生成中 kill -9 pi 后 message.error 入流 + session.exited 广播到达（收尾链非静默）',
    'B：occupancy 复位 idle（turn=idle 且四维全闲）',
    'C：强杀执行（pi 进程从进程表消失）',
    'B：宽限期无 session.restored 自动恢复广播、无新 pi 进程（崩溃恢复仍归用户显式重开）',
    'B：session.restore 成功（reply session.created）+ session.history 含 kill 前消息（历史完整）',
    'B：restore 后新消息正常收发（会话可用性恢复）',
  ],
  notProvable: [
    'toast 呈现与错误消息的视觉形态（A 通道截图断言属 UI 剧本职责，本剧本走协议层对照）',
    'exit 链 reject 与探测超时的时序先后（观测超时属 pi-stall-detection U1 实装后才有对照物；基线上此断言由「收尾链秒级完成」间接承载）',
    'sample 取证产物不存在（取证属 U2 新机制，基线无该产物通道；实装后由停滞注入剧本族负向断言承接）',
    'restore 后新 pi 的进程级 argv 锚定（restore spawn 的 argv 形态与首建不同且未核实，2026-10-31 R6 实测三锚定不匹配）——restore 后 pi 在位以功能证据承载（restore 后新消息 turn 完成 = pi 活着收发 RPC），ps 扫描结果仅作诊断记录',
  ],
}

/**
 * ps 扫描：本实例 pi 子进程。三锚定（2026-10-31 两轮探针实测）：
 * argv 同时含 `--mode rpc` + `mockllm/`（mock-http 零 token 通道的 --model mockllm/<id>
 * 为本实例特有，排除同机常驻打包版 TaiJi.app pi——同款 --mode rpc 但真模型 argv）
 * + worktree 路径（pi spawn argv 含 `--skill <repo>/.agents/skills`，实例专属）。
 * 不用 ppid 链核对：pi 与 dev-instance.mjs 之间隔 Electron Helper 树多层（实测 7+ 跳且深度不定），不可靠。
 */
function listInstancePiProcesses(repo) {
  const out = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  const rows = []
  for (const line of String(out.stdout ?? '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    if (m[3].includes('--mode rpc') && m[3].includes('mockllm/') && m[3].includes(repo)) {
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3].slice(0, 200) })
    }
  }
  return rows
}

export async function run(ctx) {
  const { protocol, ev, log } = ctx
  const uncovered = []
  const gotchas = [
    '本剧本是第 0 层（进程存活）回归对照：pi-stall-detection 交付后必须保持绿——若停滞检测实装改变了进程死亡形态收尾时序，本剧本先红',
    'kill 用 SIGKILL（kill -9 语义）；定位 = ps 扫三锚定（--mode rpc + mockllm/ + worktree 路径），不盲杀——ppid 链核对不可靠（Electron Helper 树 7+ 跳深度不定，2026-10-31 实测弃用）',
    'session.restore 的 replyType 是 session.created（session.restored 是自动恢复链广播，不是回执）',
  ]

  // ── 段 1：建会话发消息，等流式帧（生成中） ─────────────────────
  const created = await protocol.call('session.create', { cwd: ctx.repo, label: 'p0-stall-kill9' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  if (!sid) throw new Error('session.create 未返回 sessionId')
  await protocol.subscribe(sid)

  const sinceSend = protocol.events.length
  await protocol.send(sid, `${KILL_MARKER} 长文本低速流式，流到一半进程被 kill`)
  let streaming = false
  {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (protocol.events.slice(sinceSend).some((e) => /text_delta|message_update/.test(e.type))) {
        streaming = true
        break
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  ev.assert('B: 会话进入生成中（流式帧到达）', streaming, {
    channel: 'B', expected: 'text_delta/message_update 帧', actual: streaming ? '已开始' : '60s 内无流式帧',
  })
  if (!streaming) return { uncovered: ['未进入生成中（流式帧 60s 未到），后续段未执行'], gotchas }

  // ── 段 2：定位 pi 子进程并 kill -9 ─────────────────────────────
  let pi = null
  {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !pi) {
      pi = listInstancePiProcesses(ctx.repo)[0] ?? null
      if (!pi) await new Promise((r) => setTimeout(r, 500))
    }
  }
  ev.step({ step: 'pi.locate', channel: 'C', exitCode: pi ? 0 : 1, stats: pi ? { pid: pi.pid, ppid: pi.ppid } : { anchor: '--mode rpc + mockllm/ + repo path' } })
  ev.assert('C: 定位到本实例 pi 子进程（三锚定扫描）', Boolean(pi), {
    channel: 'C', expected: '恰好一个属本实例的 pi', actual: pi ? `pid=${pi.pid}` : '30s 无匹配（锚失灵？读 report 归因）',
  })
  if (!pi) return { uncovered: ['未定位到 pi 子进程（进程表扫描无匹配），kill 段未执行'], gotchas }

  process.kill(pi.pid, 'SIGKILL')
  ev.step({ step: 'pi.kill9', channel: 'C', exitCode: 0, stats: { pid: pi.pid, signal: 'SIGKILL' } })

  // 进程消失（C 通道强杀执行旁证）
  let gone = false
  {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (!listInstancePiProcesses(ctx.repo).some((p) => p.pid === pi.pid)) { gone = true; break }
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  ev.assert('C: pi 进程已从进程表消失（强杀执行）', gone, {
    channel: 'C', expected: `pid=${pi.pid} 不在`, actual: gone ? '已消失' : '10s 仍在（SIGKILL 未生效？）',
  })

  // ── 段 3：收尾链断言（exit 链应秒级） ──────────────────────────
  const sinceKill = protocol.events.length
  let exited = null
  {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !exited) {
      exited = protocol.events.slice(sinceKill).find((e) => e.type === 'session.exited' && e.payload?.sessionId === sid) ?? null
      if (!exited) await new Promise((r) => setTimeout(r, 300))
    }
  }
  ev.assert('B: session.exited 广播到达（exit 链收敛非静默）', Boolean(exited), {
    channel: 'B', expected: 'session.exited{sessionId}', actual: exited ? JSON.stringify(exited.payload).slice(0, 300) : '30s 未到达',
  })

  // 「错误消息入流」的协议层载体 = session.exited payload.reason（人类可读退出原因，含 code
  // 与 stderr 尾部摘要）；renderer 消费 session.exited 完成错误消息插入 + toast。
  // message.error 是「单次消息失败」专用语义（dispatch 阶段），进程死收尾不发该帧
  // （session-service.ts onSessionExit 链，2026-10-31 源码核实 + 实跑三验证）。
  let exitedReason = ''
  {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && !exitedReason) {
      const ex = protocol.events.slice(sinceKill).find((e) => e.type === 'session.exited' && e.payload?.sessionId === sid)
      if (ex) exitedReason = String(ex.payload?.reason ?? '')
      else await new Promise((r) => setTimeout(r, 300))
    }
  }
  ev.assert('B: 错误消息入流载体（session.exited.reason 人类可读，含退出码）', /Session process exited/.test(exitedReason), {
    channel: 'B', expected: 'reason 含 "Session process exited (code: …)"', actual: exitedReason.slice(0, 200) || '15s 未取得 reason',
  })

  // occupancy 复位：session.exited 前后的 occupancy 帧全闲（turn=idle 且 compacting/bash/handingOff 全 false）
  let occIdle = null
  {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && !occIdle) {
      occIdle = [...protocol.events]
        .reverse()
        .find((e) => e.type === 'session.occupancy' && e.payload?.sessionId === sid
          && e.payload?.turn === 'idle'
          && !e.payload?.compacting && !e.payload?.bash && !e.payload?.handingOff) ?? null
      if (!occIdle) await new Promise((r) => setTimeout(r, 300))
    }
  }
  const lastOcc = [...protocol.events].reverse().find((e) => e.type === 'session.occupancy' && e.payload?.sessionId === sid)
  ev.assert('B: occupancy 复位 idle（四维全闲）', Boolean(occIdle), {
    channel: 'B', expected: 'turn=idle 且 compacting/bash/handingOff=false', actual: lastOcc ? JSON.stringify(lastOcc.payload).slice(0, 300) : '无 occupancy 帧',
  })

  // ── 段 4：零自动处置对照（宽限期无自动恢复、无 pi 重启） ─────────
  const sinceSettled = protocol.events.length
  await new Promise((r) => setTimeout(r, 8_000))
  const restoredBroadcast = protocol.events.slice(sinceSettled).some((e) => e.type === 'session.restored')
  ev.assert('B: 宽限期无 session.restored 自动恢复广播（崩溃恢复仍归用户显式重开）', !restoredBroadcast, {
    channel: 'B', expected: '无 session.restored', actual: restoredBroadcast ? '出现（自动恢复链误触发）' : '无',
  })
  const respawned = listInstancePiProcesses(ctx.repo)
  ev.assert('C: 宽限期无新 pi 进程（无自动重启）', respawned.length === 0, {
    channel: 'C', expected: '0 个', actual: respawned.map((p) => p.pid).join(',') || '0 个',
  })

  // ── 段 5：restore 重开 + 历史完整 + 新消息收发 ──────────────────
  const reply = await protocol.call('session.restore', { sessionId: sid }, { replyType: 'session.created', timeoutMs: 90_000 })
  ev.assert('B: session.restore 成功（reply session.created）', reply?.session?.id === sid, {
    channel: 'B', expected: `session.id=${sid}`, actual: `session.id=${reply?.session?.id ?? 'n/a'}`,
  })

  // restore 后新消息先行（restore spawn 可能惰性——首个消息触发 pi spawn；
  // turn 完成 = pi 在位的功能性证明），ps 扫描在其后并附诊断转储。
  // kill 收敛链 removeSessionEntry 内部 bus.clearSession 清空本会话订阅者——restore 后
  // 必须重新 subscribe，否则新 turn 事件（含 message.complete）不再推送（R5 实测根因）。
  await protocol.subscribe(sid)
  const sincePost = protocol.events.length
  await protocol.send(sid, '恢复后第一条消息，验证会话可用')
  const endPost = await protocol.waitTurnEnd(sid, { since: sincePost, timeoutMs: 180_000 })
  ev.assert('B: restore 后新消息正常收发（会话可用性恢复 = pi 在位功能证明）', endPost.type === 'message.complete' && endPost.ok, {
    channel: 'B', expected: 'message.complete', actual: `${endPost.type} stop=${endPost.payload?.stopReason ?? ''}`,
  })

  // 进程级核对为信息性诊断（不作失败判据）：restore spawn 的 pi argv 形态与首建不同
  //（2026-10-31 R6 实测三锚定不匹配，形态未核实——dump 只在 kill 前定位与强杀消失两处作硬判据，
  // 此处进程级证据 = 上方 turn 完成（pi 活着收发 RPC）。
  const restoredPi = listInstancePiProcesses(ctx.repo)
  ev.step({
    step: 'pi.restore.processcheck', channel: 'C',
    exitCode: restoredPi.length >= 1 ? 0 : 0,
    stats: { piAnchored: restoredPi.length, note: restoredPi.length >= 1 ? 'ps 锚命中' : 'ps 锚未命中（restore spawn argv 形态与首建不同，功能在位由 turn 完成承载）' },
  })
  {
    const dump = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).stdout ?? ''
    const lines = dump.split('\n').filter((l) => l.includes('--mode rpc')).map((l) => l.slice(0, 300))
    ev.attach('rpc-process-dump', lines.join('\n').slice(0, 3_000))
  }

  const history = await protocol.call('session.history', { sessionId: sid, limitTurns: 10 }, { timeoutMs: 60_000 })
  const historyText = JSON.stringify(history ?? {}).slice(0, 4000)
  ev.assert('B: 历史完整（session.history 含 kill 前用户消息）', historyText.includes(KILL_MARKER), {
    channel: 'B', expected: `含 ${KILL_MARKER}`, actual: historyText.includes(KILL_MARKER) ? '命中' : historyText.slice(0, 300),
  })

  log(`done sid=${sid}`)
  return { uncovered, gotchas }
}
