/**
 * p1-plugin-crash —— 插件崩溃隔离（impl-plan A13 / 设计 S13）：
 * kill sandbox 插件的 fork 子进程 → 崩溃检测与隔离（B：plugin:crashed 广播 +
 * plugin.list status=crashed；C：crash journal 行）+ 邻居与宿主不受影响
 * （builtin 插件状态不变、宿主 RPC 通道正常）。
 *
 * UI 面缺口（如实登记 degraded/notProvable）：设计 S13 期望「家族卡显示『插件已停止』+ 重启」，
 * 现行实现无此 UI——插件管理面对 crashed 插件零呈现（扩展页呈「未发现已安装插件」），
 * 崩溃的实际反馈面 = 崩溃 toast（plugin:crashed → showToast，4s 消失窗）。本剧本断言
 * toast 呈现（A），管理面缺口取证 attach 照录（不判失败）。
 *
 * 装配：本机 mock npm registry（同 p1-plugin-install-confirm）；无 LLM 需求。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { startMockNpmRegistry, registryEnv } from './lib/mock-npm-registry.mjs'
import { openPluginFlow, directInstallToConfirm, closePluginFlow, pollUntil } from './lib/plugin-flow-helper.mjs'

const PKG = 'plugin-crash-demo'
const PLUGIN_ID = 'plugin-crash-demo'
const BUILTIN_ID = 'scheduler-manager'

export const meta = {
  id: 'p1-plugin-crash',
  priority: 'P1',
  title: 'S13 插件崩溃隔离：SIGKILL fork → 崩溃检测（crashed + journal）+ 邻居/宿主不受影响',
  covers: ['plugin.list', 'plugin.toggle'],
  requires: [],
  estimateSec: 240,
  env: undefined, // 模块加载段按 repo 填充

  provable: [
    'kill fork 后崩溃检测生效：plugin:crashed 广播（payload.pluginId 命中）+ plugin.list status=crashed（B 双证）',
    'C：crash journal 落 plugin-worker crash 行（processId=sandbox-<pluginId> + pluginIds 命中）',
    '隔离性：builtin 插件 scheduler-manager 状态不受影响；宿主 RPC（ping / config.getProviders / plugin.list）全部正常',
    'A：崩溃 toast 呈现（plugin:crashed → showToast，文案「插件 <id> 崩溃: …」含插件标识，4s 自动消失窗内观测）；插件管理面对 crashed 插件的呈现缺口照录（证据 attach，不判失败）',
  ],
  notProvable: [
    '「家族卡显示『插件已停止』+ 重启按钮」——现行实现无该 UI 面（uncovered，产品缺口非剧本缺口）',
    'fork 内部致命异常形态（SIGKILL 外部注入覆盖 exit 信号路径；fatal_error 消息路径归单测）',
  ],
}

export async function run(ctx) {
  const { protocol, ui, ev, log, dataDir } = ctx
  const uncovered = []
  const gotchas = [
    '崩溃 UI 缺口：crashed 插件在协议层 enabled 推导为 false（plugin-info-mapper enabled = status===active），插件管理卡文本呈「已禁用」——与本剧本照录的 actual 对照读',
  ]
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

  // ── A 通道②：插件管理面对 crashed 插件的呈现（缺口照录，不判失败——设计 S13
  //    「插件已停止 + 重启」现行实现无对应 UI，缺口已登记 meta.notProvable；此处只取证）
  try {
    const navVisible = await page.locator('[data-testid="settings-nav-extension"]').first().isVisible().catch(() => false)
    if (!navVisible) await ui.click('testid=sidebar-settings')
    await ui.click('testid=settings-nav-extension')
    const entry = page.locator('[data-testid="extension-contributions-entry"]')
    if ((await entry.count()) > 0) {
      await ui.click('testid=extension-contributions-entry')
    }
    await ui.expectVisible('testid=plugin-settings-page', { timeoutMs: 15_000 })
    const cardCount = await page.locator('[data-testid="plugin-card"]').count()
    const pageText = await ui.text('testid=plugin-settings-page')
    ev.attach('s13-management-surface-text', `plugin-card ×${cardCount}；页面文案：${pageText.slice(0, 300)}`)
    await ui.screenshot('s13-plugin-card-after-crash')
    gotchas.push(`插件管理面对 crashed 插件零呈现（plugin-card ×${cardCount}，页面呈「${pageText.slice(0, 40).trim()}」）——崩溃反馈面 = 崩溃 toast（① 已断言）`)
  } catch (e) {
    // 管理面取证失败不阻断结论（B/C 双证 + toast 已闭合）；缺口照录
    uncovered.push(`插件管理面取证未完成：${e instanceof Error ? e.message : String(e)}`)
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
