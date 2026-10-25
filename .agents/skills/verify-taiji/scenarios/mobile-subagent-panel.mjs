/**
 * mobile-subagent-panel —— 移动壳子代理面板全链（remote-use-mobile-v2 §8.2 场景 V9；A9）。
 *
 * 真实用户路径（V9）：在移动壳会话里发一条指令 → 主 agent 派发 2 个子代理 → 聊天屏
 * RunBand 呈现计数 → 进行中域计数呈现 → 点运行带开 SubagentSheet 两级（列表 → 详情：
 * 元信息 + 最近执行历史派生）→ 停止其一 → 流内通知 + 运行带计数减一。
 *
 * LLM 通道：mock-http（meta.llm）——faux 在 subagent 孙进程不可达（SKILL.md §1.1b），
 * 主会话与两个子代理用 model-keyed 三演员剧本隔离队列（mockllm/mock-1 主 / mock-sub-a /
 * mock-sub-b 各自游标）；tps 节流拉长子代理流式窗口，给「运行中」断言留足观测时间。
 * 派发动作从移动壳 Composer 发起（真实用户路径），会话经 protocol 预建（壳驱动前置）。
 *
 * 断言（§8.2 V9 通过标准 + A16/F10 映射，逐条对应）：
 *   ① RunBand 呈现且计数 = 2（running 过滤口径，RunBand.vue runningSubagentRecordsOf）；
 *   ② 进行中域计数呈现：activity 回合面板「N 个子代理」+ 子代理列表 2 行
 *      （ActivityScreen 与 RunBand 消费同一分区——导航可达的计数呈现面）；
 *   ③ SubagentSheet 两级：列表 2 项 → 详情态（状态行 + 元信息 dl + 执行记录容器，
 *      历史派生窗口 N≈8）；
 *   ④ 停止其一：subagentAction cancel → 详情状态收敛为已结束 + 流内通知
 *      「已停止子代理 {slug}」（§6.20 appendActionNotice）+ RunBand 计数减一 = 1。
 *
 * 装配前置：remote-access 预置（meta.remoteAccess）+ mobile dist 在位 + mock-http 服务
 * （runner 随 meta.llm 起）。前两者复用 mobile-shell-boot-three-states 的装配判定语义。
 */
import {
  closeMobileShell,
  openMobileShell,
  openSessionInShell,
  probeShellServing,
  resolveMobileDist,
  shellComposerInput,
  waitForShellConnected,
  waitForTestidVisible,
} from './lib/mobile-shell-helper.mjs'
import fs from 'node:fs'
import path from 'node:path'

/** 主会话派发动作文本（Composer 输入；真实用户路径的指令来源）。 */
const DISPATCH_PROMPT = 'dispatch two subagents now'
/** 两个子代理的 slug（displayName 口径 = slug 优先；停止通知文案插值同源）。 */
const SLUG_A = 'ma-sub-a'
const SLUG_B = 'ma-sub-b'
/** 停止流内通知文案（zh-CN notices.subagentStopped 固定形态）。 */
const STOP_NOTICE_TEXT = `已停止子代理 ${SLUG_A}`
/** RunBand 计数文案（zh-CN runBand.running：'{count} 个子代理运行中'）。 */
const RUNBAND_COUNT_2 = '2 个子代理运行中'
const RUNBAND_COUNT_1 = '1 个子代理运行中'

/** 子演员长文本（tps=8 → ≈31ms/字符 → ~900 字符 ≈ 28s 流式窗口，撑「运行中」观测期）。 */
function longSubText(marker) {
  return `${marker} ` + 'process the queued subtask step by step and report intermediate findings. '.repeat(14)
}

/** 子演员短文本（~230 字符 ≈ 7s 完成——详情/执行记录断言的观察对象先走完落盘）。 */
function shortSubText(marker) {
  return `${marker} ` + 'subtask finished with a concise summary of the outcome. '.repeat(4)
}

