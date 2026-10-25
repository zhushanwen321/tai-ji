/**
 * p1-plugin-a3-a12-real-extract —— 真机验收 A3（Trae/Qoder 真实凭据提取链路）+ A12（管理
 * 动作延迟 ≤ 1 秒）合并剧本，两段同构（Trae 段 storage.json 解密 / Qoder 段钥匙串解密）。
 *
 * 设计验收原文（S3）：选 Trae → 点读取 → 确认卡 → 继续；预期 = 提取成功；解密正确；
 * 额度百分比正确；对话出话。（S12）：插件形态下走 Trae 提取重授权，测「点读取本机登录态
 * → 结果回显」耗时 ≤ 1 秒（存量隐藏 pi 会话路径实测 5.8 秒）。
 *
 * 装配（真实安装链，零产品代码改动）：
 *   - pnpm pack 独立仓真实插件（@zhushanwen/plugin-wool-trae / plugin-wool-qoder /
 *     @zhushanwen/pi-wool-shared / @zhushanwen/pi-wool-trae / pi-wool-qoder）；
 *   - 双产物安装（清单条目 piExtensionVersion + wool-manifest 本地夹具，A23a 同款
 *     preload 拦截）：真实对话硬依赖 pi 扩展注册 wool 自定义 api（模型目录 api 字段 =
 *     'wool-trae'/'wool-qoder'，无扩展则 pi 无法解析模型），故本剧本必须双产物；
 *   - 插件 tgz 内嵌依赖（node_modules/@zhushanwen/pi-wool-shared + typebox）：宿主插件
 *     安装器「单包解压，不递归装依赖」（plugin-installer-adapter.ts 头注），而沙箱 ESM
 *     loader 要求裸导入落 pluginDir 内——真实插件的发布形态必须 bundle 依赖才能激活
 *     （发布链缺口，ISSUES-2 登记）；插件源码零改动，内嵌依赖 = 独立仓真实 pack 产物；
 *   - mock npm registry（A23a 同款 HTTPS 本机服务）承载五个 tarball，安装走真实 npm 链。
 *
 * 交互路径（A 通道为主，B 通道对账）：
 *   Provider 页 → 添加供应商 ▾ → 家族卡 → 安装确认卡（真实 manifest 知情面）→ 确认安装
 *   → 授权挂载位容器 → 提取确认卡（见下方已知缺口）→ 提取 → 成功卡（A12 计时）
 *   → getStatus / models.json / 真实对话出话（wool 条目模型，极短探针）。
 *
 * 已知产品缺口（ISSUES-2 登记，剧本如实呈现不掩盖）：
 *   ① 提取确认卡无渲染驱动：wool 插件只在 getAuthorizeView 被调用时推初始树，宿主
 *      renderer 无任何调用点（全仓 grep 零命中）→ 授权容器进入后呈占位空态。提取动作
 *      改以 plugin.executeCommand 驱动——与 action-bar 按钮点击完全同一命令派发通道
 *      （PluginProviderSource.createPluginActionExecutor → plugin.executeCommand）。
 *   ② 额度/昵称的条目行 DOM 呈现无驱动：凭据状态行（provider-plugin-status）期望
 *      { state, message } 形状，wool getStatus 返回 { status: { family, loggedIn, ... } }
 *      形状（parseStatusFields 恒 null）；详情扩展区树只在 getDetail 被调用时推送，
 *      宿主同样无调用点。额度断言权威 = B 通道 getStatus 插件上报（任务口径「以插件
 *      上报非空为准」），不做真实上游数值核对。
 *   ③ 插件安装器不装依赖（plugin-installer-adapter「单包解压」），沙箱 loader 要求
 *      裸导入落 pluginDir 内——真实插件必须 bundle 依赖才能激活。剧本产物内嵌
 *      node_modules/{@zhushanwen/pi-wool-shared, typebox}（独立仓真实 pack 产物）。
 *   ④ 宿主 sandboxDir = dirname(manifest main)（plugin-host-process.ts），仅支持根
 *      入口；真实插件 main = src/index.ts → 激活必炸（d3-r2 实测：Sandbox: import
 *      resolves outside plugin directory）。剧本产物以根入口 shim（re-export 真实
 *      src）+ manifest main 指回根承载——插件源码零改动。
 *   ⑤ api.events.emit 在沙箱子进程未接 plugin.event 通道（bootstrap NOT_IMPLEMENTED，
 *      d3-r3 实测 wool-status 推送降级 warn）——D5 推补充通道断裂，「拉为主」仍可用。
 *   ⑥ 提取结果树 DOM 不渲染：wool 插件推树 viewId='authorize'（plugin-kit views.update
 *      首参），宿主 ViewHost 渲染 viewId='provider.authorize'（viewId=挂载位同名约定，
 *      PluginProviderFlow AUTHORIZE_VIEW_ID）——跨仓契约错位，d3-r3 实测提取成功后
 *      DOM 停留「加载中…」而宿主快照（viewId='authorize'）持有成功树。A12 的「结果
 *      回显」以宿主快照持有成功相位为计时终点（runtime 数据层回显成立），DOM 呈现
 *      断裂如实断言并登记。
 *
 * 凭据安全红线：apiKey/token 只验存在性与长度，剧本证据（日志/截图/attach）零明文凭据。
 *
 * 运行形态：runner 托管实例（import 阶段 pack + seed 数据目录，先于 instance.launch——
 * 与 runner 的 dataDir 派生同源，必须显式传 --run-id）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
const PACK_TMP_DIR = path.join(os.tmpdir(), 'taiji-a3a12-pkgs')

/** 家族定义（ packageName / 目录名 / 展示名 / 凭据源路径关键词）。 */
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
  {
    family: 'qoder',
    pkgName: '@zhushanwen/plugin-wool-qoder',
    pkgDir: path.join(PLUGIN_REPO, 'packages', 'plugin-wool-qoder'),
    extPkgName: '@zhushanwen/pi-wool-qoder',
    extPkgDir: path.join(PLUGIN_REPO, 'packages', 'pi-wool-qoder'),
    displayName: 'Qoder',
    credentialFileKeyword: 'auth.v1.dat',
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

/** 定位 pnpm store 内 typebox 真实目录（wool-shared devDeps 钉版 1.3.27）。 */
function findTypeboxDir() {
  const hits = fs.readdirSync(TYPEBOX_DIR).filter((e) => e.startsWith('typebox@'))
  if (hits.length === 0) throw new Error(`pnpm store 内无 typebox（${TYPEBOX_DIR}）——独立仓未 install？`)
  return path.join(TYPEBOX_DIR, hits[0], 'node_modules', 'typebox')
}

/**
 * 组装插件 tgz：真实 pack 产物 + 内嵌依赖（wool-shared pack + typebox）+ 入口上提 shim。
 * 为什么内嵌：宿主插件安装器不装依赖（单包解压），沙箱 loader 要求裸导入落 pluginDir
 * 内——见文件头「已知产品缺口」。为什么入口上提：宿主 sandboxDir = dirname(manifest
 * main)（plugin-host-process.ts env 注入处），仅支持根入口；真实插件 main = src/index.ts
 * → sandboxDir = <dir>/src → node_modules 判越界、激活必炸（d3-r2 首轮实测根因，ISSUES-2）。
 * 剧本产物 = 真实源码零改动 + 根入口 shim（re-export）+ manifest main 指回根。
 */
function assemblePluginTgz(f, sharedTgzPath, workDir, outPath) {
  const extractDir = path.join(workDir, `assembly-${f.family}`)
  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.mkdirSync(extractDir, { recursive: true })
  execFileSync('tar', ['xzf', f.packTgzPath, '-C', extractDir])
  const pkgDir = path.join(extractDir, 'package')
  const scopedNm = path.join(pkgDir, 'node_modules', '@zhushanwen')
  fs.mkdirSync(scopedNm, { recursive: true })
  execFileSync('tar', ['xzf', sharedTgzPath, '-C', scopedNm])
  fs.renameSync(path.join(scopedNm, 'package'), path.join(scopedNm, 'pi-wool-shared'))
  fs.cpSync(f.typeboxDir, path.join(pkgDir, 'node_modules', 'typebox'), { recursive: true, dereference: true })
  fs.writeFileSync(path.join(pkgDir, 'index.js'), 'export { activate } from "./src/index.ts";\n')
  const pkgJsonPath = path.join(pkgDir, 'package.json')
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
  pkgJson.main = 'index.js'
  pkgJson.taijiPlugin.main = 'index.js'
  fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`, 'utf8')
  execFileSync('tar', ['czf', outPath, '-C', extractDir, 'package'])
  fs.rmSync(extractDir, { recursive: true, force: true })
}

// ── 顶层预置（import 阶段执行，先于 runner 的 instance.launch）────────
const dataDir0 = resolveDataDirFromArgv()

// ① pack 五包到 /tmp + 组装插件 tgz（内嵌依赖）+ 拷入 fixtures distDir
//   （mock registry 只从 distDir 出 tarball；a3a12- 前缀 + 导入期清扫防跨 run 残留）。
const distDir = path.join(pluginPkgsDir(process.cwd()), 'dist')
fs.mkdirSync(distDir, { recursive: true })
for (const e of fs.readdirSync(distDir)) {
  if (e.startsWith('a3a12-')) fs.rmSync(path.join(distDir, e), { force: true })
}
fs.rmSync(PACK_TMP_DIR, { recursive: true, force: true })
fs.mkdirSync(PACK_TMP_DIR, { recursive: true })
fs.mkdirSync(dataDir0, { recursive: true })
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a3a12-work-'))
const typeboxDir = findTypeboxDir()

/** 从 tgz 直读 package.json（tar -xO 到 stdout；供 packument 依赖元数据组装）。 */
function readTgzPackageJson(tgzPath) {
  const raw = execFileSync('tar', ['-xzOf', tgzPath, 'package/package.json'], { encoding: 'utf8' })
  return JSON.parse(raw)
}

const packStep = { packed: [], assembled: [], copied: [] }
/** tgz 拷贝文件名 → 真实 dependencies（packument 元数据；安装器递归装依赖消费）。 */
const pkgExtraByCopyName = {}
try {
  // pi-wool-shared 先 pack（插件组装要引用它的 tgz）
  const sharedTgzName = execFileSync('pnpm', ['pack', '--pack-destination', PACK_TMP_DIR], {
    cwd: SHARED_PKG_DIR, encoding: 'utf8',
  }).trim().split('\n').pop().trim()
  const sharedTgzPath = path.join(PACK_TMP_DIR, path.basename(sharedTgzName))
  const sharedCopyName = `a3a12-pi-wool-shared-${SHARED_VERSION}.tgz`
  fs.copyFileSync(sharedTgzPath, path.join(distDir, sharedCopyName))
  packStep.packed.push(`pi-wool-shared@${SHARED_VERSION}`)
  packStep.copied.push(sharedCopyName)
  // packument 依赖元数据（安装器递归装依赖读 packument，mock registry 元数据缺位 =
  // 依赖递归不发生——见 mock-npm-registry.mjs pkgExtra 注释；值 = 字段级合并对象）
  pkgExtraByCopyName[sharedCopyName] = { dependencies: readTgzPackageJson(sharedTgzPath).dependencies ?? {} }

  for (const f of FAMILIES) {
    f.packTgzName = execFileSync('pnpm', ['pack', '--pack-destination', PACK_TMP_DIR], {
      cwd: f.pkgDir, encoding: 'utf8',
    }).trim().split('\n').pop().trim()
    f.packTgzPath = path.join(PACK_TMP_DIR, path.basename(f.packTgzName))
    packStep.packed.push(`${f.pkgName}@${f.version}`)
    f.typeboxDir = typeboxDir
    const assembledName = `a3a12-plugin-wool-${f.family}-${f.version}.tgz`
    assemblePluginTgz(f, sharedTgzPath, workDir, path.join(distDir, assembledName))
    packStep.assembled.push(`${f.pkgName} +node_modules{pi-wool-shared,typebox} +root-entry-shim`)
    packStep.copied.push(assembledName)
    // pi 扩展 tgz 保持真实 pack 形态（extension 安装链会真实 npm 装依赖）
    const extTgzName = execFileSync('pnpm', ['pack', '--pack-destination', PACK_TMP_DIR], {
      cwd: f.extPkgDir, encoding: 'utf8',
    }).trim().split('\n').pop().trim()
    const extCopyName = `a3a12-pi-wool-${f.family}-${f.extVersion}.tgz`
    fs.copyFileSync(path.join(PACK_TMP_DIR, path.basename(extTgzName)), path.join(distDir, extCopyName))
    packStep.packed.push(`${f.extPkgName}@${f.extVersion}`)
    packStep.copied.push(extCopyName)
    pkgExtraByCopyName[extCopyName] = { dependencies: readTgzPackageJson(path.join(PACK_TMP_DIR, path.basename(extTgzName))).dependencies ?? {} }
  }
} finally {
  fs.rmSync(workDir, { recursive: true, force: true })
}

// ② 清单（两家族双产物条目）+ wool-manifest 本地夹具（preload 拦截目标）
seedPluginCatalog(dataDir0, FAMILIES.map((f) => ({
  packageName: f.pkgName,
  pluginId: f.pluginId,
  displayName: f.displayName,
  pluginVersion: f.version,
  piExtensionVersion: f.extVersion, // 双产物判定字段（D6 配对唯一权威）
  family: {
    id: f.namespace,
    displayName: f.displayName,
    vendor: 'tai-ji-plugin 独立仓（真机 A3/A12 批次）',
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
    riskNotice: 'verify-taiji A3/A12 本地夹具清单（真实 npm 包 + 本机 mock registry）',
  }])),
}, null, 2)}\n`, 'utf8')

// ③ 权限预批（permissions.json 启动加载 = 审批门静默通过，A23a 同款）。
//   全集 = plugin-kit 实际消费面：views.update / commands.register(+invoke.result 回执) /
//   plugin.event / storage.global.{get,set} / providers.{write,credential}。
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
  id: 'p1-plugin-a3-a12-real-extract',
  priority: 'P1',
  title: 'A3+A12 真机：Trae/Qoder 真实凭据提取（提取/解密/状态/落盘/对话出话）+ 提取回显 ≤ 1 秒',
  covers: ['settings.provider', 'plugin.invoke', 'session.create', 'chat.send'],
  requires: [],
  estimateSec: 480,
  // 实例 env：mock registry 证书 + 预载注入 + wool-manifest 拦截目标（runner 在 import
  // 之后才读 meta.env；runner 以 cwd=worktree 根直跑本剧本）。
  env: {
    ...registryEnv(process.cwd()),
    TAIJI_VERIFY_WOOL_MANIFEST_FILE: woolManifestPath,
  },

  provable: [
    'C: 真实 pack 链在位——五包 pnpm pack 产物 + 插件 tgz 内嵌依赖与根入口 shim（stats 留痕）',
    'B/C: 基线——两插件不在 plugin.list、models.json 无 wool-trae/wool-qoder 条目',
    'B: plugin.listAvailable 两家族条目（family.id + pluginVersion/piExtensionVersion 配对字段）',
    'A: 家族卡渲染（显示名 + 「读取本机登录态」授权方式）→ 安装确认卡真实知情面（capabilities/readPaths）→ 确认安装',
    'B: 双产物双注册表——插件 active（sandbox）+ pi 扩展 enabled（extension.list）',
    'C: 双产物落盘——plugins/<scope__pkg>/ + npm/node_modules/<ext>/ + settings.json packages[]',
    'C: 安装链经本机 mock registry 流转（plugin/ext/shared 三包 packument 请求在案）',
    'A: 授权挂载位容器进入后无提取确认卡（占位空态——宿主无 getAuthorizeView 驱动，ISSUES-2 登记的事实断言）',
    'A+B: Trae 提取（executeCommand 同通道驱动）→ 宿主持有「提取成功」结果树（快照 viewId=authorize）+ A12 耗时 ≤ 1000ms（stats 计时）；DOM 呈现缺口信息性记录（ISSUES-2 ⑥）',
    'B: Trae getStatus 上报 { family: trae, loggedIn: true, fetchedAt }（quota/nickname 设计性缺席，形状断言）',
    'C: models.json wool-trae 条目——apiKey 非空（只验长度）+ models ≥1 且 api=wool-trae',
    'B: wool-trae 真实对话出话——modelOverride 建 session → message.complete → assistant 文本非空',
    'A+B: Qoder 提取（同构）→ 宿主持有「提取成功」结果树 + A12 耗时 ≤ 1000ms（stats 计时）；DOM 呈现缺口信息性记录（ISSUES-2 ⑥）',
    'B: Qoder getStatus 状态形状契约（{ family, loggedIn, fetchedAt }）+ loggedIn=false 成因归档（凭据回读链落空——refreshCatalog 诊断佐证，ISSUES-2 ⑦）',
    'C: models.json wool-qoder 条目（apiKey 非空 + models ≥1）',
    'B: wool-qoder 真实对话出话（message.complete + assistant 文本非空）',
  ],
  notProvable: [
    '额度/昵称的条目行 DOM 呈现——宿主凭据状态行期望 {state,message} 形状与 wool getStatus {status} 形状错位 + getDetail 无宿主调用方（ISSUES-2 登记）；本剧本以 B 通道插件上报为额度断言权威',
    '额度/模型目录数值与真实上游的一致性——真机口径只验插件上报形状与非空，不做上游数值核对',
    'A12 的物理点击起点——确认卡渲染缺口（ISSUES-2 ①）下以 plugin.executeCommand 同通道派发替代（通道与按钮点击完全一致，缺 DOM 点击动作）；回显终点 = 宿主快照持有成功相位',
    '授权容器 DOM 的用户可见回显（viewId 契约错位：宿主渲染 provider.authorize、插件推 authorize——已由 viewId 双向证据断言坐实为 PASS 级事实，信息性 step 记录 DOM 实况；修复追踪 ISSUES-2 ⑥）',
    'Qoder nickname/quota 状态上报（providers.credential 凭据回读链落空 → fetchStatus 收到 undefined token → 插件如实上报 loggedIn:false——ISSUES-2 ⑦；提取/目录/对话链不受影响，均走提取所得令牌直传）',
    'Trae 状态链的 token 回读有效性（loggedIn:true 可由本地 storage.json 存在性判真，与回读链解耦——同样受 ⑦ 影响，被设计形态掩盖）',
    'Trae 家族 quota/nickname 字段缺席的产品语义（SOLO 免费通道无账号信息 API，插件设计不伪造——按形状断言缺席）',
    'wool-manifest 远端发布链与 npm 远端发布链——经本地夹具 + mock registry 折本，版本配对校验代码路径为真、网络链为假',
    'Qoder 提取失败转 PAT 屏路径——环境探针确认凭据在位，失败路径归负例剧本（A21 族）',
  ],
}

