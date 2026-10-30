/**
 * provider-plugin-access D3 验收（S3 组）共享 fixture 装配。
 *
 * 职责：在实例启动前把 fixture 插件目录与清单缓存种子写入 dataDir（scenario 模块在
 * runner import 阶段执行顶层代码，先于 instance.launch——runner 的 dataDir 派生逻辑
 * 在 import 之后，本模块按同款 flag 语义自行解析，两边必须传同一组 --run-id/--data-dir）。
 *
 * 注入原理（零产品代码改动）：
 * - 插件发现：PluginRegistry.scan() 扫 `<dataDir>/plugins/`（组合根 configDir=dataDir），
 *   external 一律 sandbox（fork 子进程 + 唯一 RPC 身份），manifest 骨架对齐
 *   resources/plugins/scheduler-manager 与 packages/runtime/test/fixtures/plugins/hello-world；
 * - 清单：remote-config-fetch 每次调用都从 `<dataDir>/remote-config/v2-plugins.json`
 *   读缓存 envelope（mtime 失效检测），checkedAt 在 4h 节流窗内 = 不发网络直接返回
 *   缓存数据——写入本域 fixture 清单即确定性注入；checkedAt 拨旧则强制走网络
 *   （raw.githubusercontent.com 直连超时 = fail-safe 链的「断网」态，见 p1-plugin-catalog-unreachable）。
 *
 * fixture 插件一律零 import 的纯 ESM（sandbox 黑名单防线内），动作全部经 ctx.api 的
 * RPC（providers.* / views.update / commands.register / events.report）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 与 run.mjs 同款 flag 解析（只认带值 flag；值不允许以 -- 开头）。导出供 scenario 顶层解析 --repo 等 runner flag（probe-containers fixture 种子用）。 */
export function flagOf(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) return fallback
  return v
}

/**
 * 解析 runner 将使用的 dataDir（scenario 顶层调用）。
 * 必须显式传 --run-id 或 --data-dir：runner 的默认 runId 是 import 后取的秒级时间戳，
 * scenario 顶层自行取戳会与 runner 差秒 → 预置落错目录（静默丢 fixture，实例起来后
 * 全部断言超时）。缺 --run-id 时响亮退出，不猜。
 */
export function resolveDataDirFromArgv() {
  const argv = process.argv.slice(2)
  const explicit = flagOf(argv, 'data-dir', null) ?? process.env.TAIJI_VERIFY_DATA_DIR ?? null
  const runId = flagOf(argv, 'run-id', null)
  if (explicit) {
    const expanded = explicit.startsWith('~') ? path.join(os.homedir(), explicit.slice(1)) : path.resolve(explicit)
    return path.resolve(expanded)
  }
  if (!runId) {
    throw new Error(
      '[lib-plugin-fixtures] 缺 --run-id：scenario 顶层预置 fixture 需要与 runner 同源派生 dataDir，' +
        '请以 `node .agents/skills/verify-taiji/scripts/run.mjs <scenario> --run-id <id> --artifacts-dir <dir>` 运行',
    )
  }
  return path.join(os.homedir(), '.taiji-dev', `verify-${runId}`)
}

/**
 * 组装一个 fixture 插件的文件集（目录名 = registry pluginId = 清单 pluginId，三者同源）。
 * manifest 对齐 TaijiManifest（packages/plugin-sdk/src/types.ts）：external 一律 sandbox
 * （宿主强制，声明 trusted 也被忽略）。
 *
 * permissions 必须声明为完整 RPC 方法名（plugin-permission-map 直申通道）且不可省略——
 * sandbox 插件不声明 = RPC 恒拒（PERMISSION_DENIED，fail-closed）；声明了 = 激活停在
 * 权限审批门，由 scenario 经 plugin.approvePermissions RPC 批准后激活（见 approveFixtures）。
 */
export function pluginFixture({ dirName, pkgName, version = '0.1.0', displayName, description, capabilities, namespace, permissions = [], activateBody }) {
  const pkg = {
    name: pkgName,
    version,
    private: true,
    type: 'module',
    displayName,
    description,
    taijiPlugin: {
      manifestVersion: 1,
      main: 'index.js',
      activationEvents: ['onStartupFinished'],
      permissions,
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(namespace !== undefined ? { namespace } : {}),
    },
  }
  const indexJs = `// verify-taiji fixture（D3 验收；零 import 纯 ESM，动作全经 ctx.api RPC）
let activated = false
export async function activate(ctx) {
  const api = ctx.api
${activateBody}
  activated = true
}
export async function deactivate() {
  activated = false
}
export function isActivated() { return activated }
`
  return { dirName, files: { 'package.json': `${JSON.stringify(pkg, null, 2)}\n`, 'index.js': indexJs } }
}

