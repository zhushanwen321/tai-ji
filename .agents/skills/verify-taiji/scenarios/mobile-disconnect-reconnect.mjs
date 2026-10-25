/**
 * mobile-disconnect-reconnect —— 移动壳断线与重连预算（remote-use-mobile-v2 §8.2 场景 V10；
 * A10）。
 *
 * 真实用户路径（V10）：移动壳停在会话内（视图/草稿/滚动就位）→ 桌面 runtime 关停 →
 * 断线条呈现、视图不卸载 → runtime 回来 → 列表/历史收敛；再保持断网 >60s → 重连预算
 * 耗尽进连接页 + 可行动指引。
 *
 * 断线模拟形态（机制说明，非产品行为）：runtime 进程以 SIGTERM 精确杀死（PID 取
 * <dataDir>/runtime-instance.json——runtime 自登记契约，shared/runtime-instance.ts）。
 * Electron main 的 runtime-supervisor 有崩溃自动重启（restart-policy 退避 1-16s，
 * MAX_RESTARTS=5），重启走 findAvailablePort（端口段起点探测，旧端口已释放 → 复得同
 * 端口）→ 移动壳 ws-client 自动重连成功。第一段即「关 → 自动重启 → 恢复」主路径。
 *
 * 预算耗尽段：ws-client 重连总时长上限 60s 为模块硬编码常量（packages/core/src/
 * transport/ws-client.ts MAX_RECONNECT_DURATION_MS = 60_000，无 env 覆盖点——已核实），
 * 无法缩短。为制造「重连目标 >60s 不可达」，杀 runtime 后立即在本机抢占旧端口（TCP
 * listen）：supervisor 重启的 runtime 探测到旧端口被占 → 换端口段下一端口 → 移动壳
 * 死等旧地址 → 60s 预算耗尽 → failed 终态。壳侧视角与真实断网等价（重连地址不可达），
 * 差异仅在服务端实际换了端口——如实记录。抢占失败（supervisor 抢回旧端口 → 重连成功）
 * 时按夹具重试处理（重杀重抢，至多 2 次），不涉断言放宽。
 *
 * 断言（§8.2 V10 通过标准，逐条对应）：
 *   ① 断线条呈现（shell-reconnecting-banner；文案 restarting/reconnecting 双态之一）；
 *   ② 断线期间视图不卸载（chat-screen 保持）+ 草稿保留 + 滚动位置保持；
 *   ③ 恢复收敛：断线条消失 + 会话列表回到（runtime 重启后 config.sessions 重扫）
 *      + 历史回到（refreshHistory 重拉，消息文本在流）；
 *   ④ 预算耗尽：failed 进连接页（connect-screen + shell-failed-screen）+ 指引文案
 *      （「连接失败」+「请刷新页面重试…」）。
 */
import net from 'node:net'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

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

/** 会话与历史标记（恢复收敛断言的文本锚）。 */
const SESSION_LABEL = 'A10-RECONNECT'
const ROUND_MARKERS = ['ACK-ROUND-ALPHA', 'ACK-ROUND-BETA', 'ACK-ROUND-GAMMA']
/** 断线期草稿文本（Composer 输入，跨断线保留断言锚）。 */
const DRAFT_TEXT = 'draft-keep-me-through-reconnect'
/** 滚动就位目标（mobile-message-stream scrollTop）。 */
const SCROLL_TARGET = 120

export const meta = {
  id: 'mobile-disconnect-reconnect',
  priority: 'P0',
  title: '移动壳断线重连（V10）：断线条 + 视图/草稿/滚动不卸载 → 恢复收敛 → 预算耗尽进连接页 + 指引',
  covers: ['mobile.connection.banner', 'mobile.connection.reconnect', 'mobile.connection.budget'],
  requires: ['remote-access', 'mobile-dist', 'mock-http'],
  estimateSec: 420,
  remoteAccess: {},
  llm: {
    responses: {
      'mockllm/mock-1': [
        // 三轮长回复（无节流）：撑出消息流溢出供滚动就位 + 恢复后历史文本锚
        ...ROUND_MARKERS.map((m) => ({
          text: `${m} ` + 'detailed round reply for scroll depth. '.repeat(24),
          stopReason: 'stop',
        })),
        { text: 'spare-1', stopReason: 'stop' },
        { text: 'spare-2', stopReason: 'stop' },
      ],
    },
  },
  provable: [
    'A：断线条呈现且文案为 reconnecting/restarting 之一（close code 分流如实记录）',
    'A：断线期间 chat-screen 不卸载 + Composer 草稿原值保留 + 滚动位置保持',
    'A：runtime 回来后断线条消失 + 列表收敛（会话行在）+ 历史收敛（轮次文本在流）',
    'A：重连目标 >60s 不可达 → failed 进连接页 + 「连接失败」指引文案（60s 预算硬编码，机制等价模拟）',
  ],
  notProvable: [
    '真实网络层断开（Wi-Fi 关断/防火墙）——以「旧端口被占 + 服务端换端口」机制等价模拟，壳侧不可区分',
    '重连预算的精确秒数（60s 常量不可 env 化；断言只证「断线条长时间呈现后才落 failed」的事实序列）',
  ],
}