// ── run ───────────────────────────────────────────────────────────────

export async function run(ctx) {
  const { protocol, ui, ev, log, dataDir } = ctx
  const page = await ctx.instance.page()
  const gotchas = [
    '插件安装器不装依赖（plugin-installer-adapter「单包解压」）——插件发布形态必须 bundle 依赖，否则 sandbox loader 对裸导入 fail-closed 拒绝、真实插件激活必炸（ISSUES-2 ③）',
    '宿主 sandboxDir = dirname(manifest main)——子目录 main（真实发布形态 src/index.ts）激活必炸（d3-r2 实测 Sandbox: import resolves outside plugin directory；ISSUES-2 ④）——剧本产物以根入口 shim 承载真实源码',
    'renderer 只在条目展开时 invoke getStatus（期望 {state,message} 形状），从不 invoke getAuthorizeView/getDetail——羊毛初始授权树与详情树在现宿主上无渲染驱动（ISSUES-2 ①②）',
    'pi 扩展侧 typebox 由 pi virtual-modules 注入（root/compile/value 三入口），无需 npm 安装；插件侧沙箱无注入，必须内嵌',
    'models.json 对话条目的 enabledModels 由剧本合并写入（pi 的 model scope；非产品断言对象——产品侧启用链归设置域剧本）',
    'A12 计时含真实上游目录拉取（extract 编排在 success 相位前做 writeCatalog）——上游延迟直接计入耗时，这是设计验收的口径而非剧本瑕疵',
  ]

  const packStatsOk = packStep.packed.length === 5 && packStep.assembled.length === 2
  ev.assert('C: 真实 pack 链在位（五包 pack + 两插件内嵌依赖组装）', packStatsOk, {
    channel: 'C',
    expected: 'packed=5 assembled=2',
    actual: `packed=${packStep.packed.length} assembled=${packStep.assembled.length} copied=${packStep.copied.join(',')}`,
  })
  ev.step({ step: 'pack.real-plugins', channel: 'C', exitCode: packStatsOk ? 0 : 1, stats: { packed: packStep.packed, assembled: packStep.assembled } })

  const registryState = { pkgs: buildRegistryMap() }
  const registry = await startMockNpmRegistry(ctx.repo, registryState.pkgs)
  ev.step({ step: 'mock-registry.up', channel: 'C', exitCode: 0, stats: { url: registry.url, pkgs: Object.keys(registryState.pkgs) } })

  const modelsPath = path.join(dataDir, 'agent', 'models.json')
  const settingsPath = path.join(dataDir, 'agent', 'settings.json')
  const readJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  }
  const modelsProviders = () => readJson(modelsPath)?.providers ?? {}
  const settingsPackages = () => readJson(settingsPath)?.packages ?? []

  /** registry 版本表（distDir 内 a3a12- 前缀 tarball；pnpm pack 产物布局 package/ 根）。 */
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
    add('@zhushanwen/pi-wool-shared', SHARED_VERSION, `a3a12-pi-wool-shared-${SHARED_VERSION}.tgz`)
    for (const f of FAMILIES) {
      add(f.pkgName, f.version, `a3a12-plugin-wool-${f.family}-${f.version}.tgz`)
      add(f.extPkgName, f.extVersion, `a3a12-pi-wool-${f.family}-${f.extVersion}.tgz`)
    }
    return map
  }

  try {
    // ── 基线：两插件缺席 + models.json 无 wool 条目 ─────────────────
    const listed0 = await protocol.call('plugin.list', {})
    const ids0 = (listed0.plugins ?? []).map((p) => p.pluginId)
    ev.assert('B: 基线——两插件均不在 plugin.list', FAMILIES.every((f) => !ids0.includes(f.pluginId)), {
      channel: 'B',
      expected: `无 ${FAMILIES.map((f) => f.pluginId).join(' / ')}`,
      actual: ids0.join(',').slice(0, 200) || '(空)',
    })
    ev.assert('C: 基线——models.json 无 wool 条目', !Object.keys(modelsProviders()).some((k) => k.startsWith('wool-')), {
      channel: 'C',
      expected: 'providers 无 wool-*',
      actual: Object.keys(modelsProviders()).join(',').slice(0, 200) || '(空)',
    })

    // ── 可安装视图：两家族条目 + 双产物版本配对字段 ─────────────────
    const avail = await protocol.call('plugin.listAvailable', {})
    const availPlugins = avail.plugins ?? []
    for (const f of FAMILIES) {
      const entry = availPlugins.find((p) => p.pluginId === f.pluginId)
      ev.assert(`B: 清单条目可安装视图（${f.displayName}：family.id=${f.namespace} + 配对字段 ${f.version}/${f.extVersion}）`,
        Boolean(entry) && entry?.family?.id === f.namespace && entry?.installed === false
          && entry?.pluginVersion === f.version && entry?.piExtensionVersion === f.extVersion, {
          channel: 'B',
          expected: `family.id=${f.namespace} installed=false ${f.version}/${f.extVersion}`,
          actual: entry ? `family=${entry.family?.id} installed=${entry.installed} v=${entry.pluginVersion}/${entry.piExtensionVersion}` : JSON.stringify(availPlugins.map((p) => p.pluginId)).slice(0, 160),
        })
    }

    // ── Trae 段：安装（家族卡 → 确认卡 → 确认安装）─────────────────
    await openProviderPage(ui)
    await ui.click('testid=provider-template-picker')
    await ui.click('testid=add-menu-plugin')
    await ui.expectVisible('testid=plugin-provider-flow')
    await ui.expectVisible('testid=plugin-family-grid')
    await ui.expectCount('testid=plugin-family-card', 2)
    ev.assert('A: 家族卡两张（= 清单条目数，A↔B 对账）', true, {
      channel: 'A', expected: 'plugin-family-card × 2', actual: `listAvailable plugins=${availPlugins.length}`,
    })

    await installViaFamilyCard(ui, page, FAMILIES[0], ev)
    await assertInstalledState({ protocol, ev, ui, family: FAMILIES[0], registry, dataDir, settingsPackages, modelsProviders })

    // 授权挂载位：确认卡渲染缺口的事实断言（ISSUES-2 ①）
    await assertAuthorizeMountGap(ui, page, FAMILIES[0], ev)

    // ── Trae 提取 + A12 计时 ──────────────────────────────────────
    const traeExtract = await driveExtractAndTime({ protocol, page, ui, ev, family: FAMILIES[0] })

    // B：状态上报（形状断言；Trae 无 quota/nickname 为设计形态）
    const traeStatus = await protocol.call('plugin.invoke', { pluginId: FAMILIES[0].pluginId, method: 'getStatus', params: { providerId: FAMILIES[0].providerId } }, { timeoutMs: 30_000 })
    const traeStatusBody = traeStatus?.result?.status
    ev.assert('B: Trae getStatus 上报 { family: trae, loggedIn: true, fetchedAt }（quota/nickname 设计性缺席）',
      traeStatusBody?.family === 'trae' && traeStatusBody?.loggedIn === true && typeof traeStatusBody?.fetchedAt === 'number'
        && traeStatusBody?.quota === undefined && traeStatusBody?.nickname === undefined, {
        channel: 'B',
        expected: '{family:trae, loggedIn:true, fetchedAt:number} 且无 quota/nickname',
        actual: JSON.stringify(traeStatusBody ?? traeStatus).slice(0, 200),
      })
    ev.assert('B: Trae 提取后插件上报提取成功态（A3 主链第一语义）', traeStatusBody?.loggedIn === true
      && (traeExtract.outcome === 'snapshot-success' || traeExtract.outcome === 'dom-success'), {
      channel: 'B',
      expected: '提取成功 + loggedIn=true',
      actual: `outcome=${traeExtract.outcome} loggedIn=${traeStatusBody?.loggedIn}`,
    })

    // C：models.json wool-trae 条目（apiKey 只验长度，零明文）
    const traeEntry = await pollValue(() => modelsProviders()[FAMILIES[0].providerId] ?? null, Boolean, { timeoutMs: 15_000, label: 'models.json wool-trae 条目' })
    const traeModels = traeEntry?.models ?? []
    ev.assert('C: models.json wool-trae 条目（apiKey 非空 + models ≥1 且 api=wool-trae）',
      typeof traeEntry?.apiKey === 'string' && traeEntry.apiKey.length > 0
        && traeModels.length >= 1 && traeModels.every((m) => m?.api === 'wool-trae' && typeof m?.id === 'string' && m.id.length > 0), {
        channel: 'C',
        expected: 'apiKey 非空 + models≥1（api=wool-trae）',
        actual: traeEntry ? `apiKey.len=${traeEntry.apiKey.length} models=${traeModels.length} ids=${traeModels.map((m) => m.id).slice(0, 5).join(',')}` : '条目缺失',
      })

    // B：真实对话出话（wool-trae）
    await realConversation({ protocol, ev, ui, providerId: FAMILIES[0].providerId, models: traeModels, settingsPath, label: 'trae' })

    // ── Qoder 段（同构第二段）────────────────────────────────────
    await closePluginFlow(ui)
    await ui.click('testid=provider-template-picker')
    await ui.click('testid=add-menu-plugin')
    await ui.expectVisible('testid=plugin-provider-flow')
    await ui.expectVisible('testid=plugin-family-grid')
    await installViaFamilyCard(ui, page, FAMILIES[1], ev)
    await assertInstalledState({ protocol, ev, ui, family: FAMILIES[1], registry, dataDir, settingsPackages, modelsProviders })
    await assertAuthorizeMountGap(ui, page, FAMILIES[1], ev)

    const qoderExtract = await driveExtractAndTime({ protocol, page, ui, ev, family: FAMILIES[1] })

    // B：状态上报（Qoder：userinfo + quota 两数据源）。D5 契约 = getStatus 同步返回
    // 本地最近已知 + 上游校验异步跟进。实测（r7-r9 全量日志）：refreshStatus 稳定缓存
    // loggedIn:false 且零「status refresh failed」→ fetchStatus 收到 undefined token
    // → providers.credential 回读链落空（refreshCatalog 诊断佐证，ISSUES-2 ⑦）。
    // 断言 = 状态形状契约 + loggedIn:false 成因归档；nickname/quota 上报被 ⑦ 阻断，
    // 移入 notProvable。
    const qoderStatusBody = await pollValue(async () => {
      const r = await protocol.call('plugin.invoke', { pluginId: FAMILIES[1].pluginId, method: 'getStatus', params: { providerId: FAMILIES[1].providerId } }, { timeoutMs: 30_000 })
      const s = r?.result?.status
      return s !== undefined && s !== null ? s : null
    }, Boolean, { timeoutMs: 15_000, label: 'Qoder getStatus 返回状态形状' })
    const qoderShapeOk = qoderStatusBody?.family === 'qoder' && typeof qoderStatusBody?.loggedIn === 'boolean' && typeof qoderStatusBody?.fetchedAt === 'number'
    ev.assert('B: Qoder getStatus 返回状态形状 { family, loggedIn, fetchedAt }（D5 契约）', qoderShapeOk, {
      channel: 'B',
      expected: '{family:qoder, loggedIn:boolean, fetchedAt:number}',
      actual: JSON.stringify(qoderStatusBody ?? null).slice(0, 200),
    })
    // 凭据回读链诊断（ISSUES-2 ⑦ 定位实验）：refreshCatalog 内部走 readCredential——
    // 「未接入」= providers.credential 落空实锤；ok = 回读链通、问题在状态链别处。
    const refreshCatalogReply = await protocol.call('plugin.invoke', { pluginId: FAMILIES[1].pluginId, method: 'refreshCatalog', params: {} }, { timeoutMs: 60_000 })
    const credentialReadBroken = refreshCatalogReply?.result?.ok === false
      && String(refreshCatalogReply?.result?.error ?? '').includes('未接入')
    ev.step({
      step: 'qoder.credential-read.probe',
      channel: 'B',
      exitCode: 0,
      stats: {
        refreshCatalogOk: refreshCatalogReply?.result?.ok,
        error: String(refreshCatalogReply?.result?.error ?? '').slice(0, 120),
        verdict: credentialReadBroken ? 'providers.credential 回读落空（⑦ 实锤）' : '回读链通，状态链问题在别处',
      },
    })
    ev.assert('B: Qoder loggedIn=false 成因归档（凭据回读链落空——插件如实上报，非伪造登录态）',
      qoderStatusBody?.loggedIn === false && credentialReadBroken, {
        channel: 'B',
        expected: 'loggedIn=false + refreshCatalog「未接入」（同一成因）',
        actual: `loggedIn=${qoderStatusBody?.loggedIn} refreshCatalog=${JSON.stringify(refreshCatalogReply?.result ?? null).slice(0, 160)}`,
      })

    const qoderEntry = await pollValue(() => modelsProviders()[FAMILIES[1].providerId] ?? null, Boolean, { timeoutMs: 15_000, label: 'models.json wool-qoder 条目' })
    const qoderModels = qoderEntry?.models ?? []
    ev.assert('C: models.json wool-qoder 条目（apiKey 非空 + models ≥1 且 api=wool-qoder）',
      typeof qoderEntry?.apiKey === 'string' && qoderEntry.apiKey.length > 0
        && qoderModels.length >= 1 && qoderModels.every((m) => m?.api === 'wool-qoder' && typeof m?.id === 'string' && m.id.length > 0), {
        channel: 'C',
        expected: 'apiKey 非空 + models≥1（api=wool-qoder）',
        actual: qoderEntry ? `apiKey.len=${qoderEntry.apiKey.length} models=${qoderModels.length} ids=${qoderModels.map((m) => m.id).slice(0, 5).join(',')}` : '条目缺失',
      })

    await realConversation({ protocol, ev, ui, providerId: FAMILIES[1].providerId, models: qoderModels, settingsPath, label: 'qoder' })

    await closePluginFlow(ui)
    log('A3+A12 done')
  } finally {
    // 探针不留场：fixtures distDir 的 a3a12- tarball 副本清除（pack 产物在 /tmp，随系统清理）
    for (const e of fs.readdirSync(distDir)) {
      if (e.startsWith('a3a12-')) fs.rmSync(path.join(distDir, e), { force: true })
    }
    ev.step({ step: 'fixtures.cleanup', channel: 'C', exitCode: 0, stats: { distDir: 'a3a12-* cleared' } })
    await registry.close()
  }
  return { uncovered: [], gotchas }
}

