/**
 * plugin-provider-fixture —— D3 Provider 页剧本共用装配（A1/A5/A6/A7）。
 *
 * 职责：launch 前把 demo fixture 插件 + 清单缓存 + 权限预置写进一次性数据目录
 * （p1-permission-approval「自建隔离实例 + run 内 dispose」先例），并给四个剧本
 * 共用的实例激活等待 / provider 条目预置 / Provider 页导航 helper。
 *
 * 三个预置件的产品事实源（改此处先读对应源码）：
 *  - 插件扫描：packages/runtime/src/services/plugin-service/plugin-registry.ts（scan
 *    读 <dataDir>/plugins/ 一级目录，pluginId = 目录名，manifest = package.json 的
 *    taijiPlugin 段；installed.json / permissions.json 是文件不是目录，scan 跳过）；
 *  - 清单缓存：packages/runtime/src/services/remote-config/remote-config-fetch.ts
 *    （envelope { version, checkedAt, data }；checkedAt 在 4h 节流窗内直用缓存，
 *    不发远程请求——数据目录一次性写入即确定性生效）；
 *  - 权限预置：packages/runtime/src/services/plugin-service/plugin-permission-storage.ts
 *    （<dataDir>/plugins/permissions.json；sandbox 插件 manifest 声明完整 RPC 方法名
 *    直申通道，预置与声明同集 = 审批门静默通过，等价「用户已批准」的落盘态，
 *    规避启动期审批弹窗广播先于 renderer 连接的时序竞态）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'plugin-provider',
)

export const DEMO_PLUGIN_ID = 'demo-wool'
export const DEMO_NAMESPACE = 'demo-wool'
export const DEMO_PROVIDER_ID = 'demo-wool'
export const DEMO_ROW_NAME = 'DemoWool (verify fixture)'
export const DETAIL_EXTRA_MOUNT = 'provider.detail-extra'
export const AUTHORIZE_MOUNT = 'provider.authorize'
export const DETAIL_SENTINEL = 'DEMO-EXTRA-SENTINEL-7Q'
export const PAT_INPUT_ID = 'demo-pat'
export const CONFIRM_ACTION_ID = 'demo-confirm'

/** 与 fixture manifest permissions 逐字同集（完整 RPC 方法名直申通道）。 */
const GRANTED_METHODS = [
  'plugin.views.update',
  'plugin.commands.register',
  'plugin.commands.invoke.result',
]

/**
 * launch 前预置数据目录（幂等：每次 run 用全新 verify-* 目录）。
 * @returns {{ pluginDir: string, catalogFamilies: string[] }} 证据摘要
 */
export function seedPluginProviderFixture(dataDir) {
  const pluginsDir = path.join(dataDir, 'plugins')
  const pluginDir = path.join(pluginsDir, DEMO_PLUGIN_ID)
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    fs.readFileSync(path.join(FIXTURE_DIR, 'demo-wool.package.json'), 'utf8'),
  )
  fs.writeFileSync(
    path.join(pluginDir, 'index.js'),
    fs.readFileSync(path.join(FIXTURE_DIR, 'demo-wool.index.js'), 'utf8'),
  )
  fs.writeFileSync(
    path.join(pluginsDir, 'permissions.json'),
    `${JSON.stringify({ [DEMO_PLUGIN_ID]: GRANTED_METHODS }, null, 2)}\n`,
  )
  const catalog = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'catalog.demo.json'), 'utf8'))
  const remoteDir = path.join(dataDir, 'remote-config')
  fs.mkdirSync(remoteDir, { recursive: true })
  fs.writeFileSync(
    path.join(remoteDir, 'v2-plugins.json'),
    `${JSON.stringify({ version: 1, checkedAt: Date.now(), data: catalog }, null, 2)}\n`,
  )
  return {
    pluginDir,
    permissions: GRANTED_METHODS,
    catalogFamilies: catalog.plugins.map((p) => p.pluginId),
  }
}

