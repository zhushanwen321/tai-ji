/**
 * p1-plugin-a24-legacy-upgrade —— 真机验收 S24（存量羊毛用户升级·真实凭据）+ S23b（双产物
 * 真实对话流，设计允许与 S24 归并：同一插件同一凭据，避免重复消耗真实上游）。Trae 段。
 *
 * 设计验收原文（S24）：旧版（WoolManager 形态）已授权环境升级 taiji——① 确认条目与对话；
 * ② 安装插件后展开条目：getStatus 采纳既有凭据（providers.credential 读回 → 上游校验通过
 * → 上报已登录并写回模型目录），无需重授权；③ 清理 wool-catalog.json 存量文件后重开页面：
 * 条目模型显示正常（无「0 模型」）。（S23b）：装好的插件 provider 发真实对话出话。
 *
 * 存量形态构造（案 b·运行时直接提取，裁决理由见剧本库登记）：
 *   剧本进程（Node ≥ 23.6 原生 type-stripping，零额外工具链）直接 import 独立仓 wool-shared
 *   的 extractTraeLogin()（正是插件 extract 命令调用的同一份代码）拿真实 apiKey，在 import 期
 *   把 models.json 的 wool-trae 条目 seed 成旧版 WoolManager 写入形态（{ name, apiKey }，无
 *   models 字段——旧形态 wool-manager.ts:11 实证：凭据落 apiKey + refreshToken headers 键，
 *   目录持久化在 wool-catalog.json 而非条目内）。相比「装插件 → 提取 → 卸载 → 改条目 → 重装」
 *   的两阶段案 (a)：更贴近真实用户故事（升级后的 taiji 首启即带存量条目，无卸载/重装支线）、
 *   省一次安装循环与一次真实目录拉取、不依赖产品重装路径的覆盖薄弱面。真实用户故事里 pi 扩展
 *   在旧时代已装——本剧本不预装（对话可用性 S24① 不断言真实出话，S23b 段在插件双产物安装后
 *   统一验），pi 扩展状态以「安装前缺席 / 安装后 enabled」为明确断言面。
 *
 * 装配（照 p1-plugin-a3-a12-real-extract 复用，零产品代码改动）：
 *   - pnpm pack 独立仓真实插件（@zhushanwen/plugin-wool-trae / @zhushanwen/pi-wool-trae /
 *     @zhushanwen/pi-wool-shared）+ typebox tgz 备料；
 *   - 双产物安装（清单条目 piExtensionVersion + wool-manifest 本地夹具 preload 拦截）；
 *   - mock npm registry（本机 HTTPS）承载 tarball，安装走真实 npm 链；
 *   - 存量残留：<dataDir>/wool-catalog.json import 期写入（S24③ 启动 best-effort 清理链的
 *     真实输入——runtime/index.ts 启动时一次性删除）。
 *
 * 交互路径（免重授权是结构保证：全程零 executeCommand 提取/授权派发、零凭据输入）：
 *   Provider 页（存量「0 模型」行卡基线）→ 添加供应商 ▾ → 家族卡 → 安装确认卡 → 确认安装
 *   → 授权挂载位（确认卡渲染 = 挂载位活性，不派发提取）→ 关闭流程 → 展开条目（getStatus
 *   触发采纳链）→ 状态行「凭据可用」+ models 写回 + 接管标记置位 → 导航切走再回（重开页面
 *   语义）→「N 模型」无「0 模型」→ wool-trae 真实对话出话（S23b）。
 *
 * 凭据安全红线：apiKey/refreshToken 只验存在性与长度，剧本证据（日志/截图/attach）零明文凭据。
 *
 * 运行形态：runner 托管实例（import 阶段 pack + seed 数据目录，先于 instance.launch——
 * 与 runner 的 dataDir 派生同源，必须显式传 --run-id）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  startMockNpmRegistry,
  seedPluginCatalog,
  registryEnv,
  pluginPkgsDir,
} from './lib/mock-npm-registry.mjs'
import {
  closePluginFlow,
} from './lib/plugin-flow-helper.mjs'
import { resolveDataDirFromArgv } from './lib-plugin-fixtures.mjs'

// ── 常量（包名/版本以独立仓 package.json 为单一事实源，import 期读取）────────
const PLUGIN_REPO = '/Users/zhushanwen/Code/tai-ji-plugin-workspace/main'
const TYPEBOX_DIR = path.join(PLUGIN_REPO, 'node_modules', '.pnpm')
const PACK_TMP_DIR = path.join(os.tmpdir(), 'taiji-a24-pkgs')
/** 独立仓 wool-shared 的 Trae 提取器源文件（Node 原生 type-stripping 直接 import）。 */
const TRAE_EXTRACT_TS = path.join(PLUGIN_REPO, 'packages', 'wool-shared', 'src', 'trae', 'byte-crypto.ts')

/** 家族定义（单家族：Trae。Qoder 存量形态同构不重复消耗；WorkBuddy 按任务边界跳过）。 */
const FAMILIES = [
  {
    family: 'trae',
    pkgName: '@zhushanwen/plugin-wool-trae',
    pkgDir: path.join(PLUGIN_REPO, 'packages', 'plugin-wool-trae'),
    extPkgName: '@zhushanwen/pi-wool-trae',
    extPkgDir: path.join(PLUGIN_REPO, 'packages', 'pi-wool-trae'),
    displayName: 'Trae',
    credentialFileKeyword: 'storage.json',
  },
]
const SHARED_PKG_DIR = path.join(PLUGIN_REPO, 'packages', 'wool-shared')

