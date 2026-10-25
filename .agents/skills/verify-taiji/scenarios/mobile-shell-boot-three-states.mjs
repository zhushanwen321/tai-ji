/**
 * mobile-shell-boot-three-states —— 移动壳首屏三态 + token 交接 + 凭据隔离（V1 的剧本化；
 * remote-use-mobile-v2 §8.2 场景 V1「扫码连接首屏」）。
 *
 * 真实用户路径（V1）：桌面开远程访问 → 手机扫 QR → 打开
 * `http://<lan-ip>:<runtimePort>/?token=…`。本剧本按同一链路装配：预置 remote-access.json
 * （meta.remoteAccess 钩子，launch 前生效）→ runtime 静态托管壳 dist → Playwright iPhone
 * 仿真打开 `?token=<good>`（验身成功路径）→ 坏 token 重放（验身失败路径）。
 *
 * 三断言（§8.2 V1 通过标准，逐条对应）：
 *   ① 首屏任意时点非白屏（#app 内有三态之一：骨架 shell-boot-skeleton / 验身 token-input-view
 *      / 失败指引 shell-failed-screen）——§6.6 bootstrap 先挂载后连接的验收面；
 *   ② 地址栏 token 被抹除（query 来源验身成功 → storage 落盘 + replaceState 抹 query，
 *      connection-profile D4 双写点）；
 *   ③ 坏 token 注入不毁既有凭据（query 来源验身失败不动 storage——「坏链接不毁好凭据」，
 *      D4 显式判定 + 落 token 输入视图）。
 *
 * 装配前置（三缺一即 fail，恢复动作随断言给出）：
 *   - packages/mobile-renderer/dist 存在（runtime 启动期探测，缺失 → GET / 404）；
 *   - remote-access.json 预置生效（/health 通且静态托管 200）；
 *   - runtime.port 文件端口可服务（instance.waitReady 已保证）。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  closeMobileShell,
  openMobileShell,
  probeShellServing,
  readRemoteAccessSpawnEvidence,
  readStoredToken,
  resolveMobileDist,
  waitForTokenHandover,
  waitForTokenInputView,
  watchFirstPaint,
} from './lib/mobile-shell-helper.mjs'

export const meta = {
  id: 'mobile-shell-boot-three-states',
  priority: 'P0',
  title: '移动壳首屏三态（非白屏）+ 好 token 验身交接（地址栏抹除）+ 坏 token 不毁既有凭据',
  covers: ['env.launch', 'env.ready', 'mobile.shell.boot', 'mobile.token.handover', 'mobile.credential.isolation'],
  requires: ['remote-access', 'mobile-dist'],
  estimateSec: 150,
  remoteAccess: {},
  provable: [
    'A：首屏任意时点 #app 非空且呈三态之一（骨架/验身/失败指引；§6.6 先挂载后连接）',
    'A：好 token 验身成功后 location.search 无 token 且 localStorage 落盘同值（D4 双写点）',
    'A：坏 token 验身失败后既有 storage 凭据原值保留 + 落 token 输入视图（D4 坏链接不毁好凭据）',
  ],
  notProvable: [
    '真机触控手势/长按时长/安全区视觉（需真机；本剧本只证仿真 viewport 下的呈现与状态机）',
    'token 轮换热生效（main 重写 remote-access.json 后新握手生效，D2）——属 remote-access 轮换场景，非 boot 面',
  ],
}

export async function run(ctx) {
  const { instance, ev, log, remoteAccess } = ctx
  const gotchas = []
  const uncovered = []
  const info = instance.info()
  const runtimePort = info.runtimePort
  const goodToken = remoteAccess?.token
  if (!goodToken) throw new Error('ctx.remoteAccess 缺失：run.mjs 未做 remote-access 预置（meta.remoteAccess 钩子失效？）')

  // ── 装配判定（B 通道）：dist 在位 + 静态托管 200。缺一 = 壳不可达，如实 fail 并给恢复动作 ──
  const distDir = resolveMobileDist(ctx.repo)
  const distIndex = fs.existsSync(path.join(distDir, 'index.html'))
  ev.step({
    step: 'mobile.dist.probe',
    channel: 'C',
    exitCode: distIndex ? 0 : 1,
    stats: { distDir, indexHtml: distIndex },
  })
  const serving = await probeShellServing(runtimePort)
  // 开态生效取证：GET / 404 有两因（预置没生效 vs 开了但 dist 缺失禁用），日志行区分
  const spawnEvidence = readRemoteAccessSpawnEvidence(ctx.dataDir)
  ev.step({
    step: 'mobile.shell.serving',
    channel: 'B',
    exitCode: serving.healthOk && serving.shellStatus === 200 ? 0 : 1,
    stats: {
      runtimePort,
      healthStatus: serving.healthStatus,
      shellStatus: serving.shellStatus,
      contentType: serving.shellContentType,
      remoteAccessSpawned: spawnEvidence.mainEnabled,
      runtimeDisabledByDist: spawnEvidence.runtimeDisabledByDist,
    },
  })
  ev.attach('remote-access-spawn-evidence', [spawnEvidence.mainLine, spawnEvidence.runtimeLine].filter(Boolean).join('\n') || '(两侧行均未找到)')
  ev.assert('B: runtime /health 通（实例活着）', serving.healthOk, {
    channel: 'B', expected: 'GET /health → 200', actual: `status=${serving.healthStatus}`,
  })
  const shellReachable = distIndex && serving.shellStatus === 200 && serving.shellIsHtml
  ev.assert('B: 移动壳静态托管可达（dist 在位 + GET / 200 HTML）', shellReachable, {
    channel: 'B',
    expected: 'GET / → 200 text/html（mobile-renderer/dist/index.html 存在）',
    actual: distIndex
      ? `GET / → ${serving.shellStatus} ${serving.shellContentType || '(无 content-type)'}`
      : `dist/index.html 不存在：${distDir}（构建未产出；修复模块图断链后 pnpm --filter @taiji/mobile-renderer build）`,
  })
  if (!shellReachable) {
    uncovered.push('三断言未驱动：移动壳静态托管不可达（dist 缺失或非 200）——壳页面无法打开，装配修复后复跑')
    return { uncovered, gotchas }
  }

  // ── 断言①：首屏任意时点非白屏（好 token 直连路径；boot 期应呈骨架/连接中） ──
  let shell = null
  try {
    shell = await openMobileShell({ repo: ctx.repo, runtimePort, token: goodToken })
    ev.step({ step: 'mobile.shell.open', channel: 'A', exitCode: 0, stats: { url: shell.url, device: 'iPhone 13' } })

    const paint = await watchFirstPaint(shell.page, { timeoutMs: 15_000 })
    await ev.shot(shell.page, 'boot-first-paint')
    ev.assert('A: 首屏任意时点 #app 非空（非白屏）', paint.firstNonBlankAt !== null, {
      channel: 'A',
      expected: '采样窗内存在 #app childElementCount > 0 的时刻',
      actual: paint.firstNonBlankAt !== null
        ? `首个非空时刻 +${paint.firstNonBlankAt}ms（采样 ${paint.samples} 次）`
        : `全程白屏 ${paint.blankMs}ms（采样 ${paint.samples} 次）`,
    })
    ev.assert('A: boot 期呈三态锚点之一（骨架/验身/失败指引）', (paint.firstStateSeen ?? []).length > 0, {
      channel: 'A',
      expected: 'shell-boot-skeleton | token-input-view | shell-failed-screen 任一可见',
      actual: (paint.firstStateSeen ?? []).length > 0 ? `命中 ${paint.firstStateSeen.join(',')}` : '三态锚点均未出现',
    })
    if ((shell.pageErrors.length > 0 || paint.firstNonBlankAt === null)) {
      ev.attach('boot-page-errors', shell.pageErrors.join('\n---\n') || '(无 pageerror)')
      ev.attach('boot-console', shell.consoleLines.slice(-40).join('\n') || '(无 console)')
    }
    ev.step({
      step: 'mobile.boot.first-paint',
      channel: 'A',
      exitCode: paint.firstNonBlankAt !== null ? 0 : 1,
      stats: { firstNonBlankAt: paint.firstNonBlankAt, statesSeen: paint.firstStateSeen, pageErrors: shell.pageErrors.length },
    })

    // ── 断言②：好 token 验身成功 → 地址栏抹除 + storage 落盘同值（D4 双写点） ──
    const handover = await waitForTokenHandover(shell.page, goodToken, { timeoutMs: 20_000 })
    ev.assert('A: 验身成功后地址栏 query 已抹除', !handover.search.includes('token='), {
      channel: 'A', expected: 'location.search 不含 token=', actual: `search="${handover.search}"`,
    })
    ev.assert('A: 验身成功后凭据落盘 localStorage（taiji.remote-access.token = 好 token）', handover.stored === goodToken, {
      channel: 'A', expected: 'storage 与 query token 同值', actual: handover.stored === null ? 'storage 无凭据' : `storage=${String(handover.stored).slice(0, 8)}…`,
    })
    ev.step({
      step: 'mobile.token.handover',
      channel: 'A',
      exitCode: handover.ok ? 0 : 1,
      stats: { stripped: !handover.search.includes('token='), stored: handover.stored !== null },
    })
    await ev.shot(shell.page, 'connected-after-handover')

    // ── 断言③：坏 token 重放 → 既有凭据保留 + 落 token 输入视图（D4 坏链接不毁好凭据） ──
    const badToken = 'f'.repeat(64)
    await shell.page.goto(`http://127.0.0.1:${runtimePort}/?token=${badToken}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    ev.step({ step: 'mobile.bad-token.reload', channel: 'A', exitCode: 0, stats: {} })
    const inputShown = await waitForTokenInputView(shell.page, { timeoutMs: 20_000 })
    const storedAfterBad = await readStoredToken(shell.page)
    await ev.shot(shell.page, 'bad-token-input-view')
    ev.assert('A: 坏 token 验身失败后既有凭据原值保留', storedAfterBad === goodToken, {
      channel: 'A',
      expected: 'localStorage 凭据仍 = 好 token（坏链接不毁好凭据）',
      actual: storedAfterBad === null ? 'storage 凭据被清空' : storedAfterBad === goodToken ? '凭据原值保留' : `凭据被改成 ${String(storedAfterBad).slice(0, 8)}…`,
    })
    ev.assert('A: 坏 token 验身失败落 token 输入视图', inputShown, {
      channel: 'A', expected: 'token-input-view 可见', actual: inputShown ? '可见' : '20s 内未出现',
    })
    ev.step({
      step: 'mobile.credential.isolation',
      channel: 'A',
      exitCode: inputShown && storedAfterBad === goodToken ? 0 : 1,
      stats: { inputShown, storedKept: storedAfterBad === goodToken },
    })
  } finally {
    if (shell) {
      // 失败路径也要留页面现场证据（console/pageerror 是白屏归因第一现场）
      if (shell.pageErrors.length > 0) ev.attach('page-errors-tail', shell.pageErrors.join('\n---\n'))
      await closeMobileShell(shell)
      ev.step({ step: 'mobile.browser.close', channel: 'C', exitCode: 0, stats: {} })
    }
  }

  log('mobile-shell-boot-three-states 完成')
  return { uncovered, gotchas }
}
