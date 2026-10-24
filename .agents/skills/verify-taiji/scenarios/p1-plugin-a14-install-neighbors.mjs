/**
 * p1-plugin-a14-install-neighbors —— 邻居不变量（impl-plan A14 / 设计 S14）：
 * 施压插件（激活即经 providers.write 写入含 apiKey 的命名空间条目，确保卸载清理链
 * 被真实行使）连续安装/卸载 5 轮，期间重启实例 → 断言宿主表面不变：
 *   - 邻居 provider 条目与凭据不受污染（config.getProviders + models.json 双证）；
 *   - 无孤儿条目（models.json 无该插件命名空间前缀的残留，含 apiKey 在内全部消失）；
 *   - 插件目录无残留（plugins/<pluginId> 不出现 + .staging 清空 + installed.json 无登记）；
 *   - 重启后启动日志无该插件相关的 warn 洪水。
 *
 * 装配：本机 mock npm registry（同 p1-plugin-install-confirm；registry env 经
 * NODE_OPTIONS 预载 + NODE_EXTRA_CA_CERTS 信任自签证书）；fixture 首装声明
 * permissions=[providers.write]，激活停在权限审批门——剧本经 plugin.approvePermissions
 * 批准（B 通道 = 审批弹窗「批准」按钮的协议形态），批准落盘 permissions.json，后续
 * 轮次与重启后免审批。无 LLM 需求。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

import { startMockNpmRegistry, registryEnv } from './lib/mock-npm-registry.mjs'
import {
  openPluginFlow,
  directInstallToConfirm,
  assertConfirmFields,
  closePluginFlow,
  pollUntil,
} from './lib/plugin-flow-helper.mjs'

const PKG = 'plugin-neighbor-stress'
const PLUGIN_ID = 'plugin-neighbor-stress'
const NS = 'neighbor-stress'
const STRESS_PROVIDER_ID = 'neighbor-stress-main'
const STRESS_API_KEY = 'nsk-neighbor-stress-api-key-0001'
const NEIGHBOR_PROVIDER_ID = 'plain-neighbor'
const NEIGHBOR_API_KEY = 'nsk-plain-neighbor-key-0001'
const NEIGHBOR_ROW_NAME = 'Plain Neighbor (verify fixture)'
const ROUNDS = 5
const RESTART_AFTER_ROUND = 2
const PERMISSIONS = ['providers.write']

export const meta = {
  id: 'p1-plugin-a14-install-neighbors',
  priority: 'P1',
  title: 'S14 邻居不变量：施压插件 5 轮装卸 + 期间重启 → 邻居条目不污染 / 无孤儿条目 / 无残留目录 / 无 warn 洪水',
  covers: ['plugin.list', 'plugin.toggle', 'settings.provider'],
  requires: [],
  estimateSec: 420,
  env: undefined, // 模块加载段按 repo 填充（runner 在 import 之后才读 meta.env）

  provable: [
    '施压插件激活链真实行使：每轮安装后 models.json 出现 neighbor-stress-main 条目（含 apiKey），卸载后该命名空间条目含 apiKey 在内全部消失（5 轮逐一核）',
    '邻居不变量：宿主预置的 plain-neighbor 条目（含 apiKey）贯穿 5 轮装卸与中间重启不受污染，config.getProviders 无重复无孤儿',
    '中间重启（stop→launch→waitReady）后：plugin.list 无该插件、目录无残留、邻居条目原样（重启不复活不误删）',
    'C: 终态无残留目录——plugins/<pluginId> 不出现、.staging 清空、installed.json 无登记',
    'C: 终局重启（装卸 5 轮后，设计 S14 形态）后启动日志无该插件命名空间相关的 warn 洪水（重启后追加日志行 warn 命中 ×0）',
  ],
  notProvable: [
    '「启动日志无 warn 洪水」以本插件命名空间关键词的 warn 行计数为判据，泛化的全量日志噪声水平不在本剧本范围',
    '多插件并发装卸的交错时序（S14 设计为单施压插件串行装卸；并发归 S25 域）',
  ],
}

// 实例 env（mock registry 证书 + 预载注入）：runner 以 cwd=worktree 根直跑本剧本，
// process.cwd() 即 repo 锚；runner 在 import 完成后才读 meta.env，此处赋值时序成立。
meta.env = registryEnv(process.cwd())

export async function run(ctx) {
  const { ev, log, dataDir, repo } = ctx
  const uncovered = []
  const gotchas = [
    'fixture 首装停在权限审批门（manifest permissions=[providers.write]）——剧本经 plugin.approvePermissions 批准（B 通道=审批按钮协议形态）；批准持久化 permissions.json，后续轮次免审批',
    '卸载清理链的事实源 = 插件目录内 package.json 的 namespace 声明（前缀规则 ns / ns-*）；条目清理发生在卸载 reply 之前（cleanupProviderEntriesFor await 于 removeDescriptor 前）',
    '装卸行使期有两条预期路径 warn：单产物插件 pi 扩展成员跳过（每装一次各一条）、zcode 同步对无 baseUrl 条目跳过（条目写入期各一条）——「warn 洪水」判据窗口 = 终局重启后追加行，行使期 warn 不是残留症状',
  ]
  const { createUI } = await import(path.join(SKILL_ROOT, 'scripts', 'lib', 'ui.mjs'))

  const pluginsDir = path.join(dataDir, 'plugins')
  const stagingDir = path.join(pluginsDir, '.staging')
  const targetDir = path.join(pluginsDir, PLUGIN_ID)
  const installedJsonPath = path.join(pluginsDir, 'installed.json')
  const modelsJsonPath = path.join(dataDir, 'agent', 'models.json')

  const registry = await startMockNpmRegistry(repo, {
    [PKG]: { versions: { '1.0.0': tarballOf(repo, PKG, '1.0.0') }, latest: '1.0.0' },
  })
  ev.step({ step: 'mock-registry.up', channel: 'C', exitCode: 0, stats: { url: registry.url, pkg: PKG } })

  let ui = createUI({ page: await ctx.instance.page(), evidence: ev, repo })
  let page = await ctx.instance.page()
  let proto = ctx.protocol

  const readModels = () => readJson(modelsJsonPath)

  // ── 基线：预置邻居 provider 条目（宿主写路径 = 用户手工添加供应商的协议形态）──
  await proto.call('config.setProvider', {
    providerId: NEIGHBOR_PROVIDER_ID,
    name: NEIGHBOR_ROW_NAME,
    type: 'custom',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: NEIGHBOR_API_KEY,
    models: [{ id: 'plain-neighbor-model-1', name: 'plain-neighbor-model-1' }],
  }, { timeoutMs: 60_000 })
  const neighborEntry0 = readModels()?.providers?.[NEIGHBOR_PROVIDER_ID]
  ev.assert('基线：邻居条目已落盘 models.json（含 apiKey）', neighborEntry0?.apiKey === NEIGHBOR_API_KEY, {
    channel: 'C',
    expected: `${NEIGHBOR_PROVIDER_ID} 条目 apiKey=${NEIGHBOR_API_KEY}`,
    actual: neighborEntry0 ? `apiKey=${neighborEntry0.apiKey}` : `条目缺失（keys=${Object.keys(readModels()?.providers ?? {}).join(',')})`,
  })
  const baselineKeys = Object.keys(readModels()?.providers ?? {})
  ev.step({ step: 'neighbor.seeded', channel: 'C', exitCode: 0, stats: { providerId: NEIGHBOR_PROVIDER_ID, baselineProviders: baselineKeys } })

  // ── 5 轮装卸（第 2 轮卸载后中间重启） ──────────────────────────
  for (let round = 1; round <= ROUNDS; round++) {
    // 安装：直装 → 确认卡 → 提交（首轮带权限审批 interleave）→ 激活
    await openPluginFlow(ui, page)
    await directInstallToConfirm(ui, PKG)
    if (round === 1) {
      const fields = await assertConfirmFields(ui, page, { capabilities: [], readPaths: [], permissions: PERMISSIONS })
      ev.attach('s14-confirm-fields', JSON.stringify(fields, null, 2))
      ev.assert('A: 首轮确认卡知情面（permissions=providers.write 全量展示）', String(fields.permissions ?? '').includes('providers.write'), {
        channel: 'A',
        expected: `permissions 含 ${PERMISSIONS.join(',')}`,
        actual: JSON.stringify(fields),
      })
    }
    await ui.click('testid=plugin-install-confirm-btn')
    if (round === 1) {
      // 提交后激活停在权限审批门（registry 已 reload、descriptor 在列表、等待批准）
      const gated = await pollUntil(
        () => proto.call('plugin.list', {}),
        (r) => (r.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID),
        { timeoutMs: 30_000 },
      )
      ev.assert('B: 首轮提交后插件入注册表（激活停在权限审批门）', (gated.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID), {
        channel: 'B',
        expected: `${PLUGIN_ID} 在 plugin.list`,
        actual: (gated.plugins ?? []).map((p) => `${p.pluginId}:${p.status}`).join(',').slice(0, 200) || '(空)',
      })
      await proto.call('plugin.approvePermissions', { pluginId: PLUGIN_ID, permissions: PERMISSIONS }, { replyType: 'pong', timeoutMs: 60_000 })
      ev.step({ step: 'fixture.approve', channel: 'B', exitCode: 0, stats: { pluginId: PLUGIN_ID, permissions: PERMISSIONS } })
    }
    await ui.expectVisible('testid=plugin-authorize-container', { timeoutMs: 90_000 })
    await closePluginFlow(ui)
    const activeList = await pollUntil(
      () => proto.call('plugin.list', {}),
      (r) => (r.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID && p.status === 'active'),
      { timeoutMs: 30_000 },
    )
    const active = (activeList.plugins ?? []).find((p) => p.pluginId === PLUGIN_ID)
    ev.assert(`B: 第 ${round} 轮安装后插件激活（status=active sandbox）`, Boolean(active && active.status === 'active' && active.trustLevel === 'sandbox'), {
      channel: 'B',
      expected: 'status=active trustLevel=sandbox',
      actual: active ? `status=${active.status} trust=${active.trustLevel}` : '不在列表',
    })
    // 施压断言前提：激活写入了命名空间条目（providers.write 真实行使）
    const wrote = await pollUntil(
      () => readModels()?.providers?.[STRESS_PROVIDER_ID]?.apiKey,
      (key) => key === STRESS_API_KEY,
      { timeoutMs: 20_000 },
    )
    ev.assert(`C: 第 ${round} 轮安装后 models.json 落 ${STRESS_PROVIDER_ID}（apiKey 同值）`, wrote === STRESS_API_KEY, {
      channel: 'C',
      expected: `${STRESS_PROVIDER_ID}.apiKey=${STRESS_API_KEY}`,
      actual: wrote === STRESS_API_KEY ? '同值' : JSON.stringify(readModels()?.providers?.[STRESS_PROVIDER_ID] ?? null).slice(0, 160),
    })

    // 卸载：清理链行使（命名空间条目随卸载消失）
    await proto.call('plugin.uninstall', { pluginId: PLUGIN_ID }, { replyType: 'config.plugins', timeoutMs: 60_000 })
    ev.step({ step: `uninstall.round-${round}`, channel: 'B', exitCode: 0, stats: { pluginId: PLUGIN_ID } })
    const afterUninstall = await pollUntil(
      () => proto.call('plugin.list', {}),
      (r) => !(r.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID),
      { timeoutMs: 30_000 },
    )
    ev.assert(`B: 第 ${round} 轮卸载后 plugin.list 无该项`, !(afterUninstall.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID), {
      channel: 'B',
      expected: `无 ${PLUGIN_ID}`,
      actual: (afterUninstall.plugins ?? []).map((p) => p.pluginId).join(',').slice(0, 200) || '(空)',
    })
    const dirGone = await pollUntil(
      () => fs.existsSync(targetDir),
      (exists) => !exists,
      { timeoutMs: 15_000 },
    )
    ev.assert(`C: 第 ${round} 轮卸载后插件目录无残留`, !dirGone, {
      channel: 'C',
      expected: `${targetDir} 不存在`,
      actual: dirGone ? '目录残留' : '不存在',
    })
    const entriesGone = await pollUntil(
      () => nsEntriesOf(readModels()),
      (entries) => entries.length === 0,
      { timeoutMs: 15_000 },
    )
    ev.assert(`C: 第 ${round} 轮卸载后命名空间孤儿条目清零（含 apiKey）`, entriesGone.length === 0, {
      channel: 'C',
      expected: `models.json 无 ${NS} / ${NS}-* 前缀条目`,
      actual: entriesGone.length === 0 ? '清零' : `残留 ${entriesGone.join(',')}`,
    })
    const neighborNow = readModels()?.providers?.[NEIGHBOR_PROVIDER_ID]
    ev.assert(`C: 第 ${round} 轮后邻居条目不受污染（apiKey 同值）`, neighborNow?.apiKey === NEIGHBOR_API_KEY, {
      channel: 'C',
      expected: `${NEIGHBOR_PROVIDER_ID}.apiKey=${NEIGHBOR_API_KEY}`,
      actual: neighborNow ? `apiKey=${neighborNow.apiKey}` : '条目丢失',
    })

    // 中间重启：stop → launch → waitReady（三条就绪判据）→ 新协议/UI 句柄
    if (round === RESTART_AFTER_ROUND) {
      ev.step({ step: 'restart.begin', channel: 'C', exitCode: 0, stats: { afterRound: round } })
      await ctx.instance.stop()
      await ctx.instance.launch()
      await ctx.instance.waitReady({ timeoutMs: 180_000 })
      proto = await ctx.instance.protocol()
      page = await ctx.instance.page()
      ui = createUI({ page, evidence: ev, repo })
      ev.step({ step: 'restart.ready', channel: 'C', exitCode: 0, stats: { pid: ctx.instance.pid, elapsedMs: ctx.instance.ready?.elapsedMs } })
      const listAfterRestart = await proto.call('plugin.list', {})
      ev.assert('B: 重启后 plugin.list 无该插件（卸载不复活）', !(listAfterRestart.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID), {
        channel: 'B',
        expected: `无 ${PLUGIN_ID}`,
        actual: (listAfterRestart.plugins ?? []).map((p) => p.pluginId).join(',').slice(0, 200) || '(空)',
      })
      const neighborAfterRestart = readModels()?.providers?.[NEIGHBOR_PROVIDER_ID]
      ev.assert('C: 重启后邻居条目原样（不误删）', neighborAfterRestart?.apiKey === NEIGHBOR_API_KEY, {
        channel: 'C',
        expected: `${NEIGHBOR_PROVIDER_ID}.apiKey=${NEIGHBOR_API_KEY}`,
        actual: neighborAfterRestart ? `apiKey=${neighborAfterRestart.apiKey}` : '条目丢失',
      })
      const orphansAfterRestart = nsEntriesOf(readModels())
      ev.assert('C: 重启后无命名空间孤儿条目', orphansAfterRestart.length === 0, {
        channel: 'C',
        expected: '0',
        actual: orphansAfterRestart.join(',') || '0',
      })
    }
  }

  // ── 终局重启（设计 S14 形态：装卸 5 轮 → 重启 → 断言宿主表面不变） ──
  // warn 判据窗口 = 本次重启之后追加的日志行（安装/卸载行使期的预期路径 warn
  // ——单产物 pi 扩展成员跳过、条目无 baseUrl 同步跳过——不计入「启动 warn 洪水」）
  const logLinesBefore = runtimeLogLines(dataDir).length
  ev.step({ step: 'restart.begin', channel: 'C', exitCode: 0, stats: { afterRound: ROUNDS, logLinesBefore } })
  await ctx.instance.stop()
  await ctx.instance.launch()
  await ctx.instance.waitReady({ timeoutMs: 180_000 })
  proto = await ctx.instance.protocol()
  page = await ctx.instance.page()
  ui = createUI({ page, evidence: ev, repo })
  ev.step({ step: 'restart.ready', channel: 'C', exitCode: 0, stats: { pid: ctx.instance.pid, elapsedMs: ctx.instance.ready?.elapsedMs } })

  // ── 终态断言：宿主表面不变（重启后新代际） ─────────────────────
  const finalList = await proto.call('plugin.list', {})
  const crashedOthers = (finalList.plugins ?? []).filter((p) => p.status === 'crashed')
  ev.assert('B: 终态 plugin.list 无该插件且无其他插件进入 crashed', !(finalList.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID) && crashedOthers.length === 0, {
    channel: 'B',
    expected: `无 ${PLUGIN_ID}，crashed=0`,
    actual: `ids=${(finalList.plugins ?? []).map((p) => p.pluginId).join(',').slice(0, 200) || '(空)'} crashed=${crashedOthers.map((p) => p.pluginId).join(',') || '0'}`,
  })

  const providersReply = await proto.call('config.getProviders', {})
  const providerIds = (providersReply.providers ?? []).map((p) => p.id ?? p.providerId)
  const orphanProviders = providerIds.filter((id) => id === NS || String(id).startsWith(`${NS}-`))
  const neighborCount = providerIds.filter((id) => id === NEIGHBOR_PROVIDER_ID).length
  ev.assert('B: config.getProviders 无孤儿 provider（命名空间前缀清零）且邻居恰一条', orphanProviders.length === 0 && neighborCount === 1, {
    channel: 'B',
    expected: `孤儿=0，${NEIGHBOR_PROVIDER_ID} ×1`,
    actual: `孤儿=${orphanProviders.join(',') || '0'}，邻居×${neighborCount}，全部=${providerIds.join(',').slice(0, 200)}`,
  })

  const finalModels = readModels()
  const finalOrphans = nsEntriesOf(finalModels)
  const neighborFinal = finalModels?.providers?.[NEIGHBOR_PROVIDER_ID]
  ev.assert('C: 终态 models.json 无命名空间孤儿条目（含 apiKey 在内全部消失）且邻居凭据同值', finalOrphans.length === 0 && neighborFinal?.apiKey === NEIGHBOR_API_KEY, {
    channel: 'C',
    expected: `孤儿=0 且 ${NEIGHBOR_PROVIDER_ID}.apiKey=${NEIGHBOR_API_KEY}`,
    actual: `孤儿=${finalOrphans.join(',') || '0'}，邻居=${neighborFinal ? `apiKey=${neighborFinal.apiKey}` : '条目丢失'}`,
  })
  const modelsRaw = safeRead(modelsJsonPath)
  ev.assert('C: 终态 models.json 全文无施压 apiKey 字面量', !modelsRaw.includes(STRESS_API_KEY), {
    channel: 'C',
    expected: `全文不含 ${STRESS_API_KEY}`,
    actual: modelsRaw.includes(STRESS_API_KEY) ? '命中（凭据残留）' : '不含有',
  })

  const pluginDirEntries = fs.existsSync(pluginsDir) ? fs.readdirSync(pluginsDir) : []
  const stagingEntries = fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir) : []
  const installedJson = readJson(installedJsonPath)
  ev.assert('C: 终态无残留目录（插件目录不在场 + .staging 清空 + installed.json 无登记）',
    !pluginDirEntries.includes(PLUGIN_ID) && stagingEntries.length === 0 && !installedJson?.[PLUGIN_ID], {
      channel: 'C',
      expected: `plugins 无 ${PLUGIN_ID}，.staging 空，installed.json 无条目`,
      actual: `plugins=${pluginDirEntries.join(',').slice(0, 200)}，.staging=${stagingEntries.join(',') || '(空)'}，installed=${installedJson?.[PLUGIN_ID] ? '有残留' : '无'}`,
    })
  await ui.screenshot('s14-final-provider-page')

  // 启动日志无 warn 洪水（判据 = 终局重启后追加的日志行中「warn + 命名空间关键词」为 0；
  // 装卸行使期的预期路径 warn 不在此窗口——隔离安装链噪声与残留症状两类信号）
  const newLogLines = runtimeLogLines(dataDir).slice(logLinesBefore)
  const warnFlood = newLogLines.filter((line) => /warn/i.test(line) && line.includes(NS))
  ev.attach('s14-runtime-warn-lines', warnFlood.slice(0, 20).join('\n') || '(无)')
  ev.step({ step: 'log.scan', channel: 'C', exitCode: 0, stats: { before: logLinesBefore, after: runtimeLogLines(dataDir).length, warnHits: warnFlood.length } })
  ev.assert('C: 重启后启动日志无该插件命名空间相关的 warn 洪水', warnFlood.length === 0, {
    channel: 'C',
    expected: 'warn 行 ×0（终局重启后追加行含 neighbor-stress 关键词）',
    actual: `warn 行 ×${warnFlood.length}（扫描追加行 ×${newLogLines.length}）`,
  })

  log('S14 done')
  await registry.close()
  return { uncovered, gotchas }
}

/** 命名空间孤儿条目枚举：providerId === ns 或 ns-* 前缀（与卸载清理链同一规则）。 */
function nsEntriesOf(models) {
  const providers = models?.providers ?? {}
  return Object.keys(providers).filter((id) => id === NS || id.startsWith(`${NS}-`))
}

function tarballOf(repo, name, ver) {
  return path.join(repo, '.agents', 'skills', 'verify-taiji', 'fixtures', 'plugin-pkgs', 'dist', `${name}-${ver}.tgz`)
}

/** 运行时日志行（跨 runtime-*.log 按文件名序拼接；行偏移窗口判据用）。 */
function runtimeLogLines(dataDir) {
  const logDir = path.join(dataDir, 'logs')
  if (!fs.existsSync(logDir)) return []
  const lines = []
  for (const f of fs.readdirSync(logDir).filter((f) => f.startsWith('runtime-')).sort()) {
    lines.push(...safeRead(path.join(logDir, f)).split('\n'))
  }
  return lines
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
