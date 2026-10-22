/**
 * p0-session-chat —— 协议主链最小贯通（B0 runner 自证剧本）。
 *
 * 装配：faux（真 Electron + 真 pi 子进程 + 假 LLM 演员，零 token）。
 * 路径：协议建 session（不走 UI）→ delivery.submit 发消息 → 等 turn 结束 →
 * session.history 断言 assistant 文本 → C 通道断言会话树存在 → 第二个 session
 * 验证 history 不串。
 *
 * 本剧本刻意不碰 UI：证明「无 UI 也能验收协议/磁盘域」，UI 域由后续 P0 剧本覆盖。
 */
export const meta = {
  id: 'p0-session-chat',
  priority: 'P0',
  title: 'faux 装配下协议建会话 + 发消息 + 历史断言 + 会话隔离 + 会话树存在',
  covers: ['env.launch', 'env.ready', 'env.isolation', 'session.create', 'session.history', 'chat.send', 'chat.wait'],
  requires: ['faux'],
  estimateSec: 150,
  // B0 已知缺口：session.* / chat.* 的 capability 文档在 B1+ 分批交付；runner 只记录缺口不判 fail
  // model-keyed 脚本（faux fixture 的两种形态之一）：每个 session 是独立 pi 进程、
  // 各自从脚本加载独立响应队列，多会话想要不同回复必须用不同模型（--model 选队）。
  faux: {
    responses: {
      'faux/faux-1': [{ text: 'faux-answer-alpha', stopReason: 'stop' }],
      'faux/faux-1-b': [{ text: 'faux-answer-beta', stopReason: 'stop' }],
    },
  },
  provable: [
    '协议 session.create 建出真 pi 子进程（cwd 生效、模型解析为 faux/faux-1）',
    'delivery.submit 投递 + message.complete 收尾（B 通道事件）',
    'session.history 返回 assistant 文本（live 消息落盘后可回读）',
    'C 通道：<dataDir>/ext-sessions/<sid>/ 树在会话创建后存在',
    '两个 session 的 history 互不串（per-session 隔离）',
  ],
  notProvable: [
    'UI 渲染与流式视觉（不连 CDP 页面做 DOM 断言）',
    '真实模型行为（faux 无网络、无语义）',
    '孙进程（subagent）faux 生效性（见 scripts/probes/faux-grandchild.mjs 与 capabilities/env.md Gotchas）',
  ],
}

