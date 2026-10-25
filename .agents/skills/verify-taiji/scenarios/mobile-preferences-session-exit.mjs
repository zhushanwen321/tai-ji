/**
 * mobile-preferences-session-exit —— 移动壳偏好持久化 + 已退出会话（remote-use-mobile-v2
 * §8.2 场景 V11；A11）。
 *
 * 真实用户路径（V11）：设置屏切浅色主题 + 大字号（即时生效）→ 刷新页面（偏好保持）→
 * 打开一个已退出（dead，pi 进程已退出）的会话（历史只读形态）→ 动作 Sheet「重新打开」
 * 链路可达。
 *
 * dead 会话制造（真实路径）：pi 主 agent 进程以 SIGTERM 精确杀死（PID = pgrep -P
 * <runtimePid> + 命令行核对 `--mode rpc`，只动本实例 runtime 的直接子进程）→ runtime
 * onSessionExit 链置 dead（ADR-0122 后无自动恢复链——崩溃处置显式上报、恢复决策归用户，
 * 源码 pi-respawn.ts 头注，2026-10-25 亲读）→ session.list 轮询确认 status='dead'。
 * 串行制造两个 dead 会话（先建 → 跑一轮 → 杀 → 确认 dead，再建下一个，保证「当时唯一
 * pi」的可定位性）：C 用于「点开已退出会话」断言，B 用于「动作 Sheet 重新打开」链路。
 *
 * 断言（§8.2 V11 通过标准 + F14/偏好持久化映射，逐条对应）：
 *   ① 即时生效：切浅色 + 大字号后 html 根槽位 data-theme='light' + data-font-size='large'
 *      切换，且 settings-screen 节点未重挂载（预置探针属性跨切换保留）；
 *   ② 刷新后偏好保持：localStorage taiji.mobile.prefs 持久化读侧 + reload 后根槽位维持
 *      + 设置屏控件选中态一致；
 *   ③ 已退出会话历史形态：点开 dead 会话 C → 历史文本在流（只读可见）+ Composer 形态
 *      ——设计契约（§7.2 映射表「聊天历史只读、输入条隐藏」）在 dead 窗口内断言
 *      mobile-composer 缺位；前提（C 仍 dead）由 session.list 当刻核实，前提消失（惰性
 *      恢复先于断言完成）如实记 uncovered 不判红；
 *   ④ 重新打开链路：长按 dead 会话 B 行 → SessionActionsSheet「重新打开」（仅 dead
 *      渲染）→ 点后 B 复活（session.list status 离开 dead + 行状态更新）。
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
  MOBILE_PREFS_STORAGE_KEY,
  closeMobileShell,
  openMobileShell,
  probeShellServing,
  resolveMobileDist,
  waitForShellConnected,
  waitForTestidVisible,
} from './lib/mobile-shell-helper.mjs'

const LABEL_RESTORE = 'A11-DEAD-RESTORE' // B：动作 Sheet 重新打开链路
const LABEL_OPEN = 'A11-DEAD-OPEN' // C：点开已退出会话断言
const LABEL_LIVE = 'A11-LIVE' // A：保持活着的会话（列表对照组）
const MARK = {
  [LABEL_RESTORE]: 'PREF-BETA-RESTORE-MARKER',
  [LABEL_OPEN]: 'PREF-GAMMA-OPEN-MARKER',
  [LABEL_LIVE]: 'PREF-ALPHA-LIVE-MARKER',
}

export const meta = {
  id: 'mobile-preferences-session-exit',
  priority: 'P0',
  title: '移动壳偏好与已退出会话（V11）：浅色+大字号即时生效 → 刷新保持 → dead 会话只读形态 → 重新打开链路',
  covers: ['mobile.prefs.apply', 'mobile.prefs.persist', 'session.restore', 'mobile.dead.readonly'],
  requires: ['remote-access', 'mobile-dist', 'mock-http'],
  estimateSec: 360,
  remoteAccess: {},
  llm: {
    responses: {
      'mockllm/mock-1': [
        { text: `${MARK[LABEL_RESTORE]} 回复`, stopReason: 'stop' },
        { text: `${MARK[LABEL_OPEN]} 回复`, stopReason: 'stop' },
        { text: `${MARK[LABEL_LIVE]} 回复`, stopReason: 'stop' },
        { text: 'spare-1', stopReason: 'stop' },
      ],
    },
  },
  provable: [
    'A：切浅色 + 大字号后 html 根槽位即时切换（data-theme/data-font-size），settings-screen 未重挂载',
    'A：reload 后偏好保持（localStorage 读侧 + 根槽位 + 控件选中态）',
    'A：点开 dead 会话历史可见；dead 前提窗口内 Composer 形态对照设计契约（输入条隐藏）断言',
    'A：动作 Sheet「重新打开」可达且点击后 dead 会话复活',
  ],
  notProvable: [
    '真实手机字号/主题的视觉像素（断言根槽位与控件态，不证渲染像素——像素面归 E2E-VISUAL）',
    '惰性恢复速度（点开 dead 会话的恢复窗口时长是运行时事实，场景只分辨「窗口内形态」与「窗口错过」）',
  ],
}

/** 读 runtime 自登记 PID。 */
function readRuntimePid(dataDir) {
  const rec = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime-instance.json'), 'utf8'))
  if (!Number.isInteger(rec.pid)) throw new Error(`runtime-instance.json 形态异常：${JSON.stringify(rec).slice(0, 200)}`)
  return rec.pid
}

