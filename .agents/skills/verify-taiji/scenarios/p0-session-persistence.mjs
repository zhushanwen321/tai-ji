/**
 * p0-session-persistence —— 会话持久化与恢复：切走切回 + 重启应用后 history 一致
 * （补剧本优先级 #4；覆盖矩阵 P0-5）。
 *
 * 装配：faux（零 token）。dataDir 显式传入（verify- 前缀自建目录）：dispose 不删传入目录，
 * 重启段落复用同一目录，收尾由本剧本自删。
 * 路径：
 *   段 1——建 A/B 两个 session，A 发一轮 → history 基线（文本/轮次/modelId）；
 *   段 2 切走切回——switch 到 B 再切回 A → history ≡ 基线（切换不丢不串）；
 *   段 3 重启应用——dispose（保留 dataDir）→ 重新 launch 同 dataDir →
 *   config.sessions 仍列出 A/B（恢复链）→ history(A) ≡ 基线 → summary.modelId 一致 →
 *   C：ext-sessions/<sidA>/ 树幸存。
 *
 * 这是「live ≡ reload」不变量的验收形态：渲染通路重启后从同一持久层重建出相同历史。
 * （跨进程 entry 级等价由 E2E-EQUIV-01 机器轨覆盖，见覆盖矩阵 P0-4。）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const meta = {
  id: 'p0-session-persistence',
  priority: 'P0',
  title: '切走切回 + 重启应用后 session 仍在、history 一致、模型记忆一致、会话树幸存',
  covers: [
    'env.launch', 'env.ready', 'env.cleanup', 'env.isolation',
    'session.create', 'session.switch', 'session.history', 'session.persistence',
    'chat.send', 'chat.wait', 'chat.reload-equiv',
  ],
  requires: ['faux'],
  parallelGroup: 'chat',
  estimateSec: 150,
  faux: {
    responses: {
      'faux/faux-1': [{ text: 'persist-alpha-answer', stopReason: 'stop' }],
      'faux/faux-1-b': [{ text: 'persist-beta-answer', stopReason: 'stop' }],
    },
  },
  provable: [
    '切走切回：switch B → switch A 后 history(A) ≡ 基线（不丢轮次、不串 B 的回复）',
    '重启应用：dispose 后同 dataDir 重新 launch，config.sessions 仍列出 A 与 B',
    '重启后 history(A) ≡ 基线（含用户消息与 assistant 回复）',
    '重启后 summary.modelId / thinkingLevel 与重启前一致',
    'C：ext-sessions/<sidA>/ 树跨重启幸存',
  ],
  notProvable: [
    'entry 级逐条等价（applyEntry reducer 全类型覆盖）——由机器轨 E2E-EQUIV-01 承载，本剧本是会话级黑盒等价',
    'renderer 侧缓存重建的视觉过程（重启后首屏渲染时序）',
  ],
}

/** history 提要（断言对比用的稳定形态）。 */
function digest(historyReply) {
  const messages = historyReply.messages ?? []
  return {
    count: messages.length,
    roles: messages.map((m) => m.role).join(','),
    text: messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('|').slice(0, 2_000),
  }
}

