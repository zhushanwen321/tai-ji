/**
 * p0-model-switch —— 模型目录 / 主会话热切 / 思考档位 / 失败信号（覆盖矩阵补剧本优先级 #1）。
 *
 * 装配：faux（真 Electron + 真 pi 子进程 + 假 LLM 演员，零 token）。
 * 路径：
 *   B 通道主体——model.list 目录 → 协议建 session（默认 faux/faux-1）→ 发一轮（切换前基线）→
 *   model.switch 到 faux-1-reasoning → model.switched 回执生效值 + state 快照 state_changed 收敛 →
 *   切换后再发一轮（热切不破坏对话；faux 下 responseModel 不反映切换，见 notProvable）→
 *   session.setThinkingLevel('high') → session.thinkingLevelSet 回执 →
 *   失败信号：switch 到不存在模型必须收 error envelope（MODEL_NOT_FOUND）。
 *   C 通道——pi 会话 JSONL 追加 model_change 与 thinking_level_change entry（持久层唯一写方 = pi）。
 *   A 通道——composer 模型弹层打开后能看到目标模型行（目录 UI 可见性）。
 *
 * A 通道刻意只覆盖「目录可见性」：composer 模型名随回执更新的断言需要 UI 激活该 session
 * （协议建的 session 不改变 renderer 激活态），归 p0-chat-stream-ui 的 UI 首发链路。
 */
import fs from 'node:fs'
import path from 'node:path'

export const meta = {
  id: 'p0-model-switch',
  priority: 'P0',
  title: '模型目录 + 主会话热切（回执/广播/JSONL/responseModel）+ thinking 档位 + 失败信号',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'session.create', 'session.history',
    'model.list', 'model.switch', 'model.thinking',
    'chat.send', 'chat.wait',
  ],
  requires: ['faux'],
  parallelGroup: 'model',
  estimateSec: 90,
  // 统一数组队列（非 model-keyed）：faux 的 model-keyed 选队按进程 argv --model 一次定型
  // （faux-llm-ext.ts selfModelRef/loadScript），同进程热切模型不会重选队——切换前后必须
  // 同队顺序消费（step0 切换前、step1 切换后），否则新轮命中「faux 耗尽」error。
  faux: {
    responses: [
      { text: 'alpha-before-switch', stopReason: 'stop' },
      { text: 'after-switch-still-talks', stopReason: 'stop' },
    ],
  },
  provable: [
    'model.list 目录含 faux-1 与 faux-1-reasoning 且 enabled',
    'model.switch 回执 {provider, modelId} = 生效值（裸 id faux-1-reasoning）',
    'state 快照（重订阅 stateSnapshot）的 state_changed 条目 modelId 收敛为复合串 faux/faux-1-reasoning',
    '切换后一轮正常完成（热切不破坏对话）',
    'C：pi 会话 JSONL 追加 model_change entry（持久层写方 = pi）',
    'session.setThinkingLevel(high) 回执生效档 = high（faux-1-reasoning 支持档）',
    'state 快照 state_changed 反映新档位（thinkingLevel=high）',
    'C：JSONL 追加 thinking_level_change entry',
    '失败信号：switch 到不存在模型收 error envelope（MODEL_NOT_FOUND），会话不被破坏',
    'A：模型弹层可见 faux-1-reasoning 行（目录 UI 可见性）',
    '切换不丢历史：切换前后两轮文本都在 session.history',
  ],
  notProvable: [
    '「切换后新模型真的在跑」的最终证据 message.complete.responseModel：faux/mock-http 的回复与模型无绑定，responseModel 不反映切换（live 通道才可断言）',
    'composer 模型名随回执更新（需 UI 激活该 session，归 p0-chat-stream-ui）',
    'thinkingLevelMap 的 key→value 重映射语义（faux 无 map，只有真实 provider 模型有）',
    'pattern 引擎静默换模（faux 不触发；只能核对回执与请求不等时如实记录）',
    '真实 provider 的鉴权 / 限流 / 可用性',
  ],
}

