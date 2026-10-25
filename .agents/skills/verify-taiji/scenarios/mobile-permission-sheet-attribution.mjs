/**
 * mobile-permission-sheet-attribution —— 插件权限审批 Sheet：恒全局呈现（无归属一等分支）/
 * 拒绝在左 / 拒绝·允许动作回传与流内通知 / 过期撤窗（remote-use-mobile-v2 §8.2 场景 V7 的
 * 剧本化，按 §6.18 V-6 降级后的实现现实收敛；A7 验收单元）。
 *
 * 实现现实（源码核对 2026-10-26）：V-6 两问不成立（plugin-activator 组装点触发链不携带会话
 * 上下文）→ protocol `sessionId` 恒 undefined（plugin-service.ts:184 直发 activator payload）→
 * 权限请求恒为进程级全局请求，PermissionSheet 恒全局呈现、不渲染会话归属锚点
 * （PermissionSheet.vue 头注；scope-hint 文案「进程级请求，不归属特定会话」）。
 *
 * 装配：runtime 插件域 fixture（`<dataDir>/plugins/<dirName>/` 声明 permissions 的 sandbox
 * external 插件，activationEvents 置空 = 启动不自动激活、由剧本经 plugin.toggle 直触激活链
 * 全程掌控时序）+ env TAIJI_PLUGIN_PERMISSION_TIMEOUT_MS=45000（审批等待到期逃生门，
 * plugin-activator.ts readEnvPermissionTimeoutMs）+ faux + remote-access。
 *
 * 三段路径（同一请求单例 controller，新请求覆盖旧弹窗）：
 *   ① toggle → 请求 #1 → Sheet 全局呈现断言（会话列表页在场即弹 = 恒全局）→ Deny →
 *      流内「已拒绝本次权限请求」+ B: resolved 帧 + plugin.list 不 ACTIVE；
 *   ② toggle → 请求 #2 → 进聊天页经待授权条（chat-permission-bar）打开 Sheet → Allow →
 *      流内「已允许本次权限请求」+ B: resolved 帧 + plugin.list status=active（批准后激活放行）；
 *   ③ revokePermissions + toggle → 请求 #3 → 不作答等待到期 → B: expired 帧 + Sheet 自动关 +
 *      错误条「请求已过期」+ plugin.list 不 ACTIVE（超时取消非判拒，UNLOADED）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  backToList,
  closeShell,
  openConnectedShell,
  openSessionByRow,
  pollFor,
} from './lib/mobile-drive.mjs'

const PLUGIN_ID = 'mobile-perm-demo'
const PERMISSIONS = ['providers.list']
const PERM_TIMEOUT_MS = 45_000

/** 场景模块 import 阶段执行（先于 runner 的 instance.launch——插件发现在 launch 期 scan）。 */
function resolveDataDirFromArgv() {
  const argv = process.argv.slice(2)
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`)
    if (i === -1) return process.env[name === 'data-dir' ? 'TAIJI_VERIFY_DATA_DIR' : name] ?? null
    const v = argv[i + 1]
    return v === undefined || v.startsWith('--') ? null : v
  }
  const explicit = flag('data-dir')
  if (explicit) {
    const expanded = explicit.startsWith('~') ? path.join(os.homedir(), explicit.slice(1)) : path.resolve(explicit)
    return path.resolve(expanded)
  }
  const runId = flag('run-id')
  if (!runId) {
    throw new Error('[mobile-permission-sheet-attribution] 缺 --run-id/--data-dir：插件 fixture 预置需与 runner 同源派生 dataDir')
  }
  return path.join(os.homedir(), '.taiji-dev', `verify-${runId}`)
}

/** 落盘 fixture 插件（sandbox external 一律需审批；activateBody 空实现——批准后激活零 RPC 依赖）。 */
function seedPermissionGatePlugin(dataDir) {
  const dir = path.join(dataDir, 'plugins', PLUGIN_ID)
  fs.mkdirSync(dir, { recursive: true })
  const pkg = {
    name: '@verify/mobile-perm-demo',
    version: '0.1.0',
    private: true,
    type: 'module',
    displayName: 'MobilePermDemo (verify fixture)',
    description: 'A7 permission gate fixture: activation stalls on approval gate',
    taijiPlugin: {
      manifestVersion: 1,
      main: 'index.js',
      // 置空激活事件：启动期 handleEvent 不自动激活，激活时机由剧本 plugin.toggle 直触——
      // 壳连接时序与请求广播时序解耦（broadcast 只投递已连接端，启动期自发弹会错过壳）
      activationEvents: [],
      permissions: PERMISSIONS,
    },
  }
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `// verify-taiji fixture（A7；激活体零 RPC——本剧本只验审批门呈现与回传，不消费插件能力）\nexport async function activate() {}\nexport async function deactivate() {}\n`,
    'utf8',
  )
  return dir
}

