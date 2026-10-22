/**
 * p1-chat-revoke —— 已送达消息撤回（覆盖矩阵 P1-4；补剧本优先级 #10 之二）。
 *
 * 装配：faux（plain-text）。路径（ADR-0076 双通道的「已送达」支）：
 *   发消息 → turn 完成（已送达）→ history 取该 user 消息 id →
 *   session.revokeMessage { sessionId, targetId } → 回执 revoked:true + content=原文（草稿回填数据）→
 *   B：history 读侧不再含该消息（树回退 = append-only 追加标记 + 读侧过滤）→ C：JSONL 尾部留档 →
 *   A：页面 HTML 不再含原文（气泡移除，条件轮询等 UI 更新）。
 *
 * 在途通道（delivery.cancel）不在本剧本：那是「发送中撤回」，时机窗口由队列语义另验。
 */
import fs from 'node:fs'
import path from 'node:path'

export const meta = {
  id: 'p1-chat-revoke',
  priority: 'P1',
  title: '已送达 user 消息撤回：revoked:true + 原文回执 + history/树/UI 三面回退',
  covers: ['env.launch', 'env.ready', 'env.isolation', 'session.create', 'chat.send', 'chat.wait', 'session.history', 'chat.revoke'],
  requires: ['faux'],
  estimateSec: 120,
  faux: {
    responses: [{ text: 'revoke-scenario-answer', stopReason: 'stop' }],
  },
  provable: [
    'revokeMessage 回执 revoked:true 且 content = 被撤原文（草稿回填数据面）',
    'B：撤回后 history 不再含该 user 消息（树回退）',
    '持久态：二次撤回幂等（revoked:true 重返原文，实测形态）；JSONL 尾部形态如实 attach 留档',
    'A：页面 HTML 不再渲染该消息气泡（条件轮询等 UI 更新）',
  ],
  notProvable: [
    '在途撤回通道（delivery.cancel：发送中撤回的时机窗口）——已送达支与本支互补',
    '撤回六错误码闭集的逐码验证（D8 错误规格表；本剧本走 happy path + 一条越界错误抽查）',
    'composer 草稿回填的 UI 呈现（回填数据经 reply.content 验证，输入框填充的视觉态归手工）',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir } = ctx
  const uncovered = []
  const gotchas = [
    '撤回双通道：在途 = delivery.cancel（发送中）；已送达 = session.revokeMessage（本剧本）——ADR-0076',
    'reply 与 request 同名（payload 消费型）：revoked:true + content / revoked:false + error 六码',
    '树回退语义：撤 user 消息会连带其后 assistant 轮回退（history 断言按「原文消失」不按「全空」）',
    'pi 会话 JSONL 是 append-only：撤回不改写历史行（追加以表达），「原文消失」只成立于 history 读侧——C 通道证据 = JSONL 尾部附件 + 二次撤回的幂等分型',
    '撤回幂等：已撤 id 二次 revoke 仍 revoked:true + 原文（2026-10-22 实测，非 D8 错误码路径）——依赖「二次撤回报错」的断言会假失败',
  ]
  const SENTINEL = 'REVOKE-ME-8f3a'

  const created = await protocol.call('session.create', { cwd: ctx.repo, label: 'p1-chat-revoke' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  if (!sid) throw new Error('session.create 未返回 sessionId')
  await protocol.subscribe(sid)

  const since = protocol.events.length
  await protocol.send(sid, `这条消息将被撤回 ${SENTINEL}`)
  const end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
  ev.assert('B: 撤回前的轮完成', end.ok === true, {
    channel: 'B', expected: 'message.complete', actual: `${end.type} stop=${end.payload?.stopReason ?? ''}`,
  })

  // 取 user 消息 id
  const hist = await protocol.history(sid, { limitTurns: 10 })
  const userMsg = (hist.messages ?? []).find((m) => m.role === 'user' && JSON.stringify(m.content ?? '').includes(SENTINEL))
  ev.assert('B: history 可定位被撤消息（id + 原文）', Boolean(userMsg?.id), {
    channel: 'B',
    expected: 'user 消息带 id',
    actual: userMsg ? `id=${userMsg.id}` : '未找到含哨兵的 user 消息',
  })
  if (!userMsg?.id) {
    return { uncovered: ['history 未定位到被撤消息 id，撤回段未执行'], gotchas }
  }

  // ── 撤回 ───────────────────────────────────────────────────
  const revoke = await protocol.call('session.revokeMessage', { sessionId: sid, targetId: userMsg.id }, { timeoutMs: 60_000 })
  ev.assert('B: 回执 revoked:true 且 content=原文', revoke.revoked === true && String(revoke.content ?? '').includes(SENTINEL), {
    channel: 'B',
    expected: '{revoked:true, content 含哨兵}',
    actual: JSON.stringify(revoke).slice(0, 300),
  })
  ev.step({ step: 'chat.revoke', channel: 'B', exitCode: revoke.revoked ? 0 : 1, stats: { revoked: revoke.revoked } })

  // ── B：history 回退（条件轮询——撤回落盘/广播异步） ─────────
  let histGone = false
  {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const h = await protocol.history(sid, { limitTurns: 10 })
      if (!JSON.stringify(h.messages ?? []).includes(SENTINEL)) {
        histGone = true
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  ev.assert('B: 撤回后 history 不再含原文（树回退）', histGone, {
    channel: 'B',
    expected: '哨兵消失',
    actual: `gone=${histGone}`,
  })

  // ── C：pi JSONL 形态（append-only，如实登记不硬断言） ────────
  // pi 会话 JSONL 是 append-only：撤回不改写历史行（「原文消失」断言会假失败）——
  // 撤回的持久语义 = 追加标记 + history 读侧过滤（B 通道已断言）。这里 attach 尾部留档。
  const sessionFile = findSessionFile(path, dataDir, sid)
  if (sessionFile) {
    const tail = fs.readFileSync(sessionFile, 'utf8').split('\n').slice(-12).join('\n')
    ev.attach('jsonl-tail-after-revoke', tail.slice(0, 8_000))
  }
  ev.step({ step: 'evidence.jsonl.tail', channel: 'C', exitCode: 0, stats: { sessionFile: sessionFile ?? '' } })

  // 持久态语义实测（2026-10-22）：二次撤回幂等成功（仍 revoked:true + 原文）——撤回是
  // append-only 树上的标记操作，不是「删数据」，已撤 id 再撤不报错。断言按实测幂等形态。
  const revoke2 = await protocol.call('session.revokeMessage', { sessionId: sid, targetId: userMsg.id }, { timeoutMs: 60_000 })
  ev.assert('B: 二次撤回幂等（结构合规，不炸）', typeof revoke2.revoked === 'boolean' && (revoke2.revoked === false ? Boolean(revoke2.error) : Boolean(revoke2.content)), {
    channel: 'B',
    expected: '两形态之一：{revoked:true, content}（幂等，实测形态）或 {revoked:false, error}',
    actual: JSON.stringify(revoke2).slice(0, 200),
  })

  // ── A：UI 气泡移除（条件轮询 body HTML） ───────────────────
  let uiGone = false
  {
    const ui = ctx.ui
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const html = await ui.html('css=body')
      if (!html.includes(SENTINEL)) {
        uiGone = true
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    ev.assert('A: 页面不再渲染被撤消息（气泡移除）', uiGone, {
      channel: 'A',
      expected: 'body HTML 不含哨兵',
      actual: `gone=${uiGone}`,
    })
  }

  log(`done sid=${sid} revoked=${revoke.revoked}`)
  return { uncovered, gotchas }
}

/** 从 config.sessions summary 找 sessionFile（pi 会话 JSONL 绝对路径）。 */
function findSessionFile(path, dataDir, sid) {
  // 同步 import 场景下直接扫 agent/sessions 树（encodeCwd 段不定，递归匹配文件名含 sid）
  const root = path.join(dataDir, 'agent', 'sessions')
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.name.includes(sid)) return full
    }
  }
  return null
}