/** 从 Message.content（string | Segment[]）提取纯文本。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((s) => {
      if (!s || typeof s !== 'object') return ''
      if (s.type === 'text') return s.text ?? ''
      if (s.type === 'slash') return `/${s.name ?? ''}`
      if (s.type === 'file') return s.path ?? ''
      if (s.type === 'mention') return `@${s.name ?? ''}`
      if (s.type === 'session') return `#${s.sessionId ?? ''}`
      return ''
    })
    .join('')
}

function assistantTexts(history) {
  return (history.messages ?? [])
    .filter((m) => m.role === 'assistant')
    .map((m) => textOf(m.content))
    .filter((t) => t.length > 0)
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir, repo } = ctx
  const uncovered = []
  const gotchas = [
    'faux 响应队列是 per-pi-进程的（不是 per-instance / per-session）：每个 session spawn 独立 pi，各自从同一脚本文件重新加载队首；多会话要不同回复必须用 model-keyed 脚本 + 不同模型（本剧本 A=faux-1 / B=faux-1-b）',
    '模板默认开启 auto-rename（agent/auto-rename-enabled）；instance faux 装配已移除该标志，防标题生成消耗 faux step',
  ]

  // ── 1. 建 session A（协议，不走 UI） ──────────────────────────
  const createA = await protocol.call('session.create', { cwd: repo, label: 'b0-alpha' }, { timeoutMs: 120_000 })
  const sidA = createA.session?.id
  ev.assert('B: session.create A 返回 sessionId', Boolean(sidA), {
    channel: 'B',
    expected: 'session.id 非空',
    actual: JSON.stringify(createA.session ?? {}).slice(0, 400),
  })
  ev.assert('B: session A cwd 生效', createA.session?.cwd === repo, {
    channel: 'B',
    expected: repo,
    actual: createA.session?.cwd,
  })
  ev.assert('B: session A 模型解析（faux）', String(createA.session?.modelId ?? '').includes('faux-1') || createA.session?.modelId === 'faux-1', {
    channel: 'B',
    expected: 'faux/faux-1（默认模型）',
    actual: createA.session?.modelId,
  })
  log(`session A = ${sidA} model=${createA.session?.modelId}`)

  const subA = await protocol.subscribe(sidA)
  ev.assert('B: session.subscribe A 建立（快照可读）', Array.isArray(subA.snapshot) && Array.isArray(subA.stateSnapshot), {
    channel: 'B',
    expected: 'snapshot/stateSnapshot 均为数组',
    actual: `snapshot=${subA.snapshot.length} state=${subA.stateSnapshot.length} lastSeq=${subA.lastSeq}`,
  })

  // ── 2. 发消息 A + 等 turn end ────────────────────────────────
  // since 必须在 send 之前捕获：faux 极快返回时 complete 可能在 send resolve 前入队
  const sinceA = protocol.events.length
  const sendA = await protocol.send(sidA, '这是 B0 会话 A 的探针消息')
  ev.step({ step: 'chat.send.A', channel: 'B', exitCode: 0, stats: { sessionId: sidA, channel: sendA.channel } })
  const endA = await protocol.waitTurnEnd(sidA, { since: sinceA, timeoutMs: 180_000 })
  ev.assert('B: session A turn 以 message.complete 结束', endA.type === 'message.complete' && endA.ok, {
    channel: 'B',
    expected: 'message.complete + stopReason≠error',
    actual: `${endA.type} stopReason=${endA.payload?.stopReason ?? 'n/a'} error=${endA.payload?.message ?? endA.payload?.errorMessage ?? ''}`,
  })
  ev.step({ step: 'chat.wait.A', channel: 'B', exitCode: endA.ok ? 0 : 1, stats: { type: endA.type, stopReason: endA.payload?.stopReason } })

  // ── 3. history A 断言 assistant 文本 ────────────────────────
  const histA = await protocol.history(sidA, { limitTurns: 10 })
  const textsA = assistantTexts(histA)
  ev.assert('B: history A 含 assistant 文本', textsA.length > 0, {
    channel: 'B',
    expected: '≥1 条 assistant 消息',
    actual: `count=${(histA.messages ?? []).length} assistant=${textsA.length} roles=${(histA.messages ?? []).map((m) => m.role).join(',')}`,
  })
  ev.assert('B: history A 文本 = faux 演员脚本', textsA.some((t) => t.includes('faux-answer-alpha')), {
    channel: 'B',
    expected: '含 faux-answer-alpha',
    actual: textsA.join(' | ').slice(0, 400),
  })
  ev.assert('B: history A 含用户消息', (histA.messages ?? []).some((m) => m.role === 'user'), {
    channel: 'B',
    expected: '存在 user 消息',
    actual: (histA.messages ?? []).map((m) => m.role).join(','),
  })
  ev.attach('history-A', JSON.stringify(histA, null, 2).slice(0, 20_000))
  log(`history A messages=${(histA.messages ?? []).length} assistantText=${textsA.join('|').slice(0, 120)}`)

  // ── 4. C 通道：会话树存在 ────────────────────────────────────
  const fs = await import('node:fs')
  const path = await import('node:path')
  const treeRoot = path.join(dataDir, 'ext-sessions', sidA)
  const treeExists = fs.existsSync(treeRoot) && fs.statSync(treeRoot).isDirectory()
  const tree = treeExists ? fs.readdirSync(treeRoot) : []
  ev.assert('C: <dataDir>/ext-sessions/<sidA>/ 树存在', treeExists, {
    channel: 'C',
    expected: treeRoot,
    actual: treeExists ? `entries=${tree.join(',')}` : '目录不存在',
  })
  ev.attach('tree-A', treeRoot)
  ev.attach('tree-A-entries', tree.join('\n'))
  ev.step({ step: 'evidence.tree.A', channel: 'C', exitCode: 0, stats: { root: treeRoot, entries: tree.length } })

  // ── 5. 第二个 session：history 不串 ─────────────────────────
  const createB = await protocol.call(
    'session.create',
    { cwd: repo, label: 'b0-beta', modelOverride: 'faux/faux-1-b' },
    { timeoutMs: 120_000 },
  )
  const sidB = createB.session?.id
  ev.assert('B: session.create B 返回 sessionId 且 ≠ A', Boolean(sidB) && sidB !== sidA, {
    channel: 'B',
    expected: 'sidB 非空且与 sidA 不同',
    actual: `sidB=${sidB}`,
  })
  ev.assert('B: session B modelOverride 生效（faux/faux-1-b）', String(createB.session?.modelId ?? '').includes('faux-1-b'), {
    channel: 'B',
    expected: 'faux/faux-1-b',
    actual: createB.session?.modelId,
  })
  log(`session B = ${sidB}`)
  await protocol.subscribe(sidB)
  const sinceB = protocol.events.length
  const sendB = await protocol.send(sidB, '这是 B0 会话 B 的探针消息')
  ev.step({ step: 'chat.send.B', channel: 'B', exitCode: 0, stats: { sessionId: sidB, channel: sendB.channel } })
  const endB = await protocol.waitTurnEnd(sidB, { since: sinceB, timeoutMs: 180_000 })
  ev.assert('B: session B turn 以 message.complete 结束', endB.type === 'message.complete' && endB.ok, {
    channel: 'B',
    expected: 'message.complete + stopReason≠error',
    actual: `${endB.type} stopReason=${endB.payload?.stopReason ?? 'n/a'}`,
  })
  ev.step({ step: 'chat.wait.B', channel: 'B', exitCode: endB.ok ? 0 : 1, stats: { type: endB.type } })

  const histB = await protocol.history(sidB, { limitTurns: 10 })
  const textsB = assistantTexts(histB)
  ev.assert('B: history B 文本 = 第二个 faux 脚本步', textsB.some((t) => t.includes('faux-answer-beta')), {
    channel: 'B',
    expected: '含 faux-answer-beta',
    actual: textsB.join(' | ').slice(0, 400),
  })

  const histA2 = await protocol.history(sidA, { limitTurns: 10 })
  const textsA2 = assistantTexts(histA2)
  ev.assert('B: session 隔离（A 的 history 不含 B 的回复）', !textsA2.some((t) => t.includes('faux-answer-beta')), {
    channel: 'B',
    expected: 'A 不含 faux-answer-beta',
    actual: textsA2.join(' | ').slice(0, 400),
  })
  ev.assert('B: session 隔离（B 的 history 不含 A 的回复）', !textsB.some((t) => t.includes('faux-answer-alpha')), {
    channel: 'B',
    expected: 'B 不含 faux-answer-alpha',
    actual: textsB.join(' | ').slice(0, 400),
  })
  ev.assert('B: A 的回复仍在 A（隔离断言双向）', textsA2.some((t) => t.includes('faux-answer-alpha')), {
    channel: 'B',
    expected: 'A 仍含 faux-answer-alpha',
    actual: textsA2.join(' | ').slice(0, 400),
  })

  // ── 6. session.list 含两个 session ──────────────────────────
  const list = await protocol.call('config.sessions', {})
  const ids = (list.groups ?? []).flatMap((g) => (g.sessions ?? []).map((s) => s.id))
  ev.assert('B: config.sessions 列出 A 与 B', ids.includes(sidA) && ids.includes(sidB), {
    channel: 'B',
    expected: 'A、B 都在列表',
    actual: `count=${ids.length} hasA=${ids.includes(sidA)} hasB=${ids.includes(sidB)}`,
  })
  ev.attach('session-ids', JSON.stringify({ sidA, sidB, listed: ids }, null, 2))

  // ── 7. 会话树 B 也在 + 磁盘证据 ─────────────────────────────
  const treeB = path.join(dataDir, 'ext-sessions', sidB)
  ev.assert('C: <dataDir>/ext-sessions/<sidB>/ 树存在', fs.existsSync(treeB), {
    channel: 'C',
    expected: treeB,
    actual: fs.existsSync(treeB) ? '存在' : '不存在',
  })

  // pi 子进程日志（会话树内 logs/pi-*.jsonl）应能证明真 pi 参与
  const { readPiLogs } = await import('../scripts/lib/instance.mjs')
  const piLog = readPiLogs(dataDir)
  ev.assert('C: pi 子进程日志存在（真 pi 进程参与）', piLog.length > 0, {
    channel: 'C',
    expected: 'pi-*.jsonl 非空',
    actual: `bytes=${piLog.length}`,
  })
  // pi JSONL 单行可能巨大（message_update delta 逐条落盘）：按行截断再拼，防附件膨胀
  ev.attach(
    'pi-log-tail',
    piLog
      .split('\n')
      .slice(-60)
      .map((l) => (l.length > 1200 ? `${l.slice(0, 1200)}…[truncated ${l.length}B]` : l))
      .join('\n'),
  )

  return { uncovered, gotchas }
}