export const meta = {
  id: 'mobile-subagent-panel',
  priority: 'P0',
  title: '移动壳子代理面板（V9）：派发 2 子代理 → RunBand → 两级 Sheet → 停止其一 → 通知 + 计数减一',
  covers: ['subagent.dispatch', 'subagent.panel', 'mobile.subagent.runband', 'mobile.subagent.sheet'],
  requires: ['remote-access', 'mobile-dist', 'mock-http'],
  estimateSec: 300,
  remoteAccess: {},
  llm: {
    tps: 8,
    responses: {
      'mockllm/mock-1': [
        {
          text: '派发第一个子代理。',
          toolCalls: [
            {
              name: 'subagent_start',
              args: { task: `Subtask A: ${longSubText('SUB-A')}`, slug: SLUG_A, model: 'mockllm/mock-sub-a', fork: false },
            },
          ],
          stopReason: 'toolUse',
        },
        {
          text: '派发第二个子代理。',
          toolCalls: [
            {
              name: 'subagent_start',
              args: { task: `Subtask B: ${longSubText('SUB-B')}`, slug: SLUG_B, model: 'mockllm/mock-sub-b', fork: false },
            },
          ],
          stopReason: 'toolUse',
        },
        { text: 'two-dispatched-marker', stopReason: 'stop' },
        // 子代理终态的完成通知各触发一轮主 agent（triggerTurn）——备足防「剧本耗尽 404」噪音
        { text: 'noted-a', stopReason: 'stop' },
        { text: 'noted-b', stopReason: 'stop' },
        { text: 'noted-c', stopReason: 'stop' },
      ],
      'mockllm/mock-sub-a': [{ text: longSubText('SUB-A-RESULT'), stopReason: 'stop' }],
      'mockllm/mock-sub-b': [{ text: shortSubText('SUB-B-RESULT'), stopReason: 'stop' }],
    },
  },
  provable: [
    'A：壳发指令后 RunBand 呈现且计数 = 2（running 过滤，session.subagents 推送驱动）',
    'A：进行中域计数呈现（子代理列表段 2 行；回合面板 subagentCount 仅回合生成中渲染，见 gotchas）',
    'A：SubagentSheet 两级推进：列表 2 项 → 已完成子代理详情（状态行 + 元信息 + 执行记录 = 历史派生行 >0）',
    'A：停止其一（运行中子代理）→ 流内通知「已停止子代理 ma-sub-a」+ RunBand 计数减一 = 1 + 详情状态收敛',
  ],
  notProvable: [
    '真机触控热区/长按时长（仿真 viewport 断言呈现与状态机，不证触控手感）',
    '子代理产出质量（mock 剧本无模型语义）',
  ],
}

