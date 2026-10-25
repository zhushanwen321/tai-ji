/**
 * p1-plugin-a20-a4b-credential-audit —— D3 验收 A20（设计 S20 凭据受控回读正向）+ A4b
 * （凭据无第二落点观测：WS 帧审计 + 磁盘断言）合并剧本，Trae 段承载。
 *
 * 设计验收原文（S20）：「WorkBuddy 授权完成后，插件调 providers.credential 取凭据查额度。
 * 预期：返回本命名空间明文凭据；额度百分比正确显示；providers.credential 的明文不落日志、
 * 不进快照、不广播（WS 帧审计确认只有定向 reply）。」——WorkBuddy 按用户指示跳过，本剧本
 * 用 Trae 家族承载同一机制断言（回读 + 状态呈现 + 帧审计）；额度百分比/昵称数值在 Trae 上
 * 游设计性缺席（fetchStatus 无昵称/额度素材，A3 批次已确立），该子项的家族形态留待
 * WorkBuddy 窗口期（见 meta.notProvable）。
 *
 * 装配（A3 模板裁剪，零产品代码改动）：
 *   - Trae 插件单产物（pnpm pack 真实产物 + mock registry + GUI 家族卡安装链）。单产物
 *     依据：本剧本零对话断言——A3 双产物是「真实对话硬依赖 pi 扩展解析 wool 模型」所致，
 *     提取/回读/目录写回全在插件 fork + 宿主通道，pi 扩展不参与；
 *   - A20 探针 fixture（a20-cred-audit-probe，ns 'cred-audit'，合成凭据）：激活时
 *     providers.write 写自命名空间条目；probe 方法回读 providers.credential 并只回
 *     { hasKey, keyLen, keyMatches, source, kind }——keyMatches=true = 「reply 携带明文
 *     且只回给发起插件」的运行时正证（明文本身不出探针）；跨命名空间请求 wool-trae →
 *     NAMESPACE_MISMATCH = 定向 reply 的命名空间边界。
 *
 * A4b 帧审计（三段式，needle 全内存比对、证据只记计数）：
 *   Phase A（窗口零命中）：tap WS 连接（第二客户端，原始帧采集）在提取派发前打开，
 *     覆盖提取 + getStatus + refreshCatalog + probe 回读 + 状态行展开全过程；全帧按
 *     type 分类，对 needle 集（models.json 提取所得 apiKey + headers refreshToken 若在 +
 *     probe 合成 key）逐类断言零命中；
 *   Phase B（白名单正向对照）：经 tap 派发 config.revealProviderApiKey（设计内明文揭示
 *     RPC——UI「显示密钥」按钮同一通道，定向 reply 形态 config.providerApiKeyRevealed），
 *     断言 reply 携带 apiKey needle——同时证明检测器在 WS 帧上真实有效（防「空真」）；
 *   Phase C（命中分布）：全缓冲命中分布 = 仅 { config.providerApiKeyRevealed } 一类。
 *   结构性依据（源码锚）：providers.credential 的明文回执只进插件 IPC 定向 reply
 *   （provider-write-proxy.ts handleProviderCredential，成功路径零日志；插件 fork IPC
 *   不经 runtime WS），故 WS 观测面上提取/回读窗口预期全帧零命中，「只有定向 reply」
 *   以 Phase B 的揭示通道为白名单代表。
 *
 * A4b 磁盘断言（分体系裁决已核，provider-config-helper.ts applyProviderCredentials）：
 *   插件条目走 custom 通道 → apiKey 落 models.json（merged.apiKey）且 authStorage.remove
 *   清 auth.json——凭据合法落点 = <dataDir>/agent/models.json 唯一；<dataDir> 其余全部
 *   文件（logs/、快照落点、settings.json、auth.json、插件目录、npm 目录）对 needle 零命中；
   auth.json 实测若出现 needle 即按缺陷登记（分体系被破坏）。快照面 = plugin.ui.snapshot
 *   reply（auditedCall 内存比对）零命中。
 *
 * 凭据安全红线：needle 只在内存比对（tap 缓冲、reply 对象、文件读入即检）；assert/step/
 * attach 的 actual 只记长度、布尔、计数与帧类型分布，零明文。
 *
 * 运行形态：runner 托管实例（import 阶段 pack + seed，先于 instance.launch——必须显式传
 * --run-id）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  startMockNpmRegistry,
  seedPluginCatalog,
  registryEnv,
  pluginPkgsDir,
} from './lib/mock-npm-registry.mjs'
import { closePluginFlow } from './lib/plugin-flow-helper.mjs'
import { pluginFixture, resolveDataDirFromArgv } from './lib-plugin-fixtures.mjs'
import { waitPluginActive } from './lib/plugin-provider-fixture.mjs'

// ── 常量（包名/版本以独立仓 package.json 为单一事实源，import 期读取）────────
const PLUGIN_REPO = '/Users/zhushanwen/Code/tai-ji-plugin-workspace/main'
const TYPEBOX_DIR = path.join(PLUGIN_REPO, 'node_modules', '.pnpm')
const PACK_TMP_DIR = path.join(os.tmpdir(), 'taiji-a20a4b-pkgs')
const DIST_PREFIX = 'a20a4b-'

const TRAE = {
  family: 'trae',
  pkgName: '@zhushanwen/plugin-wool-trae',
  pkgDir: path.join(PLUGIN_REPO, 'packages', 'plugin-wool-trae'),
  displayName: 'Trae',
  credentialFileKeyword: 'storage.json',
}
TRAE.version = JSON.parse(fs.readFileSync(path.join(TRAE.pkgDir, 'package.json'), 'utf8')).version
TRAE.pluginId = `${TRAE.pkgName.split('/')[0].slice(1)}__${TRAE.pkgName.split('/')[1]}` // safePluginDirName 同式
TRAE.providerId = 'wool-trae'
TRAE.namespace = 'wool-trae'
const SHARED_PKG_DIR = path.join(PLUGIN_REPO, 'packages', 'wool-shared')
const SHARED_VERSION = JSON.parse(fs.readFileSync(path.join(SHARED_PKG_DIR, 'package.json'), 'utf8')).version

// A20 探针 fixture（合成凭据；独立命名空间，与 wool 命名空间互斥）
const PROBE_ID = 'a20-cred-audit-probe'
const PROBE_PKG = '@verify/plugin-cred-audit'
const PROBE_NS = 'cred-audit'
const PROBE_PROVIDER = 'cred-audit-prov'
const PROBE_KEY = `A20-PROBE-${randomUUID().replaceAll('-', '').slice(0, 24)}`
const PROBE_PERMISSIONS = [
  'plugin.commands.register',
  'plugin.commands.invoke.result',
  'providers.credential',
  'providers.write',
]
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
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a20a4b-work-'))
const typeboxHits = fs.readdirSync(TYPEBOX_DIR).filter((e) => e.startsWith('typebox@'))
if (typeboxHits.length === 0) throw new Error(`pnpm store 内无 typebox（${TYPEBOX_DIR}）——独立仓未 install？`)
const typeboxDir = path.join(TYPEBOX_DIR, typeboxHits[0], 'node_modules', 'typebox')
const TYPEBOX_VERSION = JSON.parse(fs.readFileSync(path.join(typeboxDir, 'package.json'), 'utf8')).version

/** 从 pnpm store 目录构造 typebox tgz（package/ 根布局，npm pack 同形）。 */
function makeTypeboxTgz(typeboxDirAbs, outPath) {
  const stage = path.join(workDir, 'typebox-pack')
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(path.join(stage, 'package'), { recursive: true })
  fs.cpSync(typeboxDirAbs, path.join(stage, 'package'), { recursive: true, dereference: true })
  execFileSync('tar', ['czf', outPath, '-C', stage, 'package'])
  fs.rmSync(stage, { recursive: true, force: true })
}

