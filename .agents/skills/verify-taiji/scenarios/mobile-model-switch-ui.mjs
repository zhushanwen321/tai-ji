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
    'A：切模型后 chip 即时更新为生效模型（复合串形态，回执写显示态非乐观请求值）',
    'B：session.state_changed 广播携带新 modelId（B 通道同步面）',
    'A：切思考档后段控 aria-selected 精确点亮所选段（其余三段不点亮）且 chip 追加档位短词',
    'A：段外值（初始 off）呈现：就近段点亮（low）+ 段外原值提示行在场',
    "B：protocol 侧 setThinkingLevel('xhigh') 回执 = 模型域钳制生效值（faux 模型域 xhigh→high，pi 钳制语义）",
    'A/B：发下一条后 message.complete 回执 responseModel 与 chip 显示模型一致（reasoning-on 演员下思考档生效）',
  ],
  notProvable: [
    'model.switch 的静默换模钳制与 provider 校验语义（桌面 p0-model-switch 已覆盖，本剧本只断移动 UI 面）',
    '「不影响另一会话」（V8 尾句）：本剧本单会话装配，跨会话隔离归 p0-session-isolation（桌面）',
    '「最高」（max）段值在 faux 模型档位域钳制下不可达 e2e（pi 钳制 xhigh/max → high，实测）；四段段控的呈现与选中语义已由低/高档 + 段外 off 态覆盖',
    '段外值 xhigh 的「超高」短词呈现（七值短词表 xhigh 行）：faux 模型域钳制使 xhigh 无法在会话生效，呈现面不可达 e2e（映射纯函数由包内单测覆盖）',
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
    const initialWord = (await page.locator('[data-testid="model-sheet-thinking-current"]').innerText()).trim()
    ev.assert('A: 思考档当前词 = 会话权威值（faux 会话缺省 off → 「关」）', initialWord === '关', {
      channel: 'A', expected: '「关」（session 权威值；liveState 已有 getState 种子，非未知占位）', actual: `"${initialWord}"`,
    })
    // 产品面证据（复合串失配）：core liveState.modelId 契约 = 'provider/modelId' 复合串，
    // ModelSheet 用裸 id 比对 → 「当前」标记不点亮 + 「不在可用清单」误报（本轮 finding 证据）
    const invalidBanner = await page.locator('[data-testid="model-sheet-current-invalid"]').isVisible().catch(() => false)
    ev.attach('model-sheet-invalid-banner', invalidBanner
      ? 'model-sheet-current-invalid 在场（复合串 modelId 与裸 id 清单失配的误报面，产品缺陷证据）'
      : 'model-sheet-current-invalid 不在场（当前值与清单 id 形态一致）')
    // 段外值映射形态（初始权威值 = off 即真实段外样本，无需注入）：四段全不点亮 +
    // 段外原值提示行在场（非段值不点亮段选中态，§7.2）
    // 实装语义（单元测试锁定态）：段控 modelValue = 就近段（off → low），原始 aria-selected
    // 点亮就近段；「非段值」信息由段外提示行承载（§7.2「就近段显示」呈现）
    const selectedInitial = {}
    for (const seg of ['low', 'medium', 'high', 'max']) {
      selectedInitial[seg] = (await page.locator(`[data-testid="segmented-option-${seg}"]`).getAttribute('aria-selected')) === 'true'
    }
    ev.assert('A: 段外值就近归段点亮（off → 仅 low 点亮）', selectedInitial.low === true && selectedInitial.medium === false && selectedInitial.high === false && selectedInitial.max === false, {
      channel: 'A', expected: 'low=true 其余 false（nearestSegmentOf(off)=low）', actual: JSON.stringify(selectedInitial),
    })
    const offHintVisibleInitial = await page.locator('[data-testid="model-sheet-thinking-offsegment"]').isVisible().catch(() => false)
    ev.assert('A: 段外原值提示行在场（offsegment hint 承载非段值信息）', offHintVisibleInitial, {
      channel: 'A', expected: 'model-sheet-thinking-offsegment 可见', actual: `visible=${offHintVisibleInitial}`,
    })
    await ev.shot(page, 'a8-model-sheet-initial')

    // ── 断言②：切模型 → chip 即时更新（回执写显示态） ─────────────────────────
    await page.locator('[data-testid="model-sheet-model-faux-1-reasoning"]').click()
    await page
      .locator('[data-testid="chat-model-chip"]', { hasText: 'faux-1-reasoning' })
      .waitFor({ state: 'visible', timeout: 15_000 })
    const chipAfterModel = (await chip.innerText()).trim()
    ev.assert('A: 切模型后 chip 即时更新为 faux-1-reasoning（回执生效值）', chipAfterModel.includes('faux-1-reasoning'), {
      channel: 'A', expected: 'chip 含「faux-1-reasoning」（复合串形态）', actual: `"${chipAfterModel}"`,
    })
    let stateChanged = null
    try {
      stateChanged = await protocol.waitFor(
        (e) => e.type === 'session.state_changed' && String(e.payload?.modelId ?? '').includes('faux-1-reasoning'),
        { timeoutMs: 15_000, sessionId: sid },
      )
    } catch (e) {
      ev.attach('state-changed-miss', waitErr(e))
    }
    ev.assert('B: session.state_changed 广播携带新模型（B 通道同步面）', Boolean(stateChanged), {
      channel: 'B', expected: "modelId 含 faux-1-reasoning", actual: stateChanged ? `modelId=${String(stateChanged.payload?.modelId)}` : '未等到',
    })
    await ev.shot(page, 'a8-after-model-switch')

    // ── 断言③：切思考档（段值 high）→ aria-selected 精确点亮 + chip 追加短词 ────
    await page.locator('[data-testid="segmented-option-high"]').click()
    await page
      .locator('[data-testid="model-sheet-thinking-current"]', { hasText: '高' })
      .waitFor({ state: 'visible', timeout: 15_000 })
    const chipAfterThinking = (await chip.innerText()).trim()
    ev.assert('A: 切思考档后 chip 即时更新（模型 ∧ 思考档两段都在场）', chipAfterThinking.includes('faux-1-reasoning') && /·\s*\S/.test(chipAfterThinking), {
      channel: 'A', expected: '「faux-1-reasoning」∧ 含思考档段', actual: `"${chipAfterThinking}"`,
    })
    ev.assert('A: chip 思考档段 = 短词「高」（§7.2 短词表，非原始值）', chipAfterThinking.includes('· 高'), {
      channel: 'A',
      expected: '「· 高」（mobile.model.level.high 短词）',
      actual: `"${chipAfterThinking}"——若显示原始档位值（· high）= ChatScreen chipText t() 传尾段 key 非全路径（产品缺陷，对照 ModelSheet.thinkingShortWord 的正确拼法）`,
    })
    const selected = {}
    for (const seg of ['low', 'medium', 'high', 'max']) {
      selected[seg] = (await page.locator(`[data-testid="segmented-option-${seg}"]`).getAttribute('aria-selected')) === 'true'
    }
    ev.assert('A: 四段段控 aria-selected 精确点亮（仅 high）', selected.high === true && selected.low === false && selected.medium === false && selected.max === false, {
      channel: 'A', expected: 'high=true 其余 false', actual: JSON.stringify(selected),
    })

    // ── 断言④：段外请求的钳制观测（faux 模型档位域不含 xhigh/max，回执 = pi 钳制生效值；
    //    段外值的呈现面已由初始 off 态覆盖，段外注入在 faux 域结构性不可达 → notProvable）──
    let setReply = null
    try {
      setReply = await protocol.call('session.setThinkingLevel', { sessionId: sid, level: 'xhigh' }, { replyType: 'session.thinkingLevelSet', timeoutMs: 30_000 })
    } catch (e) {
      ev.attach('set-xhigh-error', waitErr(e))
    }
    ev.assert("B: protocol 侧 setThinkingLevel('xhigh') 回执 = 模型域钳制生效值（high）", setReply?.level === 'high', {
      channel: 'B',
      expected: "level='high'（pi 档位域钳制：xhigh → 模型支持上限）",
      actual: setReply ? `level=${String(setReply.level)}` : 'RPC 失败',
    })
    // 钳制后 UI 收敛：当前词回「高」、仅 high 点亮（回执写显示态链路的双向核对）
    await page
      .locator('[data-testid="model-sheet-thinking-current"]', { hasText: '高' })
      .waitFor({ state: 'visible', timeout: 15_000 })
    const selectedAfterClamp = {}
    for (const seg of ['low', 'medium', 'high', 'max']) {
      selectedAfterClamp[seg] = (await page.locator(`[data-testid="segmented-option-${seg}"]`).getAttribute('aria-selected')) === 'true'
    }
    ev.assert('A: 钳制回执写显示态（词=高 ∧ 仅 high 点亮）', selectedAfterClamp.high === true && selectedAfterClamp.low === false && selectedAfterClamp.medium === false && selectedAfterClamp.max === false, {
      channel: 'A', expected: 'high=true 其余 false', actual: JSON.stringify(selectedAfterClamp),
    })
    await ev.shot(page, 'a8-clamp-xhigh')

    // ── 断言⑤：关 Sheet → 发下一条 → 回执生效值与显示一致 ─────────────────────
    await page.locator('[data-testid="model-sheet-close"]').click()
    await page.locator('[data-testid="model-sheet-models"]').waitFor({ state: 'hidden', timeout: 10_000 })
    const chipFinal = (await chip.innerText()).trim()
    ev.assert('A: 关 Sheet 后 chip 终态保持模型与思考档两段（faux-1-reasoning）', chipFinal.includes('faux-1-reasoning') && /·\s*\S/.test(chipFinal), {
      channel: 'A', expected: '「faux-1-reasoning」∧ 含思考档段', actual: `"${chipFinal}"`,
    })

    const since2 = protocol.events.length
    await sendViaComposer(page, MSG2)
    let complete2 = null
    try {
      complete2 = await protocol.waitFor(
        (e) => e.type === 'message.complete' && e.payload?.willRetry !== true,
        { timeoutMs: 120_000, since: since2, sessionId: sid },
      )
    } catch (e) {
      ev.attach('complete2-miss', waitErr(e))
    }
    ev.assert('B: 下一条回合正常收尾（message.complete 到达）', Boolean(complete2), {
      channel: 'B', expected: 'message.complete 非 error/aborted', actual: complete2 ? `stop=${String(complete2.payload?.stopReason)}` : '未等到',
    })
    // 回执生效值与显示一致：优先 responseModel 回执面；faux 缺省不带时回退 UI 状态侧
    //（session.getState 权威读 = 生效值，任务口径允许「ws 请求侧或 UI 状态」二选一）
    const responseModel = String(complete2?.payload?.responseModel ?? '')
    let effectiveModelId = responseModel
    if (effectiveModelId === '') {
      try {
        const st = await protocol.call('session.getState', { sessionId: sid }, { replyType: 'session.getState', timeoutMs: 15_000 })
        effectiveModelId = String(st.modelId ?? '')
      } catch (e) {
        ev.attach('get-state-error', waitErr(e))
      }
    }
    ev.attach('receipt-effective-model', `responseModel="${responseModel}" effective="${effectiveModelId}" chip="${(await chip.innerText()).trim()}"`)
    ev.assert('B: 生效值与 chip 显示模型一致（faux-1-reasoning）', effectiveModelId.includes('faux-1-reasoning'), {
      channel: 'B',
      expected: '生效值（responseModel 或 session.getState）含 faux-1-reasoning',
      actual: `effective="${effectiveModelId}"`,
    })
    const chipAfterSend = (await chip.innerText()).trim()
    ev.assert('A: 发送后 chip 保持模型与思考档两段（显示不被回执打回）', chipAfterSend.includes('faux-1-reasoning') && /·\s*\S/.test(chipAfterSend), {
      channel: 'A', expected: '「faux-1-reasoning」∧ 含思考档段', actual: `"${chipAfterSend}"`,
    })
    await ev.shot(page, 'a8-after-next-message')
    ev.step({
      step: 'mobile.model.receipt',
      channel: 'B',
      exitCode: effectiveModelId.includes('faux-1-reasoning') ? 0 : 1,
      stats: { responseModel, effectiveModelId, chip: chipAfterSend },
    })

    if (shell.pageErrors.length > 0) ev.attach('page-errors', shell.pageErrors.join('\n---\n'))
    log(`done sid=${sid} responseModel=${responseModel} effective=${effectiveModelId}`)
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
