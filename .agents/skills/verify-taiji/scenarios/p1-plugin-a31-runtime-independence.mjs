/**
 * p1-plugin-a31-runtime-independence —— D3 验收 A31（设计 S24/P-wool-runtime）：羊毛管理
 * 逻辑在插件 fork 进程内完整跑通（无 pi 运行时参与），Trae + Qoder 两段（WorkBuddy 按
 * 用户指示跳过，留待其窗口期）。
 *
 * 语义与形态裁决（源码已核）：
 *   - 插件命令本就在插件 fork 内执行（A3 已隐式覆盖「在插件进程内跑」）；A31 的增量
 *     验证点 = 不依赖 pi 会话/运行时。机制事实：pi 进程 spawn 的唯一入口是
 *     PiProcessManager.createSession（process-manager.ts「createSession 是 pi 进程
 *     spawn 的唯一入口」锚），wool 三管理方法（extract/getStatus/refreshCatalog）在
 *     plugin-kit 骨架内只消费宿主 API（api.providers/commands/views/storage/events，
 *     全部走插件 fork IPC），无一触达 pi。
 *   - 独立性裁决形态 = 进程面断言（不采用「停掉 pi 会话」的破坏式形态——避免为「证明
 *     独立性」人为破坏环境）：本剧本不建任何会话跑三命令，ps 进程表检测器全程零 pi
 *     进程 + <dataDir>/ext-sessions/ 无新会话目录 + config.sessions 无新增；
 *   - 检测器有效性正向对照（防「空真」）：三命令跑完后以 wool 模型建一个控制会话
 *     （session.create → 检测器必须命中 ≥1 pi 进程 → session.delete → 收敛回零）——
 *     证明「检测器能看见 pi」本身成立，零命中断言因此有 teeth。控制会话零消息发送
 *     （上游真实对话 0 条）；
 *   - 插件进程正面证据：ps 进程表含 plugin-bootstrap fork 进程（plugin-host-process
 *     以 process.execPath + ELECTRON_RUN_AS_NODE=1 fork plugin-bootstrap.cjs）。
 *
 * 装配（A3 全量双产物模板）：真实插件/扩展/共享库 pnpm pack + mock registry + wool-manifest
 * 本地夹具（preload 拦截）+ 权限预批 + GUI 家族卡安装链——控制会话需 pi 解析 wool 模型
 * （模型目录 api 字段 = wool-trae/wool-qoder 由 pi 扩展注册），故双产物必须。
 *
 * 凭据安全红线：apiKey 只验存在性与长度，证据零明文。
 *
 * 运行形态：runner 托管实例（import 阶段 pack + seed，先于 instance.launch——必须显式传
 * --run-id）。
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
import { closePluginFlow } from './lib/plugin-flow-helper.mjs'
import { resolveDataDirFromArgv } from './lib-plugin-fixtures.mjs'

// ── 常量（包名/版本以独立仓 package.json 为单一事实源，import 期读取）────────
const PLUGIN_REPO = '/Users/zhushanwen/Code/tai-ji-plugin-workspace/main'
const TYPEBOX_DIR = path.join(PLUGIN_REPO, 'node_modules', '.pnpm')
const PACK_TMP_DIR = path.join(os.tmpdir(), 'taiji-a31-pkgs')
const DIST_PREFIX = 'a31-'

/** 家族定义（双产物：插件 + pi 扩展；控制会话的 modelOverride 也按家族取）。 */
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
  f.pluginId = `${f.pkgName.split('/')[0].slice(1)}__${f.pkgName.split('/')[1]}` // safePluginDirName 同式
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

/** 从 pnpm store 目录构造 typebox tgz（package/ 根布局，npm pack 同形）。 */
function makeTypeboxTgz(typeboxDir, outPath, workDir) {
  const stage = path.join(workDir, 'typebox-pack')
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(path.join(stage, 'package'), { recursive: true })
  fs.cpSync(typeboxDir, path.join(stage, 'package'), { recursive: true, dereference: true })
  execFileSync('tar', ['czf', outPath, '-C', stage, 'package'])
  fs.rmSync(stage, { recursive: true, force: true })
}

// ── 顶层预置（import 阶段执行，先于 runner 的 instance.launch）────────
const dataDir0 = resolveDataDirFromArgv()