/**
 * 列出 runtime 直接子进程中的 pi 主 agent（命令行核对 `--mode rpc`；只定位不动手——
 * 杀由调用方按核对过的 PID 执行）。
 */
function listRuntimeChildPis(runtimePid) {
  const out = execSync(`pgrep -P ${runtimePid}`, { encoding: 'utf8' }).trim()
  const pids = out === '' ? [] : out.split('\n').map((s) => s.trim()).filter(Boolean)
  return pids.map((pid) => {
    let cmd = ''
    try {
      cmd = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf8' }).trim()
    } catch {
      cmd = '(ps 失败)'
    }
    return { pid: Number(pid), cmd }
  })
}

/** 杀掉当时唯一的 pi 主 agent（多值 = 定位歧义，fail-fast 不猜）。SIGKILL = 异常死亡
 *  形态（SIGTERM 会走 pi 优雅退出，runtime 侧翻 done 不翻 dead——首跑实测）。 */
function killSoleRuntimeChildPi(ev, dataDir) {
  const runtimePid = readRuntimePid(dataDir)
  const pis = listRuntimeChildPis(runtimePid).filter((x) => /--mode(\s+|=)rpc/.test(x.cmd))
  ev.step({
    step: 'pi.locate',
    channel: 'C',
    exitCode: pis.length === 1 ? 0 : 1,
    stats: { runtimePid, candidates: pis },
  })
  if (pis.length !== 1) throw new Error(`pi 定位歧义：期望唯一 --mode rpc 子进程，实际 ${pis.length} 个`)
  process.kill(pis[0].pid, 'SIGKILL')
  return pis[0].pid
}

