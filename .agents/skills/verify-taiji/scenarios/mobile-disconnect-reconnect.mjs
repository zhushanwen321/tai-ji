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
 * 无法缩短。为制造「服务长期不在」，连杀 runtime 耗尽 supervisor 重启配额
 * （MAX_RESTARTS=5）：前 5 次死亡各触发一次重启，第 6 次死亡后不再重启，壳侧重连预算
 * 60s 耗尽 → failed 终态。全程产品机制（占端口方案在 macOS 原理性不可行已实测弃用：
 * SO_REUSEADDR 双方重叠 bind 合法、连接归后绑者）。
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
  estimateSec: 540,
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
    'A：服务不再回来 >60s → failed 进连接页 + 「连接失败」指引文案（以耗尽 supervisor 重启配额模拟，60s 预算硬编码）',
  ],
  notProvable: [
    '真实网络层断开（Wi-Fi 关断/防火墙）——以「runtime 不再回来」机制等价模拟，壳侧重连目标不可达的事实序列相同',
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

function readRuntimeStartedAt(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime-instance.json'), 'utf8')).startedAt ?? ''
}

/** 等 supervisor 重启的新 runtime 登记出现（pid 与上次被杀者不同）。超时返回 null。 */
async function waitForRuntimeRespawn(dataDir, lastKilled, { timeoutMs = 45_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const rec = readRuntimeInstance(dataDir)
      if (rec.pid !== lastKilled.pid && rec.port > 0) return rec
    } catch {
      /* json 瞬态不可读：继续轮询 */
    }
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, 500))
  }
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
    // 路由保持在 chat（断线不换视图）；chat 态 BottomNav 结构性隐藏——popstate 回列表
    await shell.page.locator('[data-testid="chat-back"]').click()
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

    // ── 第二段：预算耗尽（连杀耗尽 supervisor 重启配额 → 服务不再回来 → 60s 预算 →
    //    failed 指引）。占端口方案在 macOS 原理性不可行（SO_REUSEADDR 双方重叠 bind
    //    合法、连接归后绑者——两轮实测 supervisor 重启的 runtime 均绑回原端口），改走
    //    产品机制：runtime-supervisor 崩溃自动重启上限 MAX_RESTARTS=5（restart-policy.ts，
    //    退避 1/2/4/8/16s）——连杀 6 次（exit#1..#6），前 5 次各触发一次重启，第 6 次死亡
    //    后不再重启，壳侧重连预算（ws-client MAX_RECONNECT_DURATION_MS=60s 硬编码）耗尽
    //    落 failed。全程产品机制，无夹具 hack。
    const killTimeline = []
    const KILLS_NEEDED = 6
    let budgetInterrupted = false
    let lastKilled = { pid: -1, startedAt: '' }
    for (let i = 0; i < KILLS_NEEDED; i++) {
      // 等上一个被杀 runtime 的新实例登记出现（最后一杀后无重启，不等待）
      if (i > 0) {
        const newSpawn = await waitForRuntimeRespawn(ctx.dataDir, lastKilled, { timeoutMs: 45_000 })
        if (!newSpawn) {
          // 无重启 = 配额已尽（提前达成）或 supervisor 未按预期重启——交给 failed 观察判定
          killTimeline.push(`#${i + 1}: 无新实例登记（45s），停止连杀`)
          budgetInterrupted = true
          break
        }
      }
      const kill = sigtermRuntime(ev, ctx.dataDir)
      lastKilled = { pid: kill.pid, startedAt: readRuntimeStartedAt(ctx.dataDir) }
      killTimeline.push(`#${i + 1}: pid=${kill.pid} port=${kill.port} @${new Date(kill.killedAt).toISOString().slice(11, 23)}`)
      await new Promise((r) => setTimeout(r, 300))
    }
    ev.attach('budget-kill-timeline', killTimeline.join('\n'))
    // failed 等待：最后一次死亡 + ws-client 60s 预算 + 余量
    const failedShown = await waitForTestidVisible(shell.page, 'shell-failed-screen', { timeoutMs: 90_000 })
    const connectShown = failedShown ? await waitForTestidVisible(shell.page, 'connect-screen', { timeoutMs: 10_000 }) : false
    const failedText = failedShown ? await waitForTextVisible(shell.page, '连接失败', { timeoutMs: 5_000 }) : false
    const hintShown = failedShown ? await waitForTextVisible(shell.page, '请刷新页面重试', { timeoutMs: 5_000 }) : false
    ev.assert('A: 预算耗尽进连接页（shell-failed-screen）', failedShown, {
      channel: 'A',
      expected: '服务不再回来 >60s → shell-failed-screen 可见（60s 预算硬编码不可 env 化；以耗尽 supervisor 重启配额模拟「服务长期不在」）',
      actual: failedShown ? `failed 出现（连杀 ${killTimeline.length} 次${budgetInterrupted ? '，配额提前耗尽' : ''}）` : `90s 内未落 failed（连杀 ${killTimeline.length} 次）`,
    })
    if (failedShown) {
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
    if (shell) {
      if (shell.pageErrors.length > 0) ev.attach('page-errors-tail', shell.pageErrors.join('\n---\n'))
      await closeMobileShell(shell)
      ev.step({ step: 'mobile.browser.close', channel: 'C', exitCode: 0, stats: {} })
    }
  }

  log('mobile-disconnect-reconnect 完成')
  return { uncovered, gotchas }
}
