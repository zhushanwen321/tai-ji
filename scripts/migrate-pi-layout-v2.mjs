#!/usr/bin/env node
/**
 * migrate-pi-layout-v2.mjs —— 一次性手工迁移脚本（方案 B / U14a）
 *
 * 把 xyz-agent 旧布局 `<dataDir>/pi/{agent,sessions}` 迁到 pi 0.84.x 同构新布局
 * `<dataDir>/agent/sessions/<encodeCwd>/`（唯一差异 = 根目录，无 pi/ 中间层）。
 * 设计规格：extensions/universal/session-reader/docs/
 * 2026-09-10-session-root-discovery-and-env-transparency.md §6.11 六步流程块（逐行实现规格）。
 *
 * 用法：`node scripts/migrate-pi-layout-v2.mjs <dataDir>`（如 ~/.xyz-agent、~/.xyz-agent-dev）。
 * 不在 app 启动路径；推荐时序 = 先迁后升（关闭应用 → 跑脚本 → 装新版）。
 * 「先升后迁」（agent/ 已存在）由步骤 2b 分域并道处理；中断由步骤 0c 续传分支处理。
 *
 * 六步（§6.11，每步幂等，失败即人工可见、修因后重跑安全）：
 *   0. 前置检查：a. 实参形态（basename .xyz-agent* + pi 下含 agent|sessions 子目录）
 *                b. 运行中进程检测（pgrep -f 固定模式清单 + 本机 pi 二进制自证）
 *                c. 三判：pi 存在 → 首迁；无 pi 无备份 → 无需迁移；无 pi 有备份 → 续传
 *   1. rename(pi → pi.backup-v2-<ts>) 原子；备份即暂存，不二次改名
 *   2. agent 上移：2a agent/ 不存在 → 整体 rename；2b 已存在 → 分域并道
 *      （记录型子树文件级并入 / provider 三件套 keyed union + 防御式降级 /
 *        独立凭据 token* 新赢旧避让 / 其余单文件旧赢新避让 / 资源型目录存在即跳过）
 *   3. 分发主 session：备份 sessions/ 递归逐 .jsonl 读首行 header.cwd → encodeCwd 子目录；
 *      无/坏头 → _migrated-no-cwd/；sidecar 按 <basename>. 前缀随行
 *   4. 兼并更早布局 <dataDir>/sessions（同 3）
 *   5. 清除 agent/settings.json 的 sessionDir 覆盖位
 *   6. 迁移报告（计数 / 备份体积 / 回滚命令 / 冲突清单 / 顶层残片 / 旧备份清单）
 *
 * 测试：scripts/__tests__/migrate-pi-layout-v2.test.mjs（纯函数 + 依赖注入导出面，
 * fixture 全落 mkdtempSync tmpdir 自建自删，不触碰真实数据目录）。
 * 本脚本是旧布局字面量（pi/agent、pi/sessions 相对形态）的合法持有者（U18 豁免表登记）。
 */
import * as nodeFs from 'node:fs'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// ---------- 常量（§6.11 规格字面） ----------

/** 记录型子树（步骤 2b：文件级并入，uuid/manifest 命名，同名跳过） */
export const RECORD_SUBTREES = ['sessions', 'subagents', 'workflow-state']
/** 资源型目录（双侧皆为生成物：目标存在即跳过） */
export const RESOURCE_DIRS = ['npm', 'extensions', 'tmp']
/** 无 cwd session 收容目录（pi listAll / scanJsonlRecursive 按「任意子目录」枚举，可被发现） */
export const NO_CWD_DIR = '_migrated-no-cwd'
/** 备份名前缀（备份名内嵌创建序毫秒 ts，是续传分支的一手判据——v9.2 弃用 mtime 判据） */
export const BACKUP_PREFIX = 'pi.backup-v2-'
const BACKUP_NAME_RE = /^pi\.backup-v2-(\d+)$/

/**
 * 步骤 0b 进程检测固定模式清单（pgrep -f 对完整命令行做 ERE 匹配；node 脚本进程
 * comm = node，不带 -f 会全漏）。自证：本机 pi 二进制路径须被 pi 模式命中才继续
 * （§11.13：不依赖用户先验自证——孤儿 pi 恰是用户不知道的进程；清单失效必须修而不是漏检）。
 */
export const PROCESS_PATTERNS = [
  { label: 'pi binary（…/pi 或 …/pi.js 路径形态）', ere: '/pi(\\.js)?($| )' },
  { label: 'relay.mjs', ere: 'relay\\.mjs' },
  { label: 'TaiJi.app', ere: 'TaiJi\\.app' },
  { label: 'runtime node 入口（packages/runtime | runtime/dist）', ere: 'packages/runtime|runtime/dist' },
]
const PI_BINARY_PATTERN = PROCESS_PATTERNS[0].ere