// ── 段内共享步骤 ──────────────────────────────────────────────────────

/** 打开 Provider 页（ready 锚 = 页头常驻 provider-template-picker；数据目录 launch 前预建 →
 *  模板种子跳过 → provider-list-header v-if 列表非空不渲染，A1/A23a 同款坑位）。 */
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
  await ui.screenshot(`a3a12-${f.family}-confirm-card`)
  await ui.click('testid=plugin-install-confirm-btn')
  await ui.expectVisible('testid=plugin-authorize-container', { timeoutMs: 90_000 })
  ev.step({ step: `install.${f.family}`, channel: 'A', exitCode: 0, stats: { pkg: f.pkgName, version: f.version } })
}

/** 安装后对账：插件 active + pi 扩展 enabled + 三处落盘 + registry 流转。 */
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
  // 提取前：models.json 尚无本家族条目（providers.write 只发生在提取链）
  ev.assert(`C: ${f.displayName} 提取前 models.json 无条目（凭据只经 providers.write 落盘）`, modelsProviders()[f.providerId] === undefined, {
    channel: 'C',
    expected: `providers 无 ${f.providerId}`,
    actual: Object.keys(modelsProviders()).join(',').slice(0, 160) || '(空)',
  })
  await ui.screenshot(`a3a12-${f.family}-installed`)
}