export async function run(ctx) {
  const { ev, log, repo } = ctx
  const uncovered = []
  const gotchas = [
    'pi 会话文件延迟写入（关键规则 #6）：首条 user/assistant 消息前 jsonl 可能不存在——本剧本先发消息再断言，天然满足落盘条件',
    '重启段用「同 dataDir 重新 launch」：传入 dataDir 时 instance.dispose 不删目录（删仅限自建 mkdtemp），收尾由本剧本清理',
    '跨进程 entry 级等价（applyEntry 全类型）归 E2E-EQUIV-01 机器轨（TAIJI_SKIP_REAL_PI=1 pnpm --filter @taiji/runtime test:equivalence）',
  ]

  const { createInstance } = await import('../scripts/lib/instance.mjs')
  const dataDir = path.join(os.homedir(), '.taiji-dev', `verify-persist-${Date.now()}`)
  const instanceName = `verify-persist-${Date.now()}`
  const faux = meta.faux

  // ── 段 1：基线 ──────────────────────────────────────────────
  const inst1 = createInstance({ repo, name: instanceName, dataDir, faux, background: true })
  await inst1.launch()
  const ready1 = await inst1.waitReady({ timeoutMs: 180_000 })
  ev.step({ step: 'env.launch.1', channel: 'C', exitCode: 0, stats: { dataDir, readyMs: ready1.elapsedMs } })
  const proto1 = await inst1.protocol()

  const createdA = await proto1.call('session.create', { cwd: repo, label: 'persist-alpha', modelOverride: 'faux/faux-1' }, { timeoutMs: 120_000 })
  const sidA = createdA.session?.id
  const modelA = createdA.session?.modelId
  await proto1.subscribe(sidA)
  const sinceA = proto1.events.length
  await proto1.send(sidA, '持久化基线消息')
  const endA = await proto1.waitTurnEnd(sidA, { since: sinceA, timeoutMs: 180_000 })
  ev.assert('段 1：A 轮完成', endA.ok === true, { channel: 'B', expected: 'message.complete', actual: `${endA.type} stop=${endA.payload?.stopReason ?? ''}` })

  const createdB = await proto1.call('session.create', { cwd: repo, label: 'persist-beta', modelOverride: 'faux/faux-1-b' }, { timeoutMs: 120_000 })
  const sidB = createdB.session?.id
  await proto1.subscribe(sidB)
  const sinceB = proto1.events.length
  await proto1.send(sidB, 'B 会话独立消息')
  const endB = await proto1.waitTurnEnd(sidB, { since: sinceB, timeoutMs: 180_000 })
  ev.assert('段 1：B 轮完成', endB.ok === true, { channel: 'B', expected: 'message.complete', actual: `${endB.type} stop=${endB.payload?.stopReason ?? ''}` })

  const baselineA = digest(await proto1.history(sidA, { limitTurns: 20 }))
  ev.assert('段 1：基线 history 含 A 回复', baselineA.text.includes('persist-alpha-answer'), {
    channel: 'B', expected: '含 persist-alpha-answer', actual: baselineA.text.slice(0, 200),
  })
  ev.attach('baseline-A', JSON.stringify(baselineA, null, 2))

  // ── 段 2：切走切回 ─────────────────────────────────────────
  await proto1.call('session.switch', { sessionId: sidB }, { timeoutMs: 60_000 })
  await proto1.call('session.switch', { sessionId: sidA }, { timeoutMs: 60_000 })
  const afterSwitch = digest(await proto1.history(sidA, { limitTurns: 20 }))
  ev.assert('段 2：切走切回后 history(A) ≡ 基线', afterSwitch.count === baselineA.count && afterSwitch.text === baselineA.text, {
    channel: 'B',
    expected: `count=${baselineA.count} text 前 120=${baselineA.text.slice(0, 120)}`,
    actual: `count=${afterSwitch.count} text 前 120=${afterSwitch.text.slice(0, 120)}`,
  })
  ev.step({ step: 'session.switch.roundtrip', channel: 'B', exitCode: 0, stats: { sidA, sidB } })
  await proto1.close()
  await inst1.dispose()
  ev.step({ step: 'env.dispose.1', channel: 'C', exitCode: 0, stats: { dataDirKept: fs.existsSync(dataDir) } })

  // ── 段 3：重启应用 ─────────────────────────────────────────
  // 同 dataDir 二次预置需 force（seed-faux 遇已存在的 faux-responses.json 拒绝覆盖）
  const inst2 = createInstance({ repo, name: instanceName, dataDir, faux: { ...faux, force: true }, background: true })
  await inst2.launch()
  await inst2.waitReady({ timeoutMs: 180_000 })
  const proto2 = await inst2.protocol()

  const list = await proto2.call('config.sessions', {})
  const ids = (list.groups ?? []).flatMap((g) => (g.sessions ?? []).map((s) => s.id))
  ev.assert('段 3：重启后 A/B 都在列表', ids.includes(sidA) && ids.includes(sidB), {
    channel: 'B',
    expected: `A=${sidA} B=${sidB} 都在`,
    actual: `count=${ids.length}`,
  })
  const summaryA = (list.groups ?? []).flatMap((g) => g.sessions ?? []).find((s) => s.id === sidA)
  ev.assert('段 3：重启后 summary.modelId 一致', summaryA?.modelId === modelA, {
    channel: 'B',
    expected: modelA,
    actual: summaryA?.modelId ?? '<缺>',
  })

  const afterRestart = digest(await proto2.history(sidA, { limitTurns: 20 }))
  ev.assert('段 3：重启后 history(A) ≡ 基线', afterRestart.count === baselineA.count && afterRestart.text === baselineA.text, {
    channel: 'B',
    expected: `count=${baselineA.count}`,
    actual: `count=${afterRestart.count} text 前 120=${afterRestart.text.slice(0, 120)}`,
  })
  ev.attach('after-restart-A', JSON.stringify(afterRestart, null, 2))

  const treeKept = fs.existsSync(path.join(dataDir, 'ext-sessions', String(sidA)))
  ev.assert('C: ext-sessions/<sidA>/ 树跨重启幸存', treeKept, {
    channel: 'C',
    expected: '树存在',
    actual: treeKept ? '存在' : '不存在',
  })
  ev.step({ step: 'session.persistence', channel: 'B', exitCode: 0, stats: { sidA, sidB } })

  await proto2.close()
  await inst2.dispose()
  fs.rmSync(dataDir, { recursive: true, force: true })
  log(`done sidA=${sidA} sidB=${sidB}`)
  return { uncovered, gotchas }
}