/**
 * provider 三件套 keyed 域锚点（§12.3 实机形态核证，v9.3 锚定各文件真实域路径）：
 * auth.json = 顶层 keyed；models.json = `.providers` 一层之下；config/providers.json =
 * `.providers`（顶层另有 version:int / scopedModels:list 非域键伴随字段，形态预期登记在
 * asideSchemas——伴随字段非预期形态 = 该侧畸形，走防御式降级）。
 */
export const TRIPLET_SPECS = [
  { relPath: 'auth.json', domainPath: [], asideSchemas: {} },
  { relPath: 'models.json', domainPath: ['providers'], asideSchemas: {} },
  {
    relPath: 'config/providers.json',
    domainPath: ['providers'],
    asideSchemas: { version: 'number', scopedModels: 'array' },
  },
]

// ---------- 通用工具 ----------

export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
}

/**
 * 编码 cwd 为目录名——复刻 packages/runtime/src/infra/pi/pi-paths.ts:122-124 现有实现
 * （迁移脚本步骤 3 与 pi/fork/import 写侧共用同一编码规则，规则漂移 = 会话不可见）。
 * 规则：'--' + cwd 去掉首斜杠 + 所有 / \ : 替换为 - + '--'。
 */
export function encodeCwd(cwd) {
  return '--' + cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--'
}

/** tmp + rename 原子写（对齐 §6.12 spawn 清单写语义：写一半崩溃不损坏目标） */
export function writeAtomic(dest, content, fsMod) {
  const tmp = join(dirname(dest), `.${basename(dest)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`)
  fsMod.writeFileSync(tmp, content)
  fsMod.renameSync(tmp, dest)
}

export function measureTree(dir, fsMod) {
  let files = 0
  let bytes = 0
  const walk = (d) => {
    for (const e of fsMod.readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        files++
        bytes += fsMod.statSync(p).size
      }
    }
  }
  if (fsMod.existsSync(dir)) walk(dir)
  return { files, bytes }
}

function ensureParent(p, fsMod) {
  fsMod.mkdirSync(dirname(p), { recursive: true })
}

// ---------- 步骤 0a：实参形态校验 ----------

/**
 * basename 匹配 .xyz-agent* 且 `<dataDir>/pi` 下含 agent/ 或 sessions/ 子目录
 * （存在性判据而非「仅含」——防误传资源布局目录如 apps/electron/resources/pi）。
 * 续传模式 pi/ 不存在 → 形态判据自然跳过、仅 basename 校验生效。
 */
export function validateDataDirShape(dataDir, fsMod) {
  const base = basename(dataDir)
  if (!base.startsWith('.xyz-agent')) {
    return { ok: false, reason: `实参 basename "${base}" 不匹配 .xyz-agent*（防误传资源布局目录被 rename 破坏）` }
  }
  const piDir = join(dataDir, 'pi')
  if (!fsMod.existsSync(piDir)) return { ok: true }
  const hasAgent = fsMod.existsSync(join(piDir, 'agent'))
  const hasSessions = fsMod.existsSync(join(piDir, 'sessions'))
  if (!hasAgent && !hasSessions) {
    return {
      ok: false,
      reason: `<dataDir>/pi 存在但其下既无 agent/ 也无 sessions/ 子目录——不像旧布局数据目录（疑误传；旧布局判据 = 含 agent|sessions 子目录）`,
    }
  }
  return { ok: true }
}

// ---------- 步骤 0b：运行中进程检测 ----------

/** 默认 pgrep 探测（无命中时 pgrep exit 1，属正常路径非错误） */
function defaultExecPgrep(ere) {
  try {
    const stdout = execFileSync('pgrep', ['-f', ere], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return { status: 0, stdout }
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '' }
  }
}