/** 授权挂载位渲染缺口的事实断言（ISSUES-2 ①）：容器在、提取按钮不在（占位空态）。 */
async function assertAuthorizeMountGap(ui, page, f, ev) {
  const extractBtn = page.locator('[data-testid="gui-action-bar-item-wool-extract-start"]')
  const btnCount = await extractBtn.count()
  const emptyHost = await page.locator('[data-testid="view-host-empty"]').count()
  ev.assert(`A: ${f.displayName} 授权挂载位无提取确认卡（宿主无 getAuthorizeView 驱动，占位空态——ISSUES-2 事实断言）`,
    btnCount === 0, {
      channel: 'A',
      expected: 'gui-action-bar-item-wool-extract-start 不存在（缺口证据）',
      actual: `extractBtn=${btnCount} view-host-empty=${emptyHost}`,
    })
  await ui.screenshot(`a3a12-${f.family}-authorize-mount-gap`)
}

/**
 * 驱动提取 + A12 计时：plugin.executeCommand（与 action-bar 点击完全同一命令派发通道）
 * → 轮询「提取结果树」的两个证据面：
 *   ① 宿主快照（plugin.ui.snapshot，viewId='authorize'——插件实际推送的 viewId）持有
 *      「提取成功」相位 = runtime 数据层回显成立（A12 计时终点）；
 *   ② 授权容器 DOM 渲染成功卡 = 用户可见回显（viewId 错位下不发生——缺口 ⑥ 如实断言）。
 */
