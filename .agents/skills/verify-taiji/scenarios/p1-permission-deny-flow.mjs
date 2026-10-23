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
    'A：等待期对话流工具块已入流运行中（tool_execution_start 先于审批等待——S1 撤案结论的行为锁定）',
    'A：等待期侧栏会话行 waiting 警示点（S4：permission 判定键 → deriveStatus waiting）',
    'A：审批广播帧携带 permission:true（S4 runtime 侧判定键）',
    'A：点 Deny（空理由）后浮层消失，展开回合 trace 失败工具块可见（含 [pi-permission] deny 原因；收起时机契约下回看形态 = 展开后可见）',
    'A：page.reload 重开重放、展开 trace 后失败块仍在（live ≡ reload）',
    'B：turn 收尾正常 + history 工具结果含 [pi-permission] deny 原因（isError tool_result）',
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

/**
 * 确保会话视图在位（对话流 TurnMeta 可点）：实测回合收尾后焦点会话可能被应用侧切回
 * landing（runDir deny-failed-block.png 现场）——用户回看路径就是重进会话行，此处同法
 * 恢复：turn-meta 在场直接返回；不在场点会话行后等其在场。
 */
async function ensureSessionView(ui) {
  const inView = await pollUntil(async () => {
    try {
      await ui.html('testid=turn-meta-1')
      return true
    } catch { return false }
  }, { timeoutMs: 4_000 })
  if (inView !== null) return true
  try {
    await ui.click('css=.session-item', { timeoutMs: 5_000 })
  } catch { return false }
  return (await pollUntil(async () => {
    try {
      await ui.html('testid=turn-meta-1')
      return true
    } catch { return false }
  }, { timeoutMs: 15_000 })) !== null
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

  // S1 行为锁定①：等待期工具块已入流（tool_execution_start 先于审批等待）且运行中。
  // 工具行渲染双形态：独立 Block（data-testid="block-tool-<id>"）或 run-group 组行
  // （"执行命令" 分组，RunGroupBlock data-testid="run-group"）——任一命中即工具已入流；
  // 运行态指示 = 呼吸弧动画类（Work turn 状态行 / 运行中块共用 animate-loader-spin）。
  await pollUntil(async () => {
    try {
      const html = await ui.html('css=body')
      return (html.includes('data-testid="block-tool-') || html.includes('data-testid="run-group"')) && html.includes('animate-loader-spin')
    } catch { return false }
  }, { timeoutMs: 20_000 })
  const waitHtml = await ui.html('css=body')
  const toolBlockLive = waitHtml.includes('data-testid="block-tool-') || waitHtml.includes('data-testid="run-group"')
  const runningIndicator = waitHtml.includes('animate-loader-spin')
  ev.assert('A: 等待期工具块已入流且运行中（工具行/组行 + 呼吸弧）', toolBlockLive && runningIndicator, {
    channel: 'A', expected: 'block-tool-*/run-group 可见 + 运行态指示',
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
  // CompanionBand select 形态 = radio 单选（companion-select-option-<value>）+ 確認提交
  // （companion-select-ok，选中前置 disabled）——两步：选 Deny → 点確認。
  await ui.click('testid=companion-select-option-Deny', { timeoutMs: 15_000 })
  await ui.click('testid=companion-select-ok', { timeoutMs: 15_000 })

  // Reject-with-Reason input 对话框（W6 T9 G3）：CompanionBand 换渲染 input 形态
  // （companion-input + companion-input-ok），空提交即 fallback 固定文案——出现则点確認跳过
  const reasonShown = await pollUntil(async () => {
    try {
      const html = await ui.html('css=body')
      return html.includes('Reason for denying')
    } catch { return false }
  }, { timeoutMs: 8_000 })
  if (reasonShown !== null) {
    try {
      await ui.click('testid=companion-input-ok', { timeoutMs: 8_000 })
      ev.step({ step: 'permission.reason-input', channel: 'A', exitCode: 0, stats: { skipped: 'empty-submit' } })
    } catch { /* input 框可能已自行关闭（fail-soft fallback） */ }
  }

  await ui.expectGone('testid=companion-band', { timeoutMs: 30_000 })
  ev.assert('A: Deny 后浮层消失', true, { channel: 'A', expected: 'companion-band 移除', actual: '已消失' })

  // S1 行为锁定②：失败工具块（含拒绝原因）。文本锚 = "[pi-permission] deny"（index.ts
  // tool_call handler 的 block reason 前缀；fallback 细节形态 = "denied via rpc"——approvalCtx.mode
  // 是 RPC 审批通道标识，非 permission 配置 mode）。
  // 时序：deny 的 tool_call_end 到达即实时渲染失败块（展开态），但 faux 第二响应紧随收尾回合
  // → trace 按收起时机契约折叠（U4 C4：会话结束不清展开分区、折叠态只显末位 text 正文）——
  // 回看形态 = 用户点 TurnMeta 展开 trace（design §3.1 交互6「回看就是全量」）。断言走展开后
  // 可见性（折叠瞬间窗口过窄，不作断言依据）。
  const end = await proto.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
  ev.assert('B: deny 后 turn 正常收尾', end.ok === true, {
    channel: 'B', expected: 'message.complete', actual: `${end.type} stop=${end.payload?.stopReason ?? ''}`,
  })

  // 诊断 attach：deny 相关广播帧全文（toolResult isError 文本形态取证）
  const denyFrames = proto.events.slice(since).filter((e) => {
    const t = JSON.stringify(e)
    return t.includes('[pi-permission]') || t.includes('"isError"')
  })
  ev.attach('deny-frames', JSON.stringify(denyFrames.slice(-6), null, 2).slice(0, 4000))

  // 展开本回合 trace（TurnMeta 按钮，工具 ×1 = hasFoldable）→ 失败块可见。
  // 工具行渲染为 run-group 组行（"执行命令"分组）时组行自身还有一层折叠——点开组头
  // （run-group-header）展开成员行，deny 文本在成员失败块的 output 里。
  const viewReady = await ensureSessionView(ui)
  if (!viewReady) ev.attach('view-restore-probe', '回合收尾后会话视图未恢复（landing 态，重进会话行未果）')
  await ui.click('testid=turn-meta-1', { timeoutMs: 15_000 })
  await pollUntil(async () => {
    try {
      await ui.click('testid=run-group-header', { timeoutMs: 2_000 })
      return true
    } catch {
      return false // 非 run-group 形态（独立工具行）→ 无组头可点
    }
  }, { timeoutMs: 4_000 })
  const denyShown = await pollUntil(async () => {
    try {
      const html = await ui.html('css=body')
      return html.includes('[pi-permission] deny')
    } catch { return false }
  }, { timeoutMs: 20_000 })
  ev.assert('A: 展开回合 trace 后失败工具块可见（含 [pi-permission] deny 原因）', denyShown === true, {
    channel: 'A', expected: '失败块展开显示拒绝原因（[pi-permission] deny: …）',
    actual: denyShown ? '命中' : '展开后 20s 未现',
  })
  if (denyShown !== true) {
    try {
      const html = await ui.html('css=body')
      const hit = html.match(/\[pi-permission\][^<"]{0,120}/)
      ev.attach('deny-dom-probe', hit ? hit[0] : `no [pi-permission] text in body (len=${html.length})`)
    } catch { /* ignore */ }
  }
  await ev.shot(await instance.page(), 'deny-failed-block')

  const hist = await proto.history(sid, { limitTurns: 10 })
  const histText = JSON.stringify(hist.messages ?? [])
  const histDenied = histText.includes('[pi-permission] deny')
  ev.assert('B: history 工具结果含 deny 原因（isError tool_result）', histDenied, {
    channel: 'B', expected: 'deny 原因进 agent 上下文（历史事实）', actual: `hit=${histDenied}`,
  })
  if (!histDenied) {
    ev.attach('history-probe', histText.slice(0, 3000))
  }

  // ── S1 行为锁定③：重开一致（page.reload → 重放 → 失败块仍在）──
  // 重放后 trace 同为折叠态（收起时机契约），同法展开回合 trace 后断言。
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
    await ui.click('testid=turn-meta-1', { timeoutMs: 20_000 })
    await pollUntil(async () => {
      try {
        await ui.click('testid=run-group-header', { timeoutMs: 2_000 })
        return true
      } catch {
        return false
      }
    }, { timeoutMs: 4_000 })
    const replayHit = await pollUntil(async () => {
      try {
        const html = await ui.html('css=body')
        return html.includes('[pi-permission] deny')
      } catch { return false }
    }, { timeoutMs: 20_000 })
    reloadHit = replayHit === true
  } catch (e) {
    ev.attach('reload-error', e instanceof Error ? e.message : String(e))
  }
  ev.assert('A: 重开（reload 重放）展开后失败块仍在同位置', reloadHit, {
    channel: 'A', expected: '重放对话流展开后含 [pi-permission] deny 失败块', actual: reloadHit ? '命中' : '重放未命中（现场见 reload-error）',
  })
  if (!reloadHit) uncovered.push('重开一致性断言未命中（reload 后会话激活或重放窗口问题）')
  await ev.shot(await instance.page(), 'after-reload')

  log(`done sid=${sid}`)
}