function readPkgVersion(pkgDir) {
  return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version
}
for (const f of FAMILIES) {
  f.version = readPkgVersion(f.pkgDir)
  f.extVersion = readPkgVersion(f.extPkgDir)
  f.pluginId = `${f.pkgName.split('/')[0].slice(1)}__${f.pkgName.split('/')[1]}` // safePluginDirName 同式：scope__pkg
  f.providerId = `wool-${f.family}`
  f.namespace = `wool-${f.family}`
}
const SHARED_VERSION = readPkgVersion(SHARED_PKG_DIR)

/** 定位 pnpm store 内 typebox 真实目录（wool-shared devDeps 钉版）。 */
function findTypeboxDir() {
  const hits = fs.readdirSync(TYPEBOX_DIR).filter((e) => e.startsWith('typebox@'))
  if (hits.length === 0) throw new Error(`pnpm store 内无 typebox（${TYPEBOX_DIR}）——独立仓未 install？`)
  return path.join(TYPEBOX_DIR, hits[0], 'node_modules', 'typebox')
}

/** 从 pnpm store 目录构造 typebox tgz（package/ 根布局，与 npm pack 产物同形）。 */
function makeTypeboxTgz(typeboxDir, outPath, workDir) {
  const stage = path.join(workDir, 'typebox-pack')
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(path.join(stage, 'package'), { recursive: true })
  fs.cpSync(typeboxDir, path.join(stage, 'package'), { recursive: true, dereference: true })
  execFileSync('tar', ['czf', outPath, '-C', stage, 'package'])
  fs.rmSync(stage, { recursive: true, force: true })
}

/** 从 tgz 直读 package.json（tar -xO 到 stdout；供 packument 依赖元数据组装）。 */
function readTgzPackageJson(tgzPath) {
  const raw = execFileSync('tar', ['-xzOf', tgzPath, 'package/package.json'], { encoding: 'utf8' })
  return JSON.parse(raw)
}

// ── 存量凭据提取（案 b 核心：与插件 extract 命令同一份独立仓代码，真实解密）────────
const traeExtracted = (await import(pathToFileURL(TRAE_EXTRACT_TS).href)).extractTraeLogin()
const LEGACY_API_KEY = traeExtracted.login.token
if (typeof LEGACY_API_KEY !== 'string' || LEGACY_API_KEY.length === 0) {
  throw new Error('extractTraeLogin 未取得真实令牌——本机 Trae CN 登录态缺失？环境前提不满足，剧本拒绝起跑')
}

// ── 顶层预置（import 阶段执行，先于 runner 的 instance.launch）────────
const dataDir0 = resolveDataDirFromArgv()

// ① pack 插件/扩展/共享库 + typebox 备料（a24- 前缀 + 导入期清扫防跨 run 残留）
const distDir = path.join(pluginPkgsDir(process.cwd()), 'dist')
fs.mkdirSync(distDir, { recursive: true })
for (const e of fs.readdirSync(distDir)) {
  if (e.startsWith('a24-')) fs.rmSync(path.join(distDir, e), { force: true })
}
fs.rmSync(PACK_TMP_DIR, { recursive: true, force: true })
fs.mkdirSync(PACK_TMP_DIR, { recursive: true })
fs.mkdirSync(dataDir0, { recursive: true })
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a24-work-'))
const typeboxDir = findTypeboxDir()
const TYPEBOX_VERSION = JSON.parse(fs.readFileSync(path.join(typeboxDir, 'package.json'), 'utf8')).version

const packStep = { packed: [], copied: [] }
/** tgz 拷贝文件名 → 真实 dependencies（packument 元数据；安装器递归装依赖消费）。 */
const pkgExtraByCopyName = {}
try {
  const typeboxCopyName = `a24-typebox-${TYPEBOX_VERSION}.tgz`
  makeTypeboxTgz(typeboxDir, path.join(distDir, typeboxCopyName), workDir)
  packStep.copied.push(typeboxCopyName)

  // pi-wool-shared pack（插件依赖，安装器 prepare 段递归装进 pluginDir/node_modules；
  // typebox 为 peerDependencies，npm7+ 自动装 peer 语义经 pkgExtra 镜像进 packument）
  const sharedTgzName = execFileSync('pnpm', ['pack', '--pack-destination', PACK_TMP_DIR], {
    cwd: SHARED_PKG_DIR, encoding: 'utf8',
  }).trim().split('\n').pop().trim()
  const sharedCopyName = `a24-pi-wool-shared-${SHARED_VERSION}.tgz`
  fs.copyFileSync(path.join(PACK_TMP_DIR, path.basename(sharedTgzName)), path.join(distDir, sharedCopyName))
  packStep.packed.push(`pi-wool-shared@${SHARED_VERSION}`)
  packStep.copied.push(sharedCopyName)
  pkgExtraByCopyName[sharedCopyName] = { dependencies: { typebox: TYPEBOX_VERSION } }

  for (const f of FAMILIES) {
    const packTgzName = execFileSync('pnpm', ['pack', '--pack-destination', PACK_TMP_DIR], {
      cwd: f.pkgDir, encoding: 'utf8',
    }).trim().split('\n').pop().trim()
    const pluginCopyName = `a24-plugin-wool-${f.family}-${f.version}.tgz`
    fs.copyFileSync(path.join(PACK_TMP_DIR, path.basename(packTgzName)), path.join(distDir, pluginCopyName))
    packStep.packed.push(`${f.pkgName}@${f.version}`)
    packStep.copied.push(pluginCopyName)

    const extTgzName = execFileSync('pnpm', ['pack', '--pack-destination', PACK_TMP_DIR], {
      cwd: f.extPkgDir, encoding: 'utf8',
    }).trim().split('\n').pop().trim()
    const extCopyName = `a24-pi-wool-${f.family}-${f.extVersion}.tgz`
    fs.copyFileSync(path.join(PACK_TMP_DIR, path.basename(extTgzName)), path.join(distDir, extCopyName))
    packStep.packed.push(`${f.extPkgName}@${f.extVersion}`)
    packStep.copied.push(extCopyName)
    pkgExtraByCopyName[extCopyName] = { dependencies: readTgzPackageJson(path.join(PACK_TMP_DIR, path.basename(extTgzName))).dependencies ?? {} }
  }
} finally {
  fs.rmSync(workDir, { recursive: true, force: true })
}