/** 从 config.sessions reply 里找 session summary（含 sessionFile 路径）。 */
function findSummary(listReply, sid) {
  for (const g of listReply.groups ?? []) {
    for (const s of g.sessions ?? []) {
      if (s.id === sid) return s
    }
  }
  return null
}

/** 读 pi 会话 JSONL，返回匹配行（截断防膨胀）。 */
function grepSessionFile(sessionFile, needle) {
  let text = ''
  try {
    text = fs.readFileSync(sessionFile, 'utf8')
  } catch {
    return { hits: [], bytes: 0 }
  }
  const hits = text
    .split('\n')
    .filter((l) => l.includes(needle))
    .map((l) => (l.length > 400 ? `${l.slice(0, 400)}…[truncated ${l.length}B]` : l))
  return { hits, bytes: text.length }
}

/**
 * 条件轮询重订阅 stateSnapshot，直到 state_changed 条目满足谓词（或超时返回最后值）。
 * 为什么不等广播帧 / 不立即读快照：见文件尾 gotchas 的「state_changed 实测行为」条。
 */
async function pollStateSnapshotEntry(protocol, sid, predicate, { timeoutMs = 20_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  let entry = null
  while (Date.now() < deadline) {
    const sub = await protocol.call('session.subscribe', { sessionId: sid }, {})
    entry = (sub.stateSnapshot ?? []).find((s) => s?.type === 'session.state_changed') ?? null
    if (entry && predicate(entry)) return entry
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return entry
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir, repo, instance } = ctx
  const uncovered = []
  const gotchas = [
    'model.switch 的持久化语义 = pi 会话内 model_change entry；它不写 agent/settings.json 的 defaultModel（那是 config.setDefaultModel 的动作）',
    'faux-1 只有 off 档：thinking 多档必须切到 faux-1-reasoning（supportedLevels = off/minimal/low/medium/high，faux-llm-ext.ts 四演员注释锁定）',
    'faux-1 是 faux-1-reasoning 的子串：断言生效模型用「含 faux-1-reasoning」，不要用「含 faux-1」（前轮匹配会双命中）',
    'model.switch / setThinkingLevel 都先 ensureActive（停止态 1–2s）；期间触发器单飞锁，并发两条 switch 会乱序回执',
    'modelId 有两种 wire 形态：session.create / state_changed payload 是 provider/id 复合串（faux/faux-1-reasoning），model.switched 回执是裸 id（faux-1-reasoning）——runtime 拆解复合串回填（model-message-handler.ts 的 parseModelSelector）',
    'state_changed 实测行为（2026-10-22 两次复现）：switch 回执后等待窗口内本 WS 只收到 commands/stats_update，未收到 state_changed 增量帧；但发布已发生（重订阅 stateSnapshot 可读到新值）。注意这与 bus 层「对订阅者全集无差别投递」的源码推演相悖，机制未定位（登记为待查疑点）；无论机制如何，生效值核验一律用条件轮询重订阅读 stateSnapshot（发布链有 300ms 防抖 + 重新拉取，回执后立即读会拿旧值）——这是确定性收敛路径',
    'faux 的 model-keyed 选队按进程 argv --model 一次定型（selfModelRef/loadScript），同进程热切模型不重选队：验切换的剧本必须用统一数组队列，切换后轮才会被消费（model-keyed 下新轮命中「faux 耗尽」error）',
  ]

  // ── 1. model.list：目录含两个演员 ─────────────────────────────
  const listReply = await protocol.call('model.list', {}, { timeoutMs: 60_000 })
  const models = listReply.models ?? []
  const byId = new Map(models.map((m) => [m.id, m]))
  ev.step({ step: 'model.list', channel: 'B', exitCode: 0, stats: { count: models.length } })
  ev.assert('B: 目录含 faux-1', byId.has('faux-1'), {
    channel: 'B',
    expected: 'model.list 含 id=faux-1',
    actual: `count=${models.length} ids=${models.map((m) => m.id).join(',').slice(0, 300)}`,
  })
  ev.assert('B: 目录含 faux-1-reasoning 且 enabled', (() => {
    const m = byId.get('faux-1-reasoning')
    return Boolean(m) && m.enabled !== false
  })(), {
    channel: 'B',
    expected: 'id=faux-1-reasoning 且 enabled !== false',
    actual: JSON.stringify(byId.get('faux-1-reasoning') ?? null).slice(0, 300),
  })
  ev.attach('model-list', JSON.stringify(models, null, 2).slice(0, 20_000))

  // ── 2. 建 session（默认 faux/faux-1）+ 发切换前基线轮 ─────────
  const created = await protocol.call('session.create', { cwd: repo, label: 'p0-model-switch' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  // modelId 形态：session.create / state_changed 里是 provider/id 复合串（'faux/faux-1'）；
  // model.switched 回执里是裸 id（runtime 拆解复合串回填，见 switchModel U6 注释）——两形态别混。
  ev.assert('B: session.create 返回 sessionId 且默认模型 = faux/faux-1', Boolean(sid) && created.session?.modelId === 'faux/faux-1', {
    channel: 'B',
    expected: 'modelId=faux/faux-1（复合串，无 override 的默认演员）',
    actual: `sid=${sid} modelId=${created.session?.modelId}`,
  })
  await protocol.subscribe(sid)

  const sinceBase = protocol.events.length
  await protocol.send(sid, '切换前基线消息')
  const endBase = await protocol.waitTurnEnd(sid, { since: sinceBase, timeoutMs: 180_000 })
  ev.assert('B: 切换前轮完成', endBase.type === 'message.complete' && endBase.ok, {
    channel: 'B',
    expected: 'message.complete 非 error',
    actual: `${endBase.type} stopReason=${endBase.payload?.stopReason ?? 'n/a'}`,
  })
  ev.step({ step: 'chat.send.before', channel: 'B', exitCode: 0, stats: { responseModel: endBase.payload?.responseModel ?? null } })

  // ── 3. A 通道：模型弹层目录可见性（协议建 session 不改 renderer 激活态，断言不受影响） ──
  try {
    const ui = ctx.ui
    await ui.click('css=[title="切换模型"]')
    await ui.expectVisible('testid=model-picker-item-faux-1-reasoning')
    const rowText = await ui.text('testid=model-picker-item-faux-1-reasoning')
    ev.assert('A: 模型弹层可见 faux-1-reasoning 行', Boolean(rowText), {
      channel: 'A',
      expected: 'model-picker-item-faux-1-reasoning 可见（testid 只带裸 modelId，见 model.md Gotcha 2）',
      actual: String(rowText).slice(0, 200),
    })
    await ev.shot(await instance.page(), 'model-picker-open')
    await ui.press('Escape')
    ev.step({ step: 'model.picker.A', channel: 'A', exitCode: 0, stats: {} })
  } catch (e) {
    // UI 锚点失败按失败处理（不弱化）：记录现场后继续 B/C 断言，最终 verdict 由 ev.ok 决定
    ev.assert('A: 模型弹层可见 faux-1-reasoning 行', false, {
      channel: 'A',
      expected: '点击 [title="切换模型"] 后弹层含目标行',
      actual: String(e?.message ?? e).slice(0, 400),
    })
    // 结构化失败现场（ui.mjs 的 visibleTestIds 摘要 / 页面 URL 等 evidence 字段）落盘供排障
    ev.attach('model-picker-error', JSON.stringify({ message: e?.message, hint: e?.hint, evidence: e?.evidence }, null, 2).slice(0, 20_000))
    try {
      await ev.shot(await instance.page(), 'model-picker-fail')
    } catch {
      /* 页面不可用时放弃截图，失败现场以 attach 为准 */
    }
    ev.step({ step: 'model.picker.A', channel: 'A', exitCode: 1, stats: {} })
  }

  // ── 4. model.switch 到 faux-1-reasoning ─────────────────────
  const switched = await protocol.call(
    'model.switch',
    { sessionId: sid, provider: 'faux', modelId: 'faux-1-reasoning' },
    { replyType: 'model.switched', timeoutMs: 120_000 },
  )
  ev.assert('B: model.switched 回执生效值 = faux-1-reasoning', switched.provider === 'faux' && switched.modelId === 'faux-1-reasoning', {
    channel: 'B',
    expected: '{provider:"faux", modelId:"faux-1-reasoning"}（值 = pi 实际生效模型）',
    actual: JSON.stringify({ provider: switched.provider, modelId: switched.modelId }),
  })
  ev.attach('model-switched', JSON.stringify(switched, null, 2).slice(0, 4_000))

  // 生效值核验走「重订阅读 state 快照」（last-value 语义）。实测（2026-10-22 两次复现）：
  // switch 回执后等待期间该 WS 只收到 commands/stats_update，未收到 state_changed 增量帧
  // （与 bus 层「对订阅者全集无差别投递」的源码推演相悖，机制未定位——见 gotchas）；
  // 发布已发生并写入 stateSnapshot，且发布链有 300ms 防抖 + 重新拉取，回执后立即读会拿旧值。
  const stateChangedEntry = await pollStateSnapshotEntry(protocol, sid, (e) => e.payload?.modelId === 'faux/faux-1-reasoning')
  ev.assert('B: state 快照 state_changed 条目 modelId 收敛为 faux/faux-1-reasoning', stateChangedEntry?.payload?.modelId === 'faux/faux-1-reasoning', {
    channel: 'B',
    expected: 'state_changed.payload.modelId = faux/faux-1-reasoning（last-value 快照，防抖后收敛）',
    actual: JSON.stringify(stateChangedEntry ?? null).slice(0, 300),
  })
  ev.step({ step: 'model.switch', channel: 'B', exitCode: 0, stats: { modelId: switched.modelId, snapshotThinkingLevel: stateChangedEntry?.payload?.thinkingLevel ?? null } })

  // ── 5. C 通道：JSONL model_change entry ─────────────────────
  const listNow = await protocol.call('config.sessions', {})
  const summary = findSummary(listNow, sid)
  const sessionFile = summary?.sessionFile ?? ''
  if (sessionFile && fs.existsSync(sessionFile)) {
    const modelChange = grepSessionFile(sessionFile, '"type":"model_change"')
    ev.assert('C: 会话 JSONL 追加 model_change 且含 faux-1-reasoning', modelChange.hits.some((h) => h.includes('faux-1-reasoning')), {
      channel: 'C',
      expected: `model_change entry 含 faux-1-reasoning（${sessionFile}）`,
      actual: `hits=${modelChange.hits.length} bytes=${modelChange.bytes}`,
    })
    ev.attach('model-change-lines', modelChange.hits.join('\n') || '(无命中)')
  } else {
    ev.assert('C: 会话 JSONL 存在（经 config.sessions summary.sessionFile）', false, {
      channel: 'C',
      expected: 'sessionFile 可得且文件在盘',
      actual: `sessionFile=${sessionFile || '<summary 未带>'}`,
    })
  }

  // ── 6. 切换后一轮：热切不破坏对话（faux 下 responseModel 不反映切换，见 notProvable） ──
  const sinceAfter = protocol.events.length
  await protocol.send(sid, '切换后验证消息')
  const endAfter = await protocol.waitTurnEnd(sid, { since: sinceAfter, timeoutMs: 180_000 })
  ev.assert('B: 切换后轮正常完成（热切不破坏对话）', endAfter.type === 'message.complete' && endAfter.ok, {
    channel: 'B',
    expected: 'message.complete 非 error（若 error 且文本含 faux 耗尽 = 误用 model-keyed 选队）',
    actual: `${endAfter.type} stopReason=${endAfter.payload?.stopReason ?? 'n/a'} msg=${String(endAfter.payload?.message ?? '').slice(0, 200)}`,
  })
  ev.step({ step: 'chat.send.after', channel: 'B', exitCode: endAfter.ok ? 0 : 1, stats: { stopReason: endAfter.payload?.stopReason ?? null } })

  const hist = await protocol.history(sid, { limitTurns: 10 })
  const allText = JSON.stringify(hist.messages ?? [])
  ev.assert('B: 切换不丢历史（前后两轮文本都在）', allText.includes('alpha-before-switch') && allText.includes('after-switch-still-talks'), {
    channel: 'B',
    expected: 'history 同时含 alpha-before-switch 与 after-switch-still-talks',
    actual: `messages=${(hist.messages ?? []).length}`,
  })

  // ── 7. thinking 档位（faux-1-reasoning：high 是支持档，不钳制） ──
  const think = await protocol.call(
    'session.setThinkingLevel',
    { sessionId: sid, level: 'high' },
    { replyType: 'session.thinkingLevelSet', timeoutMs: 120_000 },
  )
  ev.assert('B: thinkingLevelSet 回执生效档 = high', think.level === 'high', {
    channel: 'B',
    expected: 'level=high（支持档 → 不钳制，以 reply 为准）',
    actual: JSON.stringify({ level: think.level }).slice(0, 200),
  })
  ev.step({ step: 'model.thinking', channel: 'B', exitCode: 0, stats: { level: think.level } })

  // 快照收敛核验：state_changed 是 last-value 覆盖，等防抖后重订阅拿最新组合值
  const thinkEntry = await pollStateSnapshotEntry(protocol, sid, (e) => e.payload?.thinkingLevel === 'high')
  ev.assert('B: state 快照 state_changed 反映新档位（thinkingLevel=high 且 modelId 保持）', thinkEntry?.payload?.thinkingLevel === 'high' && thinkEntry?.payload?.modelId === 'faux/faux-1-reasoning', {
    channel: 'B',
    expected: '{modelId:"faux/faux-1-reasoning", thinkingLevel:"high"}',
    actual: JSON.stringify(thinkEntry?.payload ?? null).slice(0, 300),
  })

  if (sessionFile && fs.existsSync(sessionFile)) {
    const thinkChange = grepSessionFile(sessionFile, '"type":"thinking_level_change"')
    ev.assert('C: 会话 JSONL 追加 thinking_level_change', thinkChange.hits.length > 0, {
      channel: 'C',
      expected: '≥1 条 thinking_level_change entry',
      actual: `hits=${thinkChange.hits.length}`,
    })
    ev.attach('thinking-change-lines', thinkChange.hits.join('\n') || '(无命中)')
  }

  // ── 8. 失败信号：不存在模型 → error envelope（MODEL_NOT_FOUND），会话不坏 ──
  let failCode = ''
  try {
    await protocol.call(
      'model.switch',
      { sessionId: sid, provider: 'faux', modelId: 'faux-nope' },
      { replyType: 'model.switched', timeoutMs: 60_000 },
    )
    failCode = '<未抛错：error envelope 缺失>'
  } catch (e) {
    failCode = String(e?.message ?? e)
  }
  ev.assert('B: 不存在模型收 error envelope（MODEL_NOT_FOUND）', /MODEL_NOT_FOUND/.test(failCode), {
    channel: 'B',
    expected: 'ProtocolError 含 MODEL_NOT_FOUND',
    actual: failCode.slice(0, 300),
  })
  ev.step({ step: 'model.switch.invalid', channel: 'B', exitCode: /MODEL_NOT_FOUND/.test(failCode) ? 0 : 1, stats: {} })
  const histAfterFail = await protocol.history(sid, { limitTurns: 10 })
  ev.assert('B: 失败切换不破坏会话（history 仍可读）', Array.isArray(histAfterFail.messages) && histAfterFail.messages.length > 0, {
    channel: 'B',
    expected: 'history 可读且非空',
    actual: `messages=${(histAfterFail.messages ?? []).length}`,
  })

  ev.attach('session-file', sessionFile || '(无)')
  log(`done sid=${sid} sessionFile=${sessionFile}`)
  return { uncovered, gotchas }
}