/** 本机 pi 二进制解析（自证对象；which 不到 = 无 pi 可跑，漏检面不存在，见 detectRunningPiProcesses） */
function defaultResolvePiBinary() {
  try {
    const out = execFileSync('which', ['pi'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out || null
  } catch {
    return null
  }
}

/**
 * 跑全部 pgrep 模式聚合 PID；自证本机 pi 二进制路径被 pi 模式命中（清单失效 → 拒继续）。
 * 本机无 pi 二进制时自证对象不存在——「pi 进程漏检」在该机器上不可能发生，放行并注明。
 */
export function detectRunningPiProcesses({ execPgrep = defaultExecPgrep, resolvePiBinary = defaultResolvePiBinary } = {}) {
  const pidLabels = new Map()
  for (const { label, ere } of PROCESS_PATTERNS) {
    const r = execPgrep(ere)
    if (r && r.status === 0 && r.stdout) {
      for (const line of r.stdout.split('\n')) {
        const pid = line.trim()
        if (pid) pidLabels.set(pid, [...(pidLabels.get(pid) ?? []), label])
      }
    }
  }
  const piBinary = resolvePiBinary()
  if (piBinary) {
    const selfOk = new RegExp(PI_BINARY_PATTERN).test(piBinary)
    if (!selfOk) {
      return {
        ok: false,
        pids: [...pidLabels.keys()],
        selfCheck: { checked: true, ok: false, piBinary },
        reason: `自证失败：本机 pi 二进制 "${piBinary}" 不被 pi 模式清单命中（${PI_BINARY_PATTERN}）——进程检测清单失效，拒继续（修 PROCESS_PATTERNS 后重跑）`,
      }
    }
  }
  if (pidLabels.size > 0) {
    const lines = [...pidLabels.entries()].map(([pid, labels]) => `  pid ${pid}（${labels.join(', ')}）`)
    return {
      ok: false,
      pids: [...pidLabels.keys()],
      selfCheck: { checked: Boolean(piBinary), ok: true, piBinary },
      reason: `检测到疑似运行中的 pi / relay / TaiJi / runtime 进程——先关闭应用（或确认下列进程可终止）再重跑：\n${lines.join('\n')}`,
    }
  }
  return { ok: true, pids: [], selfCheck: { checked: Boolean(piBinary), ok: true, piBinary } }
}

// ---------- 步骤 0c：三判辅助 ----------

/** 列出全部 pi.backup-v2-<ts>，ts 降序（备份名内嵌 ts = 创建序一手判据，v9.2） */
export function listBackups(dataDir, fsMod) {
  if (!fsMod.existsSync(dataDir)) return []
  return fsMod
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && BACKUP_NAME_RE.test(e.name))
    .map((e) => {
      const ts = Number(BACKUP_NAME_RE.exec(e.name)[1])
      return { name: e.name, ts, path: join(dataDir, e.name) }
    })
    .sort((a, b) => b.ts - a.ts)
}

function allocateBackupTs(nowTs, existing, fsMod, dataDir) {
  let ts = nowTs
  while (existing.some((b) => b.ts === ts) || fsMod.existsSync(join(dataDir, BACKUP_PREFIX + ts))) ts++
  return ts
}

// ---------- 步骤 2b：provider 三件套 keyed union ----------

const TYPE_CHECKERS = {
  number: (v) => typeof v === 'number',
  array: (v) => Array.isArray(v),
  object: (v) => isPlainObject(v),
}

/**
 * 单侧健康性判定（§6.11 防御式降级的「畸形」定义）：JSON 已解析为 root 的前提下——
 * 顶层非 plain object / 域路径解析不到 / keyed 域非 plain object / 伴随字段非预期形态，
 * 任一命中即该侧畸形（整体取健康一侧）。
 */
function parseSideHealth(root, spec) {
  if (!isPlainObject(root)) return { ok: false, reason: '顶层非 object' }
  let node = root
  for (const seg of spec.domainPath) {
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, seg)) {
      return { ok: false, reason: `域路径 .${spec.domainPath.join('.')} 解析不到` }
    }
    node = node[seg]
  }
  if (!isPlainObject(node)) return { ok: false, reason: `keyed 域 .${spec.domainPath.join('.')} 非 object` }
  for (const [k, t] of Object.entries(spec.asideSchemas)) {
    if (Object.prototype.hasOwnProperty.call(root, k) && !TYPE_CHECKERS[t](root[k])) {
      return { ok: false, reason: `伴随字段 ${k} 非预期形态（预期 ${t}）` }
    }
  }
  return { ok: true, domain: node }
}

/** 伴随键 = 顶层非域路径键（domainPath 各段都不算伴随；顶层即域的文件——domainPath 为空——无伴随键） */
function asideKeysOf(root, spec) {
  if (spec.domainPath.length === 0) return []
  const domainSegs = new Set(spec.domainPath)
  return Object.keys(root).filter((k) => !domainSegs.has(k))
}

/** 按 domainPath 重建完整 root：伴随取 new 侧 + 域放回原路径 */
function rebuildRoot(newRoot, domain, spec) {
  if (spec.domainPath.length === 0) return domain
  const root = {}
  for (const k of asideKeysOf(newRoot, spec)) root[k] = newRoot[k]
  let node = root
  for (let i = 0; i < spec.domainPath.length - 1; i++) {
    node[spec.domainPath[i]] = {}
    node = node[spec.domainPath[i]]
  }
  node[spec.domainPath[spec.domainPath.length - 1]] = domain
  return root
}

/**
 * provider 三件套单文件 keyed union（§6.11 v9.3）：
 * - 双侧健康 → 域内逐 key union（key 只在一侧取该侧；双侧都有 → 新赢——凭据时效）；
 *   域外伴随字段取新侧（值不同才进冲突清单——运行时是新版代码在读，新侧与其 schema 自洽）；
 *   union 结果与主位现状深等 → skip（重跑幂等的关键：主位已含上次 union 结果时恒等）。
 * - 任一侧畸形 → 整体取健康一侧（旧坏 → take-new；新坏 → take-old；双坏 → leave-both 不动报人工，
 *   不产坏数据主位）。
 * 返回 { status, root?, conflicts, reasons? }；磁盘动作由调用方执行。
 */