// ② 存量形态 seed：旧版 WoolManager 写入形态条目（{ name, apiKey }，无 models 字段）
//   + wool-catalog.json 存量残留（S24③ 启动清理链的真实输入）。
const modelsPath0 = path.join(dataDir0, 'agent', 'models.json')
fs.mkdirSync(path.dirname(modelsPath0), { recursive: true })
fs.writeFileSync(modelsPath0, `${JSON.stringify({
  providers: Object.fromEntries(FAMILIES.map((f) => [f.providerId, {
    name: f.displayName,
    apiKey: LEGACY_API_KEY,
  }])),
}, null, 2)}\n`, 'utf8')
const legacyCatalogFile = path.join(dataDir0, 'wool-catalog.json')
fs.writeFileSync(legacyCatalogFile, `${JSON.stringify({
  schemaVersion: 1,
  fetchedAt: Date.now(),
  families: Object.fromEntries(FAMILIES.map((f) => [f.family, { models: [], note: 'verify-taiji A24 存量残留夹具（旧版 WoolManager 目录缓存形态）' }])),
}, null, 2)}\n`, 'utf8')

// ③ 清单（双产物条目）+ wool-manifest 本地夹具（preload 拦截目标）
seedPluginCatalog(dataDir0, FAMILIES.map((f) => ({
  packageName: f.pkgName,
  pluginId: f.pluginId,
  displayName: f.displayName,
  pluginVersion: f.version,
  piExtensionVersion: f.extVersion, // 双产物判定字段（D6 配对唯一权威）
  family: {
    id: f.namespace,
    displayName: f.displayName,
    vendor: 'tai-ji-plugin 独立仓（真机 A24 批次）',
    credentialSource: 'ide-extract',
    modelCount: 3,
  },
  capabilities: ['network.http', 'fs.read-user-data', 'crypto', 'process.spawn'],
})))
const woolManifestPath = path.join(dataDir0, 'remote-config', 'wool-manifest.json')
fs.writeFileSync(woolManifestPath, `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: Date.now(),
  families: Object.fromEntries(FAMILIES.map((f) => [f.family, {
    pkg: f.extPkgName,
    version: f.extVersion,
    displayName: f.displayName,
    vendor: 'tai-ji-plugin 独立仓',
    credentialsSource: 'ide-extract',
    riskNotice: 'verify-taiji A24 本地夹具清单（真实 npm 包 + 本机 mock registry）',
  }])),
}, null, 2)}\n`, 'utf8')

// ④ 权限预批（permissions.json 启动加载 = 审批门静默通过，A3 同款全集）。
const pluginsDir0 = path.join(dataDir0, 'plugins')
fs.mkdirSync(pluginsDir0, { recursive: true })
const WOOL_PERMISSIONS = [
  'plugin.views.update',
  'plugin.commands.register',
  'plugin.commands.invoke.result',
  'plugin.event',
  'plugin.storage.global.get',
  'plugin.storage.global.set',
  'providers.write',
  'providers.credential',
]
fs.writeFileSync(
  path.join(pluginsDir0, 'permissions.json'),
  `${JSON.stringify(Object.fromEntries(FAMILIES.map((f) => [f.pluginId, WOOL_PERMISSIONS])), null, 2)}\n`,
  'utf8',
)

export const meta = {
  id: 'p1-plugin-a24-legacy-upgrade',
  priority: 'P1',
  title: 'S24+S23b 真机：存量羊毛用户升级（真实凭据采纳链·免重授权·目录写回·接管标记）+ 插件 provider 真实对话出话（Trae 段）',
  covers: ['settings.provider', 'plugin.invoke', 'session.create', 'chat.send'],
  requires: [],
  estimateSec: 360,
  env: {
    ...registryEnv(process.cwd()),
    TAIJI_VERIFY_WOOL_MANIFEST_FILE: woolManifestPath,
  },

  provable: [
    'C: 真实 pack 链在位（插件/扩展/共享库 pnpm pack 原始产物 + typebox 备料，stats 留痕）',
    'C: 存量形态预置——models.json wool-trae 条目为旧版 WoolManager 写入形态（真实 apiKey 只验长度 + name 在位 + 无 models 字段）；wool-catalog.json 存量残留 import 期在盘',
    'C: S24③ 启动清理——runtime 启动后 wool-catalog.json 被 best-effort 一次性删除（存量清理链真跑）',
    'B: 基线——插件不在 plugin.list；A: Provider 页 wool-trae 行卡在位且显示「0 模型」（存量症状基线 = S24① 条目保留语义）',
    'A: 安装链走通（家族卡「读取本机登录态」→ 真实 manifest 知情面确认卡 → 确认安装）；授权挂载位提取确认卡正常渲染（挂载位活性）——剧本零提取/授权命令派发',
    'B: 双产物——插件 active（sandbox）+ pi 扩展 enabled + 双产物落盘对账 + 安装链经 mock registry 流转',
    'A: S24② 展开条目渲染凭据状态行「凭据可用」（上报已登录；免重授权 = 全程无提取确认交互、无凭据输入）',
    'C: S24② 目录写回——展开条目后 models.json wool-trae 条目 models 字段被写回（非空数组且 api=wool-trae；真实上游目录拉取）',
    'C: S24② 接管标记——plugins/<pluginId>/globalState.json 的 catalog-adopted=true（仅目录写回成功后置位）',
    'C: 采纳合并语义——存量 name 保留 + apiKey 长度不变（既有凭据原样接管，未经重授权改写）',
    'B: 写回幂等——再次展开条目后 models.json 条目内容与 mtime 稳定（标记生效，无第二次写回）',
    'A: S24③ 重开页面条目显示正常——导航切走再回 Provider 页，行卡「N 模型」（N≥1）且无「0 模型」',
    'B: A23b 真实对话出话——modelOverride 建 session（模型解析成功 = pi 扩展读条目得完整目录的机制面）→ message.complete + assistant 文本非空',
  ],
  notProvable: [
    'S24② 中间态「已登录 · 模型目录未同步」——需构造目录写回失败（断真实上游），真机不设；失败不置标记 + 重展开幂等自愈的语义由 plugin-kit 实装路径与单测承载',
    '免重授权的「人手零操作」物理面——真人手指动作不可观测；剧本以结构保证（全程零 executeCommand 提取/授权派发、零凭据输入）+ 结果面（状态行 valid + models 写回 + 标记置位）证明',
    '额度/昵称数值与真实上游的一致性——Trae 家族无 userinfo 端点（SOLO 免费通道设计性缺席），状态行走宿主默认「凭据可用」文案',
    'wool-manifest 远端发布链与 npm 远端发布链——经本地夹具 + mock registry 折本，版本配对校验代码路径为真、网络链为假',
    'Qoder 段——本剧本只做 Trae 段（任务边界：Qoder 存量形态同构，避免重复消耗真实上游；WorkBuddy 按用户指示跳过）',
  ],
}