/** 读 runtime 自登记（shared/runtime-instance.ts 契约：{pid, port, startedAt}）。 */
function readRuntimeInstance(dataDir) {
  const file = path.join(dataDir, 'runtime-instance.json')
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Number.isInteger(rec.pid) || !Number.isInteger(rec.port)) {
    throw new Error(`runtime-instance.json 形态异常：${JSON.stringify(rec).slice(0, 200)}`)
  }
  return { pid: rec.pid, port: rec.port }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 优雅杀 runtime（SIGTERM 精确 PID；杀前核对存活与命令行归属——只动自己实例）。 */
function sigtermRuntime(ev, dataDir) {
  const { pid, port } = readRuntimeInstance(dataDir)
  const cmd = (() => {
    try {
      return execSync(`ps -o command= -p ${pid}`, { encoding: 'utf8' }).trim()
    } catch {
      return '(进程已不在)'
    }
  })()
  ev.step({ step: 'runtime.sigterm', channel: 'C', exitCode: isAlive(pid) ? 0 : 1, stats: { pid, port, cmd: cmd.slice(0, 200) } })
  if (!isAlive(pid)) throw new Error(`runtime pid=${pid} 已不存活（runtime-instance.json 陈旧？）`)
  process.kill(pid, 'SIGTERM')
  return { pid, port, killedAt: Date.now() }
}