export function unionProviderFile(oldRoot, newRoot, spec) {
  const hOld = parseSideHealth(oldRoot, spec)
  const hNew = parseSideHealth(newRoot, spec)
  if (!hOld.ok && !hNew.ok) {
    return {
      status: 'leave-both',
      conflicts: [],
      reasons: [hOld.reason, hNew.reason],
    }
  }
  if (!hOld.ok) {
    return {
      status: 'take-new',
      conflicts: [{ file: spec.relPath, type: 'file', direction: 'take-new', detail: `旧侧畸形（${hOld.reason}）→ 整体取新侧（旧侧原文件留在备份）` }],
      reasons: [hOld.reason],
    }
  }
  if (!hNew.ok) {
    return {
      status: 'take-old',
      conflicts: [{ file: spec.relPath, type: 'file', direction: 'take-old', detail: `新侧畸形（${hNew.reason}）→ 整体取旧侧（新侧避让为 *.new-v2-aside）` }],
      reasons: [hNew.reason],
    }
  }
  const domain = { ...hOld.domain, ...hNew.domain }
  const conflicts = []
  for (const k of Object.keys(hOld.domain)) {
    if (Object.prototype.hasOwnProperty.call(hNew.domain, k) && !deepEqual(hOld.domain[k], hNew.domain[k])) {
      conflicts.push({ file: spec.relPath, type: 'key', key: k, direction: 'new', detail: `provider "${k}" 双侧都有且值不同 → 取新侧凭据/定义` })
    }
  }
  for (const k of asideKeysOf(newRoot, spec)) {
    if (Object.prototype.hasOwnProperty.call(oldRoot, k) && !deepEqual(oldRoot[k], newRoot[k])) {
      conflicts.push({ file: spec.relPath, type: 'aside', key: k, direction: 'new', detail: `伴随字段 ${k} 双侧不同 → 取新侧` })
    }
  }
  const rebuilt = rebuildRoot(newRoot, domain, spec)
  if (deepEqual(rebuilt, newRoot)) return { status: 'skip', conflicts } // 无写动作；双侧差异仍照报冲突清单（事实陈述，供人工核对）
  return { status: 'union', root: rebuilt, conflicts }
}

// ---------- 步骤 2b：条目级分域搬移 ----------

function makeCounts() {
  return {
    filesMoved: 0,
    recordMoved: 0,
    recordSkipped: 0,
    sessionDistributed: 0,
    sessionNoCwd: 0,
    sessionSkipped: 0,
    sidecarsMoved: 0,
    sidecarSkipped: 0,
    resourcesSkipped: 0,
    resourcesMoved: 0,
    asidesCreated: 0,
    unionWrites: 0,
    unionSkipped: 0,
  }
}

function makeReport(dataDir) {
  return {
    mode: null,
    dataDir,
    backupPath: null,
    counts: makeCounts(),
    conflicts: [],
    fragments: [],
    oldBackups: [],
    manualIntervention: [],
    notices: [],
    processPatterns: PROCESS_PATTERNS.map((p) => p.label),
    selfCheck: null,
    sessionDirCleared: false,
    backupStats: null,
    rollbackCommand: null,
    aborted: null,
  }
}

/** 独立凭据文件（token* 等，无跨文件联动）双侧都有 → 新赢、旧侧避让 *.old-v2-aside */
function isIndependentCredential(rel) {
  return basename(rel).startsWith('token')
}

/** 三件套单文件并道（双侧解析 → union/降级 → tmp+rename 原子写目标） */
function migrateTripletFile(oldPath, newPath, spec, report, fsMod) {
  const readParsed = (p) => {
    if (!fsMod.existsSync(p)) return { exists: false }
    try {
      return { exists: true, root: JSON.parse(fsMod.readFileSync(p, 'utf8')) }
    } catch {
      return { exists: true, root: null } // JSON 解析失败 → root null → parseSideHealth 判畸形
    }
  }
  const oldSide = readParsed(oldPath)
  const newSide = readParsed(newPath)
  if (!oldSide.exists && !newSide.exists) return
  if (oldSide.exists && !newSide.exists) {
    ensureParent(newPath, fsMod)
    fsMod.renameSync(oldPath, newPath)
    report.counts.filesMoved++
    return
  }
  if (!oldSide.exists) return // 单侧新：主位已在其位

  const res = unionProviderFile(oldSide.root, newSide.root, spec)
  report.conflicts.push(...res.conflicts) // skip（无写动作）时同样进清单——换 key 等双侧差异必须可见
  if (res.status === 'skip') {
    report.counts.unionSkipped++
    return
  }
  if (res.status === 'leave-both') {
    report.manualIntervention.push(
      `三件套 ${spec.relPath} 双侧均畸形（旧侧：${res.reasons[0]}；新侧：${res.reasons[1]}）——未迁移、主位保持新侧原文件，人工核对备份 ${oldPath} 后处理`,
    )
    return
  }
  if (res.status === 'take-new') return // 新赢：主位已是新侧；旧侧完整文件天然留在备份
  if (res.status === 'take-old') {
    fsMod.renameSync(newPath, newPath + '.new-v2-aside') // 畸形新侧避让出主位
    report.counts.asidesCreated++
    ensureParent(newPath, fsMod)
    fsMod.renameSync(oldPath, newPath)
    report.counts.filesMoved++
    return
  }
  // union：tmp+rename 原子写
  ensureParent(newPath, fsMod)
  writeAtomic(newPath, JSON.stringify(res.root, null, 2) + '\n', fsMod)
  report.counts.unionWrites++
}

