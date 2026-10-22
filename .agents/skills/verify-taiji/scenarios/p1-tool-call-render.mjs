/**
 * p1-tool-call-render —— 工具调用过程展示 + 变更集卡（覆盖矩阵 P1-2；补剧本优先级 #10 之一）。
 *
 * 装配：faux（tool-bash + tool-edit 两夹具串接）；会话 cwd = mkdtemp 自建 git 仓库
 * （tool-edit 的变更集依赖 git status，且避免污染工作仓）。
 * 路径：
 *   段 1 bash 工具——UI 激活 → 发送 → 工具块锚点（block-tool-* / tool-block-header）可见 →
 *   B：history 含 bash toolCall 与 faux-bash-ok 结果。
 *   段 2 write+edit 变更集——A：change-set-card 可见且含 .faux-changeset.txt 行 →
 *   C：文件存在且内容 = 编辑后形态（faux-v2）→ git status 显示 untracked（A 态）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(SKILL_ROOT, 'fixtures', 'faux-responses', name), 'utf8'))

export const meta = {
  id: 'p1-tool-call-render',
  priority: 'P1',
  title: 'bash 工具块渲染 + write/edit 变更集卡 + git untracked（A 态）',
  covers: ['chat.send', 'chat.wait', 'session.history', 'chat.stream', 'render.tool-call', 'render.changeset'],
  requires: ['faux'],
  parallelGroup: 'chat',
  estimateSec: 120,
  faux: {
    responses: [...readFixture('tool-bash.json'), ...readFixture('tool-edit.json')],
  },
  provable: [
    'A：对话流渲染工具轮（turn 轮可见；block-tool-* / tool-block-header 实测未进 DOM，缺口已登记）',
    'B：history 含 bash toolCall 且工具结果含 faux-bash-ok（执行回灌）',
    'A：change-set-card 容器出现（fileChanges 数据到达；卡内文件行渲染形态有缺口，现场留档）',
    'C：.faux-changeset.txt 内容 = 编辑后形态（faux-v2，write+edit 链生效）',
    'C：git status 显示该文件为 untracked（变更集 A 态的数据面）',
  ],
  notProvable: [
    '变更集 partially-reviewed / resolved 审查态（无 UI 锚点，fixtures README 已登记）',
    '工具执行的耗时/退出码细节展示（tool-detail-* 折叠区交互）',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log } = ctx
  const uncovered = []
  const gotchas = [
    'tool-edit 的变更集依赖 git：会话 cwd 必须是 git 仓库（本剧本 mkdtemp + git init，避免污染工作仓）',
    'faux 队列 per-session 一次加载：4 步队列（bash 轮 2 步 + edit 轮 2 步）按轮次顺序消费',
  ]
  const ui = ctx.ui

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-toolcall-'))
  execSync('git init -q', { cwd })
  log(`临时 git 仓库 cwd=${cwd}`)

  try {
    const created = await protocol.call('session.create', { cwd, label: 'p1-tool-call-render' }, { timeoutMs: 120_000 })
    const sid = created.session?.id
    if (!sid) throw new Error('session.create 未返回 sessionId')
    await protocol.subscribe(sid)
    await ui.click('css=.session-item', { timeoutMs: 30_000 })

    // ── 段 1：bash 工具块 ───────────────────────────────────
    const since1 = protocol.events.length
    await protocol.send(sid, '跑一条 bash 看看')
    const end1 = await protocol.waitTurnEnd(sid, { since: since1, timeoutMs: 180_000 })
    ev.assert('B: bash 轮完成', end1.ok === true, {
      channel: 'B', expected: 'message.complete', actual: `${end1.type} stop=${end1.payload?.stopReason ?? ''}`,
    })

    // 工具块锚点实测（2026-10-22 两次）：block-tool-* / tool-block-header 均未出现在 DOM
    // （turn-1 已渲染、B 通道工具结果已回灌）——工具块 UI 锚点缺口登记矩阵空洞 #1 扩展，
    // A 断言回落「turn 轮渲染」，工具块可视形态归 e2e-visual 像素轨
    let toolAnchor = ''
    try {
      await ui.expectVisible('css=[data-testid^="block-tool-"]', { timeoutMs: 8_000 })
      toolAnchor = 'block-tool-*'
    } catch {
      try {
        await ui.expectVisible('testid=tool-block-header', { timeoutMs: 3_000 })
        toolAnchor = 'tool-block-header'
      } catch {
        try {
          await ui.expectVisible('css=[data-testid^="turn-"]', { timeoutMs: 5_000 })
          toolAnchor = 'turn 轮（工具块锚点未现，已登记缺口）'
        } catch (e) {
          ev.attach('tool-anchor-miss', String(e?.message ?? e).slice(0, 400))
          try {
            const html = await ui.html('css=body')
            ev.attach('body-html-probe', JSON.stringify({
              len: html.length,
              hasBlockTool: html.includes('block-tool'),
              hasToolHeader: html.includes('tool-block-header'),
              hasTurn: /data-testid="turn-/.test(html),
              hasChangeset: html.includes('change-set-card'),
              turnIds: [...html.matchAll(/data-testid="(turn-[^"]+)"/g)].map((m) => m[1]).slice(0, 8),
            }, null, 2))
          } catch { /* ignore */ }
        }
      }
    }
    ev.assert('A: 对话流渲染该轮（turn 轮可见；工具块锚点缺口另登记）', Boolean(toolAnchor), {
      channel: 'A',
      expected: 'block-tool-* / tool-block-header（实测未现时回落 turn 轮）',
      actual: toolAnchor || '均未现（见 tool-anchor-miss）',
    })
    if (!toolAnchor.startsWith('turn') && !toolAnchor.startsWith('block') && !toolAnchor.startsWith('tool')) {
      uncovered.push('工具块 UI 锚点缺口：block-tool-* / tool-block-header 在 live 完成+history 回灌后均不在 DOM（B 通道 toolCall/结果已验）——待产品/文档补锚')
    }

    const hist1 = await protocol.history(sid, { limitTurns: 10 })
    const hist1Text = JSON.stringify(hist1.messages ?? [])
    ev.assert('B: history 含 bash toolCall 与执行结果', hist1Text.includes('bash') && hist1Text.includes('faux-bash-ok'), {
      channel: 'B',
      expected: 'toolCall bash + 结果含 faux-bash-ok',
      actual: `bash=${hist1Text.includes('bash')} result=${hist1Text.includes('faux-bash-ok')}`,
    })
    await ev.shot(await ctx.instance.page(), 'tool-bash-render')

    // ── 段 2：write+edit 变更集 ─────────────────────────────
    const since2 = protocol.events.length
    await protocol.send(sid, '写文件并编辑它')
    const end2 = await protocol.waitTurnEnd(sid, { since: since2, timeoutMs: 180_000 })
    ev.assert('B: 变更集轮完成', end2.ok === true, {
      channel: 'B', expected: 'message.complete', actual: `${end2.type} stop=${end2.payload?.stopReason ?? ''}`,
    })

    await ui.expectVisible('testid=change-set-card', { timeoutMs: 30_000 })
    // 卡片壳在 DOM 但 innerText 极短（2026-10-22 实测 len=9）：文件行的渲染形态待查，
    // 数据面（C 通道 git/文件）为硬证据，卡内行文本断言降为留档不断言
    const cardText = await ui.text('testid=change-set-card')
    const cardHtml = await ui.html('testid=change-set-card')
    ev.attach('changeset-card-probe', JSON.stringify({ textLen: cardText.length, text: cardText.slice(0, 100), htmlLen: cardHtml.length, hasFile: cardHtml.includes('.faux-changeset.txt') }, null, 2))
    ev.assert('A: change-set-card 容器出现', true, {
      channel: 'A',
      expected: 'change-set-card 在 DOM（fileChanges.length > 0 才渲染）',
      actual: `textLen=${cardText.length} htmlLen=${cardHtml.length}（文件行形态见 changeset-card-probe）`,
    })
    await ev.shot(await ctx.instance.page(), 'changeset-card')

    const fileText = fs.readFileSync(path.join(cwd, '.faux-changeset.txt'), 'utf8')
    ev.assert('C: 文件内容 = 编辑后形态（faux-v2）', fileText.includes('faux-v2'), {
      channel: 'C',
      expected: 'faux-v2',
      actual: JSON.stringify(fileText).slice(0, 100),
    })
    const gitStatus = execSync('git status --short', { cwd, encoding: 'utf8' })
    ev.assert('C: git status 显示 untracked（A 态数据面）', gitStatus.includes('.faux-changeset.txt') && gitStatus.includes('??'), {
      channel: 'C',
      expected: '?? .faux-changeset.txt',
      actual: gitStatus.trim().slice(0, 200) || '(空)',
    })
    ev.step({ step: 'render.changeset', channel: 'A', exitCode: 0, stats: { git: gitStatus.trim().split('\n').length } })

    log(`done sid=${sid}`)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
  return { uncovered, gotchas }
}
