/**
 * p1-permission-approval —— 工具审批闭环（CompanionBand，覆盖矩阵 P1-3）。
 *
 * 装配：faux + permission-tool.json（bash echo 触发审批）。**前置 = 非 yolo 模式**：
 * launch 前（seed 之后）写 `<dataDir>/agent/config/permission-ext-config.json`
 * `{"mode":"strict"}`——dataDir 显式传入以控制写入时机。
 * 路径：
 *   发送（step1 = bash toolUse）→ A：companion-band 审批浮层可见 → 点 Approve 选项 →
 *   工具真执行（B：工具结果含 permission-approval-ok 入 history）→ step2 收尾 →
 *   A：浮层消失。deny 分支不验（见 notProvable）。
 *
 * 锚点事实：pi-permission 的审批 UI = CompanionBand（packages/ui/src/extension-host/），
 * 选项无独立 testid（Button 文本寻址 text=Approve）；permission-dialog 家族属插件权限
 * 体系（另一子系统，仓内无 sandbox 夹具 = 不可达，不要混用）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const meta = {
  id: 'p1-permission-approval',
  priority: 'P1',
  title: 'strict 模式下 bash 工具审批：CompanionBand 浮层 → Approve → 工具真执行 → 收尾',
  covers: ['env.launch', 'env.ready', 'env.isolation', 'session.create', 'chat.send', 'chat.wait', 'session.history', 'interaction.permission'],
  requires: ['faux'],
  parallelGroup: 'chat',
  estimateSec: 120,
  faux: {
    responses: JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, 'fixtures', 'faux-responses', 'permission-tool.json'), 'utf8')),
  },
  provable: [
    'strict 模式下 bash 工具触发审批：A：companion-band 浮层可见（含标题/消息区）',
    'A：点击 Approve 选项后浮层消失（审批提交）',
    'B：工具真的执行了——history 工具结果含 permission-approval-ok',
    'B：step2 收尾文本到达（审批后 agent loop 继续）',
  ],
  notProvable: [
    'Deny 分支（工具被拒的 UI 形态与 history 记录）——一次会话一条审批流，deny 分支另行覆盖',
    '插件权限审批（PermissionRequestDialog / permission-dialog 家族）——仓内无 sandbox 插件夹具 = 不可达（矩阵 P1-3 备注）',
    'auto 模式的 AI classifier 分支（只验 strict 确定性分支）',
  ],
}

export async function run(ctx) {
  const { ev, log, repo } = ctx
  const uncovered = []
  const gotchas = [
    '两个审批子系统别混：pi-permission 工具审批 = CompanionBand（本剧本）；插件权限审批 = PermissionRequestDialog（无夹具不可达）',
    '非 yolo 模式必须在 pi spawn 前写好 permission-ext-config.json（本剧本在 seed 后 launch 前写入）',
    '审批选项无独立 testid（Button 文本寻址）：Approve (once) / Deny',
  ]
  const ui = ctx.ui
  const { createInstance } = await import('../scripts/lib/instance.mjs')

  const dataDir = path.join(process.env.HOME ?? '', '.taiji-dev', `verify-perm-${Date.now()}`)
  const instance = createInstance({
    repo,
    name: `verify-perm-${Date.now()}`,
    dataDir,
    faux: meta.faux,
    background: true,
  })
  let proto = null

  try {
    // seed 后、launch 前：写 strict 模式（launch 前写保证首个 pi 进程即按 strict 装配）
    const cfgDir = path.join(dataDir, 'agent', 'config')
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(path.join(cfgDir, 'permission-ext-config.json'), JSON.stringify({ mode: 'strict' }))
    ev.step({ step: 'permission.config', channel: 'C', exitCode: 0, stats: { mode: 'strict' } })

    await instance.launch()
    await instance.waitReady({ timeoutMs: 180_000 })
    proto = await instance.protocol()

    const created = await proto.call('session.create', { cwd: repo, label: 'p1-permission' }, { timeoutMs: 120_000 })
    const sid = created.session?.id
    if (!sid) throw new Error('session.create 未返回 sessionId')
    await proto.subscribe(sid)
    // renderer 挂载时序：CDP ready ≠ Vue app 消费完 config.sessions（传入 dataDir 的实例
    // launch 更快，窗口更明显）——条件轮询点击，60s 内反复重试
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
          hasSessionList: html.includes('session-list'),
          hasLanding: html.includes('default-project'),
        }, null, 2))
      } catch { /* ignore */ }
    }
    ev.assert('A: 侧栏会话行激活（条件轮询 60s）', activated, {
      channel: 'A',
      expected: '侧栏出现会话行并点击',
      actual: activated ? '已激活' : '60s 未现（现场见 sidebar-miss）',
    })

    const since = protocol.events.length
    await proto.send(sid, '执行需要审批的命令')
    // 审批浮层出现（工具调用轮不结束 turn——waitTurnEnd 会挂到审批后）
    await ui.expectVisible('testid=companion-band', { timeoutMs: 60_000 })
    const bandText = await ui.text('testid=companion-band')
    ev.assert('A: 审批浮层（companion-band）可见', bandText.length > 0, {
      channel: 'A',
      expected: '浮层含标题/消息区',
      actual: `len=${bandText.length}`,
    })
    await ev.shot(await instance.page(), 'companion-band-open')

    // 点 Approve（文本寻址；rpc 模式选项 = Approve (once) / Deny）
    await ui.click('text=Approve', { timeoutMs: 15_000 })
    await ui.expectGone('testid=companion-band', { timeoutMs: 30_000 })
    ev.assert('A: Approve 后浮层消失', true, {
      channel: 'A', expected: 'companion-band 移除', actual: '已消失',
    })
    ev.step({ step: 'interaction.permission', channel: 'A', exitCode: 0, stats: { choice: 'approve' } })

    const end = await proto.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    ev.assert('B: 审批后 turn 收尾', end.ok === true, {
      channel: 'B', expected: 'message.complete', actual: `${end.type} stop=${end.payload?.stopReason ?? ''}`,
    })

    const hist = await proto.history(sid, { limitTurns: 10 })
    const histText = JSON.stringify(hist.messages ?? [])
    ev.assert('B: 工具真执行（结果含 permission-approval-ok）', histText.includes('permission-approval-ok'), {
      channel: 'B',
      expected: 'bash 输出回灌 history',
      actual: `hit=${histText.includes('permission-approval-ok')}`,
    })

    log(`done sid=${sid}`)
  } finally {
    try {
      await proto?.close()
    } catch { /* ignore */ }
    await instance.dispose()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
  return { uncovered, gotchas }
}
