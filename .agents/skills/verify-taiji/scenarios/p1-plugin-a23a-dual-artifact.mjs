/**
 * p1-plugin-a23a-dual-artifact —— D3 验收场景 A23a（设计 S23 双产物安装闭环·确定性断言；
 * impl-plan 复审 F5 拆行：A23 的确定性半边，真实对话流归 A23b L4）。
 *
 * 双产物形态（D6/S23）：清单条目携带 piExtensionVersion = 双产物——taiji 插件（管理动作，
 * 装 <dataDir>/plugins/）+ pi 扩展（会话加载面，经 WoolExtensionInstaller 装 <dataDir>/npm/
 * node_modules/）。本剧本断言的是完整生命周期三件套：
 *   安装 → 插件目录 + installed.json 登记 + pi 扩展落盘（npm 布局）+ settings.json packages[]
 *   登记 + models.json 命名空间条目（fixture 插件激活经 providers.write 真实写链落盘）；
 *   卸载（plugin.uninstall）→ 插件目录 + installed.json 条目 + pi 扩展目录 + settings 登记 +
 *   models.json 条目五处完整清除（U4 双产物卸载编排：命名空间前缀扫描派生清理集）。
 *
 * 零真实上游的三层夹具（全部 fixtures/plugin-pkgs 内，零产品代码改动）：
 *   ① mock npm registry（本机 HTTPS，NPM_CONFIG_REGISTRY 预载指向）承载两个 tarball：
 *      plugin-wool-qoder@1.0.0（插件侧）与 @zhushanwen/pi-wool-qoder@1.0.0（扩展侧）；
 *   ② wool-manifest 本地夹具：WoolExtensionInstaller.fetchManifest 的清单 URL 是硬编码
 *      常量（manifestUrl 端口组合根未暴露），经 preload 的 opt-in fetch 拦截
 *      （TAIJI_VERIFY_WOOL_MANIFEST_FILE env，TAIJI_ 前缀白名单内）折到本地文件——
 *      版本配对校验（清单 1.0.0 == 条目 piExtensionVersion 1.0.0）走真实代码路径；
 *   ③ 清单缓存 seed（remote-config/v2-plugins.json，4h 节流窗内不发网络）。
 *
 * 运行形态：runner 托管实例（--run-id 传给 runner，顶层 import 阶段 seed 数据目录，
 * 先于 instance.launch——runner 的 dataDir 派生在 import 之后，两边同源）。
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
  closePluginFlow,
} from './lib/plugin-flow-helper.mjs'
import { resolveDataDirFromArgv } from './lib-plugin-fixtures.mjs'

const PLUGIN_ID = 'plugin-wool-qoder'
const PLUGIN_PKG = 'plugin-wool-qoder'
const EXT_PKG = '@zhushanwen/pi-wool-qoder'
const NAMESPACE = 'wool-qoder' // deriveNamespace('plugin-wool-qoder')：去 plugin- 前缀（shared/plugin-namespace SSOT）
const PROVIDER_ID = 'wool-qoder'
const FIXTURE_API_KEY = 'A23A-FIXTURE-KEY-7Q'
const AUTHORIZED_SENTINEL = 'A23A-AUTHORIZED-SENTINEL-7Q'
const VERSION = '1.0.0'

// ── 顶层预置（import 阶段执行，先于 runner 的 instance.launch）────────
const dataDir0 = resolveDataDirFromArgv()
seedPluginCatalog(dataDir0, [
  catalogEntry({
    packageName: PLUGIN_PKG,
    pluginId: PLUGIN_ID,
    displayName: 'Qoder',
    namespace: NAMESPACE,
    version: VERSION,
    piExtensionVersion: VERSION, // 双产物判定字段（D6：配对唯一权威）
    capabilities: ['network.http'],
  }),
])
// 权限预置（审批落盘同文件、与 manifest 声明同集 = 审批门静默通过——
// plugin-provider-fixture 先例；避免安装期激活停在审批门）：
const pluginsDir0 = path.join(dataDir0, 'plugins')
fs.mkdirSync(pluginsDir0, { recursive: true })
fs.writeFileSync(
  path.join(pluginsDir0, 'permissions.json'),
  `${JSON.stringify({ [PLUGIN_ID]: ['providers.write', 'plugin.views.update', 'plugin.commands.register'] }, null, 2)}\n`,
  'utf8',
)

export const meta = {
  id: 'p1-plugin-a23a-dual-artifact',
  priority: 'P1',
  title: 'S23 双产物安装闭环·确定性断言：安装五处在场 + 卸载五处完整清除（文件系统/注册表）',
  covers: ['plugin.list', 'settings.provider'],
  requires: [],
  estimateSec: 240,
  env: undefined, // 下方模块加载段按 repo 填充（runner 在 import 之后才读 meta.env）

  provable: [
    'C: 安装后插件目录落盘（<dataDir>/plugins/plugin-wool-qoder + package.json）+ installed.json 登记含 installedAt',
    'C: 安装后 pi 扩展成员落盘（<dataDir>/npm/node_modules/@zhushanwen/pi-wool-qoder，版本=清单配对值）+ settings.json packages[] 登记 npm:<pkg>',
    'B: 安装后插件 active（plugin.list）+ 扩展 enabled（extension.list）——双产物双注册表对账',
    'C: models.json 命名空间条目（providers.write 真实写链：apiKey + 2 模型，由 fixture 插件激活时写入）',
    'B/C: 卸载后五处完整清除——插件目录 / installed.json 条目 / pi 扩展目录 / settings 登记 / models.json 条目，plugin.list 无该项',
  ],
  notProvable: [
    'pi 扩展的真实对话流（对话链需真实上游凭据，归 A23b L4）——本剧本只证安装落盘与注册表事实',
    'wool-manifest 远端发布链（github/gitcode 双通道）——本剧本经 preload 拦截折到本地夹具，配对校验代码路径为真、网络链为假',
  ],
}

// 实例 env：mock registry 证书 + 预载注入 + wool-manifest 拦截目标（runner 以 cwd=worktree
// 根直跑本剧本，process.cwd() 即 repo 锚；.agents 是跨 workspace 符号链接，import.meta 路径不可用）。
meta.env = {
  ...registryEnv(process.cwd()),
  TAIJI_VERIFY_WOOL_MANIFEST_FILE: path.join(process.cwd(), '.agents', 'skills', 'verify-taiji', 'fixtures', 'plugin-pkgs', 'wool-manifest.json'),
}

export async function run(ctx) {
  const { protocol, ui, ev, log, dataDir } = ctx
  const page = await ctx.instance.page()
  const gotchas = [
    'pi 扩展 npm 布局事实源：extension-service installExtension → installAndValidate → <dataDir>/npm/node_modules/<pkg>（scoped 天然子目录）+ pi-settings-store packages[]；卸载 uninstallExtension 反向清除',
    'models.json 条目由 fixture 插件激活内 providers.write 写入（真实写链：身份收窄 → 命名空间复核 → setProvider 写策略链），非剧本直写',
    '卸载清理集按命名空间前缀扫描 models.json 派生（无 pluginId→providerId 落盘登记）——providerId 命名 wool-qoder 才会被扫中',
  ]

  const registry = await startMockNpmRegistry(ctx.repo, buildRegistryMap(ctx.repo))
  ev.step({ step: 'mock-registry.up', channel: 'C', exitCode: 0, stats: { url: registry.url, pkgs: [PLUGIN_PKG, EXT_PKG] } })

  const pluginsDir = path.join(dataDir, 'plugins')
  const targetDir = path.join(pluginsDir, PLUGIN_ID)
  const installedJsonPath = path.join(pluginsDir, 'installed.json')
  const extDir = path.join(dataDir, 'npm', 'node_modules', ...EXT_PKG.split('/'))
  const settingsPath = path.join(dataDir, 'agent', 'settings.json')
  const modelsPath = path.join(dataDir, 'agent', 'models.json')

  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }
  const settingsPackages = () => readJson(settingsPath)?.packages ?? []
  const modelsProviders = () => Object.keys(readJson(modelsPath)?.providers ?? {})

  // ── 基线：三件套全部缺席 ─────────────────────────────────────
  const listed0 = await protocol.call('plugin.list', {})
  ev.assert('B: 基线——plugin.list 无 plugin-wool-qoder', !(listed0.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID), {
    channel: 'B',
    expected: `无 ${PLUGIN_ID}`,
    actual: (listed0.plugins ?? []).map((p) => p.pluginId).join(',').slice(0, 200) || '(空)',
  })
  ev.assert('C: 基线——pi 扩展目录与 settings 登记缺席', !fs.existsSync(extDir) && !settingsPackages().includes(`npm:${EXT_PKG}`), {
    channel: 'C',
    expected: `${extDir} 不存在且 packages[] 无 npm:${EXT_PKG}`,
    actual: `extDir=${fs.existsSync(extDir) ? '在场' : '缺席'} packages=${settingsPackages().filter((s) => s.includes('wool')).join(',') || '无 wool 项'}`,
  })
  ev.assert('C: 基线——models.json 无 wool-qoder 条目', !modelsProviders().includes(PROVIDER_ID), {
    channel: 'C',
    expected: `providers 无 ${PROVIDER_ID}`,
    actual: modelsProviders().join(',').slice(0, 200) || '(空)',
  })
  const avail = await protocol.call('plugin.listAvailable', {})
  const availEntry = (avail.plugins ?? []).find((p) => p.pluginId === PLUGIN_ID)
  ev.assert('B: 清单条目可安装视图（family.id=wool-qoder + 双产物版本配对字段在条目上）',
    Boolean(availEntry) && availEntry?.family?.id === NAMESPACE && availEntry?.installed === false, {
      channel: 'B',
      expected: `family.id=${NAMESPACE} installed=false`,
      actual: JSON.stringify(availEntry ? { family: availEntry.family?.id, installed: availEntry.installed } : avail.plugins ?? avail).slice(0, 200),
    })

  // ── 安装（家族卡路径：清单驱动的羊毛用户路径）─────────────────
  // 就绪锚用页头常驻 provider-template-picker（页头无条件渲染）：本剧本 import 阶段
  // 预建 dataDir（seed 清单/权限）→ 模板种子跳过 → agent/models.json 缺失 → Provider
  // 列表空 → provider-list-header（v-if 列表非空）永远不渲染（plugin-provider-fixture
  // openProviderPage 同款坑位登记，2026-10-24 d3-r4-a23a 首跑归因）。
  await ui.click('testid=sidebar-settings')
  await ui.expectVisible('testid=settings-nav-provider')
  await ui.click('testid=settings-nav-provider')
  await ui.expectVisible('testid=provider-template-picker')
  await ui.click('testid=provider-template-picker')
  await ui.click('testid=add-menu-plugin')
  await ui.expectVisible('testid=plugin-provider-flow')
  await ui.expectVisible('testid=plugin-family-grid')
  const cardSel = 'css=[data-testid="plugin-family-card"]'
  const cardText = await ui.text(cardSel)
  ev.assert('A: 家族卡渲染 Qoder 家族（清单条目驱动）', cardText.includes('Qoder'), {
    channel: 'A',
    expected: '卡文本含 Qoder',
    actual: cardText.slice(0, 120),
  })
  await ui.click(cardSel)
  await ui.expectVisible('testid=plugin-install-confirm', { timeoutMs: 60_000 })
  ev.step({ step: 'prepare.via-family-card', channel: 'A', exitCode: 0, stats: { pkg: PLUGIN_PKG } })
  await ui.screenshot('a23a-confirm-card')
  await ui.click('testid=plugin-install-confirm-btn')
  await ui.expectVisible('testid=plugin-authorize-container', { timeoutMs: 60_000 })
  await ui.screenshot('a23a-after-confirm-authorize')
  ev.step({ step: 'confirm.install', channel: 'A', exitCode: 0, stats: {} })

  // ── 安装后·B 通道：双注册表对账 ─────────────────────────────
  const listed1 = await pollValue(
    async () => {
      const r = await protocol.call('plugin.list', {})
      return (r.plugins ?? []).find((p) => p.pluginId === PLUGIN_ID)
    },
    (info) => Boolean(info && info.status === 'active'),
    { timeoutMs: 30_000, label: '插件 active' },
  )
  ev.assert('B: 插件已激活（status=active，sandbox）', listed1?.status === 'active' && listed1?.trustLevel === 'sandbox', {
    channel: 'B',
    expected: 'status=active trustLevel=sandbox',
    actual: listed1 ? `status=${listed1.status} trust=${listed1.trustLevel} v${listed1.version}` : '插件不在列表',
  })
  const extListed = await pollValue(
    async () => {
      const r = await protocol.call('extension.list', {})
      return (r.extensions ?? []).find((e) => e.name === EXT_PKG)
    },
    (info) => Boolean(info && info.enabled),
    { timeoutMs: 30_000, label: 'pi 扩展 enabled' },
  )
  ev.assert('B: pi 扩展已注册且 enabled（extension.list）', Boolean(extListed?.enabled), {
    channel: 'B',
    expected: `${EXT_PKG} enabled=true`,
    actual: extListed ? `v${extListed.version} enabled=${extListed.enabled}` : '扩展不在列表',
  })

  // ── 安装后·C 通道：五处在场 ─────────────────────────────────
  const pluginPkg = readJson(path.join(targetDir, 'package.json'))
  ev.assert('C: 插件目录落盘（package.json 在场且包名/命名空间与清单同源）',
    pluginPkg?.name === PLUGIN_PKG && pluginPkg?.taijiPlugin?.namespace === NAMESPACE, {
      channel: 'C',
      expected: `${PLUGIN_PKG} + namespace=${NAMESPACE}`,
      actual: pluginPkg ? `name=${pluginPkg.name} ns=${pluginPkg.taijiPlugin?.namespace}` : `${targetDir}/package.json 缺失`,
    })
  const installedJson = readJson(installedJsonPath)
  ev.assert('C: installed.json 登记安装事实（installedAt）', Boolean(installedJson?.[PLUGIN_ID]?.installedAt), {
    channel: 'C',
    expected: `installed.json['${PLUGIN_ID}'].installedAt 为时间戳`,
    actual: JSON.stringify(installedJson?.[PLUGIN_ID] ?? null).slice(0, 200),
  })
  const extPkg = readJson(path.join(extDir, 'package.json'))
  ev.assert('C: pi 扩展成员落盘（node_modules npm 布局，版本=清单配对值）', extPkg?.name === EXT_PKG && extPkg?.version === VERSION, {
    channel: 'C',
    expected: `${extDir} v${VERSION}`,
    actual: extPkg ? `name=${extPkg.name} v${extPkg.version}` : `${extDir}/package.json 缺失`,
  })
  ev.assert('C: settings.json packages[] 登记 pi 扩展（npm:<纯名>，钉版语义只存在于安装时刻）',
    settingsPackages().includes(`npm:${EXT_PKG}`), {
      channel: 'C',
      expected: `packages[] 含 npm:${EXT_PKG}`,
      actual: settingsPackages().filter((s) => s.includes('wool')).join(',') || '无 wool 项',
    })
  const modelsEntry = await pollValue(
    () => readJson(modelsPath)?.providers?.[PROVIDER_ID] ?? null,
    Boolean,
    { timeoutMs: 30_000, label: 'models.json wool-qoder 条目' },
  )
  ev.assert('C: models.json 命名空间条目（providers.write 写链：apiKey + 2 模型）',
    modelsEntry?.apiKey === FIXTURE_API_KEY && (modelsEntry?.models ?? []).length === 2, {
      channel: 'C',
      expected: `apiKey=${FIXTURE_API_KEY} models×2`,
      actual: modelsEntry ? `apiKey=${String(modelsEntry.apiKey).slice(0, 8)}… models=${(modelsEntry.models ?? []).length} name=${modelsEntry.name ?? '—'}` : '条目缺失',
    })
  const registryPaths = registry.requests.map((r) => r.path)
  ev.assert('C: 双产物都经本机 mock registry 流转（插件 + pi 扩展 packument 均有请求）',
    registryPaths.some((p) => p.includes(PLUGIN_PKG)) && registryPaths.some((p) => p.includes(EXT_PKG.split('/')[1])), {
      channel: 'C',
      expected: 'registry 请求含 plugin-wool-qoder 与 pi-wool-qoder 两包',
      actual: `requests=${registryPaths.length} uniq=${[...new Set(registryPaths)].slice(0, 8).join(' | ')}`,
    })
  await ui.screenshot('a23a-installed-five-artifacts')

  // ── 卸载（plugin.uninstall → U4 双产物卸载编排）───────────────
  await protocol.call('plugin.uninstall', { pluginId: PLUGIN_ID })
  const unlisted = await pollGone(
    async () => (await protocol.call('plugin.list', {})).plugins?.some((p) => p.pluginId === PLUGIN_ID) ?? false,
    { timeoutMs: 30_000 },
  )
  ev.assert('B: 卸载后 plugin.list 无该项', unlisted, {
    channel: 'B',
    expected: `无 ${PLUGIN_ID}`,
    actual: unlisted ? '已移除' : '仍在列表',
  })
  const gonePlugin = await pollGone(() => fs.existsSync(targetDir), { timeoutMs: 15_000 })
  const installedAfter = readJson(installedJsonPath)
  const goneExtDir = await pollGone(() => fs.existsSync(extDir), { timeoutMs: 15_000 })
  const goneModels = await pollGone(() => modelsProviders().includes(PROVIDER_ID), { timeoutMs: 15_000 })
  ev.assert('C: 卸载五处完整清除（插件目录 / installed.json / pi 扩展目录 / settings 登记 / models.json 条目）',
    gonePlugin && !installedAfter?.[PLUGIN_ID] && goneExtDir && !settingsPackages().includes(`npm:${EXT_PKG}`) && goneModels, {
      channel: 'C',
      expected: '五处全部清零',
      actual: [
        `pluginDir=${gonePlugin ? '已删' : '残留'}`,
        `installedJson=${installedAfter?.[PLUGIN_ID] ? '残留' : '已清'}`,
        `extDir=${goneExtDir ? '已删' : '残留'}`,
        `settings=${settingsPackages().filter((s) => s.includes('wool')).join(',') || '无 wool 项'}`,
        `models=${goneModels ? '已清' : `残留 ${modelsProviders().filter((k) => k.startsWith(NAMESPACE)).join(',')}`}`,
      ].join(' '),
    })
  await ui.screenshot('a23a-after-uninstall')

  await closePluginFlow(ui)
  log('A23a done')
  await registry.close()
  return { uncovered: [], gotchas }
}

/** registry 版本表：fixtures/plugin-pkgs/dist/ 双 tarball（repo 锚定，符号链接安全）。 */
function buildRegistryMap(repo) {
  const distDir = path.join(repo, '.agents', 'skills', 'verify-taiji', 'fixtures', 'plugin-pkgs', 'dist')
  const pluginTgz = path.join(distDir, `${PLUGIN_PKG}-${VERSION}.tgz`)
  const extTgz = path.join(distDir, `${EXT_PKG.split('/')[1]}-${VERSION}.tgz`)
  for (const f of [pluginTgz, extTgz]) {
    if (!fs.existsSync(f)) throw new Error(`缺 fixture tarball：${f}`)
  }
  return {
    [PLUGIN_PKG]: { versions: { [VERSION]: pluginTgz }, latest: VERSION },
    [EXT_PKG]: { versions: { [VERSION]: extTgz }, latest: VERSION },
  }
}

/** 条件轮询取值（异步判定，每轮重算；超时返回末值——失败形态由断言呈现，不抛）。 */
async function pollValue(fn, predicate, { timeoutMs, intervalMs = 500, label = 'condition' }) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await fn()
    if (predicate(last)) return last
    if (Date.now() >= deadline) {
      const e = new Error(`pollUntil 超时（${timeoutMs}ms）: ${label}`)
      e.hint = '核对安装编排（plugin.list / extension.list / 磁盘路径）与 runtime 日志'
      e.evidence = `末值=${JSON.stringify(last)?.slice(0, 200)}`
      throw e
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** 布尔消失轮询：fn() 为假值即通过（返回 true）；超时返回 false（断言呈现残留形态）。 */
async function pollGone(fn, { timeoutMs, intervalMs = 500 }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const gone = !(await fn())
    if (gone) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