/** 读移动壳文本（innerText 条件轮询至等于期望；超时返回 null 由剧本记断言）。 */
async function waitForTextEquals(page, testid, expected, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    last = await page
      .locator(`[data-testid="${testid}"]`)
      .first()
      .innerText()
      .catch(() => '')
    if (last.trim() === expected) return last.trim()
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** 等流内通知文本可见（system 提示行无专用 testid，文本锚定是稳定呈现事实）。 */
async function waitForTextVisible(page, text, { timeoutMs = 15_000 } = {}) {
  try {
    await page.locator(`text=${text}`).first().waitFor({ state: 'visible', timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

export async function run(ctx) {
  const { instance, ev, log, remoteAccess, protocol: proto } = ctx
  const gotchas = [
    'subagent_start 为异步派发：主轮回合秒级收尾（idle），进行中屏回合面板（含 subagentCount）仅回合生成中渲染——后台子代理形态的进行中域计数呈现面 = 子代理列表段（activity-subagent-list）；BottomNav 角标是待办计数（权限/表单），不反映子代理数',
    '运行中子代理的执行记录可能拉不到（子会话 JSONL 首条未落盘窗口，首跑实测 B 通道 20s 全 0）——「元信息 + 执行记录」断言选先完成的子代理，停止断言选长跑子代理',
  ]
  const uncovered = []
  const info = instance.info()
  const runtimePort = info.runtimePort
  const token = remoteAccess?.token
  if (!token) throw new Error('ctx.remoteAccess 缺失：meta.remoteAccess 预置未生效')

  // ── 装配判定（与 boot 剧本同语义）：dist 在位 + 静态托管 200 + mock-http 拓扑在 ──
  const distIndex = fs.existsSync(path.join(resolveMobileDist(ctx.repo), 'index.html'))
  const serving = await probeShellServing(runtimePort)
  const topo = instance.llm
  ev.step({
    step: 'mobile.assembly.probe',
    channel: 'C',
    exitCode: distIndex && serving.shellStatus === 200 && topo ? 0 : 1,
    stats: { distIndex, shellStatus: serving.shellStatus, mockBaseUrl: topo?.baseUrl ?? null, mainRef: topo?.mainRef ?? null },
  })
  ev.assert('C: 装配三件（dist 在位 + 壳静态托管 200 + mock-http 拓扑）', distIndex && serving.shellStatus === 200 && Boolean(topo), {
    channel: 'C',
    expected: 'dist/index.html 存在 + GET / 200 + llm.mainRef 在',
    actual: `distIndex=${distIndex} shell=${serving.shellStatus} mainRef=${topo?.mainRef ?? '缺'}`,
  })
  if (!distIndex || serving.shellStatus !== 200 || !topo) {
    uncovered.push('V9 未驱动：装配不完整（dist 缺失 / 壳 404 / mock-http 缺）——修复装配后复跑')
    return { uncovered, gotchas }
  }

  // ── 壳驱动前置：protocol 预建会话（B 通道；派发动作本体走壳 Composer）──
  const created = await proto.call('session.create', { cwd: ctx.repo, label: 'A9-SUBAGENT-PANEL' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  ev.step({ step: 'session.create', channel: 'B', exitCode: sid ? 0 : 1, stats: { sessionId: sid } })
  if (!sid) throw new Error('session.create 未返回 session.id')
  await proto.subscribe(sid)

  // ── 打开移动壳 → connected → 进入会话 ──
  let shell = null
  try {
    shell = await openMobileShell({ repo: ctx.repo, runtimePort, token, locale: 'zh-CN' })
    const connected = await waitForShellConnected(shell.page, { timeoutMs: 30_000 })
    ev.assert('A: 壳连接成功（bottom-nav 挂载）', connected, {
      channel: 'A', expected: 'bottom-nav 可见', actual: connected ? '可见' : '30s 内未出现',
    })
    if (!connected) {
      ev.attach('boot-console', shell.consoleLines.slice(-40).join('\n'))
      ev.attach('boot-page-errors', shell.pageErrors.join('\n---\n') || '(无)')
      uncovered.push('V9 未驱动：壳未达 connected（连接装配问题）')
      return { uncovered, gotchas }
    }

    const chatShown = await openSessionInShell(shell.page, sid, { timeoutMs: 20_000 })
    ev.assert('A: 会话行点入聊天屏（chat-screen 挂载）', chatShown, {
      channel: 'A', expected: `session-row-${sid} 可点 + chat-screen 可见`, actual: chatShown ? 'chat-screen 可见' : '切入失败',
    })
    await ev.shot(shell.page, 'a9-chat-entered')

    // ── 派发：Composer 逐字输入 + 点发送（真实用户路径）──
    const input = shellComposerInput(shell.page)
    await input.waitFor({ state: 'visible', timeout: 15_000 })
    await input.click()
    await input.pressSequentially(DISPATCH_PROMPT, { delay: 15 })
    await shell.page.locator('[data-testid="mobile-composer-send"]').click()
    ev.step({ step: 'mobile.dispatch.sent', channel: 'A', exitCode: 0, stats: { prompt: DISPATCH_PROMPT } })

    // ── 断言①：RunBand 呈现且计数 = 2（主轮两步派发 + 孙进程 spawn + 推送到达，给足预算）──
    const runBandShown = await waitForTestidVisible(shell.page, 'mobile-run-band', { timeoutMs: 90_000 })
    ev.assert('A: 运行带（RunBand）呈现', runBandShown, {
      channel: 'A', expected: 'mobile-run-band 可见', actual: runBandShown ? '可见' : '90s 内未出现（派发链未达壳）',
    })
    const countText = runBandShown ? await waitForTextEquals(shell.page, 'mobile-run-band-count', RUNBAND_COUNT_2, { timeoutMs: 20_000 }) : null
    ev.assert('A: RunBand 计数 = 2（两个子代理运行中）', countText === RUNBAND_COUNT_2, {
      channel: 'A', expected: RUNBAND_COUNT_2, actual: countText ?? '(计数文本未命中)',
    })
    await ev.shot(shell.page, 'a9-runband-2')
    // 注意：此处不等主轮 message.complete——subagent_start 派发后主轮回合要到子代理跑完
    // 才收尾（完成通知轮），等待会把「运行中窗口」耗尽（2026-10-25 首跑实测 30s 空档）。
    // 派发双发生的事实由 RunBand = 2 承载。

    // ── 断言②：进行中域计数呈现（running 窗口内；chat 态 BottomNav 结构性隐藏——
    //    先 popstate 回列表再点 activity tab；App.vue BottomNav v-if="shellRoute !== 'chat'"）──
    await shell.page.locator('[data-testid="chat-back"]').click()
    await waitForTestidVisible(shell.page, 'bottom-nav', { timeoutMs: 15_000 })
    await shell.page.locator('[data-testid="mobile-nav-activity"]').click()
    const activityShown = await waitForTestidVisible(shell.page, 'activity-screen', { timeoutMs: 15_000 })
    const turnSubagents = activityShown ? await waitForTextEquals(shell.page, 'activity-turn-subagents', '2 个子代理', { timeoutMs: 5_000 }) : null
    // 回合面板 subagentCount 挂在 v-if="isActive && observedDuration" 内（ActivityScreen）——
    // subagent_start 为异步派发，主轮回合秒级收尾（idle），后台子代理形态下面板结构性走
    // 空态。呈现条件如实记录（首跑实测），不作为通过判据；进行中域的子代理计数呈现面 =
    // 下方子代理列表段。
    ev.step({
      step: 'activity.turnpanel.subagentcount',
      channel: 'A',
      exitCode: 0,
      stats: { rendered: turnSubagents === '2 个子代理', note: '仅回合生成中渲染；后台子代理形态走空态' },
    })
    // 行数只数 list 容器内的行（v-if 与空态分支互斥，容器在 = running > 0；
    // 全页前缀匹配会误命中空态按钮 activity-subagent-empty-action）
    const subRows = activityShown
      ? await shell.page.locator('[data-testid="activity-subagent-list"] [data-testid^="activity-subagent-"]').count()
      : 0
    ev.assert('A: 进行中域子代理列表 2 行', activityShown && subRows === 2, {
      channel: 'A', expected: 'activity-subagent-list 2 行', actual: `${subRows} 行`,
    })
    await ev.shot(shell.page, 'a9-activity-count')

    // 回聊天屏（RunBand 与 Sheet 断言的容器）
    await shell.page.locator('[data-testid="mobile-nav-sessions"]').click()
    await openSessionInShell(shell.page, sid, { timeoutMs: 20_000 })

    // ── 断言③：点运行带 → SubagentSheet 两级 ──
    await shell.page.locator('[data-testid="mobile-run-band"]').click()
    const listShown = await waitForTestidVisible(shell.page, 'subagent-sheet-list', { timeoutMs: 15_000 })
    ev.assert('A: 运行带点开 SubagentSheet 列表态', listShown, {
      channel: 'A', expected: 'subagent-sheet-list 可见', actual: listShown ? '可见' : '点运行带后未出现',
    })
    const listRows = listShown ? await shell.page.locator('[data-testid^="subagent-sheet-item-"]').count() : 0
    ev.assert('A: 列表态 2 项', listRows === 2, {
      channel: 'A', expected: 'subagent-sheet-item-* 2 项', actual: `${listRows} 项`,
    })
    await ev.shot(shell.page, 'a9-sheet-list')

    // ── 断言③：详情（已完成子代理 SLUG_B——执行记录已落盘）→ 返回 → 运行中 SLUG_A ──
    // 执行记录数据 = 打开详情时 fetchSubagentHistory 一次拉取；运行中子代理的子会话
    // JSONL 首条可能未落盘（首跑实测 B 通道 20s 全 0），故「元信息 + 执行记录」断言
    // 选先完成的 SLUG_B（B 通道等终态后打开），「停止」断言选长跑的 SLUG_A。
    let subBStatus = null
    try {
      const deadline = Date.now() + 45_000
      for (;;) {
        const reply = await proto.call('session.getSubagents', { sessionId: sid }, { timeoutMs: 15_000 })
        subBStatus = (reply.subagents ?? []).find((r) => r.slug === SLUG_B)?.status ?? null
        if (subBStatus && subBStatus !== 'running') break
        if (Date.now() >= deadline) break
        await new Promise((r) => setTimeout(r, 500))
      }
    } catch (e) {
      ev.step({ step: 'subagent.b.waitdone', channel: 'B', exitCode: 1, stats: { error: e instanceof Error ? e.message : String(e) } })
    }
    ev.step({ step: 'subagent.b.waitdone', channel: 'B', exitCode: subBStatus && subBStatus !== 'running' ? 0 : 1, stats: { status: subBStatus } })

    await shell.page
      .locator('[data-testid^="subagent-sheet-item-"]')
      .filter({ hasText: SLUG_B })
      .first()
      .click()
    const detailShown = await waitForTestidVisible(shell.page, 'subagent-sheet-detail', { timeoutMs: 15_000 })
    ev.assert('A: 详情态推进（subagent-sheet-detail）', detailShown, {
      channel: 'A', expected: 'subagent-sheet-detail 可见', actual: detailShown ? '可见' : '列表项点击后未推进',
    })
    const detailStateEnded = detailShown ? await waitForTextEquals(shell.page, 'subagent-sheet-detail-state', '已结束', { timeoutMs: 10_000 }) : null
    ev.assert('A: 已完成子代理详情状态行 = 已结束', detailStateEnded === '已结束', {
      channel: 'A', expected: '已结束', actual: detailStateEnded ?? '(状态行未命中)',
    })
    // 元信息 dl（agent 必有；model/turns 等缺省字段不渲染行——行数 ≥1 即形态成立）
    const metaRows = detailShown ? await shell.page.locator('[data-testid="subagent-sheet-detail-meta"] dt').count() : 0
    ev.assert('A: 详情元信息呈现（dl ≥1 行）', metaRows >= 1, {
      channel: 'A', expected: 'subagent-sheet-detail-meta ≥1 行', actual: `${metaRows} 行`,
    })
    const historyShown = detailShown ? await waitForTestidVisible(shell.page, 'subagent-sheet-history', { timeoutMs: 10_000 }) : false
    ev.assert('A: 执行记录容器呈现（历史派生）', historyShown, {
      channel: 'A', expected: 'subagent-sheet-history 容器可见', actual: historyShown ? '可见' : '未出现',
    })
    // 执行记录行：已完成子代理的 task/回复消息派生（N≈8 窗口）。首拉为空时回列表重进
    // 重拉一次（fetchSubagentHistory 只在 openDetail 触发）。
    let historyRows = historyShown ? await shell.page.locator('[data-testid^="subagent-sheet-history-"]').count() : 0
    if (historyRows === 0 && historyShown) {
      await shell.page.locator('[data-testid="subagent-sheet-back"]').click()
      await waitForTestidVisible(shell.page, 'subagent-sheet-list', { timeoutMs: 10_000 })
      await shell.page
        .locator('[data-testid^="subagent-sheet-item-"]')
        .filter({ hasText: SLUG_B })
        .first()
        .click()
      await waitForTestidVisible(shell.page, 'subagent-sheet-detail', { timeoutMs: 10_000 })
      historyRows = await shell.page.locator('[data-testid^="subagent-sheet-history-"]').count().catch(() => 0)
    }
    ev.step({ step: 'subagent.history.rows', channel: 'A', exitCode: historyRows > 0 ? 0 : 1, stats: { rows: historyRows } })
    ev.assert('A: 执行记录含历史行（子代理 task 消息派生）', historyRows > 0, {
      channel: 'A', expected: 'subagent-sheet-history-* ≥1 行', actual: `${historyRows} 行`,
    })
    await ev.shot(shell.page, 'a9-sheet-detail-done')

    // 返回列表 → 点运行中 SLUG_A 进详情
    await shell.page.locator('[data-testid="subagent-sheet-back"]').click()
    await waitForTestidVisible(shell.page, 'subagent-sheet-list', { timeoutMs: 10_000 })
    await shell.page
      .locator('[data-testid^="subagent-sheet-item-"]')
      .filter({ hasText: SLUG_A })
      .first()
      .click()
    await waitForTestidVisible(shell.page, 'subagent-sheet-detail', { timeoutMs: 10_000 })
    const detailStateRunning = await waitForTextEquals(shell.page, 'subagent-sheet-detail-state', '运行中', { timeoutMs: 10_000 })
    ev.assert('A: 运行中子代理详情状态行 = 运行中', detailStateRunning === '运行中', {
      channel: 'A', expected: '运行中', actual: detailStateRunning ?? '(状态行未命中——运行窗口错过则如实红)',
    })
    await ev.shot(shell.page, 'a9-sheet-detail-running')
    await ev.shot(shell.page, 'a9-sheet-detail')

    // ── 断言④：停止其一 → 详情收敛 + 流内通知 + RunBand 计数减一 ──
    await shell.page.locator('[data-testid="subagent-sheet-stop"]').click()
    const stateAfterStop = await waitForTextEquals(shell.page, 'subagent-sheet-detail-state', '已结束', { timeoutMs: 30_000 })
    ev.assert('A: 停止后详情状态收敛为已结束', stateAfterStop === '已结束', {
      channel: 'A', expected: '已结束', actual: stateAfterStop ?? '(30s 内未收敛)',
    })
    const noticeShown = await waitForTextVisible(shell.page, STOP_NOTICE_TEXT, { timeoutMs: 15_000 })
    ev.assert('A: 流内通知「已停止子代理 ma-sub-a」呈现', noticeShown, {
      channel: 'A', expected: STOP_NOTICE_TEXT, actual: noticeShown ? '可见' : '15s 内未出现',
    })
    const countAfterStop = await waitForTextEquals(shell.page, 'mobile-run-band-count', RUNBAND_COUNT_1, { timeoutMs: 30_000 })
    ev.assert('A: 停止后 RunBand 计数减一 = 1', countAfterStop === RUNBAND_COUNT_1, {
      channel: 'A', expected: RUNBAND_COUNT_1, actual: countAfterStop ?? '(计数未收敛)',
    })
    await ev.shot(shell.page, 'a9-after-stop')

    await shell.page.locator('[data-testid="subagent-sheet-close"]').click()
    const bandStillThere = await waitForTestidVisible(shell.page, 'mobile-run-band', { timeoutMs: 10_000 })
    ev.assert('A: 关 Sheet 后 RunBand 保持（计数 1）', bandStillThere, {
      channel: 'A', expected: 'mobile-run-band 仍可见', actual: bandStillThere ? '可见' : '关闭后消失',
    })
  } finally {
    if (shell) {
      if (shell.pageErrors.length > 0) ev.attach('page-errors-tail', shell.pageErrors.join('\n---\n'))
      await closeMobileShell(shell)
      ev.step({ step: 'mobile.browser.close', channel: 'C', exitCode: 0, stats: {} })
    }
  }

  // ── 收敛等待：全部子代理终态（防 dispose 时孙进程仍在跑）+ mock 请求面归因证据 ──
  try {
    const deadline = Date.now() + 90_000
    let running = -1
    while (Date.now() < deadline) {
      const reply = await proto.call('session.getSubagents', { sessionId: sid }, { timeoutMs: 30_000 })
      const records = reply.subagents ?? []
      running = records.filter((r) => r.status === 'running' && r.stopReason === undefined).length
      if (running === 0) break
      await new Promise((r) => setTimeout(r, 1_000))
    }
    ev.step({ step: 'subagents.settled', channel: 'C', exitCode: running === 0 ? 0 : 1, stats: { running } })
    const mockRequests = (instance.mockLlm?.requests ?? []).map((r) => ({
      model: r.model,
      status: r.status,
      stepIndex: r.stepIndex,
      error: r.error,
    }))
    ev.attach('mock-requests', JSON.stringify(mockRequests, null, 2))
    ev.step({ step: 'mock.requests', channel: 'C', exitCode: 0, stats: { total: mockRequests.length, models: [...new Set(mockRequests.map((r) => r.model))].join(',') } })
  } catch (e) {
    gotchas.push(`收敛等待失败（dispose 可能需杀在飞孙进程）：${e instanceof Error ? e.message : String(e)}`)
  }

  log('mobile-subagent-panel 完成')
  return { uncovered, gotchas }
}
