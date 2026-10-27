/**
 * a5-failure-window-edit-disabled —— 验收场景 5（设计 §8）：失败期编辑禁用 + 首发归属（负面）。
 *
 * 回溯目标 3。失败窗口口径：连接可用、project 域加载失败（与场景 4 段 1 同注入——WS 级
 * 丢弃 project.loaded 回执；设计 §8 场景 5 的「失败窗口内首发会话可正常对话」只在该形态
 * 下成立：真冻结是全通道无响应，会话消息同样发不出去）。
 *
 * 通过标准（设计 §8 场景 5）：
 *   编辑入口置灰、有原因提示；不产生本地草稿；恢复后无脏数据；失败窗口内首发的
 *   会话可正常对话、数据恢复后不被追溯改动。首发归属按设计 §6.9 分档口径分两形态：
 *   主档（曾成功加载后失败）→ 首发归锚定项目组；子档（从未成功加载）→ 首发归
 *   「未分组」（projectId 留空）。本剧本覆盖子档形态（注入手段 reload 重置页面
 *   生命周期，store 从未持有回执），主档形态未构造——见 notProvable 登记。
 *
 * 装配：faux（主会话零 token 驱动首发消息）。
 */
import path from 'node:path'

import {
  PROD_DATA_DIR,
  countTestId,
  pollBodyHtml,
  readJsonFile,
  seedRealisticDataDir,
  waitForSidebarGroups,
} from './lib-conn-datasync.mjs'

const MSG_TEXT = 'A5-FAILWINDOW-FIRST-MESSAGE'
const REPLY_TEXT = 'A5-FAILWINDOW-REPLY'

