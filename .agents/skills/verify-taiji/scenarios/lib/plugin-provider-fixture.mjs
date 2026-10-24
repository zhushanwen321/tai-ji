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
 * @param {{ catalogCheckedAt?: number }} options catalogCheckedAt = 清单缓存 envelope 的
 *   checkedAt（缺省 Date.now() = 4h 节流窗内直用缓存；拨旧到 >4h 前 = 强制 listAvailable
 *   走网络——A15 的「曾拉取成功后断网」态）。
 * @returns {{ pluginDir: string, permissions: string[], catalogFamilies: string[] }} 证据摘要
 */
export function seedPluginProviderFixture(dataDir, options = {}) {
  const { catalogCheckedAt = Date.now() } = options
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
  writeCatalogCache(dataDir, catalog, catalogCheckedAt)
  return {
    pluginDir,
    permissions: GRANTED_METHODS,
    catalogFamilies: catalog.plugins.map((p) => p.pluginId),
  }
}

/** 写 remote-config 清单缓存 envelope（remote-config-fetch RemoteCacheEnvelope 同构）。 */
export function writeCatalogCache(dataDir, catalog, checkedAt = Date.now()) {
  const remoteDir = path.join(dataDir, 'remote-config')
  fs.mkdirSync(remoteDir, { recursive: true })
  fs.writeFileSync(
    path.join(remoteDir, 'v2-plugins.json'),
    `${JSON.stringify({ version: 1, checkedAt, data: catalog }, null, 2)}\n`,
  )
  return path.join(remoteDir, 'v2-plugins.json')
}

/** 删除清单缓存文件（A15「从未拉取」态；不存在 = no-op）。返回删除前是否存在。 */
export function removeCatalogCache(dataDir) {
  const file = path.join(dataDir, 'remote-config', 'v2-plugins.json')
  const existed = fs.existsSync(file)
  if (existed) fs.rmSync(file, { force: true })
  return existed
}

/**
 * 通用多插件预置（S3 组 A16/A17/A21/A25）：插件文件集 + permissions.json + 自定义清单
 * 一次落盘。plugins 元素 = lib-plugin-fixtures.mjs pluginFixture() 的输出
 * （{ dirName, files: { 'package.json', 'index.js' } }）；permissionSpecs =
 * { pluginId: [完整 RPC 方法名] }（与各 manifest permissions 同集 = 审批门静默通过）；
 * catalogPlugins = 清单条目数组（lib-plugin-fixtures.mjs catalogEntry() 产出）。
 */
export function seedMultiPluginFixture(dataDir, { plugins, permissionSpecs, catalogPlugins, catalogCheckedAt = Date.now() }) {
  const pluginsDir = path.join(dataDir, 'plugins')
  const seededDirs = []
  for (const f of plugins) {
    const dir = path.join(pluginsDir, f.dirName)
    fs.mkdirSync(dir, { recursive: true })
    for (const [name, content] of Object.entries(f.files)) {
      fs.writeFileSync(path.join(dir, name), content, 'utf8')
    }
    seededDirs.push(dir)
  }
  fs.writeFileSync(
    path.join(pluginsDir, 'permissions.json'),
    `${JSON.stringify(permissionSpecs, null, 2)}\n`,
  )
  const cacheFile = writeCatalogCache(
    dataDir,
    { version: 1, plugins: catalogPlugins },
    catalogCheckedAt,
  )
  return { pluginDirs: seededDirs, permissions: permissionSpecs, catalogCacheFile: cacheFile }
}

/**
 * 自建隔离实例（seed → launch → waitReady → protocol）。
 * 实例名/数据目录都在 verify-<family> 家族内，与常驻实例隔离（SKILL §1）。
 * @param {string} family 实例家族名（D3 分批批次：S1 组 d3-r1 / S3 组 d3-r3——
 *   数据目录 verify-<family>-<tag>-<ts> 与实例名 verify-<family>-<tag> 的前缀）。
 * @param {(dataDir: string) => object} seed launch 前预置函数（缺省 = demo-wool 全家桶；
 *   S3 组定制插件集场景传 seedMultiPluginFixture 的偏形态）。
 */
export async function launchFixtureInstance({ repo, ev, tag, family = 'd3-r1', seed = seedPluginProviderFixture }) {
  const { createInstance } = await import('../../scripts/lib/instance.mjs')
  const dataDir = path.join(os.homedir(), '.taiji-dev', `verify-${family}-${tag}-${Date.now().toString(36)}`)
  const instance = createInstance({ repo, name: `verify-${family}-${tag}`, dataDir, background: true })
  const seeded = seed(dataDir)
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

/** UI：打开设置 → Provider 页（testid 路径，settings.md capability 入口形态）。
 *  就绪锚 = 页头常驻 provider-template-picker（页头无条件渲染）；provider-list-header
 *  仅在 renderList.length>0 时渲染（ProviderPage.vue v-if），未 seed provider 的实例
 *  （fixture dataDir 预建跳过模板种子 → models.json 缺失 → providers 空）永远等不到。 */
export async function openProviderPage(ui) {
  await ui.click('testid=sidebar-settings')
  await ui.expectVisible('testid=settings-nav-provider')
  await ui.click('testid=settings-nav-provider')
  await ui.expectVisible('testid=provider-template-picker')
}

/** demo provider 行卡选择器（行名 = DEMO_ROW_NAME 子串匹配）。 */
export function demoCardSelector() {
  return `css=[data-testid="provider-card"]:has-text("${DEMO_ROW_NAME}")`
}

/** 任意行名 → 行卡选择器（ProviderRowCard 的 provider-card + 行名文本子串匹配）。 */
export function providerCardSelector(rowName) {
  return `css=[data-testid="provider-card"]:has-text("${rowName}")`
}

/** UI：展开任意行名的 provider 行（点行名 role=button → 展开体可见）。 */
export async function expandProviderRow(ui, rowName) {
  const card = providerCardSelector(rowName)
  await ui.expectVisible(card)
  await ui.click(`${card} span[role="button"]`)
  await ui.expectVisible(`${card} [data-testid="provider-expand-body"]`)
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