/**
 * 步骤 2b 条目级递归分域（rel 为相对 agent/ 的 posix 路径）：
 * 顶层目录按「记录型并入 / 资源型跳过或搬 / 其余递归」分流；文件按
 * 「三件套 union / token* 新赢旧避让 / 其余旧赢新避让」分流。
 * 双侧同值不产避让（同值非冲突——冲突清单只收值不同的真实冲突）。
 */
function migrateEntry(oldPath, newPath, rel, report, fsMod) {
  const st = fsMod.statSync(oldPath)
  const top = rel.split('/')[0]
  if (st.isDirectory()) {
    if (RECORD_SUBTREES.includes(top)) {
      mergeRecordTree(oldPath, newPath, report, fsMod)
      return
    }
    if (RESOURCE_DIRS.includes(top)) {
      if (fsMod.existsSync(newPath)) report.counts.resourcesSkipped++
      else {
        ensureParent(newPath, fsMod)
        fsMod.renameSync(oldPath, newPath)
        report.counts.resourcesMoved++
      }
      return
    }
    fsMod.mkdirSync(newPath, { recursive: true }) // 目标目录本身先建，子条目 rename 才可达
    for (const e of fsMod.readdirSync(oldPath, { withFileTypes: true })) {
      migrateEntry(join(oldPath, e.name), join(newPath, e.name), `${rel}/${e.name}`, report, fsMod)
    }
    return
  }
  // 文件
  const spec = TRIPLET_SPECS.find((s) => s.relPath === rel)
  if (spec) {
    migrateTripletFile(oldPath, newPath, spec, report, fsMod)
    return
  }
  if (!fsMod.existsSync(newPath)) {
    ensureParent(newPath, fsMod)
    fsMod.renameSync(oldPath, newPath)
    report.counts.filesMoved++
    return
  }
  const same = deepEqual(safeParse(fsMod, oldPath), safeParse(fsMod, newPath))
  if (isIndependentCredential(rel)) {
    if (same) return // 双侧同值非冲突，主位已是同内容
    fsMod.renameSync(oldPath, newPath + '.old-v2-aside') // 新赢：主位保持新侧，旧侧避让
    report.counts.asidesCreated++
    report.conflicts.push({ file: rel, type: 'file', direction: 'new-wins-old-aside', detail: `独立凭据双侧都有 → 主位取新侧，旧侧避让为 ${basename(rel)}.old-v2-aside` })
    return
  }
  if (same) return
  fsMod.renameSync(newPath, newPath + '.new-v2-aside') // 旧赢：新侧避让
  report.counts.asidesCreated++
  fsMod.renameSync(oldPath, newPath)
  report.counts.filesMoved++
  report.conflicts.push({ file: rel, type: 'file', direction: 'old-wins-new-aside', detail: `配置双侧都有 → 主位取旧侧（数月累积定制），新侧避让为 ${basename(rel)}.new-v2-aside` })
}

function safeParse(fsMod, p) {
  try {
    return JSON.parse(fsMod.readFileSync(p, 'utf8'))
  } catch {
    return undefined
  }
}

/** 记录型子树文件级并入（uuid/manifest 命名；同名跳过并计数；encodeCwd 同名子目录内部自然合并） */
export function mergeRecordTree(oldDir, newDir, report, fsMod) {
  if (!fsMod.existsSync(oldDir)) return
  fsMod.mkdirSync(newDir, { recursive: true })
  for (const e of fsMod.readdirSync(oldDir, { withFileTypes: true })) {
    const s = join(oldDir, e.name)
    const d = join(newDir, e.name)
    if (e.isDirectory()) {
      fsMod.mkdirSync(d, { recursive: true }) // 目标子目录本身必须存在，rename 到其内文件才不 ENOENT
      mergeRecordTree(s, d, report, fsMod)
    } else if (fsMod.existsSync(d)) {
      report.counts.recordSkipped++
    } else {
      fsMod.renameSync(s, d)
      report.counts.recordMoved++
    }
  }
}

// ---------- 步骤 3/4：主 session 分发 ----------