const distDir = path.join(pluginPkgsDir(process.cwd()), 'dist')
fs.mkdirSync(distDir, { recursive: true })
for (const e of fs.readdirSync(distDir)) {
  if (e.startsWith(DIST_PREFIX)) fs.rmSync(path.join(distDir, e), { force: true })
}
fs.rmSync(PACK_TMP_DIR, { recursive: true, force: true })
fs.mkdirSync(PACK_TMP_DIR, { recursive: true })
fs.mkdirSync(dataDir0, { recursive: true })
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a31-work-'))
const typeboxDir = findTypeboxDir()
const TYPEBOX_VERSION = JSON.parse(fs.readFileSync(path.join(typeboxDir, 'package.json'), 'utf8')).version

function readTgzPackageJson(tgzPath) {
  return JSON.parse(execFileSync('tar', ['-xzOf', tgzPath, 'package/package.json'], { encoding: 'utf8' }))
}

const packStep = { packed: [], copied: [] }
const pkgExtraByCopyName = {}
try {
  const typeboxCopyName = `${DIST_PREFIX}typebox-${TYPEBOX_VERSION}.tgz`
  makeTypeboxTgz(typeboxDir, path.join(distDir, typeboxCopyName), workDir)
  packStep.copied.push(typeboxCopyName)

  const sharedTgzName = execFileSync('pnpm', ['pack', '--pack-destination', PACK_TMP_DIR], {
    cwd: SHARED_PKG_DIR, encoding: 'utf8',
  }).trim().split('\n').pop().trim()
  const sharedCopyName = `${DIST_PREFIX}pi-wool-shared-${SHARED_VERSION}.tgz`
  fs.copyFileSync(path.join(PACK_TMP_DIR, path.basename(sharedTgzName)), path.join(distDir, sharedCopyName))
  packStep.packed.push(`pi-wool-shared@${SHARED_VERSION}`)
  packStep.copied.push(sharedCopyName)
  pkgExtraByCopyName[sharedCopyName] = { dependencies: { typebox: TYPEBOX_VERSION } }

  for (const f of FAMILIES) {
    const packTgzName = execFileSync('pnpm', ['pack', '--pack-destination', PACK_TMP_DIR], {
      cwd: f.pkgDir, encoding: 'utf8',
    }).trim().split('\n').pop().trim()
    const assembledName = `${DIST_PREFIX}plugin-wool-${f.family}-${f.version}.tgz`
    fs.copyFileSync(path.join(PACK_TMP_DIR, path.basename(packTgzName)), path.join(distDir, assembledName))
    packStep.packed.push(`${f.pkgName}@${f.version}`)
    packStep.copied.push(assembledName)

    const extTgzName = execFileSync('pnpm', ['pack', '--pack-destination', PACK_TMP_DIR], {
      cwd: f.extPkgDir, encoding: 'utf8',
    }).trim().split('\n').pop().trim()
    const extCopyName = `${DIST_PREFIX}pi-wool-${f.family}-${f.extVersion}.tgz`
    fs.copyFileSync(path.join(PACK_TMP_DIR, path.basename(extTgzName)), path.join(distDir, extCopyName))
    packStep.packed.push(`${f.extPkgName}@${f.extVersion}`)
    packStep.copied.push(extCopyName)
    pkgExtraByCopyName[extCopyName] = { dependencies: readTgzPackageJson(path.join(PACK_TMP_DIR, path.basename(extTgzName))).dependencies ?? {} }
  }
} finally {
  fs.rmSync(workDir, { recursive: true, force: true })
}

