/**
 * p1-plugin-a26-update-chain —— 插件更新链路（impl-plan A26 / 设计 S26）：
 * 清单版本 > 已装版本 → 条目更新提示 → 执行更新（provider 条目与凭据保留）；
 * 更新中途必失败的 fixture 包（激活即抛错）→ 更新失败 → 旧版本幸存可用（无两头空）。
 *
 * 三版本链（fixtures/plugin-update-demo）：
 *   1.0.0 基线安装（激活写 update-demo-main 条目 + apiKey）→
 *   清单翻 1.1.0（改写 remote-config 缓存 pluginVersion + mock registry dist-tags.latest
 *   → 家族卡 plugin-family-update-badge + 条目「更新插件」按钮两级提示）→ 确认卡（update
 *   意图直达）→ 更新成功（重激活重写同 providerId，apiKey 同值）→
 *   清单翻 2.0.0（激活必抛错包）→ 更新失败（plugin-install-error 可见）→ 旧版本 1.1.0
 *   幸存（目录 version / plugin.list version / models.json 条目凭据三证）→ 重新启用
 *   激活成功（「可用」面收口）。
 *
 * 装配：本机 mock npm registry（同 p1-plugin-install-confirm；setLatest 翻转 dist-tags）
 * + 清单缓存改写（seedPluginCatalog 幂等覆写，mtime 失效 → runtime 下次拉取即新清单）。
 * fixture 声明 permissions=[providers.write]，首装停在权限审批门——剧本经
 * plugin.approvePermissions 批准（B 通道），批准落盘后续更新免审批。无 LLM 需求。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

const PKG = 'plugin-update-demo'
const PLUGIN_ID = 'plugin-update-demo'
const NS = 'update-demo'
const PROVIDER_ID = 'update-demo-main'
const API_KEY = 'udk-update-demo-api-key-0001'
const CAPABILITIES = ['network.http']
const READ_PATHS = ['Documents/taiji-verify-update-demo.json']
const PERMISSIONS = ['providers.write']
const ROW_NAME_SUBSTR = 'update-demo (verify fixture'
const STAGING_DIR = '.staging'
const REPLACING_PREFIX = '.replacing-'

export const meta = {
  id: 'p1-plugin-a26-update-chain',
  priority: 'P1',
  title: 'S26 更新链路：版本提示两级呈现 → 更新成功条目凭据保留 → 必败包更新失败旧版本幸存可用',
  covers: ['plugin.list', 'plugin.toggle', 'settings.provider'],
  requires: [],
  estimateSec: 360,
  env: undefined, // 模块加载段按 repo 填充（runner 在 import 之后才读 meta.env）

  provable: [
    'A: 家族卡更新提示（plugin-family-update-badge）与条目内「更新插件」按钮（provider-update-plugin-btn）随「清单版本 > 已装版本」出现',
    '更新成功：确认卡 update 意图直达（@1.1.0）；更新后 plugin.list version=1.1.0 active、目录 package.json version=1.1.0、插件重激活重写同 providerId（displayName 切 1.1.0）且 apiKey 同值',
    '更新失败（激活必抛错包）：plugin-install-error 可见；旧版本幸存三证——目录 package.json 仍 1.1.0、plugin.list version 仍 1.1.0、models.json 条目凭据不动；暂存/替换位无残留',
    '旧版本可用：失败后重新启用（plugin.toggle）激活成功（status=active version=1.1.0），条目凭据原值（无两头空）',
  ],
  notProvable: [
    '清单远程热更新链（清单为本剧本 seed 的本地缓存形态，版本翻转走改写缓存文件——远程拉取归 S15 域）',
    '更新中断的进程级形态（commit 窗口进程死亡由 .staging 替换位启动清扫承接，归 S18/S14 残留面；本剧本覆盖激活失败回滚路径）',
  ],
}

// 实例 env（mock registry 证书 + 预载注入）：runner 以 cwd=worktree 根直跑本剧本，
// process.cwd() 即 repo 锚；runner 在 import 完成后才读 meta.env，此处赋值时序成立。
meta.env = registryEnv(process.cwd())

export async function run(ctx) {
  const { ev, log, dataDir, repo } = ctx
  const uncovered = []
  const gotchas = [
    'fixture 首装停在权限审批门（manifest permissions=[providers.write]）——剧本经 plugin.approvePermissions 批准（B 通道=审批按钮协议形态）；批准持久化，后续更新免审批',
    '版本翻转双杠杆：清单缓存 pluginVersion 驱动 updateAvailable 呈现（isUpdateAvailable 语义比较），registry dist-tags.latest 驱动 prepare/confirm 实际下载的 tarball 版本',
    '更新失败回滚后插件呈未激活态（激活终局失败），「可用」以重新启用激活成功收口——目录/注册表/凭据幸存是本剧本硬断言，恢复激活是行为断言',
  ]
  const { createUI } = await import(path.join(SKILL_ROOT, 'scripts', 'lib', 'ui.mjs'))

  const pluginsDir = path.join(dataDir, 'plugins')
  const stagingDir = path.join(pluginsDir, STAGING_DIR)
  const targetDir = path.join(pluginsDir, PLUGIN_ID)
  const modelsJsonPath = path.join(dataDir, 'agent', 'models.json')

  const registry = await startMockNpmRegistry(repo, buildRegistryMap(repo))
  ev.step({ step: 'mock-registry.up', channel: 'C', exitCode: 0, stats: { url: registry.url, pkg: PKG, versions: ['1.0.0', '1.1.0', '2.0.0'], latest: '1.0.0' } })

  const ui = createUI({ page: await ctx.instance.page(), evidence: ev, repo })
  const page = await ctx.instance.page()
  const proto = ctx.protocol
  const readModels = () => readJson(modelsJsonPath)

  // ── 基线 + 1.0.0 基线安装（直装，首装带权限审批 interleave） ────
  const before = await proto.call('plugin.list', {})
  ev.assert('基线：目标插件尚未安装', !(before.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID), {
    channel: 'B',
    expected: `plugin.list 无 ${PLUGIN_ID}`,
    actual: (before.plugins ?? []).map((p) => p.pluginId).join(',').slice(0, 200) || '(空)',
  })

  await openPluginFlow(ui, page)
  await directInstallToConfirm(ui, PKG)
  await ui.click('testid=plugin-install-confirm-btn')
  const gated = await pollUntil(
    () => proto.call('plugin.list', {}),
    (r) => (r.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID),
    { timeoutMs: 30_000 },
  )
  ev.assert('B: 提交后插件入注册表（激活停在权限审批门）', (gated.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID), {
    channel: 'B',
    expected: `${PLUGIN_ID} 在 plugin.list`,
    actual: (gated.plugins ?? []).map((p) => `${p.pluginId}:${p.status}`).join(',').slice(0, 200) || '(空)',
  })
  await proto.call('plugin.approvePermissions', { pluginId: PLUGIN_ID, permissions: PERMISSIONS }, { replyType: 'pong', timeoutMs: 60_000 })
  ev.step({ step: 'fixture.approve', channel: 'B', exitCode: 0, stats: { pluginId: PLUGIN_ID, permissions: PERMISSIONS } })
  await ui.expectVisible('testid=plugin-authorize-container', { timeoutMs: 90_000 })
  await closePluginFlow(ui)
  const active1 = await pollUntil(
    () => proto.call('plugin.list', {}),
    (r) => (r.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID && p.status === 'active' && p.version === '1.0.0'),
    { timeoutMs: 30_000 },
  )
  const info1 = (active1.plugins ?? []).find((p) => p.pluginId === PLUGIN_ID)
  ev.assert('B: 基线安装激活（status=active version=1.0.0）', Boolean(info1), {
    channel: 'B',
    expected: 'active @1.0.0',
    actual: info1 ? `status=${info1.status} v${info1.version}` : '不在列表',
  })
  const key1 = await pollUntil(
    () => readModels()?.providers?.[PROVIDER_ID]?.apiKey,
    (key) => key === API_KEY,
    { timeoutMs: 20_000 },
  )
  ev.assert('C: 基线激活写入条目（update-demo-main + apiKey 同值）', key1 === API_KEY, {
    channel: 'C',
    expected: `${PROVIDER_ID}.apiKey=${API_KEY}`,
    actual: key1 === API_KEY ? '同值' : JSON.stringify(readModels()?.providers?.[PROVIDER_ID] ?? null).slice(0, 160),
  })

  // ── 清单 1.0.0（无更新提示基线）→ 翻 1.1.0（两级提示出现） ──────
  seedCatalogVersion(dataDir, '1.0.0')
  ev.step({ step: 'catalog.seed', channel: 'C', exitCode: 0, stats: { pluginVersion: '1.0.0' } })
  await openPluginFlow(ui, page)
  const badgeBefore = await page.locator('[data-testid="plugin-family-update-badge"]').count()
  ev.assert('A: 清单版本 = 已装版本时家族卡无更新提示', badgeBefore === 0, {
    channel: 'A',
    expected: 'plugin-family-update-badge ×0',
    actual: `×${badgeBefore}`,
  })
  await closePluginFlow(ui)

  seedCatalogVersion(dataDir, '1.1.0')
  registry.setLatest(PKG, '1.1.0')
  ev.step({ step: 'version.flip', channel: 'C', exitCode: 0, stats: { catalog: '1.1.0', registryLatest: '1.1.0' } })
  await openPluginFlow(ui, page)
  await ui.expectVisible('testid=plugin-family-update-badge', { timeoutMs: 20_000 })
  ev.assert('A: 家族卡更新提示出现（清单 1.1.0 > 已装 1.0.0）', true, {
    channel: 'A',
    expected: 'plugin-family-update-badge 可见',
    actual: '可见',
  })
  await ui.screenshot('s26-family-update-badge')
  await closePluginFlow(ui)

  // 条目内「更新插件」按钮（展开行 → 宿主常驻动作区）
  const card = `css=[data-testid="provider-card"]:has-text("${ROW_NAME_SUBSTR}")`
  await ui.expectVisible(card, { timeoutMs: 20_000 })
  await ui.click(`${card} span[role="button"]`)
  await ui.expectVisible(`${card} [data-testid="provider-expand-body"]`)
  await ui.expectVisible(`${card} [data-testid="provider-update-plugin-btn"]`, { timeoutMs: 20_000 })
  ev.assert('A: 条目内「更新插件」按钮出现（展开行动作区）', true, {
    channel: 'A',
    expected: 'provider-update-plugin-btn 可见',
    actual: '可见',
  })
  await ui.screenshot('s26-row-update-btn')

  // ── 执行更新 1.0.0 → 1.1.0（确认卡 update 意图直达） ────────────
  await ui.click(`${card} [data-testid="provider-update-plugin-btn"]`)
  await ui.expectVisible('testid=plugin-install-confirm', { timeoutMs: 60_000 })
  const confirmText = await ui.text('testid=plugin-install-confirm')
  ev.assert('A: 更新确认卡直达且目标版本 1.1.0（update 意图文案）', confirmText.includes('plugin-update-demo@1.1.0'), {
    channel: 'A',
    expected: '确认卡含 plugin-update-demo@1.1.0',
    actual: confirmText.slice(0, 200),
  })
  const fields = await assertConfirmFields(ui, page, { capabilities: CAPABILITIES, readPaths: READ_PATHS, permissions: PERMISSIONS })
  ev.attach('s26-confirm-fields', JSON.stringify(fields, null, 2))
  await ui.click('testid=plugin-install-confirm-btn')
  await ui.expectVisible('testid=plugin-authorize-container', { timeoutMs: 90_000 })
  await closePluginFlow(ui)
  const active2 = await pollUntil(
    () => proto.call('plugin.list', {}),
    (r) => (r.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID && p.status === 'active' && p.version === '1.1.0'),
    { timeoutMs: 30_000 },
  )
  const info2 = (active2.plugins ?? []).find((p) => p.pluginId === PLUGIN_ID)
  ev.assert('B: 更新后插件重激活（status=active version=1.1.0）', Boolean(info2), {
    channel: 'B',
    expected: 'active @1.1.0',
    actual: info2 ? `status=${info2.status} v${info2.version}` : '不在列表',
  })
  const dirPkg2 = readJson(path.join(targetDir, 'package.json'))
  ev.assert('C: 更新后目录 package.json version=1.1.0', dirPkg2?.version === '1.1.0', {
    channel: 'C',
    expected: '1.1.0',
    actual: dirPkg2?.version ?? '(目录缺失或不可读)',
  })
  const entry2 = readModels()?.providers?.[PROVIDER_ID]
  ev.assert('C: 更新后条目与凭据保留（apiKey 同值 + displayName 切 1.1.0 = 重激活重写）',
    entry2?.apiKey === API_KEY && String(entry2?.name ?? '').includes('v1.1.0'), {
      channel: 'C',
      expected: `apiKey=${API_KEY} 且 name 含 v1.1.0`,
      actual: entry2 ? `apiKey=${entry2.apiKey} name=${entry2.name}` : '条目缺失',
    })
  ev.assert('C: 更新成功后暂存/替换位无残留', stagingResidue(stagingDir, PLUGIN_ID).length === 0, {
    channel: 'C',
    expected: '.staging 无 plugin-update-demo / .replacing-* 残留',
    actual: stagingResidue(stagingDir, PLUGIN_ID).join(',') || '(空)',
  })

  // ── 翻 2.0.0（激活必抛错包）→ 更新失败 → 旧版本幸存 ────────────
  seedCatalogVersion(dataDir, '2.0.0')
  registry.setLatest(PKG, '2.0.0')
  ev.step({ step: 'version.flip', channel: 'C', exitCode: 0, stats: { catalog: '2.0.0', registryLatest: '2.0.0' } })
  await openPluginFlow(ui, page)
  await ui.expectVisible('testid=plugin-family-update-badge', { timeoutMs: 20_000 })
  await closePluginFlow(ui)
  await ui.expectVisible(card, { timeoutMs: 20_000 })
  const expanded = await page.locator(`${selectorOf(card)} [data-testid="provider-expand-body"]`).isVisible().catch(() => false)
  if (!expanded) {
    await ui.click(`${card} span[role="button"]`)
    await ui.expectVisible(`${card} [data-testid="provider-expand-body"]`)
  }
  await ui.expectVisible(`${card} [data-testid="provider-update-plugin-btn"]`, { timeoutMs: 20_000 })
  await ui.click(`${card} [data-testid="provider-update-plugin-btn"]`)
  await ui.expectVisible('testid=plugin-install-confirm', { timeoutMs: 60_000 })
  const confirmText2 = await ui.text('testid=plugin-install-confirm')
  ev.assert('A: 必败更新确认卡目标版本 2.0.0', confirmText2.includes('plugin-update-demo@2.0.0'), {
    channel: 'A',
    expected: '确认卡含 plugin-update-demo@2.0.0',
    actual: confirmText2.slice(0, 200),
  })
  await ui.click('testid=plugin-install-confirm-btn')
  await ui.expectVisible('testid=plugin-install-error', { timeoutMs: 90_000 })
  const errorText = await ui.text('testid=plugin-install-error')
  ev.assert('A: 更新失败可见（plugin-install-error 呈错误文案）', errorText.trim().length > 0, {
    channel: 'A',
    expected: '错误文案非空（激活失败回滚）',
    actual: errorText.slice(0, 200),
  })
  await ui.screenshot('s26-update-failed')

  // 旧版本幸存三证（目录 / 注册表 / 凭据）+ 无残留
  const dirPkg3 = readJson(path.join(targetDir, 'package.json'))
  ev.assert('C: 更新失败后旧版本幸存（目录 package.json 仍 1.1.0）', dirPkg3?.version === '1.1.0', {
    channel: 'C',
    expected: '1.1.0',
    actual: dirPkg3?.version ?? '(目录缺失或不可读)',
  })
  const afterFail = await pollUntil(
    () => proto.call('plugin.list', {}),
    (r) => (r.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID && p.version === '1.1.0'),
    { timeoutMs: 20_000 },
  )
  const info3 = (afterFail.plugins ?? []).find((p) => p.pluginId === PLUGIN_ID)
  ev.assert('B: 更新失败后 plugin.list version 不变（仍 1.1.0，状态照录）', Boolean(info3 && info3.version === '1.1.0'), {
    channel: 'B',
    expected: 'version=1.1.0（不得为 2.0.0）',
    actual: info3 ? `status=${info3.status} v${info3.version}` : '不在列表',
  })
  const entry3 = readModels()?.providers?.[PROVIDER_ID]
  ev.assert('C: 更新失败后条目凭据不动（apiKey 同值）', entry3?.apiKey === API_KEY, {
    channel: 'C',
    expected: `apiKey=${API_KEY}`,
    actual: entry3 ? `apiKey=${entry3.apiKey} name=${entry3.name}` : '条目缺失',
  })
  const residue = stagingResidue(stagingDir, PLUGIN_ID)
  ev.assert('C: 更新失败后暂存/替换位无残留（回滚收敛）', residue.length === 0, {
    channel: 'C',
    expected: '.staging 无 plugin-update-demo / .replacing-* 残留',
    actual: residue.join(',') || '(空)',
  })

  // 关闭失败态确认卡（Esc → resetFlow → cancelPluginInstall 清 pending 登记）
  await closePluginFlow(ui)

  // ── 旧版本可用收口：重新启用激活成功 ───────────────────────────
  await proto.call('plugin.toggle', { pluginId: PLUGIN_ID, enabled: true }, { replyType: 'config.plugins', timeoutMs: 60_000 })
  ev.step({ step: 're-enable', channel: 'B', exitCode: 0, stats: { pluginId: PLUGIN_ID } })
  const reactivated = await pollUntil(
    () => proto.call('plugin.list', {}),
    (r) => (r.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID && p.status === 'active' && p.version === '1.1.0'),
    { timeoutMs: 45_000 },
  )
  const info4 = (reactivated.plugins ?? []).find((p) => p.pluginId === PLUGIN_ID)
  ev.assert('B: 旧版本可用（重新启用激活成功 active @1.1.0，无两头空）', Boolean(info4), {
    channel: 'B',
    expected: 'active @1.1.0',
    actual: info4 ? `status=${info4.status} v${info4.version}` : '激活未达成',
  })
  const entry4 = readModels()?.providers?.[PROVIDER_ID]
  ev.assert('C: 重激活后条目凭据原值', entry4?.apiKey === API_KEY, {
    channel: 'C',
    expected: `apiKey=${API_KEY}`,
    actual: entry4 ? `apiKey=${entry4.apiKey}` : '条目缺失',
  })

  log('S26 done')
  await registry.close()
  return { uncovered, gotchas }
}

/** 清单缓存改写（幂等覆写，mtime 失效 → runtime 下次拉取即新版本）。 */
function seedCatalogVersion(dataDir, version) {
  seedPluginCatalog(dataDir, [
    catalogEntry({
      packageName: PKG,
      pluginId: PLUGIN_ID,
      displayName: 'Update Demo',
      namespace: NS,
      version,
      capabilities: CAPABILITIES,
      readPaths: READ_PATHS,
    }),
  ])
}

/** registry 版本表：fixtures/plugin-pkgs/dist/plugin-update-demo-<ver>.tgz（repo 锚定）。 */
function buildRegistryMap(repo) {
  const distDir = path.join(repo, '.agents', 'skills', 'verify-taiji', 'fixtures', 'plugin-pkgs', 'dist')
  const versions = {}
  for (const ver of ['1.0.0', '1.1.0', '2.0.0']) {
    const file = path.join(distDir, `${PKG}-${ver}.tgz`)
    if (!fs.existsSync(file)) throw new Error(`missing tarball: ${file}`)
    versions[ver] = file
  }
  return { [PKG]: { versions, latest: '1.0.0' } }
}

/** 暂存区残留枚举：本插件的正常暂存位与替换位。 */
function stagingResidue(stagingDir, pluginId) {
  if (!fs.existsSync(stagingDir)) return []
  return fs.readdirSync(stagingDir).filter((e) => e === pluginId || e === `${REPLACING_PREFIX}${pluginId}`)
}

/** css= 选择器剥前缀（page.locator 需要裸 selector）。 */
function selectorOf(sel) {
  return String(sel).replace(/^css=/, '')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
