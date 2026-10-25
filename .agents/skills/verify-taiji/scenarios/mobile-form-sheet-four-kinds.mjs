/**
 * mobile-form-sheet-four-kinds —— 待回答体系：ask_user 表单（单选必答 + 多选）+ dialog
 * 四型的移动 FormSheet 承接（remote-use-mobile-v2 §8.2 场景 V6 的剧本化；A6 验收单元）。
 *
 * 真实用户路径（V6）：agent 发 ask_user 表单（§6.5 form 通道 → FormRequestSection 节）→
 * 底部待回答条 + FormSheet 呈现、未答完提交禁用、提交回传后回合继续 + 流内「已提交回答」；
 * 另发 dialog 型请求实断言两型——pi-permission strict 审批 select（desktop p1-permission-deny-flow
 * 同款装配先例）与 Reject-with-Reason input；confirm/editor 两型无 faux 可达触发源，以
 * 词表/形态断言覆盖（dialog-methods.ts 词表全集 + FormSheet 模板分支在场）。
 * 表单取消路径回传 result:null 以协议层取证（extension.getPendingRequests 前后对照）。
 *
 * 触发链（源码核对 2026-10-26）：ask_user 工具 → runtime event-adapter 翻 form:true 帧 →
 * form 通道；strict 模式下 tool_call hook 对所有工具生效（含 ask_user/bash）→ 审批 select
 * dialog（pi 源 method=select）→ FormSheet dialog 节；Deny 后 Reject-with-Reason input dialog
 * （method=input）。移动壳 dialog 通道 C4 门排除 form 类帧，两通道零重叠。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  backToList,
  closeShell,
  openConnectedShell,
  openSessionByRow,
  pollFor,
} from './lib/mobile-drive.mjs'

const RESPONSES = [
  {
    toolCalls: [{
      name: 'ask_user',
      args: {
        questions: [
          { header: 'DB', question: '选哪个数据库？', options: [{ label: 'SQLite', description: '零运维' }, { label: 'Postgres', description: '强一致' }] },
          { header: '观测', question: '启用哪些观测特性？（多选）', multiSelect: true, options: [{ label: '日志' }, { label: '指标' }, { label: '追踪' }] },
        ],
      },
    }],
    stopReason: 'toolUse',
  },
  { text: '表单已收到，按你的选择继续（FORM-DONE）。', stopReason: 'stop' },
  {
    toolCalls: [{ name: 'bash', args: { command: 'echo a6-dialog-flow' } }],
    stopReason: 'toolUse',
  },
  { text: '拒绝流程结束（DENY-DONE）。', stopReason: 'stop' },
  {
    toolCalls: [{
      name: 'ask_user',
      args: {
        questions: [
          { header: '确认', question: '还需要继续吗？', options: [{ label: '继续' }, { label: '结束' }] },
        ],
      },
    }],
    stopReason: 'toolUse',
  },
  { text: '取消路径结束（CANCEL-DONE）。', stopReason: 'stop' },
]

/**Reject-with-Reason 输入内容（B 通道取证锚：deny 理由进工具结果）。 */
const DENY_REASON = 'A6 移动端明确拒绝'