// 清单（两家族双产物条目）+ wool-manifest 本地夹具（preload 拦截目标，双产物安装链消费）
seedPluginCatalog(dataDir0, FAMILIES.map((f) => ({
  packageName: f.pkgName,
  pluginId: f.pluginId,
  displayName: f.displayName,
  pluginVersion: f.version,
  piExtensionVersion: f.extVersion,
  family: {
    id: f.namespace,
    displayName: f.displayName,
    vendor: 'tai-ji-plugin 独立仓（真机 A31 批次）',
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
    riskNotice: 'verify-taiji A31 本地夹具清单（真实 npm 包 + 本机 mock registry）',
  }])),
}, null, 2)}\n`, 'utf8')

// 权限预批（审批门静默通过）
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

// ── pi 进程检测器（ps 进程表；signature 只记进程行片段，供对照归零）──

/** ps 全表行（pid + command）。 */
function psLines() {
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 15_000 })
    .split('\n').map((l) => l.trim()).filter(Boolean)
}

/**
 * pi 可执行文件候选路径集（与 runtime find-pi-executable 探测序同源镜像）：
 * dev 模式优先 <repo>/apps/electron/resources/pi/pi-<plat>-<arch>（prepare-pi-resources
 * 产物，runtime 实际 spawn 的就是它），回退 which pi → nvm → 常见位置。检测器按「行内
 * 含任一候选」匹配——a31-r1 实测教训：只匹配 which pi 会对 dev resources pi 恒零命中
 * （检测器空真被正向对照当场证伪，正是对照存在的意义）。
 */
function resolvePiCandidates(repo) {
  const candidates = []
  const devPi = path.join(repo, 'apps', 'electron', 'resources', 'pi', `pi-${process.platform}-${process.arch}`)
  if (fs.existsSync(devPi)) candidates.push(devPi)
  try {
    const out = execFileSync('which', ['pi'], { encoding: 'utf8', timeout: 10_000 }).trim()
    if (out.length > 0) candidates.push(out)
  } catch { /* PATH 无 pi */ }
  try {
    const nvmVersions = path.join(os.homedir(), '.nvm', 'versions', 'node')
    for (const ver of fs.readdirSync(nvmVersions)) {
      const candidate = path.join(nvmVersions, ver, 'bin', 'pi')
      if (fs.existsSync(candidate)) candidates.push(candidate)
    }
  } catch { /* nvm 树不存在 */ }
  const localPi = '/usr/local/bin/pi'
  if (fs.existsSync(localPi)) candidates.push(localPi)
  if (candidates.length === 0) {
    throw new Error('pi 可执行文件定位失败（dev resources + which pi + nvm + /usr/local/bin 均空）——检测器无法建立，核对环境')
  }
  return candidates
}

/** pi 进程行（行内含任一候选路径；排除探测命令自身）。 */
function piProcessLines(lines, piCandidates) {
  return lines.filter((l) => piCandidates.some((p) => l.includes(p)) && !l.includes('which pi') && !l.includes('ps -axo'))
}

/** 插件宿主 fork 进程行（plugin-bootstrap.cjs 标识）。 */
function pluginBootstrapLines(lines) {
  return lines.filter((l) => l.includes('plugin-bootstrap'))
}

// ── meta ──────────────────────────────────────────────────────────────

export const meta = {
  id: 'p1-plugin-a31-runtime-independence',
  priority: 'P1',
  title: 'A31 真机：羊毛管理方法（extract/getStatus/refreshCatalog）在插件 fork 内跑通且零 pi 运行时依赖（Trae + Qoder 双段，含检测器正向对照）',
  covers: ['plugin.invoke', 'settings.provider'],
  requires: [],
  estimateSec: 600,
  env: {
    ...registryEnv(process.cwd()),
    TAIJI_VERIFY_WOOL_MANIFEST_FILE: woolManifestPath,
  },
  provable: [
    'C: 真实 pack 链在位——五包 pnpm pack 产物 + typebox 备料（全 A3 双产物模板）',
    'B: 两家族清单条目可安装视图（family.id + 双产物配对字段）',
    'A: 家族卡 → 安装确认卡知情面 → 确认安装 → 授权挂载位提取确认卡渲染（两家族）',
    'C: 双产物落盘——pluginDir/node_modules（shared+typebox）+ pi 扩展 npm 布局 + settings.json packages[]（两家族）',
    'C: A31 基线——三命令前零 pi 进程（ps 检测器）+ config.sessions 无新增 + ext-sessions 无目录',
    'A+B: Trae 三命令零 pi 依赖跑通——extract 成功（DOM/快照）→ getStatus {state:valid} → refreshCatalog 非「未接入」；每命令后 ps 检测器仍零 pi',
    'A+B: Qoder 三命令零 pi 依赖跑通——extract 成功 → getStatus {state,message?} → refreshCatalog 非「未接入」；每命令后 ps 检测器仍零 pi',
    'B: wool-trae / wool-qoder models.json 条目在位（apiKey 非空 + models ≥1；零会话前提下的目录写回）',
    'C: 插件进程正面证据——ps 含 plugin-bootstrap fork 进程（管理方法在插件进程执行的进程表实证）',
    'B: 检测器正向对照——控制会话（wool 模型，零消息）建立时检测器命中 ≥1 pi 进程，session.delete 后收敛回零（零命中断言因此有 teeth）',
  ],
  notProvable: [
    '插件 fork IPC 通道的逐调用观测——管理方法对宿主 API 的依赖判定以 plugin-kit 源码（只消费 api.providers/commands/views/storage/events）+ 沙箱 fork 进程存在性承载，不逐帧审计 IPC',
    'Qoder getStatus 的 loggedIn 瞬时值——上游校验依赖当刻 userinfo/quota 可达性，形状断言不定死 valid/invalid（与 A3 同口径）',
    'refreshCatalog 上游目录内容与官方目录的一致性——真机口径只验回读链通（非「未接入」）与条目写回，不做目录逐项核对',
    'WorkBuddy 家族——按用户指示跳过，留待其窗口期',
  ],
}

// ── run ───────────────────────────────────────────────────────────────

export async function run(ctx) {
  const { protocol, ui, ev, log, dataDir } = ctx
  const page = await ctx.instance.page()
  const gotchas = [
    '独立性裁决形态 = 进程面：pi spawn 唯一入口是 createSession（process-manager.ts 锚点）——零会话 + ps 检测器零 pi 贯穿三命令即「无 pi 运行时依赖」的机制性证明；检测器有效性由控制会话正向对照兜底（防「空真」）',
    '不采用「停掉 pi 会话」破坏式形态——避免为证明独立性人为破坏环境（SKILL §1.3 mock pi 置换属进程级伪造通道，本断言不需要）',
    '控制会话零消息发送：session.create 只验证「wool 模型可解析出 pi 进程」，不产生上游真实对话消耗',
    'ext-sessions 孤儿目录有 runtime 侧清理链（logger.ts 孤儿清扫）；断言口径 = 三命令窗口内无新增会话目录',
  ]

  const packStatsOk = packStep.packed.length === 5 && packStep.copied.length === 6
  ev.assert('C: 真实 pack 链在位（五包 pack 原始产物 + typebox 备料）', packStatsOk, {
    channel: 'C',
    expected: 'packed=5 copied=6',
    actual: `packed=${packStep.packed.length} copied=${packStep.copied.join(',')}`,
  })
  ev.step({ step: 'pack.real-plugins', channel: 'C', exitCode: packStatsOk ? 0 : 1, stats: { packed: packStep.packed } })

  const registryState = { pkgs: buildRegistryMap() }
  const registry = await startMockNpmRegistry(ctx.repo, registryState.pkgs)
  ev.step({ step: 'mock-registry.up', channel: 'C', exitCode: 0, stats: { url: registry.url, pkgs: Object.keys(registryState.pkgs) } })

  const modelsPath = path.join(dataDir, 'agent', 'models.json')
  const settingsPath = path.join(dataDir, 'agent', 'settings.json')
  const extSessionsDir = path.join(dataDir, 'ext-sessions')
  const readJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  }
  const modelsProviders = () => readJson(modelsPath)?.providers ?? {}

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
    add('typebox', TYPEBOX_VERSION, `${DIST_PREFIX}typebox-${TYPEBOX_VERSION}.tgz`)
    add('@zhushanwen/pi-wool-shared', SHARED_VERSION, `${DIST_PREFIX}pi-wool-shared-${SHARED_VERSION}.tgz`)
    for (const f of FAMILIES) {
      add(f.pkgName, f.version, `${DIST_PREFIX}plugin-wool-${f.family}-${f.version}.tgz`)
      add(f.extPkgName, f.extVersion, `${DIST_PREFIX}pi-wool-${f.family}-${f.extVersion}.tgz`)
    }
    return map
  }

  const piCandidates = resolvePiCandidates(ctx.repo)

  /**
   * 零 pi 断言点（基线/每命令后复用）。requireBootstrap：插件 fork 进程只在安装后存在——
   * 基线点（安装前）只断言 pi=0；命令后各点断言 pi=0 + plugin-bootstrap fork 在位
   * （管理方法在插件进程执行的进程表实证）。
   */
  function assertNoPi(label, { requireBootstrap = true } = {}) {
    const lines = psLines()
    const pi = piProcessLines(lines, piCandidates)
    const bootstrap = pluginBootstrapLines(lines)
    const ok = pi.length === 0 && (!requireBootstrap || bootstrap.length > 0)
    ev.assert(`C: A31 进程面（${label}）`, ok, {
      channel: 'C',
      expected: requireBootstrap
        ? `pi 进程=0（candidates=${piCandidates.length} 个）+ plugin-bootstrap fork ≥1`
        : `pi 进程=0（candidates=${piCandidates.length} 个）`,
      actual: `pi=${pi.length} bootstrap=${bootstrap.length}${pi.length > 0 ? ` piPids=${pi.map((l) => l.split(/\s+/)[0]).slice(0, 5).join(',')}` : ''}`,
    })
    return { piCount: pi.length, bootstrapCount: bootstrap.length }
  }

  /** ext-sessions 会话目录数。 */
  const extSessionDirCount = () => {
    try { return fs.readdirSync(extSessionsDir).length } catch { return 0 }
  }

  try {
    // ── 可安装视图 ─────────────────────────────────────────────────
    const avail = await protocol.call('plugin.listAvailable', {})
    const availPlugins = avail.plugins ?? []
    for (const f of FAMILIES) {
      const entry = availPlugins.find((p) => p.pluginId === f.pluginId)
      ev.assert(`B: 清单条目可安装视图（${f.displayName}：family.id=${f.namespace} + 配对字段）`,
        Boolean(entry) && entry?.family?.id === f.namespace && entry?.installed === false
          && entry?.pluginVersion === f.version && entry?.piExtensionVersion === f.extVersion, {
          channel: 'B',
          expected: `family.id=${f.namespace} installed=false ${f.version}/${f.extVersion}`,
          actual: entry ? `family=${entry.family?.id} installed=${entry.installed} v=${entry.pluginVersion}/${entry.piExtensionVersion}` : JSON.stringify(availPlugins.map((p) => p.pluginId)).slice(0, 160),
        })
    }

    // ── A31 基线：零 pi + 零会话 ──────────────────────────────────
    const sessions0 = await protocol.call('config.sessions', {})
    const baselineSessionCount = (sessions0.groups ?? []).length
    const baselineExtSessionDirs = extSessionDirCount()
    ev.step({
      step: 'a31.baseline',
      channel: 'C',
      exitCode: 0,
      stats: {
        piCandidates: piCandidates.map((p) => path.basename(p)).join(','),
        sessions: baselineSessionCount,
        extSessionDirs: baselineExtSessionDirs,
      },
    })
    assertNoPi('基线（三命令前，插件未安装——只断言零 pi）', { requireBootstrap: false })

    // ── 两家族轮次：安装 → 三命令零 pi → 落盘对账 ─────────────────
    const familyResults = []
    for (const [fIdx, f] of FAMILIES.entries()) {
      // 逐家族基线（前一家族的控制会话会在 ext-sessions 留会话目录——会话删除不清
      // 历史目录，家族窗口内零新增才是本断言语义）
      const familyExtBaseline = extSessionDirCount()
      await openProviderPage(ui)
      await ui.click('testid=provider-template-picker')
      await ui.click('testid=add-menu-plugin')
      await ui.expectVisible('testid=plugin-provider-flow')
      await ui.expectVisible('testid=plugin-family-grid')
      await installViaFamilyCard(ui, page, f, ev)

      // 安装后对账（双产物）
      const listed = await pollValue(
        async () => {
          const r = await protocol.call('plugin.list', {})
          return (r.plugins ?? []).find((p) => p.pluginId === f.pluginId) ?? null
        },
        (info) => Boolean(info && info.status === 'active'),
        { timeoutMs: 30_000, label: `插件 ${f.pluginId} active` },
      )
      ev.assert(`B: ${f.displayName} 插件已激活（status=active，sandbox）`, listed?.status === 'active' && listed?.trustLevel === 'sandbox', {
        channel: 'B',
        expected: 'status=active trustLevel=sandbox',
        actual: listed ? `status=${listed.status} trust=${listed.trustLevel}` : '插件不在列表',
      })
      const extListed = await pollValue(
        async () => {
          const r = await protocol.call('extension.list', {})
          return (r.extensions ?? []).find((e) => e.name === f.extPkgName) ?? null
        },
        (info) => Boolean(info && info.enabled),
        { timeoutMs: 30_000, label: `pi 扩展 ${f.extPkgName} enabled` },
      )
      ev.assert(`B: ${f.displayName} pi 扩展已注册且 enabled（双产物；控制会话模型解析依赖）`, Boolean(extListed?.enabled), {
        channel: 'B',
        expected: `${f.extPkgName} enabled=true`,
        actual: extListed ? `v${extListed.version} enabled=${extListed.enabled}` : '扩展不在列表',
      })
      const pluginPkg = readJson(path.join(dataDir, 'plugins', f.pluginId, 'package.json'))
      const extPkg = readJson(path.join(dataDir, 'npm', 'node_modules', ...f.extPkgName.split('/'), 'package.json'))
      const sharedInstalled = readJson(path.join(dataDir, 'plugins', f.pluginId, 'node_modules', '@zhushanwen', 'pi-wool-shared', 'package.json'))
      ev.assert(`C: ${f.displayName} 双产物落盘（插件目录同源 + node_modules shared + pi 扩展 npm 布局）`,
        pluginPkg?.name === f.pkgName && pluginPkg?.taijiPlugin?.namespace === f.namespace
          && sharedInstalled?.name === '@zhushanwen/pi-wool-shared'
          && extPkg?.name === f.extPkgName && extPkg?.version === f.extVersion, {
          channel: 'C',
          expected: `${f.pkgName} ns=${f.namespace} + shared@${SHARED_VERSION} + ${f.extPkgName}@${f.extVersion}`,
          actual: `plugin=${pluginPkg ? pluginPkg.name : '缺失'} shared=${sharedInstalled?.version ?? '缺失'} ext=${extPkg ? `${extPkg.name}@${extPkg.version}` : '缺失'}`,
        })

      // 授权挂载位渲染提取确认卡
      const extractBtn = page.locator('[data-testid="gui-action-bar-item-wool-extract-start"]')
      const btnCount = await extractBtn.count()
      const emptyHost = await page.locator('[data-testid="view-host-empty"]').count()
      ev.assert(`A: ${f.displayName} 授权挂载位渲染提取确认卡（getAuthorizeView 驱动 + viewId 对齐）`,
        btnCount > 0 && emptyHost === 0, {
          channel: 'A',
          expected: 'gui-action-bar-item-wool-extract-start 存在 + 无 view-host-empty 占位',
          actual: `extractBtn=${btnCount} view-host-empty=${emptyHost}`,
        })
      await ui.screenshot(`a31-${f.family}-authorize-mount`)

      // ── 命令 1/3：extract（executeCommand 同通道）── 零 pi 断言点 ──
      await protocol.call('plugin.executeCommand', { pluginId: f.pluginId, commandId: 'extract' }, { timeoutMs: 30_000 })
      const container = page.locator('[data-testid="plugin-authorize-container"]')
      const snapshotTree = async () => {
        const reply = await protocol.call('plugin.ui.snapshot', { mountId: 'provider.authorize', pluginId: f.pluginId, viewId: 'provider.authorize' }, { timeoutMs: 15_000 })
        return (reply?.views ?? []).map((v) => JSON.stringify(v?.components ?? v)).join(' ')
      }
      let outcome = 'timeout'
      const start = Date.now()
      for (;;) {
        if ((await container.locator('[data-testid="gui-card"]:has-text("提取成功")').count()) > 0) { outcome = 'dom-success'; break }
        if ((await container.locator('[data-testid="gui-card"]:has-text("提取失败")').count()) > 0) { outcome = 'dom-error'; break }
        let tree = ''
        try { tree = await snapshotTree() } catch { /* 未就绪轮询 */ }
        if (tree.includes('提取成功')) { outcome = 'snapshot-success'; break }
        if (tree.includes('提取失败')) { outcome = 'snapshot-error'; break }
        if (Date.now() - start > 60_000) break
        await new Promise((r) => setTimeout(r, 80))
      }
      ev.assert(`A+B: ${f.displayName} 命令 1/3 extract 零 pi 依赖跑通`, outcome === 'dom-success' || outcome === 'snapshot-success', {
        channel: 'A',
        expected: 'DOM/快照呈现「提取成功」',
        actual: `outcome=${outcome} elapsedMs=${Date.now() - start}`,
      })
      assertNoPi(`extract 后（${f.family}）`)

      // ── 命令 2/3：getStatus ── 零 pi 断言点 ───────────────────────
      const statusBody = (await protocol.call('plugin.invoke', { pluginId: f.pluginId, method: 'getStatus', params: { providerId: f.providerId } }, { timeoutMs: 30_000 }))?.result
      const shapeOk = f.family === 'trae'
        ? statusBody?.state === 'valid' && statusBody?.providerId === undefined
        : (statusBody?.state === 'valid' || statusBody?.state === 'invalid')
          && (statusBody?.message === undefined || typeof statusBody?.message === 'string')
      ev.assert(`B: ${f.displayName} 命令 2/3 getStatus 零 pi 依赖跑通（宿主契约形状）`, shapeOk, {
        channel: 'B',
        expected: f.family === 'trae' ? '{state:valid}（无素材 message 省略）' : '{state:valid|invalid, message?:string}',
        actual: JSON.stringify(statusBody ?? null).slice(0, 200),
      })
      assertNoPi(`getStatus 后（${f.family}）`)

      // ── 命令 3/3：refreshCatalog（回读链 + 真实上游）── 零 pi 断言点 ──
      const refreshReply = await protocol.call('plugin.invoke', { pluginId: f.pluginId, method: 'refreshCatalog', params: {} }, { timeoutMs: 60_000 })
      const refreshError = String(refreshReply?.result?.error ?? '')
      const credentialReadBroken = refreshReply?.result?.ok === false && refreshError.includes('未接入')
      ev.assert(`B: ${f.displayName} 命令 3/3 refreshCatalog 零 pi 依赖跑通（非「未接入」= 回读链通；上游环境类失败不判负）`,
        !credentialReadBroken, {
          channel: 'B',
          expected: 'ok=true，或 ok=false 但 error 非「未接入」',
          actual: `ok=${refreshReply?.result?.ok} error=${refreshError.slice(0, 120)}`,
        })
      const piAfterCommands = assertNoPi(`refreshCatalog 后（${f.family}）`)

      // 会话目录零新增（三命令窗口无 session 生命周期发生；基线 = 本家族轮次起点）
      const extDirsNow = extSessionDirCount()
      ev.assert(`C: ${f.displayName} 三命令窗口 ext-sessions 无新增会话目录`, extDirsNow === familyExtBaseline, {
        channel: 'C',
        expected: `${familyExtBaseline}（本家族基线值）`,
        actual: `${extDirsNow}`,
      })

      // models.json 条目（零会话前提下的目录写回）
      const entry = await pollValue(() => modelsProviders()[f.providerId] ?? null, Boolean, { timeoutMs: 15_000, label: `models.json ${f.providerId} 条目` })
      const models = entry?.models ?? []
      ev.assert(`B: ${f.displayName} models.json 条目（apiKey 非空 + models ≥1 且 api=wool-${f.family}）`,
        typeof entry?.apiKey === 'string' && entry.apiKey.length > 0
          && models.length >= 1 && models.every((m) => m?.api === `wool-${f.family}` && typeof m?.id === 'string' && m.id.length > 0), {
          channel: 'B',
          expected: `apiKey 非空 + models≥1（api=wool-${f.family}）`,
          actual: entry ? `apiKey.len=${entry.apiKey.length} models=${models.length}` : '条目缺失',
        })
      await ui.screenshot(`a31-${f.family}-three-commands`)

      // ── 检测器正向对照（防「空真」；零消息控制会话）────────────────
      const modelId = (models.find((m) => typeof m?.id === 'string' && m.id.length > 0) ?? {}).id
      if (typeof modelId !== 'string') {
        ev.assert(`B: ${f.displayName} 检测器正向对照（控制会话）`, false, {
          channel: 'B',
          expected: 'models 内有可用模型 id',
          actual: `models=${JSON.stringify(models).slice(0, 160)}`,
        })
      } else {
        const composite = `${f.providerId}/${modelId}`
        let settings = {}
        try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch { /* 缺文件以空对象起 */ }
        const enabled = new Set(Array.isArray(settings.enabledModels) ? settings.enabledModels : [])
        enabled.add(composite)
        settings.enabledModels = [...enabled]
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
        fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')

        const created = await protocol.call('session.create', { cwd: process.cwd(), label: `a31-${f.family}-control`, modelOverride: composite }, { timeoutMs: 120_000 })
        const sid = created.session?.id
        // 轮询等 pi 进程出现在进程表（create 链 await client.start() 后才回执，ps 可见性
        // 紧随其后；轮询 15s 只为吸收进程表采样时序差）
        const piDuringControl = await pollValue(
          () => piProcessLines(psLines(), piCandidates).length,
          (n) => n >= 1,
          { timeoutMs: 15_000, intervalMs: 500, label: '控制会话 pi 进程出现在进程表' },
        ).catch(() => 0)
        ev.assert(`B: ${f.displayName} 检测器正向对照——控制会话建立时检测器命中 ≥1 pi 进程（检测器非「空真」）`,
          Boolean(sid) && piDuringControl >= 1, {
            channel: 'B',
            expected: `sessionId 非空 + pi 进程 ≥1（candidates=${piCandidates.map((p) => path.basename(p)).join(',')}）`,
            actual: `sid=${sid} modelId=${created.session?.modelId} pi=${piDuringControl}`,
          })
        if (sid) {
          await protocol.call('session.delete', { sessionId: sid }, { timeoutMs: 30_000 }).catch(() => {})
          const converged = await pollValue(
            () => piProcessLines(psLines(), piCandidates).length,
            (n) => n === 0,
            { timeoutMs: 30_000, intervalMs: 1000, label: 'session.delete 后 pi 进程收敛回零' },
          ).catch(() => -1)
          ev.assert(`B: ${f.displayName} 控制会话删除后 pi 进程收敛回零`, converged === 0, {
            channel: 'B',
            expected: 'pi=0',
            actual: `pi=${converged}`,
          })
        }
      }

      familyResults.push({ family: f.family, outcome, piAfterCommands: piAfterCommands.piCount })
      await closePluginFlow(ui)
    }

    // 终态：会话列表回到基线（控制会话已删）
    const sessionsEnd = await protocol.call('config.sessions', {})
    ev.step({
      step: 'a31.summary',
      channel: 'C',
      exitCode: 0,
      stats: {
        families: familyResults.map((r) => `${r.family}:${r.outcome}/pi=${r.piAfterCommands}`).join(' | '),
        sessionsEnd: (sessionsEnd.groups ?? []).length,
        sessionsBaseline: baselineSessionCount,
      },
    })
    log('A31 done')
  } finally {
    for (const e of fs.readdirSync(distDir)) {
      if (e.startsWith(DIST_PREFIX)) fs.rmSync(path.join(distDir, e), { force: true })
    }
    ev.step({ step: 'fixtures.cleanup', channel: 'C', exitCode: 0, stats: { distDir: `${DIST_PREFIX}* cleared` } })
    await registry.close()
  }
  return { uncovered: [], gotchas }
}

// ── 段内共享步骤 ──────────────────────────────────────────────────────

/** 打开 Provider 页；控制会话会把 renderer 切去会话视图且可能有遮罩残留——失败时
 * Esc 清场重试（a31-r1 实测：控制会话后 sidebar-settings 点击被拦截超时）。 */
async function openProviderPage(ui) {
  for (let attempt = 1; ; attempt++) {
    if (attempt > 3) throw new Error('openProviderPage 三次重试失败——核对 renderer 视图状态（截图见 a31-nav-retry-*）')
    try {
      await ui.click('testid=sidebar-settings', { timeoutMs: 15_000 })
      await ui.expectVisible('testid=settings-nav-provider', { timeoutMs: 15_000 })
      await ui.click('testid=settings-nav-provider', { timeoutMs: 15_000 })
      await ui.expectVisible('testid=provider-template-picker', { timeoutMs: 15_000 })
      return
    } catch (e) {
      await ui.screenshot(`a31-nav-retry-${attempt}`).catch(() => {})
      await ui.press('Escape').catch(() => {})
      await new Promise((r) => setTimeout(r, 1_500))
      if (attempt === 3) throw e
    }
  }
}

/** 家族卡 → 安装确认卡（真实 manifest 知情面断言）→ 确认安装 → 授权容器。 */
async function installViaFamilyCard(ui, page, f, ev) {
  const cardSel = `css=[data-testid="plugin-family-card"]:has-text("${f.displayName}")`
  await ui.expectVisible(cardSel)
  await ui.click(cardSel)
  await ui.expectVisible('testid=plugin-install-confirm', { timeoutMs: 60_000 })
  const capsText = await ui.text('testid=plugin-confirm-capabilities')
  const readPathsText = await ui.text('testid=plugin-confirm-read-paths')
  ev.assert(`A: ${f.displayName} 安装确认卡真实知情面`, capsText.includes('network.http') && capsText.includes('fs.read-user-data') && readPathsText.includes(f.credentialFileKeyword), {
    channel: 'A',
    expected: `network.http + fs.read-user-data + readPaths 含 ${f.credentialFileKeyword}`,
    actual: `caps=${capsText.slice(0, 120)} readPaths=${readPathsText.slice(0, 140)}`,
  })
  await ui.screenshot(`a31-${f.family}-confirm-card`)
  await ui.click('testid=plugin-install-confirm-btn')
  await ui.expectVisible('testid=plugin-authorize-container', { timeoutMs: 90_000 })
  ev.step({ step: `install.${f.family}`, channel: 'A', exitCode: 0, stats: { pkg: f.pkgName, version: f.version } })
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}
const readJson = readJsonSafe

/** 条件轮询取值（异步判定；超时抛——调用方 catch 或由断言呈现）。 */
async function pollValue(fn, predicate, { timeoutMs, intervalMs = 500, label = 'condition' }) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await fn()
    if (predicate(last)) return last
    if (Date.now() >= deadline) {
      const e = new Error(`pollValue 超时（${timeoutMs}ms）: ${label}`)
      e.hint = '核对编排与 runtime 日志'
      e.evidence = `末值=${JSON.stringify(last)?.slice(0, 200)}`
      throw e
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
