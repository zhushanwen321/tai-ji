/**
 * p1-plugin-install-confirm —— 安装确认知情面（impl-plan A27 / 设计 S27）：
 * 确认卡在提交前全量展示 capabilities 与 readPaths（展示物 = 暂存解压物内 manifest，
 * 同源）；未确认不发生安装落盘（取消清暂存 + 正式目录不出现）。
 *
 * 双路径（设计 S27 要求清单安装与包名直装各走一次）：
 *   路径① 家族卡安装：seed 清单缓存（remote-config/v2-plugins.json，节流窗内 runtime
 *     直读缓存）→ 家族卡点击 → prepare（mock registry HTTPS 下载解压至暂存）→ 确认卡
 *     断言知情面 → 取消 → 暂存清理 + 正式目录不出现；
 *   路径② 包名直装：plugin-direct-spec 输入 → 同一确认停点 → 知情面断言（与暂存
 *     manifest 同源核对：staging 内 package.json 的 taijiPlugin 字段逐字对上）→
 *     确认 → 提交激活成功（B：plugin.list active；C：目录落盘 + installed.json 登记）。
 *
 * 装配：本机 mock npm registry（fixtures/plugin-pkgs tarball + 自签证书；registry
 * 地址经 NODE_OPTIONS 预载注入，NODE_EXTRA_CA_CERTS 信任证书——两 env 都在
 * main→runtime 白名单 NODE_ 前缀内）。无 LLM 需求（requires: none）。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  startMockNpmRegistry,
  seedPluginCatalog,
  catalogEntry,
  registryEnv,
} from './lib/mock-npm-registry.mjs'
import {
  openPluginFlow,
  directInstallToConfirm,
  assertConfirmFields,
  closePluginFlow,
  pollUntil,
} from './lib/plugin-flow-helper.mjs'

const PKG = 'plugin-confirm-demo'
const PLUGIN_ID = 'plugin-confirm-demo'
const MANIFEST = {
  capabilities: ['network.http'],
  readPaths: ['Documents/taiji-verify-confirm-demo.json'],
}

export const meta = {
  id: 'p1-plugin-install-confirm',
  priority: 'P1',
  title: 'S27 安装确认知情面：确认卡全量展示 capabilities/readPaths + 未确认不落盘（双路径）',
  covers: ['plugin.list', 'plugin.toggle', 'settings.provider'],
  requires: [],
  estimateSec: 240,
  env: undefined, // 下方模块加载段按 repo 填充（runner 在 import 之后才读 meta.env）

  provable: [
    '路径①家族卡安装：确认卡在提交前全量展示 capabilities（network.http）与 readPaths，展示项与暂存解压物 manifest 同源',
    '取消（未确认）不发生安装落盘：暂存目录清理 + 正式目录不出现 + plugin.list 无此项',
    '路径②包名直装：同一确认停点同一知情面；确认后 B（plugin.list active）+ C（目录 + installed.json）双证',
  ],
  notProvable: [
    '「展示物 = 提交阶段校验物」的运行时同一性（宿主从暂存 manifest 读取后透传）以「确认卡字段 = 暂存 package.json 内容逐字比对」同源核对替代——无独立观测通道可证读取链路',
    '远程清单真实拉取（清单缓存为本剧本 seed 的本地形态，remote-config 网络链归 S15 域）',
  ],
}

export async function run(ctx) {
  const { protocol, ui, ev, log, dataDir } = ctx
  const uncovered = []
  const gotchas = [
    'registry 地址注入走 NODE_OPTIONS --require 预载（NPM_* 不在 main→runtime env 白名单）；tarball 走 HTTPS localhost（validateUrlHost 拒非 https 与私网 IP host，localhost 含字母可过）',
    '清单来自 seed 的 remote-config 域缓存（checkedAt 在 4h 节流窗内 → runtime 不发网络，直读缓存；S15 网络链不在本剧本范围）',
  ]

  const registry = await startMockNpmRegistry(ctx.repo, buildRegistryMap(ctx.repo))
  ev.step({ step: 'mock-registry.up', channel: 'C', exitCode: 0, stats: { url: registry.url, pkg: PKG } })

  // 插件目录事实锚（runtime configDir = 实例数据目录，pluginsDir = <dataDir>/plugins）
  const pluginsDir = path.join(dataDir, 'plugins')
  const stagingDir = path.join(pluginsDir, '.staging')
  const targetDir = path.join(pluginsDir, PLUGIN_ID)
  const installedJsonPath = path.join(pluginsDir, 'installed.json')

  const pluginsBefore = await protocol.call('plugin.list', {})
  ev.assert('基线：目标插件尚未安装', !(pluginsBefore.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID), {
    channel: 'B',
    expected: `plugin.list 无 ${PLUGIN_ID}`,
    actual: (pluginsBefore.plugins ?? []).map((p) => p.pluginId).join(',').slice(0, 200) || '(空)',
  })

  // ── 路径①：家族卡安装 → 确认卡 → 取消（未确认不落盘） ──────────
  seedPluginCatalog(dataDir, [
    catalogEntry({
      packageName: PKG,
      pluginId: PLUGIN_ID,
      displayName: 'Confirm Demo',
      namespace: 'confirm-demo',
      version: '1.0.0',
      capabilities: MANIFEST.capabilities,
      readPaths: MANIFEST.readPaths,
    }),
  ])
  ev.step({ step: 'catalog.seed', channel: 'C', exitCode: 0, stats: { entries: 1 } })

  await openPluginFlow(ui)
  await ui.expectVisible('testid=plugin-family-grid')
  await ui.click('testid=plugin-family-card')
  await ui.expectVisible('testid=plugin-install-confirm', { timeoutMs: 60_000 })
  ev.step({ step: 'prepare.via-family-card', channel: 'A', exitCode: 0, stats: {} })

  const confirmShot = await ui.screenshot('s27-confirm-card')
  ev.attach('s27-confirm-card', confirmShot)
  const fields1 = await assertConfirmFields(ui, MANIFEST)
  ev.attach('s27-confirm-card-fields', JSON.stringify(fields1, null, 2))
  ev.assert('A: 确认卡全量展示 capabilities 与 readPaths（与 fixture manifest 同源）', true, {
    channel: 'A',
    expected: MANIFEST,
    actual: fields1,
  })

  // 同源核对：确认停点态，暂存解压物在 .staging/<pluginId>，其 manifest 与确认卡一致；
  // 正式目录未出现（未确认不落盘）
  const stagingPkg = readJson(path.join(stagingDir, PLUGIN_ID, 'package.json'))
  ev.assert('C: 确认停点态暂存解压物在场且 manifest 与确认卡展示同源', Boolean(stagingPkg), {
    channel: 'C',
    expected: `${MANIFEST.capabilities} + ${MANIFEST.readPaths}（staging package.json）`,
    actual: stagingPkg
      ? { capabilities: stagingPkg.taijiPlugin?.capabilities, readPaths: stagingPkg.taijiPlugin?.readPaths, version: stagingPkg.version }
      : `staging 缺 ${path.join(stagingDir, PLUGIN_ID, 'package.json')}`,
  })
  ev.assert('C: 未确认不落盘——正式目录未出现', !fs.existsSync(targetDir), {
    channel: 'C',
    expected: `${targetDir} 不存在`,
    actual: fs.existsSync(targetDir) ? '已存在（违反知情停点）' : '不存在',
  })
  const listedMid = await pollUntil(
    () => protocol.call('plugin.list', {}),
    (r) => (r.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID),
    { timeoutMs: 3_000 },
  )
  ev.assert('B: 确认停点态 plugin.list 仍无该项（提交未发生）', !(listedMid.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID), {
    channel: 'B',
    expected: `无 ${PLUGIN_ID}`,
    actual: (listedMid.plugins ?? []).map((p) => p.pluginId).join(',').slice(0, 200) || '(空)',
  })

  // 取消：清暂存 + 退回家族卡
  await ui.click('testid=plugin-install-cancel')
  await ui.expectVisible('testid=plugin-family-grid', { timeoutMs: 15_000 })
  const stagingGone = await pollUntil(
    () => fs.existsSync(path.join(stagingDir, PLUGIN_ID)),
    (exists) => !exists,
    { timeoutMs: 10_000 },
  )
  ev.assert('C: 取消后暂存目录已清理', !fs.existsSync(stagingGone ? path.join(stagingDir, PLUGIN_ID) : stagingDir), {
    channel: 'C',
    expected: '.staging/plugin-confirm-demo 不存在',
    actual: fs.existsSync(path.join(stagingDir, PLUGIN_ID)) ? '暂存残留' : '已清理',
  })
  ev.assert('C: 取消后正式目录仍不出现', !fs.existsSync(targetDir), {
    channel: 'C',
    expected: '不存在',
    actual: fs.existsSync(targetDir) ? '已出现（取消泄漏落盘）' : '不存在',
  })
  await ui.screenshot('s27-after-cancel')

  // ── 路径②：包名直装 → 确认卡 → 确认 → 提交激活 ─────────────────
  await directInstallToConfirm(ui, PKG)
  ev.step({ step: 'prepare.via-direct-spec', channel: 'A', exitCode: 0, stats: { spec: PKG } })
  const fields2 = await assertConfirmFields(ui, MANIFEST)
  ev.attach('s27-direct-confirm-fields', JSON.stringify(fields2, null, 2))
  ev.assert('A: 直装路径确认卡同一知情面', true, {
    channel: 'A',
    expected: MANIFEST,
    actual: fields2,
  })

  await ui.click('testid=plugin-install-confirm-btn')
  // 确认成功 → 进入授权容器段（plugin-authorize-container = 提交成功的 UI 信号）
  await ui.expectVisible('testid=plugin-authorize-container', { timeoutMs: 60_000 })
  await ui.screenshot('s27-after-confirm')
  ev.step({ step: 'confirm.install', channel: 'A', exitCode: 0, stats: {} })

  const listedAfter = await pollUntil(
    () => protocol.call('plugin.list', {}),
    (r) => (r.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID && p.status === 'active'),
    { timeoutMs: 30_000 },
  )
  const info = (listedAfter.plugins ?? []).find((p) => p.pluginId === PLUGIN_ID)
  ev.assert('B: 确认后插件已激活（status=active，sandbox）', Boolean(info && info.status === 'active' && info.trustLevel === 'sandbox'), {
    channel: 'B',
    expected: 'status=active trustLevel=sandbox',
    actual: info ? `status=${info.status} trust=${info.trustLevel} v${info.version}` : '插件不在列表',
  })
  ev.assert('C: 正式目录落盘', fs.existsSync(path.join(targetDir, 'package.json')), {
    channel: 'C',
    expected: `${targetDir}/package.json 存在`,
    actual: fs.existsSync(path.join(targetDir, 'package.json')) ? '存在' : '缺失',
  })
  const installedJson = readJson(installedJsonPath)
  ev.assert('C: installed.json 登记安装事实（installedAt）', Boolean(installedJson?.[PLUGIN_ID]?.installedAt), {
    channel: 'C',
    expected: `installed.json['${PLUGIN_ID}'].installedAt 为时间戳`,
    actual: JSON.stringify(installedJson?.[PLUGIN_ID] ?? null),
  })
  ev.assert('C: 暂存区已清空（提交后无残留）', !fs.existsSync(path.join(stagingDir, PLUGIN_ID)), {
    channel: 'C',
    expected: '无暂存残留',
    actual: fs.existsSync(path.join(stagingDir, PLUGIN_ID)) ? '暂存残留' : '无残留',
  })

  await closePluginFlow(ui)
  log('S27 done')
  await registry.close()
  return { uncovered, gotchas }
}

/** registry 版本表：fixtures/plugin-pkgs/dist/<name>-<ver>.tgz（repo 锚定，符号链接安全） */
function buildRegistryMap(repo) {
  const distDir = path.join(repo, '.agents', 'skills', 'verify-taiji', 'fixtures', 'plugin-pkgs', 'dist')
  const versions = {}
  for (const f of fs.readdirSync(distDir)) {
    if (!f.startsWith('plugin-confirm-demo-') || !f.endsWith('.tgz')) continue
    const ver = f.slice('plugin-confirm-demo-'.length, -'.tgz'.length)
    versions[ver] = path.join(distDir, f)
  }
  if (Object.keys(versions).length === 0) throw new Error(`no plugin-confirm-demo tarballs in ${distDir}`)
  return {
    'plugin-confirm-demo': { versions, latest: '1.0.0' },
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
