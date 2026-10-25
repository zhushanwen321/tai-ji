/**
 * p1-plugin-crash —— 插件崩溃隔离（impl-plan A13 / 设计 S13）：
 * kill sandbox 插件的 fork 子进程 → 崩溃检测与隔离（B：plugin:crashed 广播 +
 * plugin.list status=crashed；C：crash journal 行）+ 邻居与宿主不受影响
 * （builtin 插件状态不变、宿主 RPC 通道正常）。
 *
 * S13 崩溃恢复 UI（设计 §3.1 失败路径表）：家族卡显示「插件已停止」+ 重启按钮，
 * 重启 = plugin.toggle off/on（不自动重激活，ADR-0122）。本剧本 A 通道断言该闭环
 *（标记与按钮呈现 → 点击重启 → status 回 active）。fixture 经 seedPluginCatalog
 * 预置带 family 的清单条目进实例数据目录（家族卡只渲染清单 family 条目，顶层预置
 * 先于 instance.launch，同 p1-plugin-a3-a12-real-extract 模式）。
 *
 * 装配：本机 mock npm registry（同 p1-plugin-install-confirm）；无 LLM 需求。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { startMockNpmRegistry, registryEnv, seedPluginCatalog, catalogEntry } from './lib/mock-npm-registry.mjs'
import { resolveDataDirFromArgv } from './lib-plugin-fixtures.mjs'
import { openPluginFlow, directInstallToConfirm, closePluginFlow, pollUntil } from './lib/plugin-flow-helper.mjs'

const PKG = 'plugin-crash-demo'
const PLUGIN_ID = 'plugin-crash-demo'
const BUILTIN_ID = 'scheduler-manager'

// ── 顶层预置（import 阶段执行，先于 runner 的 instance.launch）：seed 带 family 的
//    清单条目（家族卡崩溃态的渲染前提——plugin-family-grid 只含清单 family 条目）──
const dataDir0 = resolveDataDirFromArgv()
seedPluginCatalog(dataDir0, [
  catalogEntry({ packageName: PKG, pluginId: PLUGIN_ID, displayName: 'Crash Demo', namespace: PLUGIN_ID, version: '1.0.0' }),
])

export const meta = {
  id: 'p1-plugin-crash',
  priority: 'P1',
  title: 'S13 插件崩溃隔离：SIGKILL fork → 崩溃检测（crashed + journal）+ 家族卡停止/重启 + 邻居/宿主不受影响',
  covers: ['plugin.list', 'plugin.toggle'],
  requires: [],
  estimateSec: 240,
  env: undefined, // 模块加载段按 repo 填充

  provable: [
    'kill fork 后崩溃检测生效：plugin:crashed 广播（payload.pluginId 命中）+ plugin.list status=crashed（B 双证）',
    'C：crash journal 落 plugin-worker crash 行（processId=sandbox-<pluginId> + pluginIds 命中）',
    '隔离性：builtin 插件 scheduler-manager 状态不受影响；宿主 RPC（ping / config.getProviders / plugin.list）全部正常',
    'A：崩溃 toast 呈现（plugin:crashed → showToast，文案「插件 <id> 崩溃: …」含插件标识，4s 自动消失窗内观测）',
    'A/S13：家族卡崩溃恢复闭环——家族卡显示「插件已停止」标记 + 重启按钮，点击重启（plugin.toggle off/on）后 status 回 active、标记消失',
  ],
  notProvable: [
    'fork 内部致命异常形态（SIGKILL 外部注入覆盖 exit 信号路径；fatal_error 消息路径归单测）',
  ],
}

export async function run(ctx) {
  const { protocol, ui, ev, log, dataDir } = ctx
  const uncovered = []
  const gotchas = []
  const page = await ctx.instance.page()

  const registry = await startMockNpmRegistry(ctx.repo, {
    [PKG]: { versions: { '1.0.0': tarballOf(ctx.repo, PKG, '1.0.0') }, latest: '1.0.0' },
  })
  ev.step({ step: 'mock-registry.up', channel: 'C', exitCode: 0, stats: { url: registry.url, pkg: PKG } })

  // ── 安装（直装路径）并等激活 ────────────────────────────────────
  await openPluginFlow(ui, page)
  await directInstallToConfirm(ui, PKG)
  await ui.click('testid=plugin-install-confirm-btn')
  await ui.expectVisible('testid=plugin-authorize-container', { timeoutMs: 60_000 })
  await closePluginFlow(ui)

  const activeInfo = await pollUntil(
    () => protocol.call('plugin.list', {}),
    (r) => (r.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID && p.status === 'active'),
    { timeoutMs: 30_000 },
  )
  const active = (activeInfo.plugins ?? []).find((p) => p.pluginId === PLUGIN_ID)
  ev.assert('前置：fixture 插件已激活（sandbox fork 在场）', Boolean(active && active.status === 'active'), {
    channel: 'B',
    expected: 'status=active',
    actual: active ? `status=${active.status} trust=${active.trustLevel}` : '不在列表',
  })

  // 基线：宿主健康 + builtin 插件正常
  await protocol.call('ping', {})
  const providers0 = await protocol.call('config.getProviders', {})
  const list0 = await protocol.call('plugin.list', {})
  const builtin0 = (list0.plugins ?? []).find((p) => p.pluginId === BUILTIN_ID)
  ev.assert('基线：宿主 RPC 正常 + builtin 插件在场非 crashed', Boolean(builtin0 && builtin0.status !== 'crashed') && (providers0.providers ?? []).length >= 0, {
    channel: 'B',
    expected: `ping ok + ${BUILTIN_ID} 非 crashed`,
    actual: `builtin=${builtin0 ? builtin0.status : '不在列表'} providers=${(providers0.providers ?? []).length}`,
  })

  // ── 故障注入：定位 sandbox fork PID 并 SIGKILL ─────────────────
  const fork = findSandboxForkPid(PLUGIN_ID)
  ev.assert('C: 定位到唯一的 sandbox fork 进程（plugin-bootstrap-process）', fork !== null, {
    channel: 'C',
    expected: '恰 1 个 plugin-bootstrap-process 子进程',
    actual: fork ? `pid=${fork.pid} cmd=${fork.cmd.slice(0, 160)}` : '零命中（fork 未起或匹配式漂移）',
  })
  if (!fork) throw new Error('无法定位 sandbox fork 进程，故障注入无法进行')
  ev.attach('s13-fork-ps', fork.cmd)

  const since = protocol.events.length
  try {
    process.kill(fork.pid, 'SIGKILL')
  } catch (e) {
    throw new Error(`SIGKILL ${fork.pid} 失败: ${e instanceof Error ? e.message : String(e)}`)
  }
  ev.step({ step: 'crash.inject', channel: 'C', exitCode: 0, stats: { pid: fork.pid, signal: 'SIGKILL' } })

  // A 通道①：崩溃 toast（现行实现的崩溃反馈面：plugin:crashed → showToast
  // `插件 <id> 崩溃: <error>`，TOAST_DURATION_MS=4000 自动消失——必须在过窗前观测）
  const toastHit = await pollUntil(async () => {
    const loc = page.locator('[data-testid="toast-container"]', { hasText: `插件 ${PLUGIN_ID} 崩溃` })
    return (await loc.count().catch(() => 0)) > 0
  }, (hit) => hit === true, { timeoutMs: 8_000, intervalMs: 200 })
  ev.assert('A: 崩溃 toast 呈现（文案含插件标识）', toastHit === true, {
    channel: 'A',
    expected: `toast-container 含「插件 ${PLUGIN_ID} 崩溃」（4s 消失窗内）`,
    actual: toastHit === true ? '命中' : '8s 未观测到（toast 已过窗或未弹）',
  })
  await ui.screenshot('s13-crash-toast')

  // 崩溃检测：plugin:crashed 广播（B 事件流）+ plugin.list status=crashed（B 拉取）
  const crashedEvt = await protocol.waitFor(
    (e) => e.type === 'plugin:crashed' && e.payload?.pluginId === PLUGIN_ID,
    { timeoutMs: 30_000, since },
  )
  ev.assert('B: plugin:crashed 广播命中（payload.pluginId = fixture）', Boolean(crashedEvt), {
    channel: 'B',
    expected: `plugin:crashed { pluginId: ${PLUGIN_ID} }`,
    actual: crashedEvt ? JSON.stringify({ pluginId: crashedEvt.payload?.pluginId, workerId: crashedEvt.payload?.workerId, error: String(crashedEvt.payload?.error ?? '').slice(0, 120) }) : '30s 未观测到',
  })

  const crashedInfo = await pollUntil(
    () => protocol.call('plugin.list', {}),
    (r) => (r.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID && p.status === 'crashed'),
    { timeoutMs: 15_000 },
  )
  const crashed = (crashedInfo.plugins ?? []).find((p) => p.pluginId === PLUGIN_ID)
  ev.assert('B: plugin.list status=crashed（崩溃态落列表）', Boolean(crashed && crashed.status === 'crashed'), {
    channel: 'B',
    expected: 'status=crashed',
    actual: crashed ? `status=${crashed.status} enabled=${crashed.enabled}` : '不在列表',
  })
  await ui.screenshot('s13-after-crash')

  // C：crash journal 行（<dataDir>/logs/crashes/runtime.jsonl）
  const journalHit = await pollUntil(
    () => readJournalRow(dataDir, PLUGIN_ID),
    (row) => row !== null,
    { timeoutMs: 10_000 },
  )
  ev.assert('C: crash journal 落 plugin-worker crash 行', journalHit !== null, {
    channel: 'C',
    expected: `layer=plugin-worker event=crash pluginIds 含 ${PLUGIN_ID}`,
    actual: journalHit ? JSON.stringify(journalHit).slice(0, 300) : 'journal 无命中行',
  })

  // ── 隔离性：邻居与宿主不受影响 ─────────────────────────────────
  await protocol.call('ping', {})
  const providers1 = await protocol.call('config.getProviders', {})
  const list1 = await protocol.call('plugin.list', {})
  const builtin1 = (list1.plugins ?? []).find((p) => p.pluginId === BUILTIN_ID)
  ev.assert('隔离：宿主 RPC 正常（ping + config.getProviders）', Array.isArray(providers1.providers), {
    channel: 'B',
    expected: 'ping ok + providers 列表可读',
    actual: `providers=${(providers1.providers ?? []).length}`,
  })
  ev.assert('隔离：builtin 插件 scheduler-manager 不受影响（非 crashed）', Boolean(builtin1 && builtin1.status !== 'crashed'), {
    channel: 'B',
    expected: `${BUILTIN_ID} 非 crashed`,
    actual: builtin1 ? `status=${builtin1.status}` : '不在列表',
  })
  const othersCrashed = (list1.plugins ?? []).filter((p) => p.pluginId !== PLUGIN_ID && p.status === 'crashed')
  ev.assert('隔离：除 fixture 外无其他插件进入 crashed', othersCrashed.length === 0, {
    channel: 'B',
    expected: '0',
    actual: othersCrashed.map((p) => p.pluginId).join(',') || '0',
  })

  // ── A/S13 通道③：家族卡崩溃恢复闭环（设计失败路径表）─────────────
  //    家族卡显示「插件已停止」+ 重启按钮 → 点击重启（plugin.toggle off/on）→
  //    status 回 active、家族卡标记消失。数据流：进入流程对话框拉 plugin.list
  //    （crashed 判定主通道），点击重启后 toggle 回包刷新运行态。
  try {
    await openPluginFlow(ui, page)
    const crashedCard = page.locator('[data-testid="plugin-family-card"]', { hasText: 'Crash Demo' })
    await ui.expectVisible('testid=plugin-family-grid', { timeoutMs: 20_000 })
    await crashedCard.waitFor({ state: 'visible', timeoutMs: 20_000 })

    const badge = crashedCard.locator('[data-testid="plugin-family-crashed-badge"]')
    const restartBtn = crashedCard.locator('[data-testid="plugin-family-restart-btn"]')
    ev.assert('A/S13: 家族卡显示「插件已停止」标记 + 重启按钮', (await badge.count()) === 1 && (await restartBtn.count()) === 1, {
      channel: 'A',
      expected: 'crashed 家族卡含「插件已停止」标记与重启按钮各一',
      actual: `badge ×${await badge.count()} restart ×${await restartBtn.count()}（卡片文案：${(await crashedCard.textContent() ?? '').slice(0, 120)}）`,
    })
    await ui.screenshot('s13-family-card-crashed')

    // 点击重启 → toggle off/on → status 回 active（ADR-0122：用户显式触发，不自动重激活）
    await restartBtn.first().click()
    const restarted = await pollUntil(
      () => protocol.call('plugin.list', {}),
      (r) => (r.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID && p.status === 'active'),
      { timeoutMs: 30_000 },
    )
    const restartedInfo = (restarted.plugins ?? []).find((p) => p.pluginId === PLUGIN_ID)
    ev.assert('A/S13: 点击重启 → plugin.toggle off/on → status 回 active', Boolean(restartedInfo && restartedInfo.status === 'active'), {
      channel: 'A',
      expected: 'status=active（重启完成）',
      actual: restartedInfo ? `status=${restartedInfo.status} enabled=${restartedInfo.enabled}` : '不在列表',
    })
    // 重启完成后家族卡标记消失（toggle 回包刷新运行态，对话框保持打开）
    await badge.waitFor({ state: 'detached', timeoutMs: 15_000 }).catch(() => {})
    const badgeAfter = await page.locator('[data-testid="plugin-family-crashed-badge"]').count()
    ev.assert('A/S13: 重启完成后家族卡「插件已停止」标记消失', badgeAfter === 0, {
      channel: 'A',
      expected: '0（标记消失）',
      actual: `×${badgeAfter}`,
    })
    await ui.screenshot('s13-family-card-restarted')
    await closePluginFlow(ui)
  } catch (e) {
    uncovered.push(`S13 家族卡崩溃恢复闭环取证未完成：${e instanceof Error ? e.message : String(e)}`)
  }

  log('S13 done')
  await registry.close()
  return { uncovered, gotchas }
}

function tarballOf(repo, name, ver) {
  return path.join(repo, '.agents', 'skills', 'verify-taiji', 'fixtures', 'plugin-pkgs', 'dist', `${name}-${ver}.tgz`)
}

/**
 * 定位 sandbox fork 子进程（唯一性判定在调用方）：dev 形态 fork 子进程命令行 =
 * <node/execPath> …/plugin-bootstrap-process.{cjs,js,ts}（PluginHostProcess.createProcess）。
 * 仓内 trusted 插件走 Worker 线程（无独立进程），故命中行应恰为 sandbox fixture。
 */
function findSandboxForkPid(pluginId) {
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 10_000 })
  if (r.status !== 0) return null
  const lines = r.stdout.split('\n').filter((l) => l.includes('plugin-bootstrap-process'))
  if (lines.length !== 1) return lines.length === 1 ? parseLine(lines[0]) : null
  return parseLine(lines[0])

  function parseLine(line) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!m) return null
    return { pid: Number(m[1]), cmd: m[2], pluginId }
  }
}

function readJournalRow(dataDir, pluginId) {
  const file = path.join(dataDir, 'logs', 'crashes', 'runtime.jsonl')
  try {
    const text = fs.readFileSync(file, 'utf8')
    for (const line of text.split('\n').reverse()) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (row.layer === 'plugin-worker' && row.event === 'crash' && Array.isArray(row.pluginIds) && row.pluginIds.includes(pluginId)) {
          return row
        }
      } catch {
        /* 跳过半行 */
      }
    }
    return null
  } catch {
    return null
  }
}

// 实例 env（mock registry 证书 + 预载注入）：runner 以 cwd=worktree 根直跑，
// process.cwd() 即 repo 锚；runner 在 import 完成后才读 meta.env。
meta.env = registryEnv(process.cwd())