export const meta = {
  id: 'mobile-form-sheet-four-kinds',
  priority: 'P0',
  title: '待回答条 + FormSheet：ask_user 单选/多选作答回传 + dialog select/input 实断言 + confirm/editor 词表形态 + 取消回传 null（§8.2 V6）',
  covers: ['mobile.form.sheet', 'interaction.askuser'],
  requires: ['faux', 'remote-access', 'mobile-dist'],
  estimateSec: 300,
  remoteAccess: {},
  faux: { responses: RESPONSES },
  provable: [
    'A：ask_user 触发后底部待回答条（chat-ask-bar）+ FormSheet 呈现（sheet-content + form-sheet-form-section 双题堆叠单列）',
    'A：未答完提交禁用（form-sheet-form-submit disabled），两题答完（单选 + 多选各选一）后可点',
    'A：提交后 Sheet 关闭 + 流内「已提交回答」通知（§6.20）；B：回合以 FORM-DONE 收尾、history 含两题答案（Postgres + 多选标签）',
    'A：strict 审批 select dialog 在 FormSheet dialog 节呈现（两选项单选、未选禁用确认键）；选 Deny → 确认回传',
    'A：Reject-with-Reason input dialog 呈现（form-sheet-dialog-input），填理由提交；B：history 工具结果含该理由（deny 理由回传事实源）',
    'B：表单取消路径——form-sheet-form-cancel 后 extension.getPendingRequests 由有到空（result:null 终结请求的协议层取证）+ 回合继续收尾',
    'C：confirm/editor 型词表/形态覆盖——dialog-methods.ts DIALOG_METHODS 覆盖 ExtensionInteractMethod 全集（编译锁在场）+ FormSheet.vue 模板 confirm 双键/editor 多行预填等宽分支在场',
  ],
  notProvable: [
    'confirm/editor dialog 的运行时闭环——两型由 pi 扩展 ctx.ui.confirm/editor 触发，faux 响应脚本无此触发源（仓内触发先例仅 permission 家族 select/input）；以词表与模板分支断言替代',
    'planReview 审批节（V6 范围外，A6 只断言 form+dialog 通道）',
    'schedule 题型（桌面 scheduler 域，无 faux 触发源）',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, repo } = ctx
  const uncovered = []
  const gotchas = [
    'strict 权限模式让 tool_call hook 对所有工具生效——ask_user 触发前会先弹一次审批 select，剧本把它当作 dialog select 型的实断言载体（桌面 p1-permission-deny-flow 同款装配）',
    'form-sheet-dialog-option-<value> 的 value 是选项字符串原文（含空格与括号，如「Approve (once)」）——选择器内嵌空格合法',
    '审批 select 的确认键未选禁用是 dialog select 型的门（CompanionBand 同语义），与表单 allAnswered 门是两条独立判定',
  ]

  // ── strict 前置：run() 开头写（先于 session.create → pi spawn 时配置已在；permission
  // 扩展每次读时刷新配置的热读契约，p1-permission-deny-flow 先例）──
  const cfgDir = path.join(ctx.dataDir, 'agent', 'config')
  fs.mkdirSync(cfgDir, { recursive: true })
  fs.writeFileSync(path.join(cfgDir, 'permission-ext-config.json'), JSON.stringify({ mode: 'strict' }))
  ev.step({ step: 'permission.config', channel: 'C', exitCode: 0, stats: { mode: 'strict', at: 'before session.create' } })

  const created = await protocol.call('session.create', { cwd: repo, label: 'A6-表单与对话型' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  if (!sid) throw new Error('session.create 未返回 sessionId')
  await protocol.subscribe(sid)
  ev.step({ step: 'session.create', channel: 'C', exitCode: 0, stats: { sid } })

  const opened = await openConnectedShell(ctx)
  const shell = opened.shell
  try {
    ev.assert('A: 移动壳已连接并落会话列表', opened.ok, {
      channel: 'A', expected: 'screen-sessions 可见', actual: `锚点=${opened.anchor}`,
    })
    if (!opened.ok) {
      uncovered.push('后续断言未驱动：壳未落到会话列表')
      return { uncovered, gotchas }
    }
    const entered = await enterSession(shell, sid)
    ev.assert('A: 点入会话落聊天页（表单/对话按活跃分区路由的前提）', entered, {
      channel: 'A', expected: 'chat-screen 可见', actual: entered ? '在' : '30s 未现',
    })
    if (!entered) {
      uncovered.push('后续断言未驱动：会话未切入聊天页')
      return { uncovered, gotchas }
    }

    // ── 段 1：ask_user 两题表单（途经 strict 审批 select = dialog select 型实断言）──
    let since = protocol.events.length
    await protocol.send(sid, '先问两个问题再继续')
    const dialogShown = await pollVisible(shell, 'form-sheet-dialog', { timeoutMs: 60_000 })
    ev.assert('A: strict 审批 select dialog 在 FormSheet dialog 节呈现（pi 源 method=select）', dialogShown, {
      channel: 'A', expected: 'form-sheet-dialog 可见', actual: dialogShown ? '可见' : '60s 未现（strict 配置未生效或 dialog 通道断）',
    })
    await ev.shot(shell.page, 'a6-dialog-select-open')
    const askBar1 = await pollVisible(shell, 'chat-ask-bar', { timeoutMs: 10_000 })
    ev.assert('A: dialog 挂起期间底部待回答条在场（askPending 三源含 dialog）', askBar1, {
      channel: 'A', expected: 'chat-ask-bar 可见', actual: askBar1 ? '可见' : '未现',
    })

    // select 型门：未选禁用确认键 → 选「Approve (once)」→ 确认（pi 源回传走 dialog queue respond）
    const okDisabledBefore = await isButtonDisabled(shell, 'form-sheet-dialog-ok')
    await clickTestid(shell, 'form-sheet-dialog-option-Approve (once)')
    const okEnabledAfter = !(await isButtonDisabled(shell, 'form-sheet-dialog-ok'))
    ev.assert('A: select 型未选禁用确认键、选中后可点（CompanionBand 同语义）', okDisabledBefore === true && okEnabledAfter === true, {
      channel: 'A', expected: '选前 disabled ∧ 选后 enabled', actual: `选前=${String(okDisabledBefore)} 选后=${String(okEnabledAfter)}`,
    })
    await clickTestid(shell, 'form-sheet-dialog-ok')

    // 表单节呈现 + 提交门（未答完禁用）
    const formShown = await pollVisible(shell, 'form-sheet-form-section', { timeoutMs: 60_000 })
    ev.assert('A: 审批放行后 ask_user 表单在 FormSheet form 节呈现（C4 通道分流）', formShown, {
      channel: 'A', expected: 'form-sheet-form-section 可见', actual: formShown ? '可见' : '60s 未现',
    })
    const q0 = await pollVisible(shell, 'form-sheet-question-0', { timeoutMs: 10_000 })
    const q1 = await pollVisible(shell, 'form-sheet-question-1', { timeoutMs: 10_000 })
    ev.assert('A: 两题堆叠单列呈现（form-sheet-question-0/1）', q0 && q1, {
      channel: 'A', expected: '双题节均在', actual: `q0=${q0} q1=${q1}`,
    })
    const submitDisabledBefore = await isButtonDisabled(shell, 'form-sheet-form-submit')
    ev.assert('A: 未答完提交禁用（allAnswered 门）', submitDisabledBefore === true, {
      channel: 'A', expected: 'form-sheet-form-submit disabled', actual: `disabled=${String(submitDisabledBefore)}`,
    })
    await ev.shot(shell.page, 'a6-form-pending')

    // 答 Q1（单选 Postgres）+ Q2（多选：指标 + 追踪）→ 提交可点 → 提交
    await clickTestid(shell, 'form-sheet-option-Postgres')
    await clickTestid(shell, 'form-sheet-option-指标')
    await clickTestid(shell, 'form-sheet-option-追踪')
    const submitEnabled = await pollFor(async () => !(await isButtonDisabled(shell, 'form-sheet-form-submit')), { timeoutMs: 10_000 })
    ev.assert('A: 两题答完提交可点', submitEnabled === true, {
      channel: 'A', expected: 'form-sheet-form-submit enabled', actual: submitEnabled ? 'enabled' : '10s 后仍禁用',
    })
    await clickTestid(shell, 'form-sheet-form-submit')
    const sheetGone1 = await pollFor(async () => !(await isVisible(shell, 'form-sheet-form-section')), { timeoutMs: 15_000 })
    ev.assert('A: 提交后 FormSheet form 节关闭', sheetGone1 === true, {
      channel: 'A', expected: 'form-sheet-form-section 移除', actual: sheetGone1 ? '已关' : '仍在',
    })
    const submittedNotice = await pollTextIn(shell, 'mobile-message-stream', '已提交回答', { timeoutMs: 15_000 })
    ev.assert('A: 流内插入「已提交回答」动作通知（§6.20）', submittedNotice, {
      channel: 'A', expected: '流内含「已提交回答」', actual: submittedNotice ? '在' : '15s 未现',
    })
    const end1 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    ev.assert('B: 表单提交后回合以 FORM-DONE 收尾', end1.type === 'message.complete', {
      channel: 'B', expected: 'message.complete', actual: `${end1.type} stop=${end1.payload?.stopReason ?? ''}`,
    })
    const hist1 = await protocol.history(sid, { limitTurns: 10 })
    const hist1Text = JSON.stringify(hist1.messages ?? [])
    ev.assert('B: history 含两题答案（Postgres + 多选 标签 回灌事实源）', hist1Text.includes('Postgres') && hist1Text.includes('指标'), {
      channel: 'B', expected: 'answers 回灌含单选与多选', actual: `postgres=${hist1Text.includes('Postgres')} multi=${hist1Text.includes('指标')}`,
    })
    await ev.shot(shell.page, 'a6-form-submitted')

    // ── 段 2：bash 触发审批 select → Deny → Reject-with-Reason input（dialog input 型实断言）──
    since = protocol.events.length
    await protocol.send(sid, '执行一条需要审批的命令')
    const dialog2 = await pollVisible(shell, 'form-sheet-dialog', { timeoutMs: 60_000 })
    ev.assert('A: 第二次审批 select dialog 呈现', dialog2, {
      channel: 'A', expected: 'form-sheet-dialog 可见', actual: dialog2 ? '可见' : '60s 未现',
    })
    if (!dialog2) {
      uncovered.push('dialog input 型与取消路径断言未驱动：第二次审批弹窗未出现')
      return { uncovered, gotchas }
    }
    await clickTestid(shell, 'form-sheet-dialog-option-Deny')
    await clickTestid(shell, 'form-sheet-dialog-ok')
    const inputShown = await pollVisible(shell, 'form-sheet-dialog-input', { timeoutMs: 20_000 })
    ev.assert('A: Deny 后 Reject-with-Reason input dialog 呈现（dialog input 型实断言）', inputShown, {
      channel: 'A', expected: 'form-sheet-dialog-input 可见', actual: inputShown ? '可见' : '20s 未现',
    })
    if (inputShown) {
      // ui Input 是裸 <input>（attrs 透传，testid 即 input 本身），直接 fill
      await shell.page.locator('[data-testid="form-sheet-dialog-input"]').first().fill(DENY_REASON)
      await clickTestid(shell, 'form-sheet-dialog-ok')
    }
    const end2 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    ev.assert('B: Deny 流程后回合收尾（DENY-DONE）', end2.type === 'message.complete', {
      channel: 'B', expected: 'message.complete', actual: `${end2.type} stop=${end2.payload?.stopReason ?? ''}`,
    })
    const hist2 = await protocol.history(sid, { limitTurns: 10 })
    const hist2Text = JSON.stringify(hist2.messages ?? [])
    ev.assert('B: history 工具结果含 deny 理由（input dialog 回传事实源）', hist2Text.includes(DENY_REASON), {
      channel: 'B', expected: `工具结果含「${DENY_REASON}」`, actual: hist2Text.includes(DENY_REASON) ? '命中' : '未命中（见 deny-frames 附件）',
    })
    const denyFrames = protocol.events.slice(since).filter((e) => JSON.stringify(e).includes('pi-permission') || JSON.stringify(e).includes('isError'))
    ev.attach('a6-deny-frames', JSON.stringify(denyFrames.slice(-6), null, 2).slice(0, 4000))
    await ev.shot(shell.page, 'a6-deny-reason')

    // ── 段 3：表单取消路径（回传 result:null 的协议层取证）──
    // strict 模式下 ask_user 工具调用同样先过审批 select（tool_call hook 全工具生效），
    // 先答审批表单才会出现（首跑实测：漏答审批 → 表单 60s 不现、回合挂起）
    since = protocol.events.length
    await protocol.send(sid, '最后再确认一次')
    const approval3 = await pollVisible(shell, 'form-sheet-dialog', { timeoutMs: 60_000 })
    if (approval3) {
      await clickTestid(shell, 'form-sheet-dialog-option-Approve (once)')
      await clickTestid(shell, 'form-sheet-dialog-ok')
    }
    const form3 = await pollVisible(shell, 'form-sheet-form-section', { timeoutMs: 60_000 })
    ev.assert('A: 第三次 ask_user 表单呈现（取消路径载体）', form3, {
      channel: 'A', expected: 'form-sheet-form-section 可见', actual: form3 ? '可见' : '60s 未现',
    })
    let cancelOk = false
    if (form3) {
      const pendingBefore = await protocol.call('extension.getPendingRequests', { sessionId: sid }, { timeoutMs: 30_000 })
      const countBefore = countPending(pendingBefore)
      await clickTestid(shell, 'form-sheet-form-cancel')
      const sheetGone3 = await pollFor(async () => !(await isVisible(shell, 'form-sheet-form-section')), { timeoutMs: 15_000 })
      // 挂起表清零条件轮询（回传 result:null → runtime 摘除条目）
      const cleared = await pollFor(async () => {
        const reply = await protocol.call('extension.getPendingRequests', { sessionId: sid }, { timeoutMs: 30_000 }).catch(() => null)
        return reply !== null && countPending(reply) === 0
      }, { timeoutMs: 15_000 })
      const pendingAfter = await protocol.call('extension.getPendingRequests', { sessionId: sid }, { timeoutMs: 30_000 })
      const countAfter = countPending(pendingAfter)
      cancelOk = sheetGone3 && countBefore > 0 && countAfter === 0
      ev.assert('B: 表单取消路径协议层取证——挂起请求由有到空（cancel → respond(requestId, null) 终结）', cancelOk, {
        channel: 'B', expected: 'getPendingRequests 前后 >0 → 0', actual: `before=${countBefore} after=${countAfter} sheetGone=${sheetGone3} cleared=${cleared}`,
      })
      ev.attach('a6-cancel-pending', JSON.stringify({ before: pendingBefore, after: pendingAfter }, null, 2).slice(0, 3000))
    }
    const end3 = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    ev.assert('B: 取消后回合继续收尾（CANCEL-DONE，工具结果为取消非挂死）', end3.type === 'message.complete', {
      channel: 'B', expected: 'message.complete', actual: `${end3.type} stop=${end3.payload?.stopReason ?? ''}`,
    })

    // ── confirm/editor 词表/形态覆盖（C 通道静态断言；运行时闭环登记 notProvable）──
    const wordlistOk = assertWordlistCoverage(repo, ev)
    ev.assert('C: dialog 四型放行词表覆盖 ExtensionInteractMethod 全集（confirm/select/input/editor + 反向编译锁在场）', wordlistOk, {
      channel: 'C',
      expected: 'dialog-methods.ts：DIALOG_METHODS 四型 satisfies 词表 + DIALOG_METHODS_COVERAGE_LOCK 反向穷举锁',
      actual: wordlistOk ? '词表与编译锁均在场' : '词表或编译锁缺失（见 a6-wordlist-probe 附件）',
    })
    const formSheetSrc = readRepoFile(repo, 'packages/mobile-renderer/src/features/FormSheet.vue')
    const confirmShape = formSheetSrc.includes("dialog.method === 'confirm'") && formSheetSrc.includes('form-sheet-dialog-cancel') && formSheetSrc.includes('form-sheet-dialog-ok')
    const editorShape = formSheetSrc.includes('form-sheet-dialog-editor') && formSheetSrc.includes('font-mono') && formSheetSrc.includes('prefill')
    ev.assert('C: FormSheet 模板 confirm/editor 形态分支在场（confirm 二选一双键 / editor 多行+预填+等宽）', confirmShape && editorShape, {
      channel: 'C', expected: 'confirm 分支（cancel+ok）∧ editor 分支（Textarea+font-mono+prefill）', actual: `confirm=${confirmShape} editor=${editorShape}`,
    })
  } finally {
    if (shell.pageErrors.length > 0) ev.attach('a6-page-errors', shell.pageErrors.join('\n---\n'))
    await closeShell(shell)
    ev.step({ step: 'mobile.browser.close', channel: 'C', exitCode: 0, stats: {} })
  }

  log(`done sid=${sid}`)
  return { uncovered, gotchas }
}

// ── 局部小工具（mobile-drive 未覆盖的 FormSheet 交互读侧）────────────────────

async function enterSession(shell, sid, timeoutMs = 30_000) {
  const rowReady = await pollFor(async () => (await shell.page.locator(`[data-testid="session-row-${sid}"]`).count()) > 0, { timeoutMs })
  if (!rowReady) return false
  return openSessionByRow(shell.page, sid)
}

async function pollVisible(shell, testid, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const visible = await shell.page
      .locator(`[data-testid="${testid}"]`)
      .first()
      .isVisible()
      .catch(() => false)
    if (visible) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function isVisible(shell, testid) {
  return shell.page
    .locator(`[data-testid="${testid}"]`)
    .first()
    .isVisible()
    .catch(() => false)
}

async function clickTestid(shell, testid, { timeoutMs = 15_000 } = {}) {
  await shell.page.locator(`[data-testid="${testid}"]`).first().click({ timeout: timeoutMs })
}

/** 按钮 disabled 事实读侧（ui Button 渲染原生 button；disabled 属性与 property 同步）。 */
async function isButtonDisabled(shell, testid) {
  return shell.page
    .locator(`[data-testid="${testid}"]`)
    .first()
    .evaluate((el) => {
      const btn = el.matches('button') ? el : el.querySelector('button')
      return btn ? btn.disabled : null
    })
    .catch(() => null)
}

async function pollTextIn(shell, testid, needle, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const text = await shell.page
      .locator(`[data-testid="${testid}"]`)
      .innerText()
      .catch(() => '')
    if (text.includes(needle)) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 300))
  }
}

function countPending(reply) {
  const requests = reply?.requests ?? reply?.pending ?? []
  return Array.isArray(requests) ? requests.length : 0
}

function readRepoFile(repo, rel) {
  try {
    return fs.readFileSync(path.join(repo, rel), 'utf8')
  } catch {
    return ''
  }
}

/** C 通道词表断言本体（返回布尔 + 附件内容由 ev.attach 落盘）。 */
function assertWordlistCoverage(repo, ev) {
  const src = readRepoFile(repo, 'packages/mobile-renderer/src/features/dialog-methods.ts')
  const hasFour = ['confirm', 'select', 'input', 'editor'].every((m) => src.includes(`'${m}'`))
  const hasLock = src.includes('DIALOG_METHODS_COVERAGE_LOCK') && src.includes('Exclude<ExtensionInteractMethod')
  ev.attach('a6-wordlist-probe', `dialog-methods.ts len=${src.length} four=${hasFour} lock=${hasLock}`)
  return hasFour && hasLock
}