// ── run ───────────────────────────────────────────────────────────────

export async function run(ctx) {
  const { protocol, ui, ev, log, dataDir } = ctx
  const page = await ctx.instance.page()
  const gotchas = [
    '案 b 存量构造：剧本进程 Node 原生 type-stripping 直接 import 独立仓 wool-shared 的 extractTraeLogin（与插件 extract 命令同一份代码）——真实 apiKey 零落日志，只以长度参与断言',
    '免重授权是结构保证：run() 全程零 plugin.executeCommand 派发（提取/授权命令从未发出），采纳链唯一触发点 = 条目展开的 getStatus（plugin-kit getStatus handler 内 refreshStatus → adoptCatalogIfPending）',
    '接管标记落盘 = <dataDir>/plugins/<pluginId>/globalState.json（PluginStorage WriteBackCache 500ms debounce 落盘）——断言用轮询等 flush',
    '首次展开条目时状态行可能晚到：getStatus 同步返回 null（缓存空），行卡由 refreshStatus 完成后的 plugin:event 增量推送驱动——轮询等待',
    'pi 扩展侧 typebox 由 pi virtual-modules 注入；插件侧 typebox 由安装器经 shared 的 packument dependencies 递归装进 pluginDir/node_modules',
    'models.json 对话条目的 enabledModels 由剧本合并写入（pi 的 model scope；非产品断言对象）',
  ]

  const family = FAMILIES[0]
  const packStatsOk = packStep.packed.length === 3 && packStep.copied.length === 4
  ev.assert('C: 真实 pack 链在位（插件/扩展/共享库 pack 产物 + typebox 备料）', packStatsOk, {
    channel: 'C',
    expected: 'packed=3 copied=4',
    actual: `packed=${packStep.packed.length} copied=${packStep.copied.length} files=${packStep.copied.join(',')}`,
  })
  ev.step({ step: 'pack.real-plugins', channel: 'C', exitCode: packStatsOk ? 0 : 1, stats: { packed: packStep.packed } })
  ev.attach('a24-legacy-seed', [
    `apiKey.len=${LEGACY_API_KEY.length}`,
    `models.json=${modelsPath0}（wool-trae: {name, apiKey}，无 models 字段）`,
    `wool-catalog.json 残留已写=${fs.existsSync(legacyCatalogFile)}`,
  ].join('\n'))

  const registry = await startMockNpmRegistry(ctx.repo, buildRegistryMap())
  ev.step({ step: 'mock-registry.up', channel: 'C', exitCode: 0, stats: { url: registry.url, pkgs: Object.keys(buildRegistryMap()) } })

  const modelsPath = path.join(dataDir, 'agent', 'models.json')
  const settingsPath = path.join(dataDir, 'agent', 'settings.json')
  const readJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  }
  const modelsProviders = () => readJson(modelsPath)?.providers ?? {}
  const settingsPackages = () => readJson(settingsPath)?.packages ?? []
  const legacyEntryFile = path.join(dataDir, 'wool-catalog.json')

  function buildRegistryMap() {
    const map = {}
    const add = (name, version, file) => {
      const abs = path.join(distDir, file)
      if (!fs.existsSync(abs)) throw new Error(`缺 tarball：${abs}`)
      const extra = pkgExtraByCopyName[file]
      map[name] = {
        versions: { [version]: abs },
        latest: version,
        ...(extra !== undefined ? { pkgExtra: { [version]: extra } } : {}),
      }
    }
    add('typebox', TYPEBOX_VERSION, `a24-typebox-${TYPEBOX_VERSION}.tgz`)
    add('@zhushanwen/pi-wool-shared', SHARED_VERSION, `a24-pi-wool-shared-${SHARED_VERSION}.tgz`)
    for (const f of FAMILIES) {
      add(f.pkgName, f.version, `a24-plugin-wool-${f.family}-${f.version}.tgz`)
      add(f.extPkgName, f.extVersion, `a24-pi-wool-${f.family}-${f.extVersion}.tgz`)
    }
    return map
  }

  try {
    // ── 启动后基线：S24③ 清理已发生 + 存量条目原样在位 ─────────────
    const catalogGone = await pollGone(() => fs.existsSync(legacyEntryFile), { timeoutMs: 20_000 })
    ev.assert('C: S24③ 启动清理——wool-catalog.json 存量残留被 runtime 启动链 best-effort 删除',
      catalogGone, {
        channel: 'C',
        expected: '<dataDir>/wool-catalog.json 不存在（启动一次性清理）',
        actual: catalogGone ? '已删除' : '20s 后仍在（启动清理链未生效）',
      })

    const seeded = modelsProviders()[family.providerId]
    const seededLegacyForm = typeof seeded?.apiKey === 'string' && seeded.apiKey.length > 0
      && seeded.name === family.displayName && seeded.models === undefined
    ev.assert('C: 存量条目原样在位（旧版形态：apiKey 非空 + name 在位 + 无 models 字段——启动链未改写存量）',
      seededLegacyForm, {
        channel: 'C',
        expected: `{name:'${family.displayName}', apiKey:len>0} 且无 models`,
        actual: seeded ? `name=${seeded.name} apiKey.len=${seeded.apiKey?.length ?? 0} models=${seeded.models === undefined ? '缺席' : JSON.stringify(seeded.models).slice(0, 60)}` : '条目缺失',
      })

    const listed0 = await protocol.call('plugin.list', {})
    ev.assert('B: 基线——插件不在 plugin.list（存量环境 = 未装插件的旧版升级态）',
      !(listed0.plugins ?? []).some((p) => p.pluginId === family.pluginId), {
        channel: 'B',
        expected: `无 ${family.pluginId}`,
        actual: (listed0.plugins ?? []).map((p) => p.pluginId).join(',').slice(0, 160) || '(空)',
      })

    // ── S24① 存量条目可见：「0 模型」行卡基线（不展开——插件未装，getStatus 无主体）──
    await openProviderPage(ui)
    const legacyCard = page.locator('[data-testid="provider-card"]', { hasText: new RegExp(family.family, 'i') }).first()
    await legacyCard.waitFor({ state: 'visible', timeoutMs: 15_000 })
    const legacyCardText = await legacyCard.innerText()
    ev.assert('A: S24① 存量条目行卡在位且显示「0 模型」（升级后条目保留 + 存量症状基线）',
      legacyCardText.includes(family.displayName) && legacyCardText.includes('0 模型'), {
        channel: 'A',
        expected: `行卡含 ${family.displayName} + 「0 模型」`,
        actual: legacyCardText.replace(/\s+/g, ' ').slice(0, 140),
      })
    await ui.screenshot('a24-baseline-legacy-card')

    // ── 安装插件（家族卡 → 真实知情面确认卡 → 确认安装）────────────
    await ui.click('testid=provider-template-picker')
    await ui.click('testid=add-menu-plugin')
    await ui.expectVisible('testid=plugin-provider-flow')
    await ui.expectVisible('testid=plugin-family-grid')
    await installViaFamilyCard(ui, page, family, ev)
    await assertInstalledState({ protocol, ev, ui, family, registry, dataDir, settingsPackages, modelsProviders })

    // 授权挂载位：提取确认卡正常渲染 = 挂载位活性（注意：只断言渲染，不派发提取——
    // 免重授权语义的结构保证从此处开始：用户故事里用户直接关掉流程去展开条目）。
    await assertAuthorizeMountRenders(ui, page, family, ev)
    await closePluginFlow(ui)

    // ── S24② 采纳链：展开条目（getStatus 触发）───────────────────
    const adoptCard = page.locator('[data-testid="provider-card"]', { hasText: new RegExp(family.family, 'i') }).first()
    await adoptCard.locator('span[role="button"]').click()
    const statusRow = page.locator('[data-testid="provider-plugin-status"]')
    const statusAppeared = await pollValue(
      async () => (await statusRow.count()) > 0,
      Boolean,
      { timeoutMs: 30_000, label: 'wool-trae 条目状态行渲染（plugin:event 增量推送驱动）' },
    ).catch(() => false)
    const statusText = statusAppeared ? await statusRow.first().innerText().catch(() => '') : ''
    ev.assert('A: S24② 展开条目渲染凭据状态行「凭据可用」（上报已登录——免重授权：无提取确认交互、无凭据输入）',
      statusAppeared && statusText.includes('凭据可用') && !statusText.includes('凭据可能已失效'), {
        channel: 'A',
        expected: 'provider-plugin-status 含「凭据可用」（valid 无素材默认文案）',
        actual: `appeared=${statusAppeared} text=${statusText.trim().slice(0, 80) || '(空)'}`,
      })
    await ui.screenshot('a24-status-row-valid')

    // C：目录写回（真实上游 fetchTraeCatalog → providers.write models）
    const adoptedEntry = await pollValue(
      () => modelsProviders()[family.providerId] ?? null,
      (e) => Array.isArray(e?.models) && e.models.length > 0,
      { timeoutMs: 90_000, label: 'models.json wool-trae models 字段写回' },
    ).catch(() => null)
    const adoptedModelsOk = Array.isArray(adoptedEntry?.models) && adoptedEntry.models.length > 0
      && adoptedEntry.models.every((m) => m?.api === family.namespace && typeof m?.id === 'string' && m.id.length > 0)
    ev.assert('C: S24② 目录写回——models 字段被写回（非空数组且 api=wool-trae；真实上游目录拉取）',
      adoptedModelsOk, {
        channel: 'C',
        expected: `models≥1（api=${family.namespace}）`,
        actual: adoptedEntry ? `models=${adoptedEntry.models?.length ?? 0} ids=${(adoptedEntry.models ?? []).map((m) => m.id).slice(0, 5).join(',')} apiKey.len=${adoptedEntry.apiKey?.length ?? 0}` : '90s 内 models 未写回',
      })

    // C：接管标记（写回成功后置位；WriteBackCache 500ms debounce → 轮询等落盘）
    const globalStatePath = path.join(dataDir, 'plugins', family.pluginId, 'globalState.json')
    const markerSet = await pollValue(
      () => readJson(globalStatePath)?.['catalog-adopted'] === true,
      Boolean,
      { timeoutMs: 20_000, label: 'globalState.json catalog-adopted 置位' },
    ).catch(() => false)
    ev.assert('C: S24② 接管标记——globalState.json catalog-adopted=true（仅目录写回成功后置位）',
      markerSet, {
        channel: 'C',
        expected: `${globalStatePath} catalog-adopted=true`,
        actual: markerSet ? '已置位' : `20s 未置位（文件=${fs.existsSync(globalStatePath) ? '在' : '缺'}）`,
      })

    // C：采纳合并语义——存量 name 保留 + apiKey 长度不变（既有凭据原样接管）
    const mergedOk = adoptedEntry?.name === family.displayName
      && typeof adoptedEntry?.apiKey === 'string' && adoptedEntry.apiKey.length === LEGACY_API_KEY.length
    ev.assert('C: 采纳合并语义——存量 name 保留 + apiKey 长度不变（凭据原样接管，未经重授权改写）',
      mergedOk, {
        channel: 'C',
        expected: `name='${family.displayName}' + apiKey.len=${LEGACY_API_KEY.length}`,
        actual: `name=${adoptedEntry?.name} apiKey.len=${adoptedEntry?.apiKey?.length ?? 0}`,
      })
    ev.attach('a24-adoption-evidence', [
      `models=${adoptedEntry?.models?.length ?? 0}`,
      `marker=${markerSet}`,
      `name=${adoptedEntry?.name}`,
      `apiKey.len=${adoptedEntry?.apiKey?.length ?? 0}（seed=${LEGACY_API_KEY.length}）`,
      `statusRow=${statusText.trim().slice(0, 40)}`,
    ].join('\n'))

    // B：写回幂等——再次展开条目（收起 + 展开），确认 getStatus 二次触发（状态行重渲染）
    // 后条目内容与 mtime 稳定 = 标记生效、无第二次写回。
    const beforeProbe = modelsProviders()[family.providerId]
    const beforeMtime = fs.statSync(modelsPath).mtimeMs
    await adoptCard.locator('span[role="button"]').click().catch(() => {})
    await new Promise((r) => setTimeout(r, 500))
    await adoptCard.locator('span[role="button"]').click().catch(() => {})
    await pollValue(
      async () => (await statusRow.count()) > 0,
      Boolean,
      { timeoutMs: 15_000, label: '再次展开后状态行重渲染（getStatus 二次触发证据）' },
    )
    await new Promise((r) => setTimeout(r, 4_000))
    const afterProbe = modelsProviders()[family.providerId]
    const afterMtime = fs.statSync(modelsPath).mtimeMs
    const idempotentOk = JSON.stringify(beforeProbe) === JSON.stringify(afterProbe) && beforeMtime === afterMtime
    ev.assert('B: 写回幂等——再次展开条目（getStatus 二次触发）后 models.json 条目内容与 mtime 稳定（接管标记生效，无第二次写回）',
      idempotentOk, {
        channel: 'B',
        expected: '条目 JSON 与 mtime 均不变（adoptCatalogIfPending 命中标记即返回）',
        actual: `contentSame=${JSON.stringify(beforeProbe) === JSON.stringify(afterProbe)} mtimeSame=${beforeMtime === afterMtime}`,
      })

    // ── S24③ 重开页面：导航切走再回，行卡「N 模型」无「0 模型」────────
    await ui.click('testid=settings-nav-skill')
    await ui.click('testid=settings-nav-provider')
    await ui.expectVisible('testid=provider-template-picker')
    const reopenedCard = page.locator('[data-testid="provider-card"]', { hasText: new RegExp(family.family, 'i') }).first()
    await reopenedCard.waitFor({ state: 'visible', timeoutMs: 15_000 })
    const reopenedText = (await reopenedCard.innerText()).replace(/\s+/g, ' ')
    const modelCountMatch = reopenedText.match(/(\d+) 模型/)
    const reopenedOk = modelCountMatch !== null && Number(modelCountMatch[1]) >= 1 && !reopenedText.includes('0 模型')
    ev.assert('A: S24③ 重开页面条目显示正常——「N 模型」(N≥1) 且无「0 模型」（目录写回后读侧完整）',
      reopenedOk, {
        channel: 'A',
        expected: '行卡模型计数 ≥1（无「0 模型」）',
        actual: reopenedText.slice(0, 140),
      })
    await ui.screenshot('a24-reopened-card-models')

    // ── A23b 真实对话出话（wool-trae；上游消耗 ≤ 2 条探针消息）────────
    await realConversation({ protocol, ev, ui, providerId: family.providerId, models: adoptedEntry?.models ?? [], settingsPath, label: family.family })

    log('A24+A23b done')
  } finally {
    // 探针不留场：fixtures distDir 的 a24- tarball 副本清除（pack 产物在 /tmp，随系统清理）
    for (const e of fs.readdirSync(distDir)) {
      if (e.startsWith('a24-')) fs.rmSync(path.join(distDir, e), { force: true })
    }
    ev.step({ step: 'fixtures.cleanup', channel: 'C', exitCode: 0, stats: { distDir: 'a24-* cleared' } })
    await registry.close()
  }
  return { uncovered: [], gotchas }
}

