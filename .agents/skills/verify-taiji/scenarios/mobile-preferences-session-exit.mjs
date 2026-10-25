/**
 * mobile-preferences-session-exit —— 移动壳偏好持久化 + 已退出会话（remote-use-mobile-v2
 * §8.2 场景 V11；A11）。
 *
 * 真实用户路径（V11）：设置屏切浅色主题 + 大字号（即时生效）→ 刷新页面（偏好保持）→
 * 打开一个已退出（dead）会话（点开即恢复形态）→ 动作 Sheet「重新打开」链路可达。
 *
 * dead 会话语义（shared/session.ts:7 亲读）＝「前端收到 session.exited 后标记」——
 * runtime 的 session.list 永不下发 dead（纯客户端标记），且为内存态、页面刷新即失。
 * 由此两条场景约束：①壳必须先订阅目标会话（点入过）才能收到 session.exited 并在行上
 * 呈现「已退出」——dead 断言全部排在 reload 之前；②「重新打开」链路同样依赖客户端
 * dead 标记（动作项 v-if status==='dead'），也排在 reload 之前。pi 进程以 SIGKILL
 * 精确杀死（PID = pgrep -P <runtimePid> + 命令行核对 `--mode rpc`，只动本实例的子进程；
 * 串行制造保证「当时唯一」可定位性——SIGTERM 会走 pi 优雅退出、runtime 侧翻 done 不出
 * exited 崩溃帧，首跑实测改 SIGKILL）。
 *
 * dead 只读窗口与点开即恢复（2026-10-25 裁决，fix-mfix-s）：设计 §7.2:196 旧字面
 * 「聊天历史只读、输入条隐藏」与 runtime 既有恢复机制冲突——pi 被 SIGKILL 后 pi-respawn
 * 编排延迟 5s 自动 respawn + session.restored 广播（ensureActive 惰性恢复不推该帧，
 * protocol.ts:2491），壳经 restored → revive 翻活 status 并插恢复通知；该链在点开
 * （selectSession → switch RPC）挂载 ChatScreen 前后数秒内完成，dead 形态窗口真机
 * 结构性不可达。场景断言按实现现实收敛：点开 dead 会话断「恢复通知在场 + 恢复后发送链
 * 可达 + 历史可见」；输入条隐藏语义由 ChatScreen 组件测试守卫（恢复失败/恢复中窗口），
 * 设计语义修订呈报 D5 终态同步。
 *
 * 断言（§8.2 V11 通过标准 + F14/偏好持久化映射）：
 *   ① 即时生效：切浅色 + 大字号后 html 根槽位 data-theme/data-font-size 切换，且
 *      settings-screen 未重挂载（预置探针属性跨切换保留）；
 *   ② dead 呈现：壳订阅过的会话在 pi 被杀后行状态词翻「已退出」（session.exited →
 *      客户端 store → 行刷新）；
 *   ③ 已退出会话点开：历史文本在流 + 流内恢复通知在场（pi-respawn 自动恢复）+
 *      恢复后发送链可达（Composer 在场 + 发送后 user 气泡回显在流，不等 LLM 回复——
 *      不依赖恢复后新 pi 的响应脚本出队位置）；
 *   ④ 重新打开链路：长按 B → 动作 Sheet「重新打开」（仅 dead 渲染）→ 点击后行状态
 *      离开「已退出」（restore RPC 重建 pi → status 翻活）；
 *   ⑤ 刷新后偏好保持：localStorage 读侧 + 设置屏控件选中态 + 根槽位（重进设置屏后
 *      applyMobilePrefs 异步落根，条件等槽位出现再断言——直接读会撞上应用前的空窗）。
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
  MOBILE_PREFS_STORAGE_KEY,
  closeMobileShell,
  openMobileShell,
  openSessionInShell,
  probeShellServing,
  resolveMobileDist,
  waitForShellConnected,
  waitForTestidVisible,
} from './lib/mobile-shell-helper.mjs'
import { sendViaComposer } from './lib/mobile-task-flow.mjs'

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
  title: '移动壳偏好与已退出会话（V11）：浅色+大字号即时生效 → dead 行呈现与点开即恢复形态 → 重新打开链路 → 刷新偏好保持',
  covers: ['session.restore', 'mobile.prefs.apply'],
  requires: ['remote-access', 'mobile-dist', 'mock-http'],
  estimateSec: 420,
  remoteAccess: {},
  llm: {
    responses: {
      'mockllm/mock-1': [
        { text: `${MARK[LABEL_RESTORE]} 回复`, stopReason: 'stop' },
        { text: `${MARK[LABEL_OPEN]} 回复`, stopReason: 'stop' },
        { text: `${MARK[LABEL_LIVE]} 回复`, stopReason: 'stop' },
        { text: 'spare-1', stopReason: 'stop' },
        { text: 'spare-2', stopReason: 'stop' },
      ],
    },
  },
  provable: [
    'A：切浅色 + 大字号后 html 根槽位即时切换，settings-screen 未重挂载',
    'A：壳订阅过的会话 pi 被杀后行状态词翻「已退出」（session.exited → 客户端 dead 标记）',
    'A：点开已退出会话：历史可见 + 流内恢复通知在场（pi-respawn 自动恢复）+ 恢复后发送链可达（Composer 在场 + user 气泡回显）',
    'A：动作 Sheet「重新打开」可达且点击后行状态离开「已退出」',
    'A：reload 后偏好保持（localStorage + 控件选中态 + 重进设置屏后的根槽位）',
  ],
  notProvable: [
    '真实手机字号/主题的视觉像素（断言根槽位与控件态，不证渲染像素——像素面归 E2E-VISUAL）',
    'dead 标记跨刷新持久性（客户端内存态、刷新即失——机制事实记录于 gotchas，非本场景裁决面）',
    'dead 只读窗口（「输入条隐藏」旧字面）真机形态：被点开链的 pi-respawn 自动恢复取代（杀 pi 后 5s 延迟 respawn + session.restored → 壳 revive，dead 窗口结构性不可达）——输入条隐藏语义由 ChatScreen 组件测试守卫（恢复失败/恢复中窗口），设计语义修订（§5 dead 态 = 点开即恢复 + 恢复通知在场）呈报 D5 终态同步（2026-10-25 裁决）',
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
 *  形态（SIGTERM 走 pi 优雅退出，runtime 侧翻 done 不出 exited 崩溃帧——首跑实测）。 */