/**
 * 自建隔离实例（seed → launch → waitReady → protocol）。
 * 实例名/数据目录都在 verify-d3-s1 家族内，与常驻实例隔离（SKILL §1）。
 */
export async function launchFixtureInstance({ repo, ev, tag }) {
  const { createInstance } = await import('../../scripts/lib/instance.mjs')
  // 实例名/数据目录 verify-d3-r1 家族（D3 实跑批次命名，与常驻实例隔离；tag 区分四场景可并行）
  const dataDir = path.join(os.homedir(), '.taiji-dev', `verify-d3-r1-${tag}-${Date.now().toString(36)}`)
  const instance = createInstance({ repo, name: `verify-d3-r1-${tag}`, dataDir, background: true })
  const seeded = seedPluginProviderFixture(dataDir)
  ev.step({ step: 'fixture.seed', channel: 'C', exitCode: 0, stats: { dataDir, ...seeded } })
  await instance.launch()
  const ready = await instance.waitReady({ timeoutMs: 180_000 })
  ev.step({
    step: 'fixture.instance.ready',
    channel: 'C',
    exitCode: 0,
    stats: { elapsedMs: ready.elapsedMs, extensions: ready.extensions, vitePort: ready.runtimePort },
  })
  const proto = await instance.protocol()
  return { instance, proto, dataDir }
}

/** 轮询 plugin.list 直到 demo 插件 status=active（fork 激活晚于 extensions ready 属常态）。 */
export async function waitPluginActive(proto, pluginId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last = 'missing'
  for (;;) {
    const reply = await proto.call('plugin.list', {})
    const info = (reply.plugins ?? []).find((p) => p.pluginId === pluginId)
    last = info ? info.status : 'missing'
    if (last === 'active') return info
    if (Date.now() >= deadline) {
      throw new Error(`插件 ${pluginId} 未在 ${timeoutMs}ms 内 active（最后状态 ${last}）`)
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
}

/**
 * 预置 demo provider 条目（走宿主 config.setProvider 写策略链 = 用户路径的 B 通道形态）
 * 并做 C 通道落盘对照。
 */
export async function seedDemoProvider(proto, dataDir, ev) {
  await proto.call(
    'config.setProvider',
    {
      providerId: DEMO_PROVIDER_ID,
      name: DEMO_ROW_NAME,
      type: 'custom',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'demo-wool-verify-key',
      models: [{ id: 'demo-model-1', name: 'demo-model-1' }],
    },
    { timeoutMs: 60_000 },
  )
  const models = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent', 'models.json'), 'utf8'))
  const entry = models.providers?.[DEMO_PROVIDER_ID]
  ev.assert('C: models.json 落盘 demo-wool 条目（含 apiKey）', Boolean(entry?.apiKey), {
    channel: 'C',
    expected: `${DEMO_PROVIDER_ID} 条目存在`,
    actual: entry ? `keys=${Object.keys(models.providers ?? {}).join(',')}` : '条目缺失',
  })
  return entry
}

/** UI：打开设置 → Provider 页（testid 路径，settings.md capability 入口形态）。 */
export async function openProviderPage(ui) {
  await ui.click('testid=sidebar-settings')
  await ui.expectVisible('testid=settings-nav-provider')
  await ui.click('testid=settings-nav-provider')
  await ui.expectVisible('testid=provider-list-header')
}

/** demo provider 行卡选择器（行名 = DEMO_ROW_NAME 子串匹配）。 */
export function demoCardSelector() {
  return `css=[data-testid="provider-card"]:has-text("${DEMO_ROW_NAME}")`
}

/** UI：展开 demo provider 行（点行名 role=button → 展开体可见）。 */
export async function expandDemoProviderRow(ui) {
  const card = demoCardSelector()
  await ui.expectVisible(card)
  await ui.click(`${card} span[role="button"]`)
  await ui.expectVisible(`${card} [data-testid="provider-expand-body"]`)
}

/** 通用条件轮询（判定每轮重算，禁盲等）。 */
export async function pollUntil(predicate, { timeoutMs, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
