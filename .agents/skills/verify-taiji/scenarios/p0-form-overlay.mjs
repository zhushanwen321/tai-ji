/**
 * p0-form-overlay —— 统一提问表单（FormOverlay / ask_user）UI 闭环（补剧本优先级 #5；
 * 覆盖矩阵 P0-15）。
 *
 * 装配：faux + fixtures/faux-responses/ask-user-two-questions.json（两题两选项，schema 合规形态）。
 * 路径：
 *   协议发送（step1 = ask_user 工具调用）→ A：form-overlay 浮层可见、两题 tab（form-tab-0/1）→
 *   题 1 点选项 form-option-SQLite → 切题 2 点 form-option-us-east-1 → form-tab-answered 出现 →
 *   form-submit 提交 → A：浮层消失 → B：turn 继续并以 step2 收尾（ASKUSER-DONE）→
 *   C：pi 会话树内落 ask_user 工具结果（用户选择回灌事实源）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const meta = {
  id: 'p0-form-overlay',
  priority: 'P0',
  title: 'ask_user 两题表单：浮层/tab/选项/提交/继续收尾 + 选择回灌 pi 会话树',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'session.create', 'chat.send', 'chat.wait', 'session.history',
    'interaction.askuser',
  ],
  requires: ['faux'],
  estimateSec: 120,
  faux: {
    responses: JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, 'fixtures', 'faux-responses', 'ask-user-two-questions.json'), 'utf8')),
  },
  provable: [
    'A：ask_user 触发后 form-overlay 可见，两题 tab（form-tab-0 / form-tab-1）在',
    'A：点选项后该题进入已答态（form-tab-answered），两题答完 form-submit 可见可点',
    'A：提交后浮层消失（expectGone）',
    'B：turn 继续——step2 收尾文本（ASKUSER-DONE）到达 message.complete',
    'B：session.history 的 toolCall 段含 ask_user 且参数带用户选择',
    'C：pi 会话树（ext-sessions/<sid>/ 或 pi jsonl）落用户选择（SQLite / us-east-1）',
  ],
  notProvable: [
    '自由文本输入（form-free-text / OTHER 分支）与多选形态——夹具只含两题单选（fixtures README 已登记 options ∈ [2,4]）',
    '表单 footer 文案（夹具刻意不改）',
    'ask_user 的 timeout 取消路径（pi 侧语义，非 UI 面）',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir, instance } = ctx
  const uncovered = []
  const gotchas = [
    '夹具每题 options 必须 ≥2（ask_user schema minItems:2）；选项 testid = `form-option-<label 原文>`（optValue 恒等，ChoiceQuestion.vue）',
    'overlay 依附激活会话：协议建会话后必须点侧栏行激活（landing/empty 不可达，Panel.vue ui-presentation-protocol D5）',
    '提交后 pi 继续消费队列 step2；若剧本在提交前 waitTurnEnd 会等到第一个 turn 的工具暂停而非终态',
  ]

  const ui = ctx.ui
  const created = await protocol.call('session.create', { cwd: ctx.repo, label: 'p0-form-overlay' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  if (!sid) throw new Error('session.create 未返回 sessionId')
  await protocol.subscribe(sid)

  // overlay 依附激活会话（landing/empty 不可达，Panel.vue D5 注释）：先点侧栏行激活
  await ui.click('css=.session-item', { timeoutMs: 30_000 })
  const since = protocol.events.length
  await protocol.send(sid, '问两个问题再继续')
  // 表单浮层出现（工具调用轮不结束 turn——waitTurnEnd 会挂到提交后，此处直接等 UI）
  await ui.expectVisible('testid=form-overlay', { timeoutMs: 60_000 })
  ev.assert('A: form-overlay 浮层可见', true, { channel: 'A', expected: 'form-overlay', actual: '可见' })
  await ui.expectVisible('testid=form-tab-0')
  await ui.expectVisible('testid=form-tab-1')
  ev.assert('A: 两题 tab 在（form-tab-0 / form-tab-1）', true, {
    channel: 'A', expected: '两个 tab', actual: 'tab-0 与 tab-1 均可见',
  })
  await ev.shot(await instance.page(), 'form-overlay-open')

  // 题 1：SQLite；切题 2：us-east-1
  await ui.click('testid=form-option-SQLite')
  await ui.click('testid=form-tab-1')
  await ui.click('testid=form-option-us-east-1')
  await ui.expectVisible('testid=form-tab-answered', { timeoutMs: 15_000 })
  ev.assert('A: 已答态出现（form-tab-answered）', true, {
    channel: 'A', expected: '至少一个 tab 显示已答', actual: 'form-tab-answered 可见',
  })
  await ev.shot(await instance.page(), 'form-answered')

  await ui.click('testid=form-submit', { timeoutMs: 15_000 })
  await ui.expectGone('testid=form-overlay', { timeoutMs: 15_000 })
  ev.assert('A: 提交后浮层消失', true, { channel: 'A', expected: 'form-overlay 移除', actual: '已消失' })
  ev.step({ step: 'interaction.askuser', channel: 'A', exitCode: 0, stats: { q1: 'SQLite', q2: 'us-east-1' } })

  const end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
  ev.assert('B: 提交后 turn 以收尾文本完成（ASKUSER-DONE）', end.type === 'message.complete' && end.ok, {
    channel: 'B',
    expected: 'message.complete + step2 收尾',
    actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
  })

  const hist = await protocol.history(sid, { limitTurns: 10 })
  const histText = JSON.stringify(hist.messages ?? [])
  ev.assert('B: history 的 toolCall 段含 ask_user 与用户选择', histText.includes('ask_user') && histText.includes('SQLite'), {
    channel: 'B',
    expected: 'toolCall ask_user + 选择 SQLite 回灌历史',
    actual: `askUser=${histText.includes('ask_user')} sqlite=${histText.includes('SQLite')}`,
  })

  // C 通道：用户选择落在 pi 会话树/日志（事实源，重启后仍可考）
  let diskHit = false
  const sidTree = path.join(dataDir, 'ext-sessions', String(sid))
  const scan = (root, depth = 0) => {
    if (diskHit || depth > 5 || !fs.existsSync(root)) return
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (diskHit) return
      const full = path.join(root, e.name)
      if (e.isDirectory()) scan(full, depth + 1)
      else {
        try {
          if (fs.readFileSync(full, 'utf8').includes('us-east-1')) diskHit = true
        } catch { /* 二进制跳过 */ }
      }
    }
  }
  scan(sidTree)
  ev.assert('C: 用户选择落 pi 会话树（us-east-1 可考）', diskHit, {
    channel: 'C',
    expected: `${sidTree} 内含 us-east-1`,
    actual: `hit=${diskHit}`,
  })

  log(`done sid=${sid}`)
  return { uncovered, gotchas }
}