/** 把文件集落盘到 <dataDir>/plugins/<dirName>/（幂等覆盖；启动前调用）。 */
export function seedPluginFixtures(dataDir, fixtures) {
  const pluginsDir = path.join(dataDir, 'plugins')
  for (const f of fixtures) {
    const dir = path.join(pluginsDir, f.dirName)
    fs.mkdirSync(dir, { recursive: true })
    for (const [name, content] of Object.entries(f.files)) {
      fs.writeFileSync(path.join(dir, name), content, 'utf8')
    }
  }
  return pluginsDir
}

/**
 * 写 remote-config 域缓存 envelope（remote-config-fetch RemoteCacheEnvelope 同构）。
 * checkedAt 传 `Date.now()` = 4h 节流窗内、确定性返回本清单（不发网络）；
 * 传过去时刻（>4h 前）= 强制走网络拉取（断网态 = 直连 GitHub raw 超时回退缓存）。
 */
export function seedCatalogCache(dataDir, plugins, { checkedAt = Date.now(), etag } = {}) {
  const envelope = { version: 1, checkedAt, ...(etag !== undefined ? { etag } : {}), data: { version: 1, plugins } }
  const dir = path.join(dataDir, 'remote-config')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'v2-plugins.json')
  fs.writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
  return file
}

/** 删除清单缓存（「从未拉取」态；不存在 = no-op）。返回删除前是否存在。 */
export function removeCatalogCache(dataDir) {
  const file = path.join(dataDir, 'remote-config', 'v2-plugins.json')
  const existed = fs.existsSync(file)
  if (existed) fs.rmSync(file, { force: true })
  return existed
}

/**
 * 批准 fixture 插件的权限并等激活（B 通道：plugin.approvePermissions → 激活链放行）。
 * pluginIds 传「pluginId → manifest permissions 数组」；逐个批准后轮询 plugin.list
 * 直到 status=active（sandbox fork + 模块加载 + activate 全链完成）。
 */
export async function approveAndAwaitActive(protocol, ev, permissionSpecs, { timeoutMs = 60_000 } = {}) {
  for (const [pluginId, permissions] of Object.entries(permissionSpecs)) {
    await protocol.call('plugin.approvePermissions', { pluginId, permissions })
    ev?.step({ step: `fixture.approve:${pluginId}`, channel: 'B', exitCode: 0, stats: { permissions } })
  }
  await pollUntil(async () => {
    const reply = await protocol.call('plugin.list', {})
    const pending = Object.keys(permissionSpecs).map((id) =>
      (reply.plugins ?? []).find((p) => p.pluginId === id),
    )
    return pending.length > 0 && pending.every((p) => p && p.status === 'active')
  }, { timeoutMs, label: `fixtures 激活（${Object.keys(permissionSpecs).join(',')} status=active）` })
  const reply = await protocol.call('plugin.list', {})
  return Object.fromEntries(Object.keys(permissionSpecs).map((id) => {
    const p = (reply.plugins ?? []).find((x) => x.pluginId === id)
    return [id, { status: p?.status, trustLevel: p?.trustLevel, enabled: p?.enabled }]
  }))
}

/** 清单条目（PluginCatalogEntry 同构；family 元数据供家族卡）。 */export function catalogEntry({ pluginId, packageName, displayName, description, version = '0.1.0', family, capabilities, readPaths }) {
  return {
    packageName,
    pluginId,
    displayName,
    ...(description !== undefined ? { description } : {}),
    pluginVersion: version,
    ...(family !== undefined ? { family } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(readPaths !== undefined ? { readPaths } : {}),
  }
}

/** 轮询直至 predicate 命中（条件轮询，禁固定 sleep 后断言）。 */
export async function pollUntil(predicate, { timeoutMs, intervalMs = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() >= deadline) {
      const e = new Error(`pollUntil 超时（${timeoutMs}ms）: ${label}`)
      e.hint = '条件轮询超时——核对 fixture 激活链（plugin.list status）与 runtime 日志'
      throw e
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