/**
 * 读 .jsonl 首行 header（64KB 内首行）：type==='session' 且 cwd 非空 string → { cwd }；
 * 否则 { cwd: null }（坏 JSON / 非 session 头 / 无 cwd / 空文件同归无 cwd 分支）。
 */
export function parseSessionHeader(file, fsMod) {
  try {
    const fd = fsMod.openSync(file, 'r')
    const buf = Buffer.alloc(65536)
    const n = fsMod.readSync(fd, buf, 0, buf.length, 0)
    fsMod.closeSync(fd)
    const firstLine = buf.subarray(0, n).toString('utf8').split('\n', 1)[0]
    const obj = JSON.parse(firstLine)
    if (obj && obj.type === 'session' && typeof obj.cwd === 'string' && obj.cwd.length > 0) return { cwd: obj.cwd }
    return { cwd: null }
  } catch {
    return { cwd: null }
  }
}

/**
 * 递归分发 srcRoot 下每个 .jsonl（平铺层 + encodeCwd 形态子目录）：
 * 有 cwd → destRoot/<encodeCwd(cwd)>/<basename>；无/坏头 → destRoot/_migrated-no-cwd/<basename>。
 * sidecar 随行 = <basename>. 前缀的全部兄弟文件（前缀匹配而非后缀白名单——.handoff.json 等
 * 仓内功能 sidecar 白名单必漏）；sidecar 判定排除 .jsonl 后缀（.jsonl 一律按主文件独立走
 * header 分发，杜绝同一文件被双规则处理）。目标已存在同名 → 跳过并计数。
 * 主文件跳过不吞 sidecar 随行（2026-09 design-code-sync F3）：skip 仍执行随行循环——
 * 源与目标同 id 并存（窗口写入/双源同名兼并）时补搬漏搬 sidecar，随行循环是补搬的
 * 唯一通路；sidecar 自身的目标已存在检查保证幂等（已搬侧 sidecarSkipped，零重复动作）。
 * 中断续传态不经此通路（纯 rename 后 kill），由备份残留 + doctor 兜底。
 */
export function distributeSessions(srcRoot, destRoot, report, fsMod) {
  if (!fsMod.existsSync(srcRoot)) return
  const entries = fsMod.readdirSync(srcRoot, { withFileTypes: true })
  for (const e of entries) {
    const s = join(srcRoot, e.name)
    if (e.isDirectory()) {
      distributeSessions(s, destRoot, report, fsMod)
      continue
    }
    if (!e.name.endsWith('.jsonl')) continue
    const { cwd } = parseSessionHeader(s, fsMod)
    const targetDir = cwd ? join(destRoot, encodeCwd(cwd)) : join(destRoot, NO_CWD_DIR)
    const d = join(targetDir, e.name)
    if (fsMod.existsSync(d)) {
      report.counts.sessionSkipped++ // 主文件不搬（目标已在位），sidecar 随行继续执行
    } else {
      fsMod.mkdirSync(targetDir, { recursive: true })
      fsMod.renameSync(s, d)
      if (cwd) report.counts.sessionDistributed++
      else report.counts.sessionNoCwd++
    }
    for (const sib of entries) {
      if (!sib.name.startsWith(e.name + '.') || sib.name.endsWith('.jsonl')) continue
      const sd = join(targetDir, sib.name)
      if (fsMod.existsSync(sd)) {
        report.counts.sidecarSkipped++
        continue
      }
      fsMod.renameSync(join(srcRoot, sib.name), sd)
      report.counts.sidecarsMoved++
    }
  }
}

// ---------- 步骤 5：sessionDir 覆盖位清除 ----------

/** agent/settings.json 的 sessionDir 是 pi 优先级链第 3 位的静默覆盖位——不清除则任何写入者都能让默认派生失效 */
function clearSessionDirOverride(settingsPath, report, fsMod, log) {
  if (!fsMod.existsSync(settingsPath)) return false
  const parsed = safeParse(fsMod, settingsPath)
  if (parsed === undefined) {
    report.notices.push(`agent/settings.json 解析失败，sessionDir 清除跳过（人工核对）：${settingsPath}`)
    return false
  }
  if (isPlainObject(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'sessionDir')) {
    const removed = parsed.sessionDir // delete 前先存原值：log 在 delete 之后执行，直接读 parsed 恒为 fallback
    delete parsed.sessionDir
    writeAtomic(settingsPath, JSON.stringify(parsed, null, 2) + '\n', fsMod)
    log(`已清除 agent/settings.json 的 sessionDir 覆盖位（原值：${JSON.stringify(removed ?? '(已删)')} 之前的值见备份）`)
    return true
  }
  return false
}

// ---------- 主编排 ----------

/**
 * 全流程（依赖注入：fsMod / execPgrep / resolvePiBinary / now / log——测试用 tmp fixture
 * 直挂，CLI 用真实实现）。返回结构化报告；aborted 非空 = 前置检查拦截（exit 1 语义）。
 */