/** session.list 轮询指定会话 status（分组 reply 形态：{groups:[{sessions:[...]}]}）。 */
async function waitSessionStatus(proto, sessionId, expect, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    const reply = await proto.call('session.list', {}, { timeoutMs: 30_000 })
    const flat = (reply.groups ?? []).flatMap((g) => g.sessions ?? [])
    last = flat.find((s) => s.id === sessionId)?.status ?? null
    if (last === expect) return last
    if (Date.now() >= deadline) return last
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** 条件等文本可见（消息流/指引文案的呈现事实锚）。 */
async function waitForTextVisible(page, text, { timeoutMs = 15_000 } = {}) {
  try {
    await page.locator(`text=${text}`).first().waitFor({ state: 'visible', timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

/** 准备一个会话：建 + 跑一轮（历史落盘），返回 sid。 */
async function createSessionWithOneRound(ctx, proto, label) {
  const created = await proto.call('session.create', { cwd: ctx.repo, label }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  if (!sid) throw new Error(`session.create(${label}) 未返回 id`)
  await proto.subscribe(sid)
  const since = proto.events.length
  await proto.send(sid, `seed round for ${label}`)
  const end = await proto.waitTurnEnd(sid, { since, timeoutMs: 120_000 })
  ctx.ev.step({ step: `prep.${label}`, channel: 'B', exitCode: end.ok ? 0 : 1, stats: { sessionId: sid, type: end.type } })
  return sid
}

export async function run(ctx) {
  const { instance, ev, log, remoteAccess, protocol: proto } = ctx
  const gotchas = []
  const uncovered = []
  const info = instance.info()
  const runtimePort = info.runtimePort
  const token = remoteAccess?.token
  if (!token) throw new Error('ctx.remoteAccess 缺失：meta.remoteAccess 预置未生效')

  // ── 装配判定 ──
  const distIndex = fs.existsSync(path.join(resolveMobileDist(ctx.repo), 'index.html'))
  const serving = await probeShellServing(runtimePort)
  ev.step({
    step: 'mobile.assembly.probe',
    channel: 'C',
    exitCode: distIndex && serving.shellStatus === 200 ? 0 : 1,
    stats: { distIndex, shellStatus: serving.shellStatus },
  })
  if (!distIndex || serving.shellStatus !== 200) {
    uncovered.push('V11 未驱动：壳静态托管不可达——修复装配后复跑')
    return { uncovered, gotchas }
  }

  // ── 会话准备（串行制造两个 dead + 一个活会话）；dead 制造失败 fail-fast（后续断言
  //    全部依赖 dead 前提，错误前提下继续 = 误导性结果）──
  const sidB = await createSessionWithOneRound(ctx, proto, LABEL_RESTORE)
  const piB = killSoleRuntimeChildPi(ev, ctx.dataDir)
  const statusB = await waitSessionStatus(proto, sidB, 'dead', { timeoutMs: 30_000 })
  ev.step({ step: 'dead.make.restore-target', channel: 'C', exitCode: statusB === 'dead' ? 0 : 1, stats: { sidB, piB, status: statusB } })
  if (statusB !== 'dead') {
    uncovered.push(`dead 会话 B 制造失败：杀 pi(${piB}) 后 status=${statusB} ≠ dead（dead 翻转链与预期不符）——V11 未驱动`)
    return { uncovered, gotchas }
  }

  const sidC = await createSessionWithOneRound(ctx, proto, LABEL_OPEN)
  const piC = killSoleRuntimeChildPi(ev, ctx.dataDir)
  const statusC = await waitSessionStatus(proto, sidC, 'dead', { timeoutMs: 30_000 })
  ev.step({ step: 'dead.make.open-target', channel: 'C', exitCode: statusC === 'dead' ? 0 : 1, stats: { sidC, piC, status: statusC } })
  if (statusC !== 'dead') {
    uncovered.push(`dead 会话 C 制造失败：杀 pi(${piC}) 后 status=${statusC} ≠ dead——V11 未驱动`)
    return { uncovered, gotchas }
  }

  const sidA = await createSessionWithOneRound(ctx, proto, LABEL_LIVE)
  ev.step({ step: 'dead.make.live-control', channel: 'C', exitCode: 0, stats: { sidA } })

  // ── 壳：打开 → settings 屏切偏好 ──
  let shell = null
  try {
    shell = await openMobileShell({ repo: ctx.repo, runtimePort, token, locale: 'zh-CN' })
    const connected = await waitForShellConnected(shell.page, { timeoutMs: 30_000 })
    ev.assert('A: 壳连接成功（bottom-nav 挂载）', connected, {
      channel: 'A', expected: 'bottom-nav 可见', actual: connected ? '可见' : '30s 内未出现',
    })
    if (!connected) {
      uncovered.push('V11 未驱动：壳未达 connected')
      return { uncovered, gotchas }
    }
    await shell.page.locator('[data-testid="mobile-nav-settings"]').click()
    const settingsShown = await waitForTestidVisible(shell.page, 'settings-screen', { timeoutMs: 15_000 })
    if (!settingsShown) {
      uncovered.push('V11 未驱动：settings 屏未出现')
      return { uncovered, gotchas }
    }
    // 重挂载探针：给 settings-screen 节点打属性标记（切换后仍在 = 未重挂载）
    await shell.page.evaluate(() => {
      document.querySelector('[data-testid="settings-screen"]')?.setAttribute('data-probe-mount', 'v11')
    })
    const before = await shell.page.evaluate(() => ({
      theme: document.documentElement.dataset.theme ?? '',
      fontSize: document.documentElement.dataset.fontSize ?? '',
    }))
    ev.step({ step: 'prefs.before', channel: 'A', exitCode: 0, stats: before })

    await shell.page.locator('[data-testid="settings-theme"] [data-testid="segmented-option-light"]').click()
    await shell.page.locator('[data-testid="settings-font-size"] [data-testid="segmented-option-large"]').click()
    const after = await shell.page.evaluate(() => ({
      theme: document.documentElement.dataset.theme ?? '',
      fontSize: document.documentElement.dataset.fontSize ?? '',
    }))
    ev.assert('A: 切浅色后根槽位即时生效（data-theme=light）', after.theme === 'light', {
      channel: 'A', expected: "data-theme='light'", actual: `data-theme='${after.theme}'`,
    })
    ev.assert('A: 切大字号后根槽位即时生效（data-font-size=large）', after.fontSize === 'large', {
      channel: 'A', expected: "data-font-size='large'", actual: `data-font-size='${after.fontSize}'`,
    })
    const probeKept = await shell.page.evaluate(() => document.querySelector('[data-testid="settings-screen"]')?.getAttribute('data-probe-mount') ?? null)
    ev.assert('A: 切换不重挂载（settings-screen 探针属性保留）', probeKept === 'v11', {
      channel: 'A', expected: "data-probe-mount='v11' 保留", actual: probeKept === null ? '节点已重建（重挂载）' : `探针=${probeKept}`,
    })
    const prefsStored = await shell.page.evaluate((key) => window.localStorage.getItem(key), MOBILE_PREFS_STORAGE_KEY)
    ev.assert('A: 偏好落盘 localStorage（taiji.mobile.prefs = light/large）', Boolean(prefsStored?.includes('"light"') && prefsStored?.includes('"large"')), {
      channel: 'A', expected: '含 "theme":"light" 与 "fontSize":"large"', actual: prefsStored ?? '(storage 无键)',
    })
    await ev.shot(shell.page, 'a11-prefs-applied')

    // ── 刷新 → 偏好保持 ──
    await shell.page.reload({ waitUntil: 'domcontentloaded' })
    const reconnected = await waitForShellConnected(shell.page, { timeoutMs: 30_000 })
    ev.assert('A: 刷新后壳恢复 connected（storage 凭据自动验身）', reconnected, {
      channel: 'A', expected: 'bottom-nav 可见', actual: reconnected ? '可见' : '刷新后未恢复',
    })
    const persisted = await shell.page.evaluate(() => ({
      theme: document.documentElement.dataset.theme ?? '',
      fontSize: document.documentElement.dataset.fontSize ?? '',
    }))
    ev.assert('A: 刷新后主题保持浅色', persisted.theme === 'light', {
      channel: 'A', expected: "data-theme='light'", actual: `data-theme='${persisted.theme}'`,
    })
    ev.assert('A: 刷新后字号保持大档', persisted.fontSize === 'large', {
      channel: 'A', expected: "data-font-size='large'", actual: `data-font-size='${persisted.fontSize}'`,
    })
    await shell.page.locator('[data-testid="mobile-nav-settings"]').click()
    await waitForTestidVisible(shell.page, 'settings-screen', { timeoutMs: 15_000 })
    const lightSelected = await shell.page
      .locator('[data-testid="settings-theme"] [data-testid="segmented-option-light"]')
      .getAttribute('aria-selected')
    const largeSelected = await shell.page
      .locator('[data-testid="settings-font-size"] [data-testid="segmented-option-large"]')
      .getAttribute('aria-selected')
    ev.assert('A: 设置屏控件选中态与偏好一致', lightSelected === 'true' && largeSelected === 'true', {
      channel: 'A', expected: 'light 与 large 段 aria-selected=true', actual: `light=${lightSelected} large=${largeSelected}`,
    })
    await ev.shot(shell.page, 'a11-prefs-persisted')

    // ── 打开已退出会话 C：历史可见 + dead 窗口内 Composer 形态对照契约 ──
    await shell.page.locator('[data-testid="mobile-nav-sessions"]').click()
    await shell.page
      .locator(`[data-testid="session-row-${sidC}"]`)
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    const openStatusBefore = await waitSessionStatus(proto, sidC, 'dead', { timeoutMs: 5_000 }).catch(() => null)
    await shell.page.locator(`[data-testid="session-row-${sidC}"]`).first().click()
    await waitForTestidVisible(shell.page, 'chat-screen', { timeoutMs: 20_000 })
    const historyVisible = await waitForTextVisible(shell.page, MARK[LABEL_OPEN], { timeoutMs: 30_000 })
    ev.assert('A: 已退出会话历史可见（只读历史在流）', historyVisible, {
      channel: 'A', expected: MARK[LABEL_OPEN], actual: historyVisible ? '可见' : '30s 内未出现',
    })
    if (openStatusBefore === 'dead') {
      // 前提核实于点入前一刻：dead 前提窗口内的 Composer 形态断言（设计 §7.2 映射表：
      // dead 会话「聊天历史只读、输入条隐藏」）。惰性恢复（switch 内 ensureActive）可能
      // 抢先复活会话——复活即前提消失，如实记 uncovered，不判红。
      const composerStillDead = await waitSessionStatus(proto, sidC, 'dead', { timeoutMs: 3_000 }).catch(() => null)
      const composerVisible = await shell.page
        .locator('[data-testid="mobile-composer"]')
        .first()
        .isVisible()
        .catch(() => false)
      if (composerStillDead === 'dead') {
        ev.assert('A: dead 前提窗口内输入条缺位（契约：输入条隐藏）', composerVisible === false, {
          channel: 'A',
          expected: 'mobile-composer 不可见（会话已退出，输入条隐藏）',
          actual: composerVisible ? 'Composer 在场（dead 态可见输入条——契约缺口，ChatScreen.vue Composer v-if 仅 !formPending 无 dead 分支）' : '缺位',
        })
      } else {
        uncovered.push(`点开已退出会话的 dead 窗口错过：惰性恢复先于断言完成（点入前 status=${openStatusBefore}，断言时已非 dead）——Composer 形态未观察到`)
      }
      ev.step({ step: 'dead.open.composer', channel: 'A', exitCode: 0, stats: { composerVisible, statusNow: composerStillDead } })
    } else {
      uncovered.push(`dead 会话 C 在点入前已非 dead（status=${openStatusBefore}）——点开形态断言前提消失`)
    }
    await ev.shot(shell.page, 'a11-dead-opened')

    // ── 重新打开链路：长按 dead 会话 B 行 → 动作 Sheet「重新打开」→ 复活 ──
    await shell.page.locator('[data-testid="chat-back"]').click()
    await shell.page
      .locator(`[data-testid="session-row-${sidB}"]`)
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    const rowB = shell.page.locator(`[data-testid="session-row-${sidB}"]`).first()
    const box = await rowB.boundingBox()
    if (!box) throw new Error('session-row B boundingBox 不可得（未渲染？）')
    // 长按 480ms 阈值 + 余量；按下后位移 <8px（>8px 取消长按，spec A9）
    await shell.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await shell.page.mouse.down()
    await shell.page.waitForTimeout(700)
    await shell.page.mouse.up()
    const actionsShown = await waitForTestidVisible(shell.page, 'session-actions-list', { timeoutMs: 10_000 })
    ev.assert('A: 长按打开动作 Sheet', actionsShown, {
      channel: 'A', expected: 'session-actions-list 可见', actual: actionsShown ? '可见' : '长按后未出现',
    })
    const restoreShown = actionsShown ? await waitForTestidVisible(shell.page, 'session-action-restore', { timeoutMs: 5_000 }) : false
    ev.assert('A: dead 会话「重新打开」动作可达（仅 dead 渲染）', restoreShown, {
      channel: 'A', expected: 'session-action-restore 可见', actual: restoreShown ? '可见' : '未出现',
    })
    if (restoreShown) {
      await shell.page.locator('[data-testid="session-action-restore"]').click()
      const statusAfterRestore = await waitSessionStatus(proto, sidB, 'idle', { timeoutMs: 30_000 }).catch(() => null)
      const revived = statusAfterRestore !== null && statusAfterRestore !== 'dead'
      ev.assert('A: 重新打开后 B 复活（status 离开 dead）', revived, {
        channel: 'A', expected: "status ∈ {idle, ...} 非 dead", actual: `status=${statusAfterRestore ?? '(查询失败)'}`,
      })
      await ev.shot(shell.page, 'a11-restored')
    }
  } finally {
    if (shell) {
      if (shell.pageErrors.length > 0) ev.attach('page-errors-tail', shell.pageErrors.join('\n---\n'))
      await closeMobileShell(shell)
      ev.step({ step: 'mobile.browser.close', channel: 'C', exitCode: 0, stats: {} })
    }
  }

  log('mobile-preferences-session-exit 完成')
  return { uncovered, gotchas }
}