export const meta = {
  id: 'a5-failure-window-edit-disabled',
  priority: 'P0',
  title: '场景 5：失败窗口编辑禁用 + 首发归属未分组（连接可用 / project 域失败）',
  covers: ['env.launch', 'env.ready', 'session.create', 'chat.send', 'chat.wait'],
  requires: ['faux'],
  estimateSec: 360,
  faux: {
    // force：本剧本停实例→种子→重launch，重launch 时 ensureFaux 会再次 seed-faux——
    // 不加 force 会被「settings.json 已存在」拒绝（seed-faux.mjs:57）。
    force: true,
    responses: {
      'faux/faux-1': [{ text: REPLY_TEXT, stopReason: 'stop' }],
    },
  },
  provable: [
    '失败窗口内编辑入口置灰（project-add-btn disabled + 原因提示 title），合成点击不产生本地草稿',
    '失败窗口内首发会话可正常对话（faux 回复到达对话流——连接可用）',
    '首发会话归入未分组（config.sessions 的 projectId 为空；恢复后 DOM 行不在任何 project-group 内）',
    '恢复后（重试放行回执）分组回归、首发会话不被追溯改动（projectId 仍为空）',
  ],
  notProvable: [
    '主档（曾成功加载后失败 → 首发归锚定项目组，设计 §8 场景 5 主形态）本剧本未构造：注入手段 reload 重置页面生命周期（store 失去已持有回执、构造出的是子档）；构造主档需真实重启链触发边沿重拉失败（无 reload 的低成本注入手段），其归属断言依赖本剧本现有子档断言 + 设计 §6.9 分档口径',
    '真冻结（SIGSTOP）窗口内的首发消息（全通道无响应，消息发不出去——设计场景 5 的行为窗口是「连接可用、project 域失败」，见文件头口径）',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, dataDir } = ctx
  const uncovered = []
  const gotchas = [
    '失败窗口 = 连接可用 + project 域失败（WS 级丢弃 project.loaded 回执）；真冻结形态下会话消息同样无法送达，设计场景 5 的行为只在本窗口成立',
    'project 域失败期分组区整体替换为失败状态条（§6.7）——会话行在窗口内不可见，归属断言经 B 通道（config.sessions）在窗口内完成，DOM 行断言在恢复后完成',
  ]

  // ── 段 0：种子 + 基线（loaded 态） ──────────────────────────────
  await instance.stop()
  const seed = seedRealisticDataDir(dataDir, { prodRoot: PROD_DATA_DIR })
  const seeded = readJsonFile(path.join(dataDir, 'projects.json'))
  const expectedNames = seeded.projects.filter((p) => p.id !== 'proj-default' && p.name).map((p) => p.name).sort()
  ev.step({ step: 'seed.realistic-data', channel: 'C', exitCode: 0, stats: { boundSessions: seed.sessions.length } })

  await instance.launch()
  const ready = await instance.waitReady({ timeoutMs: 180_000 })
  const runtimePort = ready.runtimePort
  const page = await instance.page()
  await waitForSidebarGroups(page, { minGroups: expectedNames.length, timeoutMs: 60_000 })
  ev.step({ step: 'baseline.ready', channel: 'C', exitCode: 0, stats: { runtimePort, groups: expectedNames.length } })

  // ── 段 1：失败窗口（project 域失败，连接可用） ───────────────────
  let dropping = false
  await page.routeWebSocket(
    (url) => url.port === String(runtimePort),
    (ws) => {
      const server = ws.connectToServer()
      server.onMessage((message) => {
        const text = typeof message === 'string' ? message : Buffer.from(message).toString('utf8')
        if (dropping) {
          try {
            const frame = JSON.parse(text)
            if (frame?.type === 'project.loaded') return
          } catch {
            /* 非 JSON 帧原样放行 */
          }
        }
        ws.send(message)
      })
    },
  )
  dropping = true
  await page.reload()
  const failedBarHtml = await pollBodyHtml(page, 'project-load-failed-bar', { timeoutMs: 100_000, wantPresent: true })
  ev.assert('A: 失败窗口成立（project-load-failed-bar 可见）', failedBarHtml.includes('project-load-failed-bar'), {
    channel: 'A',
    expected: '失败状态条可见',
    actual: failedBarHtml.includes('project-load-failed-bar') ? '可见' : '未出现',
  })
  await ev.shot(page, 'a5-failed-window')

  // ① 编辑入口置灰 + 原因提示
  const addDisabled = await page.locator('[data-testid="project-add-btn"]').first().getAttribute('disabled')
  const addTitle = await page.locator('[data-testid="project-add-btn"]').first().getAttribute('title')
  ev.assert('A: 失败窗口内新建项目入口置灰（disabled）', addDisabled !== null, {
    channel: 'A',
    expected: 'disabled 属性在场',
    actual: `disabled=${addDisabled ?? '(无)'}`,
  })
  ev.assert('A: 置灰入口带原因提示（title 非常态文案）', Boolean(addTitle) && addTitle.length > 0, {
    channel: 'A',
    expected: '非空 title',
    actual: addTitle ?? '(无)',
  })
  ev.attach('a5-add-btn-state', JSON.stringify({ disabled: addDisabled, title: addTitle }, null, 2))

  // ② 尝试新建项目 → 不产生本地草稿（合成点击绕过 disabled，验证无处理器泄漏）
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="project-add-btn"]')
    if (btn instanceof HTMLElement) btn.click()
  })
  await new Promise((r) => setTimeout(r, 1_500))
  const draftRows = await countTestId(page, 'project-draft-row')
  ev.assert('A: 失败窗口内尝试新建项目不产生本地草稿（project-draft-row 零出现）', draftRows === 0, {
    channel: 'A',
    expected: 0,
    actual: draftRows,
  })

  // ③ 失败窗口内首发会话 + 消息（连接可用 → 对话正常）
  const landing = await pollBodyHtml(page, 'new-task-landing', { timeoutMs: 60_000, wantPresent: true })
  ev.assert('A: 失败窗口内落地页可达（initApp 不等成功回执、failed 亦落定）', landing.includes('new-task-landing'), {
    channel: 'A',
    expected: 'new-task-landing 可见',
    actual: landing.includes('new-task-landing') ? '可见' : '未出现',
  })
  await page.click('[data-testid="composer-box"] [contenteditable="true"]', { timeout: 15_000 })
  await page.keyboard.type(MSG_TEXT, { delay: 20 })
  await page.click('[data-testid="composer-send-btn"]', { timeout: 15_000 })
  const replyHtml = await pollBodyHtml(page, REPLY_TEXT, { timeoutMs: 120_000, wantPresent: true })
  ev.assert('A: 失败窗口内首发会话可正常对话（faux 回复到达对话流）', replyHtml.includes(REPLY_TEXT), {
    channel: 'A',
    expected: REPLY_TEXT,
    actual: replyHtml.includes(REPLY_TEXT) ? '已到达' : '未到达',
  })
  await ev.shot(page, 'a5-failwindow-chat')

  // ④ 首发会话归入未分组（B 通道：projectId 为空）
  const { createProtocol } = await import('../scripts/lib/protocol.mjs')
  const proto = await createProtocol({ dataDir, runtimePort })
  let newSessionId = null
  try {
    const sessions = await proto.call('config.sessions', {}, { replyType: 'config.sessions', timeoutMs: 30_000 })
    const all = (sessions.groups ?? []).flatMap((g) => g.sessions ?? [])
    const fresh = all
      .filter((s) => !s.projectId)
      .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]
    newSessionId = fresh?.id ?? null
    ev.assert('B: 失败窗口内首发会话归入未分组（projectId 为空）', Boolean(newSessionId), {
      channel: 'B',
      expected: '存在无 projectId 的新会话',
      actual: newSessionId ? `sessionId=${newSessionId}` : `sessions=${all.length} 无未分组项`,
    })
  } finally {
    await proto.close().catch(() => {})
  }

  // ── 段 2：恢复（放行回执 + 重试）→ 分组回归 + 不被追溯改动 ─────────
  dropping = false
  await page.click('[data-testid="project-load-retry-btn"]', { timeout: 15_000 })
  const groupsBack = await waitForSidebarGroups(page, { minGroups: expectedNames.length, timeoutMs: 60_000 })
  ev.assert('A: 恢复后分组回归（重试 → load 成功）', groupsBack.map((g) => g.name).sort().join(',') === expectedNames.join(','), {
    channel: 'A',
    expected: expectedNames.join(','),
    actual: groupsBack.map((g) => g.name).sort().join(','),
  })
  await ev.shot(page, 'a5-recovered')

  // ⑤ 恢复后首发会话仍在未分组区（DOM：行不在任何 project-group 内；且不被追溯改动）
  // 行文本 = session.label（= name ?? cwd basename，session-scanner.ts:84）而非消息文本，
  // 故按「组外行数」判定：种子会话全部有归属（组内），失败窗口首发的新会话是唯一组外行。
  const rowStats = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.session-item')]
    const outside = rows.filter((r) => !r.closest('[data-testid="project-group"]'))
    return {
      total: rows.length,
      outside: outside.length,
      outsideLabels: outside.map((r) => (r.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)),
    }
  })
  ev.assert('A: 恢复后首发会话行在未分组区（唯一 project-group 外行）', rowStats.outside === 1, {
    channel: 'A',
    expected: '组外行数 = 1（种子会话全有归属，新会话为唯一未分组行）',
    actual: JSON.stringify(rowStats),
  })

  const proto2 = await createProtocol({ dataDir, runtimePort })
  try {
    const sessions = await proto2.call('config.sessions', {}, { replyType: 'config.sessions', timeoutMs: 30_000 })
    const all = (sessions.groups ?? []).flatMap((g) => g.sessions ?? [])
    const target = all.find((s) => s.id === newSessionId)
    ev.assert('B: 数据恢复后首发会话不被追溯改动（projectId 仍为空）', Boolean(target) && !target.projectId, {
      channel: 'B',
      expected: 'projectId 为空',
      actual: target ? `projectId=${target.projectId ?? '(空)'}` : '(会话消失)',
    })
  } finally {
    await proto2.close().catch(() => {})
  }

  // ⑥ 无脏数据：projects.json 未被失败窗口内的操作改写（无编辑命令成功执行）
  const projectsNow = readJsonFile(path.join(dataDir, 'projects.json'))
  ev.assert('C: 失败窗口无脏数据（projects.json 无 revision 字段——零写命令落盘）', projectsNow.revision === undefined, {
    channel: 'C',
    expected: 'revision 缺位（存量形态未变）',
    actual: `revision=${projectsNow.revision ?? '(缺)'}`,
  })

  if (uncovered.length === 0) log('a5: 全部断言通过')
  return { uncovered, gotchas }
}