/** 抢占端口（runtime 退出释放后 listen 成功；EADDRINUSE 轮询重试）。返回 server。 */
async function occupyPort(port, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const server = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', (e) => resolve({ error: e }))
      s.listen(port, '127.0.0.1', () => resolve(s))
    })
    if (server instanceof net.Server) return server
    if (Date.now() >= deadline) throw new Error(`抢占端口 ${port} 失败：${server.error?.message}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** 条件等文本出现（text 引擎全页匹配）。 */
async function waitForTextVisible(page, text, { timeoutMs = 15_000 } = {}) {
  try {
    await page.locator(`text=${text}`).first().waitFor({ state: 'visible', timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

/** 等元素消失（断线条消失 = 重连成功呈现信号）。 */
async function waitForTestidGone(page, testid, { timeoutMs = 45_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const visible = await page
      .locator(`[data-testid="${testid}"]`)
      .first()
      .isVisible()
      .catch(() => false)
    if (!visible) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** 等会话列表出现目标行（runtime 重启后 config.sessions 重扫 + connected 边沿 loadSessions）。 */
async function waitForSessionRow(page, sessionId, { timeoutMs = 30_000 } = {}) {
  try {
    await page
      .locator(`[data-testid="session-row-${sessionId}"]`)
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
    return true
  } catch {
    return false
  }
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
    uncovered.push('V10 未驱动：壳静态托管不可达——修复装配后复跑')
    return { uncovered, gotchas }
  }

  // ── 会话准备：3 轮长回复（历史 + 溢出）──
  const created = await proto.call('session.create', { cwd: ctx.repo, label: SESSION_LABEL }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  ev.step({ step: 'session.create', channel: 'B', exitCode: sid ? 0 : 1, stats: { sessionId: sid } })
  if (!sid) throw new Error('session.create 未返回 session.id')
  await proto.subscribe(sid)
  for (let i = 0; i < ROUND_MARKERS.length; i++) {
    const sinceSend = proto.events.length
    await proto.send(sid, `round ${i + 1}`)
    const end = await proto.waitTurnEnd(sid, { since: sinceSend, timeoutMs: 120_000 })
    ev.step({ step: `prep.round.${i + 1}`, channel: 'B', exitCode: end.ok ? 0 : 1, stats: { marker: ROUND_MARKERS[i], type: end.type } })
  }

  // ── 壳：打开 → connected → 进会话 → 滚动就位 + 草稿 ──
  let shell = null
  /** 占端口 server（预算耗尽段；finally 必关——防吊住 runtime 端口段与进程）。 */
  let occupier = null
  try {
    shell = await openMobileShell({ repo: ctx.repo, runtimePort, token, locale: 'zh-CN' })
    const connected = await waitForShellConnected(shell.page, { timeoutMs: 30_000 })
    ev.assert('A: 壳连接成功（bottom-nav 挂载）', connected, {
      channel: 'A', expected: 'bottom-nav 可见', actual: connected ? '可见' : '30s 内未出现',
    })
    if (!connected) {
      ev.attach('boot-console', shell.consoleLines.slice(-40).join('\n'))
      uncovered.push('V10 未驱动：壳未达 connected')
      return { uncovered, gotchas }
    }
    const chatShown = await openSessionInShell(shell.page, sid, { timeoutMs: 20_000 })
    if (!chatShown) {
      uncovered.push('V10 未驱动：会话切入失败')
      return { uncovered, gotchas }
    }
    // 等历史渲染（末轮文本锚）+ 溢出检查 + 滚动就位
    const historyLoaded = await waitForTextVisible(shell.page, ROUND_MARKERS[2], { timeoutMs: 30_000 })
    ev.assert('A: 历史渲染（末轮文本在流）', historyLoaded, {
      channel: 'A', expected: ROUND_MARKERS[2], actual: historyLoaded ? '可见' : '30s 内未出现',
    })
    const stream = shell.page.locator('[data-testid="mobile-message-stream"]')
    const overflow = await stream.evaluate((el) => el.scrollHeight - el.clientHeight)
    ev.step({ step: 'stream.overflow', channel: 'A', exitCode: overflow > 200 ? 0 : 1, stats: { overflowPx: overflow } })
    if (overflow <= 200) {
      uncovered.push(`滚动就位断言跳过：消息流未溢出（overflow=${overflow}px）——滚动位置保持无从证`)
    } else {
      await stream.evaluate((el, target) => {
        el.scrollTop = target
      }, SCROLL_TARGET)
    }
    const scrolledTo = await stream.evaluate((el) => el.scrollTop)
    // 草稿就位
    const input = shellComposerInput(shell.page)
    await input.waitFor({ state: 'visible', timeout: 15_000 })
    await input.click()
    await input.pressSequentially(DRAFT_TEXT, { delay: 10 })
    const draftIn = (await input.innerText()).includes(DRAFT_TEXT)
    ev.assert('A: 基线就位（滚动 + 草稿）', scrolledTo === SCROLL_TARGET && draftIn, {
      channel: 'A',
      expected: `scrollTop=${SCROLL_TARGET} 且草稿在输入框`,
      actual: `scrollTop=${scrolledTo} draft=${draftIn}`,
    })
    await ev.shot(shell.page, 'a10-baseline')

    // ── 第一段：杀 runtime → 断线条 + 不卸载 → 自动重启恢复 ──
    const kill1 = sigtermRuntime(ev, ctx.dataDir)
    const bannerShown = await waitForTestidVisible(shell.page, 'shell-reconnecting-banner', { timeoutMs: 20_000 })
    const bannerText = bannerShown
      ? await shell.page.locator('[data-testid="shell-reconnecting-banner"]').first().innerText()
      : ''
    ev.assert('A: 断线条呈现（shell-reconnecting-banner）', bannerShown, {
      channel: 'A', expected: '断线条可见', actual: bannerShown ? `可见，文案「${bannerText.trim()}」` : '20s 内未出现',
    })
    ev.step({
      step: 'banner.copy',
      channel: 'A',
      exitCode: bannerShown ? 0 : 1,
      stats: { text: bannerText.trim(), isRestarting: bannerText.includes('重启'), isReconnecting: bannerText.includes('重连') },
    })

    // 断线期间：视图不卸载 + 草稿保留 + 滚动保持
    const chatAlive = await shell.page
      .locator('[data-testid="chat-screen"]')
      .first()
      .isVisible()
      .catch(() => false)
    const draftKept = (await input.innerText().catch(() => '')).includes(DRAFT_TEXT)
    const scrollKept = overflow > 200 ? (await stream.evaluate((el) => el.scrollTop)) === SCROLL_TARGET : null
    ev.assert('A: 断线期间视图不卸载（chat-screen 保持）', chatAlive, {
      channel: 'A', expected: 'chat-screen 可见', actual: chatAlive ? '可见' : '已卸载',
    })
    ev.assert('A: 断线期间草稿保留', draftKept, {
      channel: 'A', expected: DRAFT_TEXT, actual: draftKept ? '原值保留' : '草稿丢失',
    })
    if (scrollKept !== null) {
      ev.assert('A: 断线期间滚动位置保持', scrollKept, {
        channel: 'A', expected: `scrollTop=${SCROLL_TARGET}`, actual: `scrollTop=${await stream.evaluate((el) => el.scrollTop)}`,
      })
    }
    await ev.shot(shell.page, 'a10-disconnected')

    // 恢复：断线条消失（ws-client 自动重连；supervisor 退避重启）→ 列表 + 历史收敛
    const bannerGone = await waitForTestidGone(shell.page, 'shell-reconnecting-banner', { timeoutMs: 60_000 })
    ev.assert('A: 重连成功（断线条消失）', bannerGone, {
      channel: 'A', expected: '断线条 60s 内消失', actual: bannerGone ? '已消失' : '仍在（重连未成）',
    })
    await shell.page.locator('[data-testid="mobile-nav-sessions"]').click()
    const rowBack = await waitForSessionRow(shell.page, sid, { timeoutMs: 30_000 })
    ev.assert('A: 恢复后列表收敛（会话行在）', rowBack, {
      channel: 'A', expected: `session-row-${sid} 可见`, actual: rowBack ? '可见' : '30s 内未回到列表',
    })
    await openSessionInShell(shell.page, sid, { timeoutMs: 20_000 })
    const historyBack = await waitForTextVisible(shell.page, ROUND_MARKERS[2], { timeoutMs: 30_000 })
    ev.assert('A: 恢复后历史收敛（轮次文本在流）', historyBack, {
      channel: 'A', expected: ROUND_MARKERS[2], actual: historyBack ? '可见' : '30s 内未回归',
    })
    await ev.shot(shell.page, 'a10-recovered')

    // ── 第二段：预算耗尽（杀 + 抢占旧端口 → 60s 预算 → failed 指引）──
    let budgetOk = false
    let budgetActual = ''
    for (let attempt = 1; attempt <= 2 && !budgetOk; attempt++) {
      const kill2 = sigtermRuntime(ev, ctx.dataDir)
      occupier = await occupyPort(kill2.port)
      ev.step({ step: 'port.occupied', channel: 'C', exitCode: 0, stats: { attempt, port: kill2.port } })
      // 等 failed（60s 预算 + 退避余量）；同时观察是否被「supervisor 抢回端口 + 重连成功」翻盘
      const deadline = Date.now() + 90_000
      let failedShown = false
      while (Date.now() < deadline) {
        failedShown = await shell.page
          .locator('[data-testid="shell-failed-screen"]')
          .first()
          .isVisible()
          .catch(() => false)
        if (failedShown) break
        // 夹具竞争判定：断线条已消失 = 重连成功 = 本次抢占输了 → 换下一次尝试
        const bannerStillThere = await shell.page
          .locator('[data-testid="shell-reconnecting-banner"]')
          .first()
          .isVisible()
          .catch(() => false)
        if (!bannerStillThere && attempt < 2) break
        await new Promise((r) => setTimeout(r, 500))
      }
      if (failedShown) {
        budgetOk = true
        budgetActual = `attempt=${attempt} failed 态出现`
      } else if (attempt < 2) {
        gotchas.push(`预算耗尽夹具 attempt=${attempt} 竞争失败（supervisor 重启抢回旧端口、壳重连成功）——重杀重抢一次`)
        if (occupier) {
          await new Promise((r) => {
            occupier.close(() => r())
          })
          occupier = null
        }
        // 等壳回到 connected 稳定态再重杀（重连边沿收敛，防叠加断线态）
        await waitForShellConnected(shell.page, { timeoutMs: 30_000 })
      } else {
        budgetActual = '两次尝试均未落 failed（抢占竞争两次失利或预算未耗尽）'
      }
    }
    ev.assert('A: 预算耗尽进连接页（shell-failed-screen）', budgetOk, {
      channel: 'A',
      expected: '断网 >60s → shell-failed-screen 可见（60s 预算硬编码不可 env 化，端口抢占机制等价模拟）',
      actual: budgetActual,
    })
    if (budgetOk) {
      const connectShown = await waitForTestidVisible(shell.page, 'connect-screen', { timeoutMs: 10_000 })
      const failedText = await waitForTextVisible(shell.page, '连接失败', { timeoutMs: 5_000 })
      const hintShown = await waitForTextVisible(shell.page, '请刷新页面重试', { timeoutMs: 5_000 })
      ev.assert('A: failed 落连接页（connect-screen 路由）', connectShown, {
        channel: 'A', expected: 'connect-screen 可见', actual: connectShown ? '可见' : '仍在聊天布局',
      })
      ev.assert('A: failed 指引文案（「连接失败」+「请刷新页面重试」）', failedText && hintShown, {
        channel: 'A',
        expected: 'shell-failed 文案 + 可行动 hint',
        actual: `failed=${failedText} hint=${hintShown}`,
      })
      await ev.shot(shell.page, 'a10-budget-exhausted')
    }
  } finally {
    if (occupier) {
      await new Promise((r) => {
        occupier.close(() => r())
      })
    }
    if (shell) {
      if (shell.pageErrors.length > 0) ev.attach('page-errors-tail', shell.pageErrors.join('\n---\n'))
      await closeMobileShell(shell)
      ev.step({ step: 'mobile.browser.close', channel: 'C', exitCode: 0, stats: {} })
    }
  }

  log('mobile-disconnect-reconnect 完成')
  return { uncovered, gotchas }
}