// ── 段内共享步骤（A3 剧本同款）────────────────────────────────────────

/** 打开 Provider 页（ready 锚 = 页头常驻 provider-template-picker）。 */
async function openProviderPage(ui) {
  await ui.click('testid=sidebar-settings')
  await ui.expectVisible('testid=settings-nav-provider')
  await ui.click('testid=settings-nav-provider')
  await ui.expectVisible('testid=provider-template-picker')
}

/** 家族卡 → 安装确认卡（真实 manifest 知情面断言）→ 确认安装 → 授权容器。 */
async function installViaFamilyCard(ui, page, f, ev) {
  const cardSel = `css=[data-testid="plugin-family-card"]:has-text("${f.displayName}")`
  await ui.expectVisible(cardSel)
  const cardText = await ui.text(cardSel)
  ev.assert(`A: ${f.displayName} 家族卡渲染（显示名 + 「读取本机登录态」授权方式）`,
    cardText.includes(f.displayName) && cardText.includes('读取本机登录态'), {
      channel: 'A',
      expected: `${f.displayName} + 读取本机登录态`,
      actual: cardText.slice(0, 140),
    })
  await ui.click(cardSel)
  await ui.expectVisible('testid=plugin-install-confirm', { timeoutMs: 60_000 })
  const capsText = await ui.text('testid=plugin-confirm-capabilities')
  const readPathsText = await ui.text('testid=plugin-confirm-read-paths')
  ev.assert(`A: ${f.displayName} 安装确认卡真实知情面（capabilities 含网络/本机读取 + readPaths 含凭据文件）`,
    capsText.includes('network.http') && capsText.includes('fs.read-user-data') && readPathsText.includes(f.credentialFileKeyword), {
      channel: 'A',
      expected: `network.http + fs.read-user-data + readPaths 含 ${f.credentialFileKeyword}`,
      actual: `caps=${capsText.slice(0, 120)} readPaths=${readPathsText.slice(0, 140)}`,
    })
  await ui.screenshot(`a24-${f.family}-confirm-card`)
  await ui.click('testid=plugin-install-confirm-btn')
  await ui.expectVisible('testid=plugin-authorize-container', { timeoutMs: 90_000 })
  ev.step({ step: `install.${f.family}`, channel: 'A', exitCode: 0, stats: { pkg: f.pkgName, version: f.version } })
}