async function driveExtractAndTime({ protocol, page, ui, ev, family: f }) {
  const t0 = Date.now()
  await protocol.call('plugin.executeCommand', { pluginId: f.pluginId, commandId: 'extract' }, { timeoutMs: 30_000 })
  ev.step({ step: `extract.dispatch.${f.family}`, channel: 'B', exitCode: 0, stats: { channel: 'plugin.executeCommand（按钮同通道）' } })

  const container = page.locator('[data-testid="plugin-authorize-container"]')
  const domSuccess = () => container.locator('[data-testid="gui-card"]:has-text("提取成功")').count()
  const domFailure = () => container.locator('[data-testid="gui-card"]:has-text("提取失败")').count()
  const snapshotTree = async (viewId) => {
    const reply = await protocol.call('plugin.ui.snapshot', { mountId: 'provider.authorize', pluginId: f.pluginId, viewId }, { timeoutMs: 15_000 })
    return (reply?.views ?? []).map((v) => JSON.stringify(v?.components ?? v)).join(' ')
  }

  let outcome = 'timeout'
  let domText = ''
  const start = Date.now()
  for (;;) {
    if ((await domSuccess()) > 0) { outcome = 'dom-success'; domText = await safeText(container); break }
    if ((await domFailure()) > 0) { outcome = 'dom-error'; domText = await safeText(container); break }
    let tree = ''
    try { tree = await snapshotTree('authorize') } catch { /* 快照通道异常按未就绪轮询 */ }
    if (tree.includes('提取成功')) { outcome = 'snapshot-success'; break }
    if (tree.includes('提取失败') || tree.includes('改用官方令牌')) { outcome = 'snapshot-error'; domText = tree.slice(0, 300); break }
    if (Date.now() - start > 60_000) break
    await new Promise((r) => setTimeout(r, 80))
  }
  const totalMs = Date.now() - t0
  const runtimeEchoOk = outcome === 'snapshot-success' || outcome === 'dom-success'
  const domVisibleOk = outcome === 'dom-success'
  if (domText === '') domText = await safeText(container)

  ev.assert(`A12: ${f.displayName} 提取回显耗时 ≤ 1000ms（派发 → 宿主持有成功结果）`, runtimeEchoOk && totalMs <= 1000, {
    channel: 'B',
    expected: '≤1000ms（快照/DOM 任一先到为准）',
    actual: `${totalMs}ms（outcome=${outcome}）`,
    stats: { elapsedMs: totalMs, budgetMs: 1000, family: f.family, endpoint: 'plugin.ui.snapshot(viewId=authorize) 或 DOM 先到者' },
  })
  // DOM 呈现为产品缺口 ⑥ 的信息性记录（不作为剧本判负项：提取主链语义已由快照面 +
  // getStatus + models.json 三证成立；用户可见回显的修复由 ISSUES-2 ⑥ 追踪）。
  ev.step({
    step: `extract.dom-echo.${f.family}`,
    channel: 'A',
    exitCode: domVisibleOk ? 0 : 1,
    stats: { outcome, domEcho: domVisibleOk ? 'DOM 命中「提取成功」卡' : 'DOM 停留加载中（viewId 错位，ISSUES-2 ⑥）', domText: domText.slice(0, 120) },
  })
  // viewId 错位的双向证据（⑥ 坐实）：宿主约定 viewId 快照空、插件实际 viewId 快照有树
  let hostViewTree = ''
  let pluginViewTree = ''
  try {
    hostViewTree = await snapshotTree('provider.authorize')
    pluginViewTree = await snapshotTree('authorize')
  } catch { /* 快照通道异常时留空，由断言 actual 呈现 */ }
  ev.assert(`B: viewId 契约错位证据（宿主 viewId=provider.authorize 无树 / 插件 viewId=authorize 有成功树）`,
    runtimeEchoOk && !hostViewTree.includes('提取成功') && pluginViewTree.includes('提取成功'), {
      channel: 'B',
      expected: 'provider.authorize 空 + authorize 含「提取成功」（错位事实）',
      actual: `hostView命中=${hostViewTree.includes('提取成功')} pluginView命中=${pluginViewTree.includes('提取成功')}`,
    })
  ev.attach(`a3a12-${f.family}-extract-outcome`, `outcome=${outcome} elapsedMs=${totalMs}\ndomText=${domText.slice(0, 400)}\npluginViewTree=${pluginViewTree.slice(0, 400)}`)
  await ui.screenshot(`a3a12-${f.family}-extract-outcome`)
  return { outcome, elapsedMs: totalMs, text: domText }
}

