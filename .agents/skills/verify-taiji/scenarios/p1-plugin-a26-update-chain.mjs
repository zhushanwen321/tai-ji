/**
 * p1-plugin-a26-update-chain —— 插件更新链路（impl-plan A26 / 设计 S26）。
 *
 * 设计期望三段：清单版本 > 已装版本 → 条目更新提示 → 执行更新（条目与凭据保留）；
 * 更新后插件重激活；更新中途必失败包 → 旧版本幸存。实跑核对出的产品现状（如实覆盖，
 * 缺口登记 uncovered + ISSUES.md，不阻断其余断言）：
 *   - 更新提交（两段式 confirm）在磁盘/注册表/激活面换新（目录 version、plugin.list
 *     version、status=active 全部跟随新版本）；
 *   - 但沙箱 fork 被复用（plugin-host-process assignProcess M6a-06：活跃进程直接复用）
 *     且 fork 内 handleLoad 对同一文件 URL `await import`（plugin-bootstrap.ts）——ESM
 *     模块缓存命中，activate 执行的仍是旧模块代码。实证：1.1.0 更新后 models.json 条目
 *     displayName 仍为 v1.0.0（新版 activate 未执行）、fork PID 不变；
 *   - 由此「激活必抛错」的 2.0.0 更新包不会在激活段失败：commit 静默成功、坏包落盘、
 *     无错误呈现——S26「更新失败时旧版本幸存」的回滚路径在已激活插件的更新场景不可达
 *     （对全新安装场景 S18 剧本族覆盖，非本剧本范围）。
 *
 * 三版本链（fixtures/plugin-update-demo）：1.0.0 基线安装（激活写 update-demo-main 条目
 * + apiKey）→ 清单翻 1.1.0（改写 remote-config 缓存 pluginVersion + mock registry
 * dist-tags.latest → 家族卡 plugin-family-update-badge + 条目「更新插件」按钮两级提示）
 * → 确认卡（update 意图直达）→ 更新提交（条目凭据保留 + 模块复用取证）→ 清单翻 2.0.0
 * （激活必抛错包）→ 更新提交静默成功（坏包落盘取证 + 凭据幸存）。
 *
 * 装配：本机 mock npm registry（同 p1-plugin-install-confirm；setLatest 翻转 dist-tags）
 * + 清单缓存改写（seedPluginCatalog 幂等覆写，mtime 失效 → runtime 下次拉取即新清单）。
 * fixture 声明 permissions=[providers.write]，首装停在权限审批门——剧本经
 * plugin.approvePermissions 批准（B 通道），批准落盘后续更新免审批。无 LLM 需求。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
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
  title: 'S26 更新链路：两级更新提示 + 更新提交条目凭据保留；重激活复用旧模块与坏包静默落盘照录（产品缺口）',
  covers: ['plugin.list', 'plugin.toggle', 'settings.provider'],
  requires: [],
  estimateSec: 360,
  env: undefined, // 模块加载段按 repo 填充（runner 在 import 之后才读 meta.env）

  provable: [
    'A: 家族卡更新提示（plugin-family-update-badge）与条目内「更新插件」按钮（provider-update-plugin-btn）随「清单版本 > 已装版本」出现',
    '更新提交换新面：确认卡 update 意图直达（@1.1.0）；更新后目录 package.json version=1.1.0、plugin.list version=1.1.0 status=active（磁盘/注册表/激活态跟随新版本）',
    'C: 更新后条目与凭据保留（update-demo-main 条目在场 + apiKey 同值，设计 S26 保留性断言）',
    '产品现状取证：更新后沙箱 fork PID 不变（进程复用）且条目 displayName 未切 v1.1.0（旧模块仍生效）——S26「插件重激活执行新代码」未达成',
    '必败包（激活即抛错）更新提交静默成功：无错误呈现、目录落盘 2.0.0、plugin.list 跟随 2.0.0，条目凭据不动（幸存面成立；失败回滚路径不可达——产品缺口 uncovered + ISSUES.md）',
  ],
  notProvable: [
    '「更新后新版本代码在当前宿主进程内生效」——产品现状为复用旧 fork + 同 URL ESM 模块缓存（plugin-bootstrap handleLoad await import），新代码待宿主重启后生效；重启后模块刷新面归重启域剧本',
    '清单远程热更新链（清单为本剧本 seed 的本地缓存形态，版本翻转走改写缓存文件——远程拉取归 S15 域）',
    '更新 commit 窗口进程死亡形态（.staging 替换位启动清扫承接，归 S18/S14 残留面）',
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
    '产品缺口（ISSUES.md 同步登记）：更新提交后 assignProcess 复用活跃 fork（M6a-06）+ handleLoad 同 URL import 命中 ESM 缓存 → 新模块不执行。后果两条：①「插件重激活」只重放旧代码；②「激活必抛错」更新包不触发回滚、坏包静默落盘',
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
  const forkPidBefore = findSandboxForkPid()
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
  ev.assert('B: 更新提交后注册表/激活态换新（status=active version=1.1.0）', Boolean(info2), {
    channel: 'B',
    expected: 'active @1.1.0',
    actual: info2 ? `status=${info2.status} v${info2.version}` : '不在列表',
  })
  const dirPkg2 = readJson(path.join(targetDir, 'package.json'))
  ev.assert('C: 更新后目录 package.json version=1.1.0（磁盘换新）', dirPkg2?.version === '1.1.0', {
    channel: 'C',
    expected: '1.1.0',
    actual: dirPkg2?.version ?? '(目录缺失或不可读)',
  })
  const entry2 = readModels()?.providers?.[PROVIDER_ID]
  ev.assert('C: 更新后条目与凭据保留（apiKey 同值，设计 S26 保留性断言）', entry2?.apiKey === API_KEY, {
    channel: 'C',
    expected: `apiKey=${API_KEY}`,
    actual: entry2 ? `apiKey=${entry2.apiKey} name=${entry2.name}` : '条目缺失',
  })
  ev.assert('C: 更新成功后暂存/替换位无残留', stagingResidue(stagingDir, PLUGIN_ID).length === 0, {
    channel: 'C',
    expected: '.staging 无 plugin-update-demo / .replacing-* 残留',
    actual: stagingResidue(stagingDir, PLUGIN_ID).join(',') || '(空)',
  })

  // 产品现状取证：fork 复用 + 旧模块仍生效（「插件重激活执行新代码」未达成的硬证据）
  const forkPidAfter = findSandboxForkPid()
  ev.assert('C: 更新后沙箱 fork PID 不变（进程复用 → 新模块代码未起进程）', Boolean(forkPidBefore) && forkPidBefore === forkPidAfter, {
    channel: 'C',
    expected: `fork PID 恒定（更新前=${forkPidBefore ?? '未定位'}）`,
    actual: `更新后=${forkPidAfter ?? '未定位'}`,
  })
  ev.assert('C: 条目 displayName 未切 v1.1.0（fork 内旧模块仍生效的产品现状证据）', String(entry2?.name ?? '').includes('v1.0.0'), {
    channel: 'C',
    expected: 'displayName 仍 v1.0.0（1.1.0 activate 未执行——模块缓存复用）',
    actual: `name=${entry2?.name ?? '(缺失)'}`,
  })
  uncovered.push('S26「插件重激活（新代码生效）」未达成：更新提交复用活跃 fork（assignProcess M6a-06）+ 同 URL ESM 模块缓存（plugin-bootstrap handleLoad），activate 重放旧代码——实证 fork PID 不变 + 条目 displayName 未切新版本（产品缺口，ISSUES.md 已登记）')

  // ── 翻 2.0.0（激活必抛错包）→ 更新提交 → 产品现状：静默成功落盘 ──
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
  // 产品现状：更新静默成功（进入授权容器段 = 提交成功 UI 信号）；错误呈现缺席取证
  await ui.expectVisible('testid=plugin-authorize-container', { timeoutMs: 90_000 })
  const errorCount = await page.locator('[data-testid="plugin-install-error"]').count()
  ev.attach('s26-broken-update-outcome', `提交后进入授权容器段（成功信号）；plugin-install-error ×${errorCount}（无失败呈现）`)
  await closePluginFlow(ui)
  uncovered.push('S26「更新中途必失败 → 旧版本幸存回滚」路径在已激活插件的更新场景不可达：激活必抛错的 2.0.0 包提交后静默成功（无 plugin-install-error），目录落盘 2.0.0 而运行代码仍旧模块——回滚触发前提（新代码激活失败）因模块缓存复用不成立（产品缺口，ISSUES.md 已登记）')

  // 幸存面核对：条目凭据不动 + 注册表跟随磁盘 + 暂存无残留
  const dirPkg3 = readJson(path.join(targetDir, 'package.json'))
  ev.assert('C: 必败包更新后目录落盘 2.0.0（坏包静默生效的磁盘证据）', dirPkg3?.version === '2.0.0', {
    channel: 'C',
    expected: '2.0.0（回滚未触发）',
    actual: dirPkg3?.version ?? '(目录缺失或不可读)',
  })
  const afterFail = await pollUntil(
    () => proto.call('plugin.list', {}),
    (r) => (r.plugins ?? []).some((p) => p.pluginId === PLUGIN_ID && p.version === '2.0.0'),
    { timeoutMs: 20_000 },
  )
  const info3 = (afterFail.plugins ?? []).find((p) => p.pluginId === PLUGIN_ID)
  ev.assert('B: 必败包更新后 plugin.list version 跟随 2.0.0（状态照录）', Boolean(info3 && info3.version === '2.0.0'), {
    channel: 'B',
    expected: 'version=2.0.0（注册表跟随磁盘）',
    actual: info3 ? `status=${info3.status} v${info3.version}` : '不在列表',
  })
  const entry3 = readModels()?.providers?.[PROVIDER_ID]
  ev.assert('C: 条目凭据不动（apiKey 同值，幸存面成立）', entry3?.apiKey === API_KEY, {
    channel: 'C',
    expected: `apiKey=${API_KEY}`,
    actual: entry3 ? `apiKey=${entry3.apiKey} name=${entry3.name}` : '条目缺失',
  })
  const residue = stagingResidue(stagingDir, PLUGIN_ID)
  ev.assert('C: 更新提交后暂存/替换位无残留', residue.length === 0, {
    channel: 'C',
    expected: '.staging 无 plugin-update-demo / .replacing-* 残留',
    actual: residue.join(',') || '(空)',
  })
  await ui.screenshot('s26-after-broken-update')

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

/**
 * 定位 sandbox fork 子进程 PID（本实例域内唯一：trusted 插件走 Worker 线程无独立进程，
 * 剧本实例同时只装一个 sandbox 插件）。无命中 = null。
 */
function findSandboxForkPid() {
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 10_000 })
  if (r.status !== 0) return null
  const lines = r.stdout.split('\n').filter((l) => l.includes('plugin-bootstrap-process'))
  if (lines.length !== 1) return null
  const m = lines[0].trim().match(/^(\d+)\s+/)
  return m ? Number(m[1]) : null
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