export function runMigration(opts = {}) {
  const {
    dataDir,
    fsMod = nodeFs,
    execPgrep = defaultExecPgrep,
    resolvePiBinary = defaultResolvePiBinary,
    now = () => Date.now(),
    log = () => {},
  } = opts
  const fs = fsMod
  const report = makeReport(dataDir)

  // 0a 实参形态
  const shape = validateDataDirShape(dataDir, fs)
  if (!shape.ok) {
    report.aborted = { step: '0a', reason: shape.reason }
    return report
  }
  // 0b 进程检测
  const proc = detectRunningPiProcesses({ execPgrep, resolvePiBinary })
  report.selfCheck = proc.selfCheck
  if (!proc.ok) {
    report.aborted = { step: '0b', reason: proc.reason, pids: proc.pids }
    return report
  }
  // 0c 三判
  const backups = listBackups(dataDir, fs)
  const piDir = join(dataDir, 'pi')
  let backupPath
  if (fs.existsSync(piDir)) {
    const ts = allocateBackupTs(now(), backups, fs, dataDir)
    backupPath = join(dataDir, BACKUP_PREFIX + ts)
    report.mode = 'migrate'
    if (backups.length > 0) {
      report.notices.push(`检测到 ${backups.length} 份既有备份（${backups.map((b) => b.name).join(', ')}）——本次新建备份续迁，旧备份残部见报告「旧备份清单」`)
    }
    fs.renameSync(piDir, backupPath) // 步骤 1：原子；备份即暂存，不再二次改名
    report.backupPath = backupPath
  } else if (backups.length === 0) {
    report.mode = 'nothing'
    return report
  } else {
    report.mode = 'resume'
    backupPath = backups[0].path // 备份名内嵌 ts 最大的一份幂等重入
    report.backupPath = backupPath
    if (backups.length > 1) {
      report.notices.push(`续传模式：检测到 ${backups.length} 份备份，取 ts 最大者 ${backups[0].name} 重入；其余见「旧备份清单」`)
    }
  }

  // 步骤 2：agent 上移
  const agentNew = join(dataDir, 'agent')
  const agentOld = join(backupPath, 'agent')
  if (fs.existsSync(agentOld)) {
    if (!fs.existsSync(agentNew)) {
      fs.renameSync(agentOld, agentNew) // 2a 先迁后升：配置域整体上移
      report.counts.filesMoved++
    } else {
      for (const e of fs.readdirSync(agentOld, { withFileTypes: true })) {
        migrateEntry(join(agentOld, e.name), join(agentNew, e.name), e.name, report, fs) // 2b 分域并道
      }
    }
  }

  // 步骤 3：备份 sessions 分发；步骤 4：旧旧布局 <dataDir>/sessions 兼并（同法）
  const sessionsNew = join(agentNew, 'sessions')
  distributeSessions(join(backupPath, 'sessions'), sessionsNew, report, fs)
  distributeSessions(join(dataDir, 'sessions'), sessionsNew, report, fs)

  // 步骤 5：sessionDir 覆盖位清除
  report.sessionDirCleared = clearSessionDirOverride(join(agentNew, 'settings.json'), report, fs, log)

  // 步骤 6：报告装配
  report.fragments = listFragments(backupPath, fs)
  report.oldBackups = backups
    .filter((b) => b.path !== backupPath)
    .map((b) => ({ name: b.name, ...measureTree(b.path, fs) }))
  report.backupStats = measureTree(backupPath, fs)
  report.rollbackCommand = `rm -rf "${agentNew}" && mv "${backupPath}" "${piDir}"  # 或先 mv agent agent.pre-rollback 再 mv 备份回 pi`
  return report
}

/** 顶层残片 = pi/ 顶层不在 agent|sessions 内的条目（dev 实测 2B 空壳等；不迁移、留备份、列报告供人工确认可忽略） */
function listFragments(backupPath, fsMod) {
  if (!fsMod.existsSync(backupPath)) return []
  return fsMod
    .readdirSync(backupPath, { withFileTypes: true })
    .filter((e) => e.name !== 'agent' && e.name !== 'sessions')
    .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
}

// ---------- 报告渲染（步骤 6） ----------

/** 中止段（步骤 0 前置校验失败）：中止原因 + 命中的 pi 进程 PID（可选）。 */
function formatAbortedLines(aborted) {
  const lines = [`✗ 迁移中止（步骤 ${aborted.step}）：${aborted.reason}`]
  if (aborted.pids?.length) lines.push(`命中 PID：${aborted.pids.join(', ')}`)
  return lines
}

/** 备份体积段：backupStats 缺失（中止 / 无需迁移路径）时不出行。 */
function formatBackupStatsLines(report) {
  if (!report.backupStats) return []
  return [
    `备份体积：${report.backupStats.files} 个文件 / ${report.backupStats.bytes} 字节（清理指引见 docs/TROUBLESHOOTING.md 迁移节；备份不自动删）`,
  ]
}

