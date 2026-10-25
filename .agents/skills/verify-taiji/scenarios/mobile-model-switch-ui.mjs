/**
 * mobile-model-switch-ui —— 模型与思考切换（remote-use-mobile-v2 §8.2 场景 V8，D3 验收目标
 * A8；§7.2 F9 + 思考档七值四段映射在移动壳的 UI 面）。
 *
 * 真实用户路径：页头模型 chip → ModelSheet → 切模型 + 切思考档 → chip 即时更新 → 关 Sheet
 * → 发下一条 → 回执生效值与显示一致。
 *
 * 断言面（V8 通过标准 + §7.2 映射表逐条对应）：
 *   ① chip 打开 ModelSheet：模型清单在场（faux 四演员）、思考档四段段控（低/中/高/最高）
 *      与七值短词词表形态（未知占位起步）；
 *   ② 切模型：chip 即时更新为生效值（回执写显示态——switchSessionModel 回执 = pi 生效值，
 *      ModelSheet applyLiveState）；B：session.state_changed 广播同步到达；
 *   ③ 切思考档：四段段控 aria-selected 精确点亮（段值才点亮）；chip 追加档位短词；
 *   ④ 非段值映射：protocol 侧置 xhigh（七值之一、段外值）→ 当前短词「超高」、四段全不
 *      点亮、段外原值提示行在场（非段值不点亮段选中态）；
 *   ⑤ 发下一条：message.complete 回执 responseModel 与 chip 显示模型一致（回执生效值 =
 *      显示值）；B：setThinkingLevel 回执 level = 请求值（无钳制时的生效读回）。
 *
 * RPC 语义（model.switch / setThinkingLevel 的生效值与钳制行为）已由桌面 p0-model-switch
 * 覆盖——本剧本只断移动 UI 面：chip/Sheet/段控呈现与回执一致性。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createTaskViaSheet,
  flattenSessions,
  openConnectedShell,
  sendViaComposer,
} from './lib/mobile-task-flow.mjs'
import { closeMobileShell } from './lib/mobile-shell-helper.mjs'

const REPLY_1 = 'A8 首轮回复，MODEL-SEED-REPLY-3k7d。'
const MSG2 = 'A8 第二条消息，验证回执生效值与显示一致'

export const meta = {
  id: 'mobile-model-switch-ui',
  priority: 'P0',
  title: '移动壳模型 chip → ModelSheet（七值四段映射）→ 切模型/思考档 chip 即时更新 → 下一条回执生效值与显示一致',
  covers: ['env.launch', 'env.ready', 'session.create', 'model.list', 'model.switch', 'model.thinking', 'mobile.model.switch-ui'],
  requires: ['remote-access', 'mobile-dist', 'faux'],
  estimateSec: 180,
  remoteAccess: {},
  faux: {
    responses: [
      { text: REPLY_1, stopReason: 'stop' },
      { text: 'A8 第二轮回复，MODEL-NEXT-REPLY-8w1c。', stopReason: 'stop' },
    ],
  },
  provable: [
    'A：页头 chip 点击打开 ModelSheet（模型清单 + 思考档四段段控低/中/高/最高 + 未知占位）',
    'A：切模型后 chip 即时更新为生效模型 id（回执写显示态，非乐观请求值）',
    'B：session.state_changed 广播携带新 modelId（B 通道同步面）',
    'A：切思考档后段控 aria-selected 精确点亮所选段（其余三段不点亮）且 chip 追加档位短词',
    'A：段外值（xhigh）呈现：当前短词「超高」+ 四段全不点亮 + 段外原值提示行（非段值不点亮段选中态）',
    "B：protocol 侧 setThinkingLevel('xhigh') 回执 level=xhigh（七值域生效读回）",
    'A/B：发下一条后 message.complete 回执 responseModel 与 chip 显示模型一致',
  ],
  notProvable: [
    'model.switch 的静默换模钳制与 provider 校验语义（桌面 p0-model-switch 已覆盖，本剧本只断移动 UI 面）',
    '「不影响另一会话」（V8 尾句）：本剧本单会话装配，跨会话隔离归 p0-session-isolation（桌面）',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, remoteAccess } = ctx
  const gotchas = []
  const uncovered = []
  const info = instance.info()
  const goodToken = remoteAccess?.token
  if (!goodToken) throw new Error('ctx.remoteAccess 缺失：run.mjs 未做 remote-access 预置（meta.remoteAccess 钩子失效？）')

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-a8-model-'))
  let shell = null
  const waitErr = (e) => JSON.stringify({ message: String(e?.message ?? e), evidence: e?.evidence }, null, 2).slice(0, 2_000)

  try {
    shell = await openConnectedShell({ repo: ctx.repo, runtimePort: info.runtimePort, token: goodToken })
    const page = shell.page
    const protocol = ctx.protocol
    ev.step({ step: 'mobile.shell.connected', channel: 'A', exitCode: 0, stats: { handover: shell.handover.ok } })

    // ── 装配：NewTaskSheet 建会话（首轮直发），订阅接线 ────────────────────────
    await createTaskViaSheet(page, { cwd, firstMessage: 'A8 模型切换会话的首条消息' })
    const listReply = await protocol.call('session.list', {}, { replyType: 'session.list' })
    const created = flattenSessions(listReply).find((s) => s.cwd === cwd)
    if (!created?.id) throw new Error('session.list 未命中新建会话（cwd 不匹配）')
    const sid = created.id
    await protocol.subscribe(sid)
    ev.step({ step: 'session.create.via-sheet', channel: 'A', exitCode: 0, stats: { sid } })
    await page
      .locator('[data-testid="mobile-message-stream"]', { hasText: 'MODEL-SEED-REPLY-3k7d' })
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 })
    await protocol.subscribe(sid)

    // ── 断言①：chip 打开 ModelSheet + 四段段控形态 ───────────────────────────
    const chip = page.locator('[data-testid="chat-model-chip"]')
    const chipBefore = (await chip.innerText()).trim()
    ev.assert('A: 初始 chip 显示默认模型（faux-1）', chipBefore.includes('faux-1'), {
      channel: 'A', expected: '含「faux-1」', actual: `"${chipBefore}"`,
    })
    await chip.click()
    await page.locator('[data-testid="model-sheet-models"]').waitFor({ state: 'visible', timeout: 10_000 })
    const modelIds = ['faux-1', 'faux-1-reasoning', 'faux-1-b', 'faux-1-c']
    const modelRows = []
    for (const id of modelIds) {
      modelRows.push({ id, visible: await page.locator(`[data-testid="model-sheet-model-${id}"]`).isVisible().catch(() => false) })
    }
    ev.assert('A: ModelSheet 模型清单在场（faux 四演员全部列出）', modelRows.every((m) => m.visible), {
      channel: 'A',
      expected: modelIds.join(' / '),
      actual: modelRows.map((m) => `${m.id}:${m.visible ? '在' : '缺'}`).join(' '),
    })
    await page.locator('[data-testid="model-sheet-thinking-segments"]').waitFor({ state: 'visible', timeout: 10_000 })
    const segmentLabels = []
    for (const seg of ['low', 'medium', 'high', 'max']) {
      const tab = page.locator(`[data-testid="segmented-option-${seg}"]`)
      segmentLabels.push({ seg, visible: await tab.isVisible().catch(() => false), text: (await tab.innerText().catch(() => '')).trim() })
    }
    ev.assert('A: 思考档四段段控在场（低/中/高/最高）', segmentLabels.every((s) => s.visible && s.text !== ''), {
      channel: 'A',
      expected: 'segmented-option-{low,medium,high,max} 四段可点',
      actual: segmentLabels.map((s) => `${s.seg}="${s.text}"${s.visible ? '' : '(缺)'}`).join(' '),
    })
    const unknownWord = (await page.locator('[data-testid="model-sheet-thinking-current"]').innerText()).trim()
    ev.assert('A: 无权威值时思考档当前词 = 未知占位（禁回退他值）', unknownWord === '未知', {
      channel: 'A', expected: '「未知」', actual: `"${unknownWord}"`,
    })
    await ev.shot(page, 'a8-model-sheet-initial')

    // ── 断言②：切模型 → chip 即时更新（回执写显示态） ─────────────────────────
    await page.locator('[data-testid="model-sheet-model-faux-1-b"]').click()
    await page
      .locator('[data-testid="chat-model-chip"]', { hasText: 'faux-1-b' })
      .waitFor({ state: 'visible', timeout: 15_000 })
    const chipAfterModel = (await chip.innerText()).trim()
    ev.assert('A: 切模型后 chip 即时更新为 faux-1-b（回执生效值）', chipAfterModel.includes('faux-1-b'), {
      channel: 'A', expected: 'chip 含「faux-1-b」', actual: `"${chipAfterModel}"`,
    })
    let stateChanged = null
    try {
      stateChanged = await protocol.waitFor(
        (e) => e.type === 'session.state_changed' && String(e.payload?.modelId ?? '').includes('faux-1-b'),
        { timeoutMs: 15_000, sessionId: sid },
      )
    } catch (e) {
      ev.attach('state-changed-miss', waitErr(e))
    }
    ev.assert('B: session.state_changed 广播携带新模型（B 通道同步面）', Boolean(stateChanged), {
      channel: 'B', expected: "modelId 含 faux-1-b", actual: stateChanged ? `modelId=${String(stateChanged.payload?.modelId)}` : '未等到',
    })
    await ev.shot(page, 'a8-after-model-switch')

    // ── 断言③：切思考档（段值 high）→ aria-selected 精确点亮 + chip 追加短词 ────
    await page.locator('[data-testid="segmented-option-high"]').click()
    await page
      .locator('[data-testid="model-sheet-thinking-current"]', { hasText: '高' })
      .waitFor({ state: 'visible', timeout: 15_000 })
    const chipAfterThinking = (await chip.innerText()).trim()
    ev.assert('A: 切思考档后 chip 追加档位短词（faux-1-b · 高）', chipAfterThinking.includes('faux-1-b') && chipAfterThinking.includes('高'), {
      channel: 'A', expected: '「faux-1-b」∧「高」', actual: `"${chipAfterThinking}"`,
    })
    const selected = {}
    for (const seg of ['low', 'medium', 'high', 'max']) {
      selected[seg] = (await page.locator(`[data-testid="segmented-option-${seg}"]`).getAttribute('aria-selected')) === 'true'
    }
    ev.assert('A: 四段段控 aria-selected 精确点亮（仅 high）', selected.high === true && selected.low === false && selected.medium === false && selected.max === false, {
      channel: 'A', expected: 'high=true 其余 false', actual: JSON.stringify(selected),
    })

    // ── 断言④：段外值（xhigh）映射形态——短词「超高」+ 四段全不点亮 + 提示行 ────
    let setReply = null
    try {
      setReply = await protocol.call('session.setThinkingLevel', { sessionId: sid, level: 'xhigh' }, { replyType: 'session.thinkingLevelSet', timeoutMs: 30_000 })
    } catch (e) {
      ev.attach('set-xhigh-error', waitErr(e))
    }
    ev.assert("B: protocol 侧 setThinkingLevel('xhigh') 回执生效值 = xhigh", setReply?.level === 'xhigh', {
      channel: 'B', expected: "level='xhigh'", actual: setReply ? `level=${String(setReply.level)}` : 'RPC 失败',
    })
    // 壳层消费广播后的呈现面：当前短词「超高」+ 四段全不点亮 + 段外提示行（条件轮询，等广播到达）
    const offWordSeen = await page
      .locator('[data-testid="model-sheet-thinking-current"]', { hasText: '超高' })
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    const currentWord = (await page.locator('[data-testid="model-sheet-thinking-current"]').innerText().catch(() => '')).trim()
    ev.assert('A: 段外值 xhigh 的当前短词呈现「超高」（七值短词表覆盖）', offWordSeen && currentWord === '超高', {
      channel: 'A', expected: '「超高」', actual: `seen=${offWordSeen} word="${currentWord}"`,
    })
    const selectedXhigh = {}
    for (const seg of ['low', 'medium', 'high', 'max']) {
      selectedXhigh[seg] = (await page.locator(`[data-testid="segmented-option-${seg}"]`).getAttribute('aria-selected')) === 'true'
    }
    ev.assert('A: 非段值不点亮段选中态（xhigh 下四段全 false）', Object.values(selectedXhigh).every((v) => v === false), {
      channel: 'A', expected: '全部 false', actual: JSON.stringify(selectedXhigh),
    })
    const offHintVisible = await page.locator('[data-testid="model-sheet-thinking-offsegment"]').isVisible().catch(() => false)
    ev.assert('A: 段外原值提示行在场（offsegment hint）', offHintVisible, {
      channel: 'A', expected: 'model-sheet-thinking-offsegment 可见', actual: `visible=${offHintVisible}`,
    })
    await ev.shot(page, 'a8-offsegment-xhigh')

    // 回到段值最高档（点选段位即下发段值；为段⑤的 chip 终态与回执对照收口）
    await page.locator('[data-testid="segmented-option-max"]').click()
    await page
      .locator('[data-testid="model-sheet-thinking-current"]', { hasText: '最高' })
      .waitFor({ state: 'visible', timeout: 15_000 })
    ev.step({ step: 'mobile.model.thinking-max', channel: 'A', exitCode: 0, stats: {} })

    // ── 断言⑤：关 Sheet → 发下一条 → 回执生效值与显示一致 ─────────────────────
    await page.locator('[data-testid="model-sheet-close"]').click()
    await page.locator('[data-testid="model-sheet-models"]').waitFor({ state: 'hidden', timeout: 10_000 })
    const chipFinal = (await chip.innerText()).trim()
    ev.assert('A: 关 Sheet 后 chip 终态 = faux-1-b · 最高', chipFinal.includes('faux-1-b') && chipFinal.includes('最高'), {
      channel: 'A', expected: '「faux-1-b」∧「最高」', actual: `"${chipFinal}"`,
    })

    const since2 = protocol.events.length
    await sendViaComposer(page, MSG2)
    let complete2 = null
    try {
      complete2 = await protocol.waitFor(
        (e) => e.type === 'message.complete' && e.payload?.willRetry === false && String(e.payload?.responseModel ?? '').length > 0,
        { timeoutMs: 120_000, since: since2, sessionId: sid },
      )
    } catch (e) {
      ev.attach('complete2-miss', waitErr(e))
    }
    const responseModel = String(complete2?.payload?.responseModel ?? '')
    ev.assert('B: 下一条回执 responseModel 与 chip 显示模型一致（faux-1-b）', responseModel.includes('faux-1-b'), {
      channel: 'B',
      expected: 'responseModel 含 faux-1-b',
      actual: complete2 ? `responseModel="${responseModel}"` : '未等到 message.complete',
    })
    const chipAfterSend = (await chip.innerText()).trim()
    ev.assert('A: 发送后 chip 保持 faux-1-b · 最高（显示不被回执打回）', chipAfterSend.includes('faux-1-b') && chipAfterSend.includes('最高'), {
      channel: 'A', expected: '「faux-1-b」∧「最高」', actual: `"${chipAfterSend}"`,
    })
    await ev.shot(page, 'a8-after-next-message')
    ev.step({
      step: 'mobile.model.receipt',
      channel: 'B',
      exitCode: responseModel.includes('faux-1-b') ? 0 : 1,
      stats: { responseModel, chip: chipAfterSend },
    })

    if (shell.pageErrors.length > 0) ev.attach('page-errors', shell.pageErrors.join('\n---\n'))
    log(`done sid=${sid} responseModel=${responseModel}`)
  } finally {
    if (shell) {
      if (shell.pageErrors.length > 0) ev.attach('page-errors-tail', shell.pageErrors.join('\n---\n'))
      await closeMobileShell(shell)
      ev.step({ step: 'mobile.browser.close', channel: 'C', exitCode: 0, stats: {} })
    }
    fs.rmSync(cwd, { recursive: true, force: true })
  }
  return { uncovered, gotchas }
}