/** 安装后对账：插件 active + pi 扩展 enabled + 双产物落盘 + registry 流转 + 条目仍在（未被安装链清除）。 */
async function assertInstalledState({ protocol, ev, ui, family: f, registry, dataDir, settingsPackages, modelsProviders }) {
  const listed = await pollValue(
    async () => {
      const r = await protocol.call('plugin.list', {})
      return (r.plugins ?? []).find((p) => p.pluginId === f.pluginId)
    },
    (info) => Boolean(info && info.status === 'active'),
    { timeoutMs: 30_000, label: `插件 ${f.pluginId} active` },
  )
  ev.assert(`B: ${f.displayName} 插件已激活（status=active，sandbox）`, listed?.status === 'active' && listed?.trustLevel === 'sandbox', {
    channel: 'B',
    expected: 'status=active trustLevel=sandbox',
    actual: listed ? `status=${listed.status} trust=${listed.trustLevel} v${listed.version}` : '插件不在列表',
  })
  const extListed = await pollValue(
    async () => {
      const r = await protocol.call('extension.list', {})
      return (r.extensions ?? []).find((e) => e.name === f.extPkgName)
    },
    (info) => Boolean(info && info.enabled),
    { timeoutMs: 30_000, label: `pi 扩展 ${f.extPkgName} enabled` },
  )
  ev.assert(`B: ${f.displayName} pi 扩展已注册且 enabled（双产物双注册表对账）`, Boolean(extListed?.enabled), {
    channel: 'B',
    expected: `${f.extPkgName} enabled=true`,
    actual: extListed ? `v${extListed.version} enabled=${extListed.enabled}` : '扩展不在列表',
  })

  const readPkgJsonSafe = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  }
  const pluginPkg = readPkgJsonSafe(path.join(dataDir, 'plugins', f.pluginId, 'package.json'))
  const extPkg = readPkgJsonSafe(path.join(dataDir, 'npm', 'node_modules', ...f.extPkgName.split('/'), 'package.json'))
  ev.assert(`C: ${f.displayName} 双产物落盘（插件目录 + package.json 同源 + pi 扩展 npm 布局版本=配对值）`,
    pluginPkg?.name === f.pkgName && pluginPkg?.taijiPlugin?.namespace === f.namespace && extPkg?.name === f.extPkgName && extPkg?.version === f.extVersion, {
      channel: 'C',
      expected: `${f.pkgName} ns=${f.namespace} + ${f.extPkgName}@${f.extVersion}`,
      actual: `plugin=${pluginPkg ? `${pluginPkg.name} ns=${pluginPkg.taijiPlugin?.namespace}` : '缺失'} ext=${extPkg ? `${extPkg.name}@${extPkg.version}` : '缺失'}`,
    })
  ev.assert(`C: ${f.displayName} settings.json packages[] 登记 pi 扩展`, settingsPackages().includes(`npm:${f.extPkgName}`), {
    channel: 'C',
    expected: `packages[] 含 npm:${f.extPkgName}`,
    actual: settingsPackages().filter((s) => s.includes('wool')).join(',') || '无 wool 项',
  })
  const registryPaths = registry.requests.map((r) => r.path)
  ev.assert(`C: ${f.displayName} 安装链经本机 mock registry 流转（插件/扩展/共享库 packument 均有请求）`,
    registryPaths.some((p) => p.includes('plugin-wool-')) && registryPaths.some((p) => p.includes('pi-wool-')) && registryPaths.some((p) => p.includes('pi-wool-shared')), {
      channel: 'C',
      expected: 'registry 请求含 plugin-wool-* / pi-wool-* / pi-wool-shared',
      actual: `requests=${registryPaths.length} uniq=${[...new Set(registryPaths)].slice(0, 8).join(' | ')}`,
    })
  // 存量条目在安装后仍以旧形态在位（安装链不清条目——采纳链才是唯一写回方）
  const entryAfterInstall = modelsProviders()[f.providerId]
  ev.assert(`C: ${f.displayName} 存量条目未被安装链触碰（无 models 字段——写回只属采纳链）`,
    entryAfterInstall?.apiKey?.length > 0 && entryAfterInstall?.models === undefined, {
      channel: 'C',
      expected: '安装后条目仍为 {name, apiKey} 无 models',
      actual: entryAfterInstall ? `apiKey.len=${entryAfterInstall.apiKey?.length ?? 0} models=${entryAfterInstall.models === undefined ? '缺席' : '在场（安装链越权写回？）'}` : '条目缺失',
    })
  await ui.screenshot(`a24-${f.family}-installed`)
}