function killSoleRuntimeChildPi(ev, dataDir) {
  const runtimePid = readRuntimePid(dataDir)
  const pis = listRuntimeChildPis(runtimePid).filter((x) => /--mode(\s+|=)rpc/.test(x.cmd))
  ev.step({
    step: 'pi.locate',
    channel: 'C',
    exitCode: pis.length === 1 ? 0 : 1,
    stats: { runtimePid, candidates: pis.map((x) => ({ pid: x.pid, head: x.cmd.slice(0, 120) })) },
  })
  if (pis.length !== 1) throw new Error(`pi 定位歧义：期望唯一 --mode rpc 子进程，实际 ${pis.length} 个`)
  process.kill(pis[0].pid, 'SIGKILL')
  return pis[0].pid
}

/**
 * 等 session.exited 广播（runtime 侧进程退出确认）。SIGKILL 的 exit code 就是 null
 * （信号杀死无退出码）——命中与否用 hit 区分，不得以 code 判（null ?? null 会把
 * 「命中但 code=null」误判成未命中，跑批实测）。
 */
async function waitSessionExited(ev, proto, sessionId, { timeoutMs = 20_000 } = {}) {
  try {
    const evt = await proto.waitFor((e) => e.type === 'session.exited', { timeoutMs, sessionId })
    return { hit: true, code: evt.payload?.code ?? null, reason: evt.payload?.reason ?? '' }
  } catch (e) {
    // 帧未达归因兜底：最近帧类型清单（区分「无广播」vs「广播了但类型/归属不符」）
    const recent = proto.events.slice(-12).map((x) => `${x.type}:${x.payload?.sessionId ?? ''}`)
    ev.attach(`session-exited-miss-${sessionId.slice(0, 8)}`, `${e instanceof Error ? e.message : String(e)}\n${recent.join('\n')}`)
    return { hit: false, code: null, reason: '' }
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
  const gotchas = [
    'dead 是纯客户端内存态标记（session.exited → store），runtime 的 session.list 不下发、页面刷新即失——「已退出」呈现与「重新打开」链路都要求壳订阅过该会话且未刷新；刷新后行回到 runtime summary 终态词（如「已完成」）',
    'dead 只读窗口被 pi-respawn 自动恢复取代：杀 pi 后 runtime 延迟 5s 自动 respawn + session.restored 广播（ensureActive 惰性恢复不推该帧，protocol.ts:2491）→ 壳 revive 翻活 status + 流内恢复通知——恢复完成点落在点开链前后数秒（行断言与 composer 断言之间实测），dead 形态窗口真机结构性不可达；点开 dead 断言按恢复形态收敛（2026-10-25 裁决，设计语义修订呈报 D5）',
    '恢复通知文案源 = ui 包 locale respawnRestored（「会话引擎已从崩溃中恢复…可继续发消息」），断言文本锚「已从崩溃中恢复」',
  ]
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

  // ── 壳先连接（订阅前提）──
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

    // ── 串行制造两个 dead（壳订阅在案：点入 → 返回 → 杀 → 等 session.exited）──
    async function makeDeadWithShellSubscription(label, marker) {
      const sid = await createSessionWithOneRound(ctx, proto, label)
      // 壳点入（订阅建立）→ 返回列表
      const opened = await openSessionInShell(shell.page, sid, { timeoutMs: 20_000 })
      if (!opened) throw new Error(`壳点入 ${label} 失败（订阅前提缺失）`)
      await waitForTextVisible(shell.page, marker, { timeoutMs: 20_000 })
      await shell.page.locator('[data-testid="chat-back"]').click()
      await waitForTestidVisible(shell.page, 'bottom-nav', { timeoutMs: 10_000 })
      // 杀当时唯一的 pi（该会话的）→ 等 exited 广播（壳同连接在案）
      const piPid = killSoleRuntimeChildPi(ev, ctx.dataDir)
      const exited = await waitSessionExited(ev, proto, sid)
      ev.step({ step: `dead.make.${label}`, channel: 'C', exitCode: exited.hit ? 0 : 1, stats: { sid, piPid, ...exited } })
      if (!exited.hit) throw new Error(`杀 pi(${piPid}) 后 20s 内无 session.exited 广播（${label}）`)
      return sid
    }

    const sidB = await makeDeadWithShellSubscription(LABEL_RESTORE, MARK[LABEL_RESTORE])
    const sidC = await makeDeadWithShellSubscription(LABEL_OPEN, MARK[LABEL_OPEN])
    const sidA = await createSessionWithOneRound(ctx, proto, LABEL_LIVE)
    ev.step({ step: 'dead.make.live-control', channel: 'C', exitCode: 0, stats: { sidA } })

    // ── dead 行呈现（客户端 dead 标记 → 行状态词「已退出」）──
    await shell.page.locator('[data-testid="mobile-nav-sessions"]').click()
    const rowB = shell.page.locator(`[data-testid="session-row-${sidB}"]`).first()
    const rowC = shell.page.locator(`[data-testid="session-row-${sidC}"]`).first()
    await rowB.waitFor({ state: 'visible', timeout: 20_000 })
    const rowBText = await rowB.innerText()
    const rowCText = await rowC.innerText()
    const rowBDead = rowBText.includes('已退出')
    const rowCDead = rowCText.includes('已退出')
    ev.assert('A: 已退出会话行呈「已退出」状态词（B/C 两行）', rowBDead && rowCDead, {
      channel: 'A',
      expected: 'session-row 文本含「已退出」（session.exited → 客户端 dead 标记 → 行刷新）',
      actual: `B=${rowBDead} C=${rowCDead}（B 词=${rowBText.replace(/\n/g, '/').slice(0, 40)}）`,
    })
    await ev.shot(shell.page, 'a11-session-list-dead')

    // ── 点开已退出会话 C：历史可见 + 流内恢复通知 + 恢复后发送链可达 ──
    // （2026-10-25 裁决：dead 只读窗口被点开链的 pi-respawn 自动恢复取代——杀 pi 后
    // runtime 5s 延迟自动 respawn + session.restored 广播 → 壳 revive 翻活 status 并插
    // 恢复通知，dead 形态窗口真机结构性不可达；原「输入条缺位」断言移除，输入条隐藏
    // 语义由 ChatScreen 组件测试守卫恢复失败/恢复中窗口，设计语义修订呈报 D5）
    await rowC.click()
    await waitForTestidVisible(shell.page, 'chat-screen', { timeoutMs: 20_000 })
    const historyVisible = await waitForTextVisible(shell.page, MARK[LABEL_OPEN], { timeoutMs: 30_000 })
    ev.assert('A: 已退出会话历史可见（历史在流）', historyVisible, {
      channel: 'A', expected: MARK[LABEL_OPEN], actual: historyVisible ? '可见' : '30s 内未出现',
    })
    // ① 流内恢复通知（pi-respawn 自动恢复 → session.restored → 前端恢复提示条；5s 延迟
    // + spawn 耗时，30s 预算覆盖）
    const restoreNoticeVisible = await waitForTextVisible(shell.page, '已从崩溃中恢复', { timeoutMs: 30_000 })
    ev.assert('A: 点开 dead 会话后流内恢复通知在场（点开即恢复形态）', restoreNoticeVisible, {
      channel: 'A',
      expected: '流内恢复通知（「会话引擎已从崩溃中恢复…可继续发消息」提示条）',
      actual: restoreNoticeVisible ? '可见' : '30s 内未出现（session.restored 未送达或未渲染）',
    })
    // ② 恢复后可继续发消息：Composer 在场 + 发送链可达（user 气泡回显在流——不等 LLM
    // 回复，不依赖恢复后新 pi 的响应脚本出队位置）
    const composerVisible = await waitForTestidVisible(shell.page, 'mobile-composer', { timeoutMs: 15_000 })
    ev.assert('A: 恢复后 Composer 在场（可继续发消息形态）', composerVisible, {
      channel: 'A',
      expected: 'mobile-composer 可见（恢复完成，会话可交互）',
      actual: composerVisible ? '可见' : '15s 内未出现',
    })
    if (composerVisible) {
      const PING = 'A11-C-REVIVE-PING'
      await sendViaComposer(shell.page, PING)
      const sentEcho = await waitForTextVisible(shell.page, PING, { timeoutMs: 15_000 })
      ev.assert('A: 恢复后发送链可达（发送后 user 气泡回显在流）', sentEcho, {
        channel: 'A',
        expected: `user 气泡含 ${PING}`,
        actual: sentEcho ? '回显可见' : '15s 内未出现（发送链未通）',
      })
      ev.step({ step: 'dead.open.composer', channel: 'A', exitCode: sentEcho ? 0 : 1, stats: { composerVisible, sentEcho } })
    }
    await ev.shot(shell.page, 'a11-dead-opened')

    // ── 重新打开链路：长按 dead 会话 B 行 → 动作 Sheet「重新打开」→ 复活 ──
    await shell.page.locator('[data-testid="chat-back"]').click()
    await rowB.waitFor({ state: 'visible', timeout: 20_000 })
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
      // 复活确认（壳侧）：行状态词离开「已退出」（restore RPC → runtime 重建 pi →
      // 客户端 store status 翻活 → 行刷新）
      const deadline = Date.now() + 30_000
      let revived = false
      while (Date.now() < deadline) {
        const txt = await rowB.innerText().catch(() => '')
        if (txt !== '' && !txt.includes('已退出')) {
          revived = true
          break
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      ev.assert('A: 重新打开后 B 复活（行状态离开「已退出」）', revived, {
        channel: 'A',
        expected: 'restore 前「已退出」→ restore 后状态词翻活',
        actual: revived ? '状态词已翻活' : '30s 内仍呈「已退出」',
      })
      await ev.shot(shell.page, 'a11-restored')
    }

    // ── 设置屏：切浅色 + 大字号 → 即时生效（不重挂载）──
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

    // ── 刷新 → 偏好保持（storage 读侧 + 控件选中态 + 重进设置屏后的根槽位）──
    await shell.page.reload({ waitUntil: 'domcontentloaded' })
    const reconnected = await waitForShellConnected(shell.page, { timeoutMs: 30_000 })
    ev.assert('A: 刷新后壳恢复 connected（storage 凭据自动验身）', reconnected, {
      channel: 'A', expected: 'bottom-nav 可见', actual: reconnected ? '可见' : '刷新后未恢复',
    })
    await shell.page.locator('[data-testid="mobile-nav-settings"]').click()
    await waitForTestidVisible(shell.page, 'settings-screen', { timeoutMs: 15_000 })
    // 根槽位由 SettingsScreen.onMounted → loadMobilePrefs → applyMobilePrefs 异步落
    // （reload 后停在 sessions 屏时根节点无 data-theme——条件等应用完成再断言）
    const deadline = Date.now() + 10_000
    let persisted = { theme: '', fontSize: '' }
    while (Date.now() < deadline) {
      persisted = await shell.page.evaluate(() => ({
        theme: document.documentElement.dataset.theme ?? '',
        fontSize: document.documentElement.dataset.fontSize ?? '',
      }))
      if (persisted.theme === 'light' && persisted.fontSize === 'large') break
      await new Promise((r) => setTimeout(r, 250))
    }
    ev.assert('A: 刷新后主题保持浅色（重进设置屏根槽位生效）', persisted.theme === 'light', {
      channel: 'A', expected: "data-theme='light'", actual: `data-theme='${persisted.theme}'`,
    })
    ev.assert('A: 刷新后字号保持大档（重进设置屏根槽位生效）', persisted.fontSize === 'large', {
      channel: 'A', expected: "data-font-size='large'", actual: `data-font-size='${persisted.fontSize}'`,
    })
    const lightSelected = await shell.page
      .locator('[data-testid="settings-theme"] [data-testid="segmented-option-light"]')
      .getAttribute('aria-selected')
    const largeSelected = await shell.page
      .locator('[data-testid="settings-font-size"] [data-testid="segmented-option-large"]')
      .getAttribute('aria-selected')
    ev.assert('A: 设置屏控件选中态与偏好一致', lightSelected === 'true' && largeSelected === 'true', {
      channel: 'A', expected: 'light 与 large 段 aria-selected=true', actual: `light=${lightSelected} large=${largeSelected}`,
    })
    const prefsAfterReload = await shell.page.evaluate((key) => window.localStorage.getItem(key), MOBILE_PREFS_STORAGE_KEY)
    ev.assert('A: 刷新后 localStorage 偏好仍在', Boolean(prefsAfterReload?.includes('"light"') && prefsAfterReload?.includes('"large"')), {
      channel: 'A', expected: 'storage 键保持', actual: prefsAfterReload ?? '(storage 无键)',
    })
    await ev.shot(shell.page, 'a11-prefs-persisted')
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

/** 条件等文本可见（消息流/指引文案的呈现事实锚）。 */
async function waitForTextVisible(page, text, { timeoutMs = 15_000 } = {}) {
  try {
    await page.locator(`text=${text}`).first().waitFor({ state: 'visible', timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}