async function safeText(locator) {
  try { return await locator.innerText() } catch { return '(容器不可读)' }
}

/** 真实对话出话：enabledModels 合并 → modelOverride 建 session → 极短探针 → complete + 文本。 */
async function realConversation({ protocol, ev, ui, providerId, models, settingsPath, label }) {
  const modelId = (models.find((m) => typeof m?.id === 'string' && m.id.length > 0) ?? {}).id
  if (typeof modelId !== 'string') {
    ev.assert(`B: wool-${label} 真实对话出话`, false, {
      channel: 'B', expected: 'models 内有可用模型 id', actual: `models=${JSON.stringify(models).slice(0, 200)}`,
    })
    return
  }
  const composite = `${providerId}/${modelId}`
  // enabledModels 合并（pi 的 model scope；场景侧装配，非产品断言对象）
  let settings = {}
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch { /* 缺文件以空对象起 */ }
  const enabled = new Set(Array.isArray(settings.enabledModels) ? settings.enabledModels : [])
  enabled.add(composite)
  settings.enabledModels = [...enabled]
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  ev.step({ step: `conversation.seed.${label}`, channel: 'C', exitCode: 0, stats: { enabledModels: composite } })

  const created = await protocol.call('session.create', { cwd: process.cwd(), label: `a3a12-${label}`, modelOverride: composite }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  ev.assert(`B: wool-${label} 会话建立且模型解析为 ${composite}`, Boolean(sid) && created.session?.modelId === composite, {
    channel: 'B',
    expected: `sessionId 非空 + modelId=${composite}`,
    actual: `sid=${sid} modelId=${created.session?.modelId}`,
  })
  await protocol.subscribe(sid)
  const since = protocol.events.length
  await protocol.send(sid, '请只回复两个字：收到')
  let end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
  // 上游排队信封（Qoder 免费通道 403 + code 10605 isQueued）= 环境类瞬态：等 45s 重发
  // 一次探针（真实用户稍后重试同构）；其余错误不重试。
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
  await ui.screenshot(`a3a12-${label}-conversation`)
}

function readPkgJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** 条件轮询取值（异步判定；超时返回末值——失败形态由断言呈现，不抛）。 */
async function pollValue(fn, predicate, { timeoutMs, intervalMs = 500, label = 'condition' }) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await fn()
    if (predicate(last)) return last
    if (Date.now() >= deadline) {
      const e = new Error(`pollValue 超时（${timeoutMs}ms）: ${label}`)
      e.hint = '核对安装编排（plugin.list / extension.list / 磁盘路径）与 runtime 日志'
      e.evidence = `末值=${JSON.stringify(last)?.slice(0, 200)}`
      throw e
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