/** 授权挂载位渲染断言：容器内提取确认卡在（挂载位活性）；不派发提取——免重授权结构保证。 */
async function assertAuthorizeMountRenders(ui, page, f, ev) {
  const extractBtn = page.locator('[data-testid="gui-action-bar-item-wool-extract-start"]')
  const btnCount = await extractBtn.count()
  const emptyHost = await page.locator('[data-testid="view-host-empty"]').count()
  ev.assert(`A: ${f.displayName} 授权挂载位渲染提取确认卡（挂载位活性——仅断言渲染，剧本不派发提取）`,
    btnCount > 0 && emptyHost === 0, {
      channel: 'A',
      expected: 'gui-action-bar-item-wool-extract-start 存在 + 无 view-host-empty 占位',
      actual: `extractBtn=${btnCount} view-host-empty=${emptyHost}`,
    })
  await ui.screenshot(`a24-${f.family}-authorize-mount`)
}

/** 真实对话出话（A3 同款）：enabledModels 合并 → modelOverride 建 session → 极短探针 → complete + 文本。 */
async function realConversation({ protocol, ev, ui, providerId, models, settingsPath, label }) {
  const modelId = (models.find((m) => typeof m?.id === 'string' && m.id.length > 0) ?? {}).id
  if (typeof modelId !== 'string') {
    ev.assert(`B: wool-${label} 真实对话出话`, false, {
      channel: 'B', expected: 'models 内有可用模型 id', actual: `models=${JSON.stringify(models).slice(0, 200)}`,
    })
    return
  }
  const composite = `${providerId}/${modelId}`
  let settings = {}
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch { /* 缺文件以空对象起 */ }
  const enabled = new Set(Array.isArray(settings.enabledModels) ? settings.enabledModels : [])
  enabled.add(composite)
  settings.enabledModels = [...enabled]
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  ev.step({ step: `conversation.seed.${label}`, channel: 'C', exitCode: 0, stats: { enabledModels: composite } })

  const created = await protocol.call('session.create', { cwd: process.cwd(), label: `a24-${label}`, modelOverride: composite }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  // 模型解析成功 = pi 扩展读条目得完整目录的机制面（S24③「无 0 模型」的 pi 侧证据）
  ev.assert(`B: wool-${label} 会话建立且模型解析为 ${composite}（pi 扩展 refreshModels 读条目得完整目录）`,
    Boolean(sid) && created.session?.modelId === composite, {
      channel: 'B',
      expected: `sessionId 非空 + modelId=${composite}`,
      actual: `sid=${sid} modelId=${created.session?.modelId}`,
    })
  await protocol.subscribe(sid)
  const since = protocol.events.length
  await protocol.send(sid, '请只回复两个字：收到')
  let end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
  // 上游排队信封（403 + code 10605 isQueued）= 环境类瞬态：等 45s 重发一次探针（真实用户
  // 稍后重试同构，A3 先例）；其余错误不重试。探针消息总量上限 2 条。
  const endError = () => String(end.payload?.message ?? end.payload?.errorMessage ?? '')
  if (!end.ok && (endError().includes('10605') || endError().includes('isQueued'))) {
    ev.step({ step: `conversation.queue-retry.${label}`, channel: 'B', exitCode: 0, stats: { waitMs: 45_000, reason: '上游排队信封（环境类瞬态）' } })
    await new Promise((r) => setTimeout(r, 45_000))
    const since2 = protocol.events.length
    await protocol.send(sid, '请只回复两个字：收到')
    end = await protocol.waitTurnEnd(sid, { since: since2, timeoutMs: 180_000 })
  }
  ev.assert(`B: wool-${label} 真实对话出话（message.complete + assistant 文本非空）`, end.type === 'message.complete' && end.ok, {
    channel: 'B',
    expected: 'message.complete + stopReason≠error（真实上游一轮）',
    actual: `${end.type} stopReason=${end.payload?.stopReason ?? 'n/a'} error=${endError().slice(0, 400)}`,
  })
  const hist = await protocol.history(sid, { limitTurns: 5 })
  const assistantTexts = (hist.messages ?? [])
    .filter((m) => m.role === 'assistant')
    .map((m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content)
      ? m.content.map((s) => (s?.type === 'text' ? s.text ?? '' : '')).join('') : ''))
    .filter((t) => t.trim().length > 0)
  ev.assert(`B: wool-${label} assistant 文本非空（对话链端到端通）`, assistantTexts.length > 0, {
    channel: 'B',
    expected: '≥1 条非空 assistant 文本',
    actual: `messages=${(hist.messages ?? []).length} assistantTexts=${assistantTexts.length} first=${(assistantTexts[0] ?? '').slice(0, 60)}`,
  })
  await ui.screenshot(`a24-${label}-conversation`)
}

/** 条件轮询取值（异步判定；超时返回 null——失败形态由断言呈现，不抛）。 */
async function pollValue(fn, predicate, { timeoutMs, intervalMs = 500, label = 'condition' }) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await fn()
    if (predicate(last)) return last
    if (Date.now() >= deadline) {
      const e = new Error(`pollValue 超时（${timeoutMs}ms）: ${label}`)
      e.hint = '核对采纳链（providers.credential 回读 / 上游目录拉取 / globalState flush）与 runtime 日志'
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