const seedDir = resolveDataDirFromArgv()
seedPermissionGatePlugin(seedDir)

export const meta = {
  id: 'mobile-permission-sheet-attribution',
  priority: 'P0',
  title: '插件权限审批：Sheet 恒全局呈现（无归属一等分支）+ 拒绝在左 + 允许/拒绝回传与流内通知 + 过期撤窗（§8.2 V7 按 §6.18 降级实现收敛）',
  covers: ['mobile.permission.sheet', 'interaction.permission', 'plugin.list'],
  requires: ['faux', 'remote-access', 'mobile-dist'],
  estimateSec: 300,
  remoteAccess: {},
  faux: {
    responses: [{ text: 'A7 会话已就绪（通知宿主会话）。', stopReason: 'stop' }],
  },
  env: { TAIJI_PLUGIN_PERMISSION_TIMEOUT_MS: String(PERM_TIMEOUT_MS) },
  provable: [
    'C：fixture 插件落盘 <dataDir>/plugins/mobile-perm-demo（声明 permissions、activationEvents 置空）',
    'B：plugin.toggle 触发激活链停在权限门——plugin:permissionRequest 广播 {pluginId, permissions, requestId} 且无 sessionId 字段（§6.18 V-6 降级协议事实）',
    'A：请求到达时壳在会话列表页，Sheet 即全局弹出（挂壳根级、无会话归属锚点；scope-hint 文案含「不归属特定会话」）',
    'A：权限作用域逐条呈现（permission-sheet-perm-providers.list）；「拒绝」按钮几何位置在「允许」左侧（安全侧在左）',
    'A：拒绝后 Sheet 收层 + 流内「已拒绝本次权限请求」通知；B：plugin:permissionRequestResolved 帧到 + plugin.list 该插件非 active',
    'A：允许路径经聊天页待授权条（chat-permission-bar）打开 Sheet 回传；流内「已允许本次权限请求」；B：resolved 帧到 + plugin.list status=active（批准放行激活）',
    'B/A：请求 #3 不作答等待到期——plugin:permissionRequestExpired 帧到、Sheet 自动关 + 错误条「请求已过期」、plugin.list 非 active（超时取消非判拒）',
  ],
  notProvable: [
    '可归属请求的会话归属聚合（§6.18 正常分支）——V-6 两问不成立后 sessionId 恒不填，一等分支即全部现实；归属呈现位留待插件激活链重构后扩展',
    '桌面端 PermissionRequestDialog 双端一致性（本剧本只驱动移动壳；resolved 广播撤回对端的机制由 controller 单测覆盖）',
    '真实插件沙箱能力面的权限校验（providers.list 等 RPC 的 fail-closed 行为归 plugin 域其他剧本）',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir } = ctx
  const uncovered = []
  const gotchas = [
    'permissionRequest 广播只投递已连接端——fixture 的 activationEvents 置空 + plugin.toggle 直触激活，把广播时机压到壳连接之后（启动期自发弹会被壳错过且无快照补拉）',
    '审批等待到期 env（TAIJI_PLUGIN_PERMISSION_TIMEOUT_MS）是请求粒度：每条请求从各自审批门起算 45s，三段路径互不影响',
    'deny 语义 = 拒绝本次申请不持久化（plugin.denyPermissions 只 resolve pending），二次 toggle 会重新弹审批；approve 才 grant+save',
  ]

  // C：fixture 落盘取证（import 阶段已写，此处取事实）
  const fixtureDir = path.join(dataDir, 'plugins', PLUGIN_ID)
  const fixtureSeeded = fs.existsSync(path.join(fixtureDir, 'package.json')) && fs.existsSync(path.join(fixtureDir, 'index.js'))
  ev.assert('C: fixture 插件已落盘（package.json + index.js，launch 前）', fixtureSeeded, {
    channel: 'C', expected: `${fixtureDir}/ 发现场`, actual: fixtureSeeded ? '两文件均在' : 'fixture 缺失（import 阶段 seed 未生效？）',
  })

  const listed0 = await protocol.call('plugin.list', {})
  const p0 = (listed0.plugins ?? []).find((p) => p.pluginId === PLUGIN_ID)
  ev.assert('B: 插件被 registry 扫描（plugin.list 含 fixture）', Boolean(p0), {
    channel: 'B', expected: `${PLUGIN_ID} 在列表`, actual: p0 ? `status=${p0.status} trust=${p0.trustLevel}` : `ids=${(listed0.plugins ?? []).map((p) => p.pluginId).join(',')}`,
  })
  if (!p0) {
    uncovered.push('后续断言未驱动：fixture 未被扫描（plugins 目录 discovery 链）')
    return { uncovered, gotchas }
  }

  // 壳侧就位：开壳 → 建通知宿主会话并点入（activeSessionId 落位 = 流内通知的分区目标）→ 回列表
  const opened = await openConnectedShell(ctx)
  const shell = opened.shell
  try {
    ev.assert('A: 移动壳已连接并落会话列表', opened.ok, {
      channel: 'A', expected: 'screen-sessions 可见', actual: `锚点=${opened.anchor}`,
    })
    if (!opened.ok) {
      uncovered.push('后续断言未驱动：壳未落到会话列表')
      return { uncovered, gotchas }
    }
    const created = await protocol.call('session.create', { cwd: ctx.repo, label: 'A7-通知宿主会话' }, { timeoutMs: 120_000 })
    const sid = created.session?.id
    if (!sid) throw new Error('session.create 未返回 sessionId')
    await protocol.subscribe(sid)
    const entered = await pollFor(async () => {
      if ((await shell.page.locator(`[data-testid="session-row-${sid}"]`).count()) === 0) return false
      return openSessionByRow(shell.page, sid)
    }, { timeoutMs: 30_000 })
    ev.assert('A: 通知宿主会话已点入（activeSessionId 落位）', entered === true, {
      channel: 'A', expected: 'chat-screen 可见', actual: entered ? '在' : '30s 未现',
    })
    if (entered !== true) {
      uncovered.push('流内通知断言未驱动：宿主会话未切入')
      return { uncovered, gotchas }
    }
    const backOk = await backToList(shell.page)
    ev.step({ step: 'drive.host-session', channel: 'A', exitCode: backOk ? 0 : 1, stats: { sid, backOk } })

    // ── 段 1：请求 #1 → 全局呈现 + 拒绝在左 → Deny ──
    let since = protocol.events.length
    await protocol.call('plugin.toggle', { pluginId: PLUGIN_ID, enabled: true })
    const req1 = await waitForFrame(protocol, 'plugin:permissionRequest', since, { timeoutMs: 30_000 })
    ev.assert('B: 激活链停在权限门（plugin:permissionRequest 广播）', req1 !== null, {
      channel: 'B', expected: 'plugin:permissionRequest 帧', actual: req1 ? `requestId=${req1.payload?.requestId ?? ''}` : '30s 未到（检查 activationEvents/EXTERNAL_PLUGIN_ENABLED）',
    })
    const noSessionId = Boolean(req1 && req1.payload && req1.payload.sessionId === undefined)
    ev.assert('B: 权限请求广播无 sessionId 字段（§6.18 V-6 降级后协议事实：恒进程级）', noSessionId, {
      channel: 'B', expected: 'payload.sessionId === undefined', actual: req1 ? `sessionId=${JSON.stringify(req1.payload?.sessionId)}` : '(无帧)',
    })
    const sheetOnList = await pollVisible(shell, 'permission-sheet-permissions', { timeoutMs: 30_000 })
    ev.assert('A: 壳在会话列表页时 Sheet 全局弹出（恒全局呈现，挂壳根级不依赖路由）', sheetOnList, {
      channel: 'A', expected: 'permission-sheet-permissions 在 screen-sessions 之上可见', actual: sheetOnList ? '已弹出' : '30s 未现',
    })
    const scopeHint = await textOf(shell, 'permission-sheet-scope-hint')
    ev.assert('A: 无归属一等分支呈现——scope-hint 标注进程级不归属特定会话', typeof scopeHint === 'string' && scopeHint.includes('不归属特定会话'), {
      channel: 'A', expected: '含「不归属特定会话」（PermissionSheet 无归属分支文案）', actual: scopeHint ?? '(元素缺失)',
    })
    const permRow = await pollVisible(shell, `permission-sheet-perm-${PERMISSIONS[0]}`, { timeoutMs: 10_000 })
    ev.assert('A: 权限作用域逐条呈现（providers.list 一行）', permRow, {
      channel: 'A', expected: `permission-sheet-perm-${PERMISSIONS[0]}`, actual: permRow ? '在' : '未现',
    })
    await ev.shot(shell.page, 'a7-sheet-global-on-list')

    const denyBox = await shell.page.locator('[data-testid="permission-sheet-deny"]').boundingBox().catch(() => null)
    const approveBox = await shell.page.locator('[data-testid="permission-sheet-approve"]').boundingBox().catch(() => null)
    const denyLeft = Boolean(denyBox && approveBox && denyBox.x < approveBox.x)
    ev.assert('A: 「拒绝」在「允许」左侧（安全侧在左，footer 几何）', denyLeft, {
      channel: 'A', expected: 'deny.x < approve.x', actual: `deny.x=${denyBox && Math.round(denyBox.x)} approve.x=${approveBox && Math.round(approveBox.x)}`,
    })

    await clickTestid(shell, 'permission-sheet-deny')
    const sheetGone1 = await pollFor(async () => !(await shell.page.locator('[data-testid="permission-sheet-deny"]').isVisible().catch(() => false)), { timeoutMs: 20_000 })
    ev.assert('A: 拒绝后 Sheet 收层（controller pending 翻 false）', sheetGone1 === true, {
      channel: 'A', expected: 'permission-sheet 收起', actual: sheetGone1 ? '已收' : '20s 仍在',
    })
    const resolved1 = await waitForFrame(protocol, 'plugin:permissionRequestResolved', since, { timeoutMs: 20_000 })
    ev.assert('B: 拒绝回传有 resolved 终局广播（任一端裁决全端撤窗的同一 requestId）', resolved1 !== null, {
      channel: 'B', expected: 'plugin:permissionRequestResolved', actual: resolved1 ? `requestId=${resolved1.payload?.requestId ?? ''}` : '20s 未到',
    })
    const statusAfterDeny = await pluginStatus(protocol, PLUGIN_ID)
    ev.assert('B: 拒绝后插件未激活（status≠active，UNLOADED 终态）', statusAfterDeny !== null && statusAfterDeny !== 'active', {
      channel: 'B', expected: 'status ≠ active', actual: `status=${statusAfterDeny}`,
    })
    const enteredAgain = await openSessionByRow(shell.page, sid)
    const deniedNotice = enteredAgain ? await pollTextIn(shell, 'mobile-message-stream', '已拒绝本次权限请求', { timeoutMs: 15_000 }) : false
    ev.assert('A: 流内插入「已拒绝本次权限请求」动作通知（§6.20，动作回执成立点插入）', deniedNotice, {
      channel: 'A', expected: '流内含「已拒绝本次权限请求」', actual: deniedNotice ? '在' : '15s 未现（现场见截图）',
    })
    await ev.shot(shell.page, 'a7-denied-notice')
    if (enteredAgain) await backToList(shell.page)

    // ── 段 2：请求 #2 → Esc 关视图（请求保留）→ 聊天页待授权条重开 → 允许 → 激活放行 ──
    since = protocol.events.length
    await protocol.call('plugin.toggle', { pluginId: PLUGIN_ID, enabled: true })
    const req2 = await waitForFrame(protocol, 'plugin:permissionRequest', since, { timeoutMs: 30_000 })
    ev.assert('B: 二次激活重新弹审批（deny 不持久化，权限门再次拦截）', req2 !== null, {
      channel: 'B', expected: 'plugin:permissionRequest 帧', actual: req2 ? `requestId=${req2.payload?.requestId ?? ''}` : '30s 未到',
    })
    // 请求到达自动开 Sheet（activeSheet=null）；遮罩挡行点击——先 Esc 关视图。
    // Sheet 拖拽/遮罩/Esc 关闭 ≠ 取消（请求保留，底部条可再开——FormSheet/PermissionSheet
    // close 事件仅关视图的呈现契约），本段顺带取证该语义：关闭后待授权条仍在、可重开。
    await shell.page.keyboard.press('Escape')
    const sheetClosedByEsc = await pollFor(async () => !(await shell.page.locator('[data-testid="permission-sheet-deny"]').isVisible().catch(() => false)), { timeoutMs: 10_000 })
    const enteredChat2 = await openSessionByRow(shell.page, sid)
    const permBar = enteredChat2 ? await pollVisible(shell, 'chat-permission-bar', { timeoutMs: 15_000 }) : false
    ev.assert('A: Esc 关视图后请求保留——聊天页待授权条在场（关闭≠取消呈现契约）', permBar && sheetClosedByEsc, {
      channel: 'A', expected: 'chat-permission-bar 可见（请求未随视图关闭被取消）', actual: `escClosed=${sheetClosedByEsc} bar=${permBar}`,
    })
    if (permBar) {
      await clickTestid(shell, 'chat-permission-bar')
      const sheetViaBar = await pollVisible(shell, 'permission-sheet-permissions', { timeoutMs: 10_000 })
      ev.assert('A: 点待授权条重开权限 Sheet（条↔Sheet 联动）', sheetViaBar, {
        channel: 'A', expected: 'permission-sheet-permissions 可见', actual: sheetViaBar ? '已开' : '10s 未现',
      })
    }
    await clickTestid(shell, 'permission-sheet-approve')
    const sheetGone2 = await pollFor(async () => !(await shell.page.locator('[data-testid="permission-sheet-approve"]').isVisible().catch(() => false)), { timeoutMs: 20_000 })
    ev.assert('A: 允许后 Sheet 收层', sheetGone2 === true, {
      channel: 'A', expected: 'permission-sheet 收起', actual: sheetGone2 ? '已收' : '20s 仍在',
    })
    const resolved2 = await waitForFrame(protocol, 'plugin:permissionRequestResolved', since, { timeoutMs: 20_000 })
    ev.assert('B: 允许回传有 resolved 终局广播', resolved2 !== null, {
      channel: 'B', expected: 'plugin:permissionRequestResolved', actual: resolved2 ? `requestId=${resolved2.payload?.requestId ?? ''}` : '20s 未到',
    })
    const activeOk = await pollFor(async () => (await pluginStatus(protocol, PLUGIN_ID)) === 'active', { timeoutMs: 30_000 })
    ev.assert('B: 批准后激活放行（plugin.list status=active，grant+save+激活链完成）', activeOk === true, {
      channel: 'B', expected: 'status=active', actual: `status=${await pluginStatus(protocol, PLUGIN_ID)}`,
    })
    const approvedNotice = await pollTextIn(shell, 'mobile-message-stream', '已允许本次权限请求', { timeoutMs: 15_000 })
    ev.assert('A: 流内插入「已允许本次权限请求」动作通知', approvedNotice, {
      channel: 'A', expected: '流内含「已允许本次权限请求」', actual: approvedNotice ? '在' : '15s 未现',
    })
    await ev.shot(shell.page, 'a7-approved-notice')
    if (enteredChat2) await backToList(shell.page)

    // ── 段 3：请求 #3 → 不作答等到期（env 缩短 45s）→ 过期撤窗 ──
    // 批准后插件已 ACTIVE（激活幂等早退不会再过权限门）：先 disable（UNLOADED）再
    // revoke（清 grant+save）再 enable，权限门才会重新拦截。
    since = protocol.events.length
    await protocol.call('plugin.toggle', { pluginId: PLUGIN_ID, enabled: false })
    await protocol.call('plugin.revokePermissions', { pluginId: PLUGIN_ID })
    await protocol.call('plugin.toggle', { pluginId: PLUGIN_ID, enabled: true })
    const req3 = await waitForFrame(protocol, 'plugin:permissionRequest', since, { timeoutMs: 30_000 })
    ev.assert('B: revoke 后三次激活再次弹审批（权限门重新拦截）', req3 !== null, {
      channel: 'B', expected: 'plugin:permissionRequest 帧', actual: req3 ? `requestId=${req3.payload?.requestId ?? ''}` : '30s 未到',
    })
    const sheet3 = await pollVisible(shell, 'permission-sheet-permissions', { timeoutMs: 20_000 })
    ev.assert('A: 第三次请求 Sheet 再现（不作答等待到期）', sheet3, {
      channel: 'A', expected: 'permission-sheet-permissions 可见', actual: sheet3 ? '已弹' : '20s 未现',
    })
    const expiredFrame = await waitForFrame(protocol, 'plugin:permissionRequestExpired', since, { timeoutMs: PERM_TIMEOUT_MS + 30_000 })
    ev.assert(`B: 审批等待到期撤窗广播（TAIJI_PLUGIN_PERMISSION_TIMEOUT_MS=${PERM_TIMEOUT_MS}）`, expiredFrame !== null, {
      channel: 'B', expected: 'plugin:permissionRequestExpired', actual: expiredFrame ? `requestId=${expiredFrame.payload?.requestId ?? ''}` : '超时未到',
    })
    const sheetAutoGone = await pollFor(async () => !(await shell.page.locator('[data-testid="permission-sheet-deny"]').isVisible().catch(() => false)), { timeoutMs: 15_000 })
    const expiredBarText = await textOf(shell, 'mobile-error-bar-text')
    ev.assert('A: 到期后 Sheet 自动关 + 错误条「请求已过期」（不把过期请求提交成成功）', sheetAutoGone === true && typeof expiredBarText === 'string' && expiredBarText.includes('请求已过期'), {
      channel: 'A', expected: 'sheet 收起 ∧ 错误条含「请求已过期」', actual: `sheetGone=${sheetAutoGone} errorBar=${expiredBarText ?? '(无)'}`,
    })
    const statusAfterExpire = await pluginStatus(protocol, PLUGIN_ID)
    ev.assert('B: 到期是取消非判拒（插件未激活，重触发可再弹）', statusAfterExpire !== 'active', {
      channel: 'B', expected: 'status ≠ active（UNLOADED，非 rejected 记录）', actual: `status=${statusAfterExpire}`,
    })
    await ev.shot(shell.page, 'a7-expired')
  } finally {
    if (shell.pageErrors.length > 0) ev.attach('a7-page-errors', shell.pageErrors.join('\n---\n'))
    await closeShell(shell)
    ev.step({ step: 'mobile.browser.close', channel: 'C', exitCode: 0, stats: {} })
  }

  log('done')
  return { uncovered, gotchas }
}

// ── 局部小工具 ──────────────────────────────────────────────────────────────

async function pollVisible(shell, testid, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const visible = await shell.page
      .locator(`[data-testid="${testid}"]`)
      .first()
      .isVisible()
      .catch(() => false)
    if (visible) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function textOf(shell, testid) {
  return shell.page
    .locator(`[data-testid="${testid}"]`)
    .first()
    .innerText()
    .catch(() => null)
}

async function clickTestid(shell, testid, { timeoutMs = 15_000 } = {}) {
  await shell.page.locator(`[data-testid="${testid}"]`).first().click({ timeout: timeoutMs })
}

async function pollTextIn(shell, testid, needle, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const text = await shell.page
      .locator(`[data-testid="${testid}"]`)
      .innerText()
      .catch(() => '')
    if (text.includes(needle)) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 300))
  }
}

/** 协议帧条件等待（按 type；返回帧或 null）。 */
async function waitForFrame(protocol, type, since, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = protocol.events.slice(since).find((e) => e.type === type)
    if (hit) return hit
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function pluginStatus(protocol, pluginId) {
  const reply = await protocol.call('plugin.list', {}).catch(() => null)
  return reply?.plugins?.find((p) => p.pluginId === pluginId)?.status ?? null
}