/** 从 tgz 直读 package.json（tar -xO；供 packument 依赖元数据组装）。 */
function readTgzPackageJson(tgzPath) {
  return JSON.parse(execFileSync('tar', ['-xzOf', tgzPath, 'package/package.json'], { encoding: 'utf8' }))
}

const packStep = { packed: [], copied: [] }
/** tgz 拷贝文件名 → 真实 dependencies（packument 元数据；安装器递归装依赖消费）。 */
const pkgExtraByCopyName = {}
try {
  const typeboxCopyName = `${DIST_PREFIX}typebox-${TYPEBOX_VERSION}.tgz`
  makeTypeboxTgz(typeboxDir, path.join(distDir, typeboxCopyName))
  packStep.copied.push(typeboxCopyName)

  const sharedTgzName = execFileSync('pnpm', ['pack', '--pack-destination', PACK_TMP_DIR], {
    cwd: SHARED_PKG_DIR, encoding: 'utf8',
  }).trim().split('\n').pop().trim()
  const sharedCopyName = `${DIST_PREFIX}pi-wool-shared-${SHARED_VERSION}.tgz`
  fs.copyFileSync(path.join(PACK_TMP_DIR, path.basename(sharedTgzName)), path.join(distDir, sharedCopyName))
  packStep.packed.push(`pi-wool-shared@${SHARED_VERSION}`)
  packStep.copied.push(sharedCopyName)
  // shared 声明 typebox 为 peerDependencies（npm7+ 自动装 peer 语义经 mock pkgExtra 镜像）
  pkgExtraByCopyName[sharedCopyName] = { dependencies: { typebox: TYPEBOX_VERSION } }

  const traeTgzName = execFileSync('pnpm', ['pack', '--pack-destination', PACK_TMP_DIR], {
    cwd: TRAE.pkgDir, encoding: 'utf8',
  }).trim().split('\n').pop().trim()
  const traeCopyName = `${DIST_PREFIX}plugin-wool-trae-${TRAE.version}.tgz`
  fs.copyFileSync(path.join(PACK_TMP_DIR, path.basename(traeTgzName)), path.join(distDir, traeCopyName))
  packStep.packed.push(`${TRAE.pkgName}@${TRAE.version}`)
  packStep.copied.push(traeCopyName)
} finally {
  fs.rmSync(workDir, { recursive: true, force: true })
}

// 清单（Trae 单产物条目：不带 piExtensionVersion = 跳过 WoolExtensionInstaller）
seedPluginCatalog(dataDir0, [{
  packageName: TRAE.pkgName,
  pluginId: TRAE.pluginId,
  displayName: TRAE.displayName,
  pluginVersion: TRAE.version,
  family: {
    id: TRAE.namespace,
    displayName: TRAE.displayName,
    vendor: 'tai-ji-plugin 独立仓（真机 A20/A4b 批次）',
    credentialSource: 'ide-extract',
    modelCount: 3,
  },
  capabilities: ['network.http', 'fs.read-user-data', 'crypto', 'process.spawn'],
}])

// A20 探针 fixture 落盘 + 双插件权限预批（审批门静默通过）
fs.mkdirSync(path.join(dataDir0, 'plugins', PROBE_ID), { recursive: true })
const probeFixture = pluginFixture({
  dirName: PROBE_ID,
  pkgName: PROBE_PKG,
  displayName: 'CredAuditProbe',
  description: 'A20 fixture: synthetic-credential positive readback via providers.credential (plaintext never leaves the probe)',
  namespace: PROBE_NS,
  capabilities: ['network.http'],
  permissions: PROBE_PERMISSIONS,
  activateBody: `
  await api.commands.register({ id: 'probe' }, async (args) => {
    try {
      const r = await api.providers.credential({ providerId: String(args?.providerId ?? '') })
      const key = r && typeof r === 'object' ? r.key : undefined
      return {
        ok: true,
        hasKey: typeof key === 'string' && key.length > 0,
        keyLen: typeof key === 'string' ? key.length : 0,
        keyMatches: typeof key === 'string' && key === '${PROBE_KEY}',
        source: r?.source ?? null,
        kind: r?.kind ?? null,
      }
    } catch (e) {
      return { ok: false, message: String(e?.message ?? e) }
    }
  })
  await api.providers.write({ providerId: '${PROBE_PROVIDER}', apiKey: '${PROBE_KEY}', displayName: 'CredAuditProbe (verify)', models: [{ id: 'a20-model' }] })
`,
})
for (const [name, content] of Object.entries(probeFixture.files)) {
  fs.writeFileSync(path.join(dataDir0, 'plugins', PROBE_ID, name), content, 'utf8')
}
fs.writeFileSync(
  path.join(dataDir0, 'plugins', 'permissions.json'),
  `${JSON.stringify({
    [TRAE.pluginId]: WOOL_PERMISSIONS,
    [PROBE_ID]: PROBE_PERMISSIONS,
  }, null, 2)}\n`,
  'utf8',
)

// ── 帧审计原语（全内存）──────────────────────────────────────────────

/** needle 的 JSON 转义变体（控制字符/非 ASCII 在 JSON.stringify 后形态变化，双形态防漏检）。 */
function needleVariants(needle) {
  return [needle, JSON.stringify(needle).slice(1, -1)]
}

