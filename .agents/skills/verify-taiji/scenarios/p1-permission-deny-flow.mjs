/**
 * p1-permission-deny-flow —— 工具审批 Deny 分支行为锁定（chat-flow-consistency U9 / S1 撤案处置 + S4）。
 *
 * 背景（design-special-flows S1 核实结论）：pi 在权限等待点之前已 emit tool_execution_start，
 * 拒绝后工具块变失败块，live ≡ reload 本就成立——本剧本把该行为锁定为验收资产，
 * 防回归；同时锁定 S4 的 permission 判定键（runtime 对审批 select 广播附加 permission:true）。
 *
 * 装配：faux + permission-tool.json（bash echo 触发审批）+ 非 yolo 前置——run() 开头
 * （session.create 之前）写 `<dataDir>/agent/config/permission-ext-config.json`
 * `{"mode":"strict"}`（permission 扩展每次读时刷新配置，pi 进程按 session spawn，
 * 写入先于 session.create 即生效）。
 *
 * 路径：
 *   发送（step1 = bash toolUse）→ A：companion-band 审批浮层可见 →
 *   等待期断言（工具块已入流运行中 + 侧栏行 waiting 警示点 + 广播帧带 permission 键）→
 *   点 Deny →（Reject-with-Reason input 对话框，空提交跳过）→ 浮层消失 →
 *   A：实时失败工具块（含 denied via strict 原因）→ page.reload 重开 → 失败块仍在 →
 *   B：turn 收尾 + history 工具结果含 denied via strict。
 *
 * 锚点事实：pi-permission 审批 select 的 options = ["Approve (once)", "Deny"]
 * （extensions/universal/permission approval.ts）；选 Deny 后 ctx.ui.input 存在 →
 * 追加「Reason for denying」input 对话框（空提交 fallback 固定文案 "denied via strict"）；
 * 审批 UI = CompanionBand（packages/ui/src/extension-host/），选项无独立 testid
 * （Button 文本寻址 text=Deny）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const meta = {
  id: 'p1-permission-deny-flow',
  priority: 'P1',
  title: 'strict 模式下工具审批 Deny：等待期运行中工具块 + 侧栏 waiting + permission 键 → Deny → 失败块 → 重开一致',
  covers: ['env.launch', 'env.ready', 'env.isolation', 'session.create', 'chat.send', 'chat.wait', 'session.history', 'interaction.permission'],
  requires: ['faux'],
  estimateSec: 150,
  faux: {
    responses: JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, 'fixtures', 'faux-responses', 'permission-tool.json'), 'utf8')),
  },
  provable: [
    'strict 模式下 bash 工具触发审批：A：companion-band 浮层可见',
    'A：等待期对话流工具块已入流（tool_execution_start 先于审批等待——S1 撤案结论的行为锁定）',
    'A：等待期侧栏会话行 waiting 警示点（S4：permission 判定键 → deriveStatus waiting）',
    'A：审批广播帧携带 permission:true（S4 runtime 侧判定键）',
    'A：点 Deny（空理由）后浮层消失，实时对话流出现失败工具块（含 denied via strict 原因）',
    'A：page.reload 重开后失败块仍在同位置（live ≡ reload）',
    'B：turn 收尾正常 + history 工具结果含 denied via strict',
  ],
  notProvable: [
    'AI classifier 分支（auto 模式）——只验 strict 确定性分支',
    '插件权限审批（permission-dialog 家族）——另一子系统，仓内无 sandbox 夹具 = 不可达',
  ],
}

/** 条件轮询 helper（禁盲等；判定条件每轮重算）。 */
async function pollUntil(predicate, { timeoutMs, intervalMs = 1000 }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export async function run(ctx) {
  const { ev, log, repo } = ctx
  const uncovered = []
  const gotchas = [
    '与 p1-permission-approval 同款两未知（侧栏激活链 / companion-band 时延）——本剧本在 run() 开头（session.create 前）写 strict 配置，依赖 permission 扩展「每次读时刷新」配置的热读契约',
    '点 Deny 后还有一次「Reason for denying」input 对话框（Reject-with-Reason），空提交即 fallback 固定文案；剧本按出现与否双形态处理',
    '审批选项无独立 testid（Button 文本寻址）：Approve (once) / Deny',
  ]
  const ui = ctx.ui
  const instance = ctx.instance
  const proto = ctx.protocol
  const dataDir = ctx.dataDir

  // ── strict 前置：run() 开头写（先于 session.create → pi spawn 时配置已在）──
  const cfgDir = path.join(dataDir, 'agent', 'config')
  fs.mkdirSync(cfgDir, { recursive: true })
  fs.writeFileSync(path.join(cfgDir, 'permission-ext-config.json'), JSON.stringify({ mode: 'strict' }))
  ev.step({ step: 'permission.config', channel: 'C', exitCode: 0, stats: { mode: 'strict', at: 'before session.create' } })

  const created = await proto.call('session.create', { cwd: repo, label: 'p1-permission-deny' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  if (!sid) throw new Error('session.create 未返回 sessionId')
  await proto.subscribe(sid)
  ev.step({ step: 'session.create', channel: 'C', exitCode: 0, stats: { sid } })

  // renderer 挂载时序：CDP ready ≠ Vue app 消费完列表——条件轮询点击（侧栏激活链是
  // 覆盖矩阵 P1-3 登记的未知点，失败时抓 DOM 概要附证据后按 fail 上报，不静默跳过）
  let activated = false
  {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      try {
        await ui.click('css=.session-item', { timeoutMs: 3_000 })
        activated = true
        break
      } catch {
        await new Promise((r) => setTimeout(r, 2_000))
      }
    }
  }
  if (!activated) {
    try {
      await ev.shot(await instance.page(), 'sidebar-miss')
      const html = await ui.html('css=body')
      ev.attach('sidebar-miss-probe', JSON.stringify({
        len: html.length,
        hasSessionItem: html.includes('session-item'),
        hasLanding: html.includes('default-project'),
      }, null, 2))
    } catch { /* ignore */ }
  }
  ev.assert('A: 侧栏会话行激活（条件轮询 60s）', activated, {
    channel: 'A',
    expected: '侧栏出现会话行并点击',
    actual: activated ? '已激活' : '60s 未现（现场见 sidebar-miss）',
  })

  // ── 发送 → 审批浮层 ──
  const since = proto.events.length
  await proto.send(sid, '执行需要审批的命令')
  await ui.expectVisible('testid=companion-band', { timeoutMs: 60_000 })
  const bandText = await ui.text('testid=companion-band')
  ev.assert('A: 审批浮层（companion-band）可见', bandText.length > 0, {
    channel: 'A', expected: '浮层含标题/消息区', actual: `len=${bandText.length}`,
  })
  await ev.shot(await instance.page(), 'companion-band-open')

  // S4 runtime 侧：审批 select 广播帧带 permission 键（title 首行 [pi-permission] Approval required）
  const framesText = JSON.stringify(proto.events.slice(since))
  const hasPermissionKey = framesText.includes('"permission":true')
  ev.assert('A: 审批广播帧携带 permission:true（U9/S4 判定键）', hasPermissionKey, {
    channel: 'A', expected: 'extension.ui_request payload 含 permission:true',
    actual: `hit=${hasPermissionKey}`,
  })

  // S1 行为锁定①：等待期工具块已入流（tool_execution_start 先于审批等待）且运行中
  await pollUntil(async () => {
    try {
      const html = await ui.html('css=body')
      return html.includes('tool-block-header') && html.includes('animate-loader-spin')
    } catch { return false }
  }, { timeoutMs: 20_000 })
  const waitHtml = await ui.html('css=body')
  const toolBlockLive = waitHtml.includes('tool-block-header')
  const runningIndicator = waitHtml.includes('animate-loader-spin')
  ev.assert('A: 等待期工具块已入流且运行中（呼吸弧在）', toolBlockLive && runningIndicator, {
    channel: 'A', expected: 'tool-block-header 可见 + 运行态指示',
    actual: `toolBlock=${toolBlockLive} running=${runningIndicator}`,
  })

  // S4 renderer 侧：等待期侧栏行 waiting 警示点（session-icon bg-warn 档）
  const sidebarWaiting = await pollUntil(async () => {
    try {
      const html = await ui.html('css=.session-item')
      return html.includes('bg-warn')
    } catch { return false }
  }, { timeoutMs: 15_000 })
  ev.assert('A: 等待期侧栏会话行 waiting 警示点（U9/S4）', sidebarWaiting !== null, {
    channel: 'A', expected: 'session-icon 处 warn 实心圆（waiting 档）',
    actual: sidebarWaiting !== null ? 'bg-warn 命中' : '侧栏行不可见或无 waiting 点',
  })
  if (sidebarWaiting === null) uncovered.push('侧栏 waiting 警示点断言未命中（侧栏激活链未知点或判定链未生效），现场见截图')

  await ev.shot(await instance.page(), 'waiting-state')

  // ── Deny 分支 ──
  await ui.click('text=Deny', { timeoutMs: 15_000 })

  // Reject-with-Reason input 对话框（Reject-with-Reason W6 T9 G3）：出现则空提交跳过
  const reasonHandled = await pollUntil(async () => {
    try {
      const html = await ui.html('css=body')
      if (!html.includes('Reason for denying')) return true // 未出现（双形态之一）→ 已处理
      // 出现：找 CompanionBand 输入区回车空提交
      const bandHtml = await ui.html('testid=companion-band')
      return bandHtml.includes('<input') || bandHtml.includes('textarea') || bandHtml.includes('contenteditable')
    } catch { return false }
  }, { timeoutMs: 10_000 })
  if (reasonHandled !== null) {
    try {
      const bandInput = await ui.html('testid=companion-band')
      if (bandInput.includes('Reason for denying')) {
        await ui.press('Enter', { timeoutMs: 5_000 })
        ev.step({ step: 'permission.reason-input', channel: 'A', exitCode: 0, stats: { skipped: 'empty-submit' } })
      }
    } catch { /* input 框可能已自行关闭（fail-soft fallback） */ }
  }

  await ui.expectGone('testid=companion-band', { timeoutMs: 30_000 })
  ev.assert('A: Deny 后浮层消失', true, { channel: 'A', expected: 'companion-band 移除', actual: '已消失' })

  // S1 行为锁定②：实时失败工具块（含拒绝原因）出现在对话流
  const denyShown = await pollUntil(async () => {
    try {
      const html = await ui.html('css=body')
      return html.includes('denied via strict')
    } catch { return false }
  }, { timeoutMs: 30_000 })
  ev.assert('A: 实时对话流出现失败工具块（含 denied via strict 原因）', denyBlocked(denyShown), {
    channel: 'A', expected: '失败块展开显示拒绝原因', actual: denyShown ? 'denied via strict 命中' : '30s 未现',
  })
  await ev.shot(await instance.page(), 'deny-failed-block')

  // ── B：turn 收尾 + history ──
  const end = await proto.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
  ev.assert('B: deny 后 turn 正常收尾', end.ok === true, {
    channel: 'B', expected: 'message.complete', actual: `${end.type} stop=${end.payload?.stopReason ?? ''}`,
  })

  const hist = await proto.history(sid, { limitTurns: 10 })
  const histText = JSON.stringify(hist.messages ?? [])
  const histDenied = histText.includes('denied via strict')
  ev.assert('B: history 工具结果含 denied via strict（isError tool_result）', histDenied, {
    channel: 'B', expected: 'deny 原因进 agent 上下文（历史事实）', actual: `hit=${histDenied}`,
  })

  // ── S1 行为锁定③：重开一致（page.reload → 重放 → 失败块仍在）──
  let reloadHit = false
  try {
    const page = await instance.page()
    await page.reload({ waitUntil: 'domcontentloaded' })
    // 重开后 renderer 重新水合：条件轮询回会话行激活 → 对话流重放
    await pollUntil(async () => {
      try {
        await ui.click('css=.session-item', { timeoutMs: 3_000 })
        return true
      } catch { return false }
    }, { timeoutMs: 30_000 })
    const replayHit = await pollUntil(async () => {
      try {
        const html = await ui.html('css=body')
        return html.includes('denied via strict')
      } catch { return false }
    }, { timeoutMs: 30_000 })
    reloadHit = replayHit !== null
  } catch (e) {
    ev.attach('reload-error', e instanceof Error ? e.message : String(e))
  }
  ev.assert('A: 重开（reload 重放）后失败块仍在同位置', reloadHit, {
    channel: 'A', expected: '重放对话流含 denied via strict 失败块', actual: reloadHit ? '命中' : '重放未命中（现场见 reload-error）',
  })
  if (!reloadHit) uncovered.push('重开一致性断言未命中（reload 后会话激活或重放窗口问题）')
  await ev.shot(await instance.page(), 'after-reload')

  log(`done sid=${sid}`)
}

function denyBlocked(v) { return v === true }