/** 计数段：各计数维度单行汇总（维度顺序按可读性排列，勿调）。 */
function formatCountsLine(report) {
  const c = report.counts
  return `计数：主 session 分发 ${c.sessionDistributed}（其中无 cwd 入 _migrated-no-cwd/ ${c.sessionNoCwd}）、主 session 跳过 ${c.sessionSkipped}、sidecar 随行 ${c.sidecarsMoved}（跳过 ${c.sidecarSkipped}）、记录型并入 ${c.recordMoved}（跳过 ${c.recordSkipped}）、单文件搬移 ${c.filesMoved}、资源目录搬移 ${c.resourcesMoved}（跳过 ${c.resourcesSkipped}）、三件套 union 写回 ${c.unionWrites}（无变化跳过 ${c.unionSkipped}）、避让文件 ${c.asidesCreated}`
}

/** 回滚命令段：单行可复制命令（先删 agent 上移结果，再把备份搬回 pi/）。 */
function formatRollbackLine(report) {
  return `回滚命令：${report.rollbackCommand}`
}

/** 自证段：pi 二进制自证结果（未走自证校验时不出行）。 */
function formatSelfCheckLines(report) {
  if (!report.selfCheck) return []
  return [
    report.selfCheck.checked
      ? `自证：本机 pi 二进制 ${report.selfCheck.piBinary} 已命中 pi 模式`
      : `自证：本机未找到 pi 二进制（which pi 失败）——pi 进程漏检面不存在`,
  ]
}

/** 冲突清单段：冲突逐条 + 需人工处理项（可选）。 */
function formatConflictLines(report) {
  const lines = [
    `冲突清单（${report.conflicts.length} 条；迁移后鉴权异常或 provider 列表缺项，先查三件套的 aside 文件与本清单）：`,
  ]
  for (const cf of report.conflicts) lines.push(`  - [${cf.file}] ${cf.detail}`)
  if (report.manualIntervention.length > 0) {
    lines.push(`需人工处理（${report.manualIntervention.length} 条）：`)
    for (const m of report.manualIntervention) lines.push(`  ! ${m}`)
  }
  return lines
}

/** 顶层残片段：残片清单（空则「（无）」）。 */
function formatFragmentsLine(report) {
  return `顶层残片清单（pi/ 顶层不在 agent|sessions 内的条目，不迁移、留在备份，供人工确认可忽略）：${report.fragments.length ? report.fragments.join(', ') : '（无）'}`
}

/** 旧备份清单段：本次之前的备份逐条（无则单行「（无更早备份）」）。 */
function formatOldBackupLines(report) {
  if (report.oldBackups.length === 0) return ['旧备份清单：（无更早备份）']
  const lines = [`本次之前的旧备份（复合态残部不被任何分支消费，请核对残部）：`]
  for (const b of report.oldBackups) lines.push(`  - ${b.name}：${b.files} 个文件 / ${b.bytes} 字节`)
  return lines
}

/** 提示段：notices 逐条（无则空数组）。 */
function formatNoticeLines(report) {
  return report.notices.map((n) => `ℹ ${n}`)
}

/**
 * 报告装配：只负责各段顺序 + join（分段构造——原单函数 cyclomatic 16 已拆到各段
 * helper，每段无交叉状态）。文案 / 行序 / 空行是下游契约，改任何一段前先跑
 * scripts/__tests__/migrate-pi-layout-v2.test.mjs。
 */
export function formatReport(report) {
  if (report.aborted) return formatAbortedLines(report.aborted).join('\n')
  if (report.mode === 'nothing') return '✓ 无需迁移：<dataDir>/pi 与 pi.backup-v2-* 均不存在（全新安装形态）'
  return [
    `== pi 布局迁移报告 ==`,
    `模式：${report.mode === 'migrate' ? '首迁' : '续传（重入 ts 最大备份）'}`,
    `数据目录：${report.dataDir}`,
    `备份路径：${report.backupPath}`,
    ...formatBackupStatsLines(report),
    formatCountsLine(report),
    formatRollbackLine(report),
    `进程检测模式清单（pgrep -f）：${report.processPatterns.join(' ; ')}`,
    ...formatSelfCheckLines(report),
    ...formatConflictLines(report),
    formatFragmentsLine(report),
    ...formatOldBackupLines(report),
    ...formatNoticeLines(report),
  ].join('\n')
}

// ---------- CLI 入口（薄包装；vitest import 导出面时不触发） ----------

function main() {
  const arg = process.argv[2]
  if (!arg) {
    console.error('用法: node scripts/migrate-pi-layout-v2.mjs <dataDir>\n  <dataDir> 形如 ~/.xyz-agent 或 ~/.xyz-agent-dev（先关闭应用再运行）')
    process.exit(1)
  }
  const report = runMigration({ dataDir: resolvePath(arg), log: console.log })
  console.log(formatReport(report))
  process.exit(report.aborted ? 1 : 0)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href
if (isMain) main()