/** 帧文本对单 needle 的命中判定（原始串 + JSON 转义变体）。 */
function frameHits(text, needle) {
  return needleVariants(needle).some((v) => v.length > 0 && text.includes(v))
}

/**
 * tap WS 连接（第二客户端）：原始帧采集器。收发全量进内存缓冲（auth 握手帧除外——
 * 它携带 runtime token，与 needle 无关且不属审计窗口）。
 */
function startFrameTap(dataDir) {
  const runtimePort = Number(fs.readFileSync(path.join(dataDir, 'runtime.port'), 'utf8').trim())
  const token = fs.readFileSync(path.join(dataDir, 'runtime-token'), 'utf8').trim()
  const ws = new WebSocket(`ws://127.0.0.1:${runtimePort}`)
  const buffer = [] // { dir: 'in'|'out', raw, at }
  let seq = 0
  const waiters = new Set()
  const notify = () => { for (const w of waiters) w() }
  ws.addEventListener('message', (ev) => {
    const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')
    buffer.push({ dir: 'in', raw, at: Date.now() })
    notify()
  })
  ws.addEventListener('error', () => notify())
  ws.addEventListener('close', () => notify())
  const ready = new Promise((resolve, reject) => {
    let timer = setTimeout(() => reject(new Error('tap auth 握手超时（15s）')), 15_000)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', payload: { token } }))
    })
    ws.addEventListener('message', (ev) => {
      if (timer === null) return
      let frame = null
      try { frame = JSON.parse(typeof ev.data === 'string' ? ev.data : '') } catch { return }
      if (frame?.type === 'auth.result') {
        clearTimeout(timer)
        timer = null
        if (frame.payload?.ok === true) resolve()
        else reject(new Error(`tap auth 被拒: ${frame.payload?.reason ?? 'unknown'}`))
      }
    })
  })
  // keepalive（runtime 无服务端心跳；id 前缀 tap-ka 便于审计分类时识别）
  const keepalive = setInterval(() => {
    try { ws.send(JSON.stringify({ type: 'ping', id: `tap-ka-${++seq}`, payload: {} })) } catch { /* closing */ }
  }, 20_000)
  keepalive.unref?.()
  return {
    ready,
    buffer,
    /** 经 tap 派发 RPC（reply 帧落缓冲 = 白名单正向对照的采集通道）。 */
    send(rawFrame) {
      buffer.push({ dir: 'out', raw: rawFrame, at: Date.now() })
      ws.send(rawFrame)
    },
    async close() {
      clearInterval(keepalive)
      try { ws.close() } catch { /* already */ }
      await new Promise((r) => setTimeout(r, 200))
    },
  }
}

/** 逐类统计帧缓冲的 needle 命中（只回计数与帧类型，零明文出参）。 */
function auditFrames(buffer, needles) {
  const classes = new Map() // class -> { count, hits: { label: count } }
  for (const f of buffer) {
    let cls = '(non-json)'
    try {
      const parsed = JSON.parse(f.raw)
      cls = `${f.dir === 'out' ? 'out' : 'in'}:${String(parsed?.type ?? 'untyped')}`
    } catch { /* 保持 non-json */ }
    const rec = classes.get(cls) ?? { count: 0, hits: {} }
    rec.count += 1
    for (const [label, needle] of Object.entries(needles)) {
      if (needle && frameHits(f.raw, needle)) rec.hits[label] = (rec.hits[label] ?? 0) + 1
    }
    classes.set(cls, rec)
  }
  return classes
}

/** 递归收集文件（上限保护：单文件 >64MB 跳读记名）。 */
function walkFiles(root) {
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(abs)
      else if (e.isFile()) out.push(abs)
    }
  }
  return out
}

// ── meta ──────────────────────────────────────────────────────────────

export const meta = {
  id: 'p1-plugin-a20-a4b-credential-audit',
  priority: 'P1',
  title: 'A20+A4b 真机：providers.credential 凭据受控回读正向（Trae 承载）+ 凭据无第二落点（WS 帧审计三段式 + 磁盘断言）',
  covers: ['plugin.invoke', 'settings.provider'],
  requires: [],
  estimateSec: 420,
  env: {
    ...registryEnv(process.cwd()),
  },
  provable: [
    'C: 真实 pack 链在位——Trae 插件 + shared pnpm pack 原始产物 + typebox 备料（单产物装配：零对话 → pi 扩展不参与）',
    'B: A20 探针激活并经 providers.write 落盘自命名空间条目（cred-audit-prov 在 models.json）',
    'B: A20 正向对照——探针 providers.credential 回读携带明文（keyMatches=true + source=models.json + kind=api_key；明文不出探针）',
    'B: A20 定向性边界——探针跨命名空间请求 wool-trae 被拒 NAMESPACE_MISMATCH（reply 只服务发起插件本命名空间）',
    'A: Trae 家族卡 + 安装确认卡知情面 → 确认安装 → 插件 active + pluginDir 落盘 + 安装链经 mock registry',
    'A+B: Trae 提取成功（DOM/快照）+ models.json wool-trae 条目（apiKey 非空 + models ≥1）',
    'B: A20 getStatus 宿主契约形状 { state: valid }（回读链解耦面的 Trae 登录态）',
    'A: Trae 条目展开渲染凭据状态行（provider-plugin-status 非空——S20 状态呈现活性等价断言）',
    'B: A20 回读链真实上游——refreshCatalog 非「未接入」（readCredential 命中 models.json）+ 回读 key 往返一致（models.json apiKey 与提取所得逐字节相同，内存比对）',
    'B: A4b 帧审计 Phase A——提取+回读窗口全部 WS 帧按类型零命中（帧类型×帧数分布留证）',
    'B: A4b 帧审计 Phase B——config.revealProviderApiKey 定向 reply（config.providerApiKeyRevealed）携带 apiKey（白名单正向对照 + 检测器有效性证明）',
    'B: A4b 帧审计 Phase C——全缓冲命中分布 = 仅揭示 reply 一类（明文只在定向 reply 帧出现）',
    'C: A4b 快照面——plugin.ui.snapshot reply 零命中（UI 快照存储无凭据）',
    'C: A4b 日志面——<dataDir>/logs/ 全量文件零命中',
    'C: A4b 磁盘面——<dataDir> 除 agent/models.json 全量文件零命中；models.json 持有 needle（合法落点正验）',
  ],
  notProvable: [
    '额度百分比/昵称数值呈现——Trae 上游设计性缺席（fetchStatus 无昵称/额度素材，A3 批次已确立）；S20 该子项以「状态行 valid 渲染 + refreshCatalog 真实上游成功」为等价活性断言，WorkBuddy 家族形态留待其窗口期',
    'providers.credential 插件 IPC reply 帧本体——插件 fork IPC 不经 runtime WS，WS tap 观测面不含它；「定向 reply」以探针 keyMatches（回给发起插件）+ 跨命名空间拒绝 + 源码锚（provider-write-proxy handleProviderCredential 定向回执）三重承载',
    '第三方 WS 连接（renderer 本体）的定向 reply——tap 只能看到广播与自己两连接的 reply；服务端广播面全量在 tap 缓冲，renderer reply 面与 scenario 共享同一服务端构造器（listProviders/buildProviderListMsgs 只出 apiKeySet 布尔）',
    'wool-manifest 远端发布链与 npm 远端发布链——本剧本单产物装配，不经该链（A3/A23a 已覆盖双产物形态）',
  ],
}

// ── run ───────────────────────────────────────────────────────────────

export async function run(ctx) {
  const { protocol, ui, ev, log, dataDir } = ctx
  const page = await ctx.instance.page()
  const gotchas = [
    '单产物装配依据：本剧本零对话断言，提取/回读/目录写回全在插件 fork + 宿主通道（plugin-kit 只消费宿主 API），pi 扩展仅真实对话需要——A3 双产物装配在此裁剪',
    'config.revealProviderApiKey 是设计内明文出线（UI「显示密钥」按钮同一 RPC 通道，reply=config.providerApiKeyRevealed）——帧审计把它当白名单正向对照（同时证明检测器非「空真」），不是缺陷',
    'providers.write 触发的 config.providers 广播只含 apiKeySet 布尔（buildCustomProviderInfo），帧审计对广播类零命中即其真机实证',
    'needle 纪律：比对全内存（tap 缓冲/RPC reply 对象/文件读入即检），比对后即弃；assert/step/attach 只记长度、布尔、计数、帧类型分布',
    '探针 providers.write 发生在激活期（窗口外）；其帧面泄漏风险与 wool 同一广播构造器承担，窗口内探针回读 reply 由 auditedCall 全量比对',
  ]

  const packStatsOk = packStep.packed.length === 2 && packStep.copied.length === 3
  ev.assert('C: 真实 pack 链在位（Trae 插件 + shared pack 原始产物 + typebox 备料）', packStatsOk, {
    channel: 'C',
    expected: 'packed=2 copied=3',
    actual: `packed=${packStep.packed.length} copied=${packStep.copied.join(',')}`,
  })
  ev.step({ step: 'pack.real-plugins', channel: 'C', exitCode: packStatsOk ? 0 : 1, stats: { packed: packStep.packed } })

  const registryState = { pkgs: buildRegistryMap() }
  const registry = await startMockNpmRegistry(ctx.repo, registryState.pkgs)
  ev.step({ step: 'mock-registry.up', channel: 'C', exitCode: 0, stats: { url: registry.url, pkgs: Object.keys(registryState.pkgs) } })

  const modelsPath = path.join(dataDir, 'agent', 'models.json')
  const readJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  }
  const modelsProviders = () => readJson(modelsPath)?.providers ?? {}

  /** registry 版本表（distDir 内 a20a4b- 前缀 tarball）。 */
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
    add(TRAE.pkgName, TRAE.version, `${DIST_PREFIX}plugin-wool-trae-${TRAE.version}.tgz`)
    return map
  }

  try {
    // ── 基线 + 探针激活 ────────────────────────────────────────────
    const listed0 = await protocol.call('plugin.list', {})
    const ids0 = (listed0.plugins ?? []).map((p) => p.pluginId)
    ev.assert('B: 基线——Trae 插件不在 plugin.list', !ids0.includes(TRAE.pluginId), {
      channel: 'B',
      expected: `无 ${TRAE.pluginId}`,
      actual: ids0.join(',').slice(0, 200) || '(空)',
    })
    // 基线只断言 wool-* 缺席：探针 fixture 在 onStartupFinished 激活（早于本检查），
    // 其 providers.write 落盘是装配预期（下一条断言即消费它作对照落点）。
    ev.assert('C: 基线——models.json 无 wool-* 条目（探针条目属装配预期，不计违规）', !Object.keys(modelsProviders()).some((k) => k.startsWith('wool-')), {
      channel: 'C',
      expected: 'providers 无 wool-*',
      actual: Object.keys(modelsProviders()).join(',').slice(0, 200) || '(空)',
    })

    const probeInfo = await waitPluginActive(protocol, PROBE_ID)
    ev.assert('B: A20 探针激活（sandbox，权限预批静默通过）', probeInfo?.status === 'active', {
      channel: 'B',
      expected: 'status=active',
      actual: `status=${probeInfo?.status} trust=${probeInfo?.trustLevel}`,
    })
    // 探针激活即 providers.write 落盘自命名空间条目（凭据对照落点）
    const probeEntry = await pollValue(() => modelsProviders()[PROBE_PROVIDER] ?? null, Boolean, { timeoutMs: 20_000, label: 'models.json cred-audit-prov 条目' })
    ev.assert(`B: A20 探针 providers.write 落盘自命名空间条目（${PROBE_PROVIDER}.apiKey 非空）`,
      typeof probeEntry?.apiKey === 'string' && probeEntry.apiKey.length > 0, {
        channel: 'C',
        expected: 'apiKey 非空（合成凭据对照落点）',
        actual: probeEntry ? `apiKey.len=${probeEntry.apiKey.length}` : '条目缺失',
      })

    // ── Trae 安装（家族卡 → 确认卡 → 确认安装 → 授权容器）──────────
    await openProviderPage(ui)
    await ui.click('testid=provider-template-picker')
    await ui.click('testid=add-menu-plugin')
    await ui.expectVisible('testid=plugin-provider-flow')
    await ui.expectVisible('testid=plugin-family-grid')
    await ui.expectCount('testid=plugin-family-card', 1)
    const cardSel = `css=[data-testid="plugin-family-card"]:has-text("${TRAE.displayName}")`
    await ui.expectVisible(cardSel)
    await ui.click(cardSel)
    await ui.expectVisible('testid=plugin-install-confirm', { timeoutMs: 60_000 })
    const capsText = await ui.text('testid=plugin-confirm-capabilities')
    const readPathsText = await ui.text('testid=plugin-confirm-read-paths')
    ev.assert(`A: ${TRAE.displayName} 安装确认卡真实知情面（capabilities 含 network.http/fs.read-user-data + readPaths 含凭据文件）`,
      capsText.includes('network.http') && capsText.includes('fs.read-user-data') && readPathsText.includes(TRAE.credentialFileKeyword), {
        channel: 'A',
        expected: `network.http + fs.read-user-data + readPaths 含 ${TRAE.credentialFileKeyword}`,
        actual: `caps=${capsText.slice(0, 120)} readPaths=${readPathsText.slice(0, 140)}`,
      })
    await ui.screenshot('a20a4b-trae-confirm-card')
    await ui.click('testid=plugin-install-confirm-btn')
    await ui.expectVisible('testid=plugin-authorize-container', { timeoutMs: 90_000 })

    const traeListed = await pollValue(
      async () => {
        const r = await protocol.call('plugin.list', {})
        return (r.plugins ?? []).find((p) => p.pluginId === TRAE.pluginId) ?? null
      },
      (info) => Boolean(info && info.status === 'active'),
      { timeoutMs: 30_000, label: 'Trae 插件 active' },
    )
    ev.assert('B: Trae 插件已激活（status=active，sandbox）', traeListed?.status === 'active' && traeListed?.trustLevel === 'sandbox', {
      channel: 'B',
      expected: 'status=active trustLevel=sandbox',
      actual: traeListed ? `status=${traeListed.status} trust=${traeListed.trustLevel}` : '插件不在列表',
    })
    const pluginPkg = readJson(path.join(dataDir, 'plugins', TRAE.pluginId, 'package.json'))
    const sharedInstalled = readJson(path.join(dataDir, 'plugins', TRAE.pluginId, 'node_modules', '@zhushanwen', 'pi-wool-shared', 'package.json'))
    ev.assert('C: Trae 双落盘（插件目录 package.json 同源 + 依赖 pluginDir/node_modules shared+typebox 由安装器真实 npm 链装）',
      pluginPkg?.name === TRAE.pkgName && pluginPkg?.taijiPlugin?.namespace === TRAE.namespace
        && sharedInstalled?.name === '@zhushanwen/pi-wool-shared' && sharedInstalled?.version === SHARED_VERSION, {
        channel: 'C',
        expected: `${TRAE.pkgName} ns=${TRAE.namespace} + node_modules{pi-wool-shared@${SHARED_VERSION}, typebox}`,
        actual: `plugin=${pluginPkg ? `${pluginPkg.name} ns=${pluginPkg.taijiPlugin?.namespace}` : '缺失'} shared=${sharedInstalled ? `${sharedInstalled.name}@${sharedInstalled.version}` : '缺失'}`,
      })
    const registryPaths = registry.requests.map((r) => r.path)
    ev.assert('C: 安装链经本机 mock registry 流转（plugin/shared packument 均有请求）',
      registryPaths.some((p) => p.includes('plugin-wool-trae')) && registryPaths.some((p) => p.includes('pi-wool-shared')), {
        channel: 'C',
        expected: 'registry 请求含 plugin-wool-trae / pi-wool-shared',
        actual: `requests=${registryPaths.length} uniq=${[...new Set(registryPaths)].slice(0, 6).join(' | ')}`,
      })
    // 授权挂载位渲染提取确认卡（宿主 getAuthorizeView 驱动）
    const extractBtn = page.locator('[data-testid="gui-action-bar-item-wool-extract-start"]')
    const btnCount = await extractBtn.count()
    const emptyHost = await page.locator('[data-testid="view-host-empty"]').count()
    ev.assert('A: 授权挂载位渲染提取确认卡（getAuthorizeView 驱动 + viewId 对齐）', btnCount > 0 && emptyHost === 0, {
      channel: 'A',
      expected: 'gui-action-bar-item-wool-extract-start 存在 + 无 view-host-empty 占位',
      actual: `extractBtn=${btnCount} view-host-empty=${emptyHost}`,
    })
    await ui.screenshot('a20a4b-trae-authorize-mount')

    // ── A4b 帧审计窗口开启（tap 在提取派发前接入）──────────────────
    const tap = startFrameTap(dataDir)
    await tap.ready
    ev.step({ step: 'audit.tap-open', channel: 'C', exitCode: 0, stats: { note: '窗口起点 = 提取派发前' } })

    // 窗口内全部 RPC 走 auditedCall（reply 对象进内存审计面）
    const auditedReplies = [] // { type, text }
    const auditedCall = async (type, payload, opts) => {
      const reply = await protocol.call(type, payload, opts)
      auditedReplies.push({ type, text: JSON.stringify(reply ?? null) })
      return reply
    }

    // ── 提取（executeCommand 同通道驱动）+ 完成轮询 ────────────────
    await auditedCall('plugin.executeCommand', { pluginId: TRAE.pluginId, commandId: 'extract' }, { timeoutMs: 30_000 })
    ev.step({ step: 'extract.dispatch', channel: 'B', exitCode: 0, stats: { channel: 'plugin.executeCommand' } })

    const container = page.locator('[data-testid="plugin-authorize-container"]')
    const snapshotTree = async () => {
      const reply = await auditedCall('plugin.ui.snapshot', { mountId: 'provider.authorize', pluginId: TRAE.pluginId, viewId: 'provider.authorize' }, { timeoutMs: 15_000 })
      return (reply?.views ?? []).map((v) => JSON.stringify(v?.components ?? v)).join(' ')
    }
    let outcome = 'timeout'
    const start = Date.now()
    for (;;) {
      if ((await container.locator('[data-testid="gui-card"]:has-text("提取成功")').count()) > 0) { outcome = 'dom-success'; break }
      if ((await container.locator('[data-testid="gui-card"]:has-text("提取失败")').count()) > 0) { outcome = 'dom-error'; break }
      let tree = ''
      try { tree = await snapshotTree() } catch { /* 快照通道异常按未就绪轮询 */ }
      if (tree.includes('提取成功')) { outcome = 'snapshot-success'; break }
      if (tree.includes('提取失败') || tree.includes('改用官方令牌')) { outcome = 'snapshot-error'; break }
      if (Date.now() - start > 60_000) break
      await new Promise((r) => setTimeout(r, 80))
    }
    ev.assert(`A+B: Trae 提取成功（outcome=${outcome}）`, outcome === 'dom-success' || outcome === 'snapshot-success', {
      channel: 'A',
      expected: 'DOM/快照呈现「提取成功」',
      actual: `outcome=${outcome} elapsedMs=${Date.now() - start}`,
    })
    await ui.screenshot('a20a4b-trae-extract-outcome')

    // ── needle 就位（models.json 提取所得；只进内存）───────────────
    const traeEntry = await pollValue(() => modelsProviders()[TRAE.providerId] ?? null, Boolean, { timeoutMs: 15_000, label: 'models.json wool-trae 条目' })
    const traeModels = traeEntry?.models ?? []
    ev.assert('C: models.json wool-trae 条目（apiKey 非空 + models ≥1 且 api=wool-trae）',
      typeof traeEntry?.apiKey === 'string' && traeEntry.apiKey.length > 0
        && traeModels.length >= 1 && traeModels.every((m) => m?.api === 'wool-trae' && typeof m?.id === 'string' && m.id.length > 0), {
        channel: 'C',
        expected: 'apiKey 非空 + models≥1（api=wool-trae）',
        actual: traeEntry ? `apiKey.len=${traeEntry.apiKey.length} models=${traeModels.length}` : '条目缺失',
      })
    /** needle 集（值只进内存；label 进证据）。 */
    const needles = { apiKey: traeEntry.apiKey }
    const refreshToken = traeEntry?.headers?.['x-wool-refresh-token']
    needles.refreshToken = typeof refreshToken === 'string' && refreshToken.length > 0 ? refreshToken : null
    needles.probeKey = PROBE_KEY
    ev.step({
      step: 'audit.needles-ready',
      channel: 'C',
      exitCode: 0,
      stats: {
        apiKeyLen: traeEntry.apiKey.length,
        refreshTokenPresent: needles.refreshToken !== null,
        refreshTokenLen: needles.refreshToken?.length ?? 0,
        probeKeyLen: PROBE_KEY.length,
      },
    })

    // ── A20：getStatus + 状态行渲染 ────────────────────────────────
    const statusBody = (await auditedCall('plugin.invoke', { pluginId: TRAE.pluginId, method: 'getStatus', params: { providerId: TRAE.providerId } }, { timeoutMs: 30_000 }))?.result
    ev.assert('B: A20 getStatus 返回宿主契约形状 { state: valid }（无素材时 message 省略、无 providerId）',
      statusBody?.state === 'valid' && statusBody?.providerId === undefined, {
        channel: 'B',
        expected: '{state:valid}（无昵称/额度素材 → message 省略）',
        actual: JSON.stringify(statusBody ?? null).slice(0, 200),
      })
    // 状态行渲染（S20「状态呈现活性」等价断言）：先关插件接入流（对话框遮罩会拦截
    // 行卡点击——A3 同款顺序），行卡出现仍由写落点广播驱动（不重开设置窗）。
    await closePluginFlow(ui)
    const traeCard = page.locator('[data-testid="provider-card"]', { hasText: /trae/i }).first()
    const cardAppeared = await pollValue(
      async () => (await traeCard.count()) > 0,
      Boolean,
      { timeoutMs: 15_000, intervalMs: 500, label: 'wool-trae 行卡即时渲染（写落点广播）' },
    ).catch(() => false)
    ev.assert('A: 提取写回后条目行卡即时出现（写落点广播驱动，不重开设置窗）', cardAppeared, {
      channel: 'A',
      expected: 'providers.write 写回后 15s 内 provider-card 出现',
      actual: cardAppeared ? '行卡已渲染' : '15s 内行卡未出现（广播链断）',
    })
    let statusRowText = ''
    if (cardAppeared) {
      await traeCard.locator('span[role="button"]').click()
      const statusRow = page.locator('[data-testid="provider-plugin-status"]')
      const statusAppeared = await pollValue(
        async () => (await statusRow.count()) > 0,
        Boolean,
        { timeoutMs: 20_000, label: 'wool-trae 条目状态行渲染' },
      )
      statusRowText = statusAppeared ? await statusRow.first().innerText().catch(() => '') : ''
      await traeCard.locator('span[role="button"]').click().catch(() => {})
    }
    ev.assert('A: Trae 条目展开渲染凭据状态行（provider-plugin-status 非空——S20 状态呈现活性等价断言）',
      statusRowText.trim().length > 0, {
        channel: 'A',
        expected: '状态行存在且文案非空（valid 默认文案或摘要）',
        actual: `text=${statusRowText.trim().slice(0, 80) || '(空)'}`,
      })

    // ── A20：refreshCatalog 回读链（真实上游）+ 往返一致 ───────────
    const apiKeyBefore = traeEntry.apiKey
    const refreshReply = await auditedCall('plugin.invoke', { pluginId: TRAE.pluginId, method: 'refreshCatalog', params: {} }, { timeoutMs: 60_000 })
    const refreshError = String(refreshReply?.result?.error ?? '')
    const credentialReadBroken = refreshReply?.result?.ok === false && refreshError.includes('未接入')
    ev.assert('B: A20 回读链真实上游——refreshCatalog 非「未接入」（readCredential 命中 models.json；上游目录拉取环境类失败不判负）',
      !credentialReadBroken, {
        channel: 'B',
        expected: 'ok=true，或 ok=false 但 error 非「未接入」（上游环境类失败）',
        actual: `ok=${refreshReply?.result?.ok} error=${refreshError.slice(0, 120)}`,
      })
    const traeEntryAfter = modelsProviders()[TRAE.providerId]
    const roundtripSame = typeof traeEntryAfter?.apiKey === 'string' && traeEntryAfter.apiKey === apiKeyBefore
    ev.assert('B: A20 回读 key 往返一致（refreshCatalog 以回读所得 key 重写 models.json，与提取所得逐字节相同——内存比对）',
      roundtripSame, {
        channel: 'B',
        expected: `apiKey 往返相同（len=${apiKeyBefore.length}）`,
        actual: roundtripSame ? '逐字节相同' : `不一致（after.len=${traeEntryAfter?.apiKey?.length ?? 0}）`,
      })

    // ── A20：探针正证（回读携带明文 + 定向性边界）——窗口内，reply 进审计面 ──
    const probeSelf = await auditedCall('plugin.invoke', { pluginId: PROBE_ID, method: 'probe', params: { providerId: PROBE_PROVIDER } }, { timeoutMs: 30_000 })
    const probeSelfBody = probeSelf?.result ?? {}
    ev.assert('B: A20 正向对照——探针 providers.credential 回读携带明文（keyMatches=true + source=models.json + kind=api_key）',
      probeSelfBody?.ok === true && probeSelfBody?.hasKey === true && probeSelfBody?.keyMatches === true
        && probeSelfBody?.source === 'models.json' && probeSelfBody?.kind === 'api_key', {
        channel: 'B',
        expected: 'ok + hasKey + keyMatches + source=models.json + kind=api_key（明文不出探针，只回布尔）',
        actual: `ok=${probeSelfBody?.ok} hasKey=${probeSelfBody?.hasKey} keyMatches=${probeSelfBody?.keyMatches} keyLen=${probeSelfBody?.keyLen} source=${probeSelfBody?.source} kind=${probeSelfBody?.kind}`,
      })
    const probeCross = await auditedCall('plugin.invoke', { pluginId: PROBE_ID, method: 'probe', params: { providerId: TRAE.providerId } }, { timeoutMs: 30_000 })
    const probeCrossBody = probeCross?.result ?? {}
    ev.assert('B: A20 定向性边界——探针跨命名空间请求 wool-trae 被拒 NAMESPACE_MISMATCH',
      probeCrossBody?.ok === false && String(probeCrossBody?.message ?? '').startsWith('NAMESPACE_MISMATCH'), {
        channel: 'B',
        expected: 'ok:false + NAMESPACE_MISMATCH 前缀',
        actual: `ok=${probeCrossBody?.ok} message=${String(probeCrossBody?.message ?? '').slice(0, 120)}`,
      })

    // ── Phase A 收口：宽限 2s（尾触发广播/推送落网）后切片审计 ─────
    // 切片在揭示对照前取（tap 保持打开到 Phase C 结束——揭示 reply 帧要落同一缓冲）。
    await new Promise((r) => setTimeout(r, 2_000))
    const windowBuffer = [...tap.buffer]
    // A4b 核心 needle 集 = 提取所得 apiKey + 探针合成 key（设计 S20/S4b 原文口径）。
    // refreshToken 单列：provider 级 headers 读侧透传使其出现在 config.providers 广播
    // （ISSUES-2 ⑨ 登记的缺陷现状），不并入核心零命中断言。
    const coreNeedles = { apiKey: needles.apiKey, probeKey: needles.probeKey }
    const windowClasses = auditFrames(windowBuffer, coreNeedles)
    const windowFrames = windowBuffer.filter((f) => f.dir === 'in').length
    const windowHitClasses = [...windowClasses.entries()].filter(([, rec]) => Object.keys(rec.hits).length > 0)
    ev.step({
      step: 'audit.window-classify',
      channel: 'C',
      exitCode: 0,
      stats: {
        framesInWindow: windowFrames,
        classes: [...windowClasses.entries()].map(([cls, rec]) => `${cls}=${rec.count}`).join(' | ').slice(0, 600),
      },
    })
    ev.assert('B: A4b 帧审计 Phase A——提取+回读窗口全部 WS 帧按类型零命中（apiKey + probeKey）', windowHitClasses.length === 0, {
      channel: 'B',
      expected: `窗口 ${windowFrames} 帧逐类零命中（needle=apiKey/probeKey）`,
      actual: windowHitClasses.length === 0 ? `零命中（${windowClasses.size} 类 ${windowFrames} 帧）` : `命中类：${windowHitClasses.map(([cls, rec]) => `${cls}=${JSON.stringify(rec.hits)}`).join(' | ').slice(0, 300)}`,
    })
    // refreshToken 缺陷 ⑨ 现状锚点：headers 随 config.providers 广播出线（apiKey 本体
    // 已脱敏为 apiKeySet 布尔，headers 没有——双标准）。断言形态对修复后仍成立：命中
    // 类 ⊆ { in:config.providers }（零命中 = 已修复，同样通过）；分布越界即真越界。
    if (needles.refreshToken !== null) {
      const rtClasses = auditFrames(windowBuffer, { refreshToken: needles.refreshToken })
      const rtHitClasses = [...rtClasses.entries()].filter(([, rec]) => (rec.hits.refreshToken ?? 0) > 0)
      const rtBounded = rtHitClasses.every(([cls]) => cls === 'in:config.providers')
      ev.step({
        step: 'audit.refreshToken-distribution',
        channel: 'C',
        exitCode: 0,
        stats: {
          defect: 'ISSUES-2 ⑨（headers 读侧透传使 refreshToken 随 config.providers 广播出线；修复后本分布应归零）',
          distribution: rtHitClasses.length === 0 ? '零命中（已修复形态）' : rtHitClasses.map(([cls, rec]) => `${cls}=${rec.hits.refreshToken}`).join(' | '),
        },
      })
      ev.assert('C: A4b refreshToken 面（ISSUES-2 ⑨ 现状锚点）——refreshToken 广播分布 ⊆ config.providers 帧（修复后归零仍通过）', rtBounded, {
        channel: 'C',
        expected: '命中类 ⊆ { in:config.providers }（⑨ 现状）或零命中（已修复）',
        actual: rtHitClasses.length === 0 ? '零命中（已修复形态）' : rtHitClasses.map(([cls, rec]) => `${cls}=${rec.hits.refreshToken}`).join(' | ').slice(0, 200),
      })
    }

    // ── Phase B：白名单正向对照（揭示 RPC 经 tap 派发，reply 帧落缓冲）──
    tap.send(JSON.stringify({ type: 'config.revealProviderApiKey', id: 'tap-reveal-1', payload: { providerId: TRAE.providerId } }))
    const revealFrame = await pollValue(
      () => tap.buffer.find((f) => f.dir === 'in' && f.raw.includes('"tap-reveal-1"')) ?? null,
      Boolean,
      { timeoutMs: 15_000, label: 'tap 揭示 reply 帧到达' },
    )
    let revealParsed = null
    try { revealParsed = JSON.parse(revealFrame.raw) } catch { /* 保持 null */ }
    const revealApiKey = revealParsed?.payload?.apiKey
    ev.assert('B: A4b 帧审计 Phase B——config.revealProviderApiKey 定向 reply 携带 apiKey（白名单正向对照 + 检测器有效性证明）',
      revealParsed?.type === 'config.providerApiKeyRevealed' && revealParsed?.payload?.available === true
        && typeof revealApiKey === 'string' && revealApiKey === needles.apiKey, {
        channel: 'B',
        expected: 'config.providerApiKeyRevealed available=true 且 apiKey 与 needle 逐字节相同（内存比对）',
        actual: `type=${revealParsed?.type} available=${revealParsed?.payload?.available} match=${revealApiKey === needles.apiKey} len=${revealApiKey?.length ?? 0} source=${revealParsed?.payload?.source}`,
      })

    // ── Phase C：全缓冲命中分布 = 仅揭示 reply 一类（然后才关 tap）──
    const fullClasses = auditFrames(tap.buffer, coreNeedles)
    const fullHitClasses = [...fullClasses.entries()].filter(([, rec]) => Object.keys(rec.hits).length > 0)
    const onlyReveal = fullHitClasses.every(([cls]) => cls === 'in:config.providerApiKeyRevealed')
      && (fullClasses.get('in:config.providerApiKeyRevealed')?.hits?.apiKey ?? 0) >= 1
    await tap.close()
    ev.assert('B: A4b 帧审计 Phase C——全缓冲命中分布 = 仅揭示 reply 一类（明文只在定向 reply 帧出现）', onlyReveal, {
      channel: 'B',
      expected: '命中类 ⊆ { in:config.providerApiKeyRevealed } 且该类 apiKey 命中 ≥1',
      actual: fullHitClasses.length === 0 ? '全缓冲零命中（揭示对照未生效？）' : fullHitClasses.map(([cls, rec]) => `${cls}=${JSON.stringify(rec.hits)}`).join(' | ').slice(0, 300),
    })

    // ── RPC reply 审计面（auditedCall 内存比对）────────────────────
    const replyHits = []
    for (const r of auditedReplies) {
      for (const [label, needle] of Object.entries(needles)) {
        if (needle && frameHits(r.text, needle)) replyHits.push(`${r.type}:${label}`)
      }
    }
    ev.assert('C: A4b 快照面 + 回执面——窗口内全部 RPC reply（含 plugin.ui.snapshot）零命中', replyHits.length === 0, {
      channel: 'C',
      expected: `窗口 ${auditedReplies.length} 个 reply 零命中`,
      actual: replyHits.length === 0 ? `零命中（${auditedReplies.length} replies：${[...new Set(auditedReplies.map((r) => r.type))].join(',').slice(0, 200)}）` : `命中：${replyHits.join(',').slice(0, 200)}`,
    })

    // ── A4b 日志面：<dataDir>/logs/ 全量扫描 ────────────────────────
    const logsDir = path.join(dataDir, 'logs')
    const logFiles = fs.existsSync(logsDir) ? walkFiles(logsDir) : []
    const logHits = []
    let logBytes = 0
    for (const file of logFiles) {
      const text = fs.readFileSync(file, 'latin1')
      logBytes += text.length
      for (const [label, needle] of Object.entries(needles)) {
        if (needle && frameHits(text, needle)) logHits.push(`${path.basename(file)}:${label}`)
      }
    }
    ev.assert('C: A4b 日志面——<dataDir>/logs/ 全量文件零命中', logHits.length === 0, {
      channel: 'C',
      expected: `${logFiles.length} 个日志文件零命中`,
      actual: logHits.length === 0 ? `零命中（files=${logFiles.length} bytes≈${logBytes}）` : `命中：${logHits.join(',').slice(0, 200)}`,
    })

    // ── A4b 磁盘面：<dataDir> 全量扫描（合法落点 = agent/models.json）──
    const legalLanding = path.join(dataDir, 'agent', 'models.json')
    // 探针 fixture 自身源码内嵌合成 key（剧本装配产物，launch 前写入，非产品落点）——排除。
    const probeSourceFile = path.join(dataDir, 'plugins', PROBE_ID, 'index.js')
    const allFiles = walkFiles(dataDir).filter((f) => f !== legalLanding && f !== probeSourceFile)
    const diskHits = []
    let diskBytes = 0
    for (const file of allFiles) {
      let text = ''
      try {
        const stat = fs.statSync(file)
        if (stat.size > 64 * 1024 * 1024) { diskHits.push(`${path.relative(dataDir, file)}:(file-too-large-to-scan)`) ; continue }
        text = fs.readFileSync(file, 'latin1')
      } catch { continue }
      diskBytes += text.length
      for (const [label, needle] of Object.entries(needles)) {
        if (needle && frameHits(text, needle)) diskHits.push(`${path.relative(dataDir, file)}:${label}`)
      }
    }
    const legalHasKeys = frameHits(fs.readFileSync(legalLanding, 'latin1'), needles.apiKey)
      && (needles.refreshToken === null || frameHits(fs.readFileSync(legalLanding, 'latin1'), needles.refreshToken))
      && frameHits(fs.readFileSync(legalLanding, 'latin1'), needles.probeKey)
    ev.assert('C: A4b 磁盘面——models.json 持有全部 needle（凭据合法落点正验）', legalHasKeys, {
      channel: 'C',
      expected: 'agent/models.json 含 apiKey + refreshToken? + probeKey（needle 有效性反证）',
      actual: `apiKey=${frameHits(fs.readFileSync(legalLanding, 'latin1'), needles.apiKey)} refreshTokenPresent=${needles.refreshToken !== null} probeKey=${frameHits(fs.readFileSync(legalLanding, 'latin1'), needles.probeKey)}`,
    })
    ev.assert('C: A4b 磁盘面——<dataDir> 其余全部文件零命中（logs/settings/auth.json/插件目录/npm 目录）', diskHits.length === 0, {
      channel: 'C',
      expected: `${allFiles.length} 个文件零命中（auth.json 零命中 = 分体系裁决：custom 通道清 auth.json）`,
      actual: diskHits.length === 0 ? `零命中（files=${allFiles.length} bytes≈${diskBytes}）` : `命中：${diskHits.join(',').slice(0, 300)}`,
    })
    const authJsonPath = path.join(dataDir, 'agent', 'auth.json')
    ev.step({
      step: 'audit.disk-summary',
      channel: 'C',
      exitCode: 0,
      stats: {
        scannedFiles: allFiles.length + 1,
        authJsonExists: fs.existsSync(authJsonPath),
        authJsonHit: fs.existsSync(authJsonPath) ? frameHits(fs.readFileSync(authJsonPath, 'latin1'), needles.apiKey) : false,
      },
    })

    log('A20+A4b done')
  } finally {
    for (const e of fs.readdirSync(distDir)) {
      if (e.startsWith(DIST_PREFIX)) fs.rmSync(path.join(distDir, e), { force: true })
    }
    ev.step({ step: 'fixtures.cleanup', channel: 'C', exitCode: 0, stats: { distDir: `${DIST_PREFIX}* cleared` } })
    await registry.close()
  }
  return { uncovered: [], gotchas }
}

// ── 共享步骤 ──────────────────────────────────────────────────────────

/** 打开 Provider 页（ready 锚 = 页头常驻 provider-template-picker）。 */
async function openProviderPage(ui) {
  await ui.click('testid=sidebar-settings')
  await ui.expectVisible('testid=settings-nav-provider')
  await ui.click('testid=settings-nav-provider')
  await ui.expectVisible('testid=provider-template-picker')
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
      e.hint = '核对装配编排与 runtime 日志'
      e.evidence = `末值=${JSON.stringify(last)?.slice(0, 200)}`
      throw e
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
