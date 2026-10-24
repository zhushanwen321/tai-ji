#!/usr/bin/env node
/**
 * 存量磁盘孤儿清扫（session-identity-visibility-state 设计 §5-W5 清扫项 / §7 项 14 / §1.5 E-21）。
 *
 * 背景：session 存储树 `<dataDir>/ext-sessions/<sessionId>/`（ADR-0141）在历史版本里留下四族
 * 孤儿一级目录（E-21）：族① `btw-create-*`、族② `btw-attach-*`（vid 含冒号过不了
 * isPiSessionId → 迁移 early-return）、族③ `ephemeral-*`（从不 rekey）、族④ 主会话 tempId
 * 空目录（迁移只回收 logs/ 叶子、父目录永久留空，最大一族）。族③族④的新增来源已由 u-w3.5
 * （migratePiSessionLogTree 连父目录回收 + withEphemeralPi finally 自清理）根治；本脚本只承接
 * **存量**清扫，不处理新增。
 *
 * 清扫三条件（同时成立才删；§5-W5 最小安全形态）：
 *   ① 目录内**仅** `logs/` 或为空——有兄弟域（attachments / canvases / btw / …）= 有内容，
 *      一律不碰；
 *   ② 目录名不属于任何已注册/已扫描会话 id——脚本无法读 runtime 内存注册表，id 集合取自磁盘
 *      上 scanner 与 btw rebuild 的同一读取源（pi 会话文件 header + btw 线文件 header）；
 *   ③ mtime 早于保留期。mtime 主语 = 目录内 `logs/*.jsonl` 的最新 mtime，无 jsonl 取目录
 *      自身 mtime（轮转段 `.jsonl.N.gz` 不算 jsonl）。
 *
 * 保留期数值 = `readLogKeepDays()`（默认 7 天，env `TAIJI_LOG_KEEP_DAYS` 可覆盖；
 * shared/src/constants.ts:441/455，与 cleanExpiredLogs 同一读取函数。本脚本为 ESM、scripts/
 * 无构建链不可 import TS 源，按同语义镜像实现）。
 *
 * 删除形态：经目录级端口 `ISessionStore.trashDirectory`（services/ports/session.ts:240，
 * 实现 infra/system/trash.ts:91）移入回收站——**失败 = 目录保留原地 + 结构化错误上抛**
 * （fail-fast：端口契约「可撤销操作永不静默变不可逆」由构造保证，禁用「降级硬删 + warn」）；
 * 非 mac 平台 rmSync 递归删是该端口内的设计内平台分支（无恢复通道），不是降级路径。本脚本
 * 无法 import TS 端口（同 zcode-session-db-cleanup.mjs 先例：scripts/ 无构建链），按端口同
 * 语义镜像实现 `createTrashDirectoryPort`——契约形状一致（Promise 语义 / 失败保留原地 /
 * 结构化错误上抛 / mac 双通道 trash CLI → Finder AppleScript / 非 mac rmSync recursive），
 * 出站子进程 env 只透传 PATH（端口侧经 buildOutboundChildEnv 剥凭证，脚本侧以最小 env 达成
 * 同等防外泄效果）。
 *
 * 不另造前缀白名单：四族名字都能过 isPiSessionId（`btw-create-<uuid>` / `btw-attach-<uuid>` /
 * `ephemeral-<ts>-<uuid>` / v4 UUID 全是合法形态），前缀清单既漏未来新族、又把判据退化成名单
 * 维护；与 cleanExpiredLogs（infra/logger.ts:401-415）的树内遍历规约对齐——一级目录名非合法
 * sessionId 形态一律跳过（手放的非会话目录归外部，不代删）。
 *
 * 半途失败账目（§7 项 14）：逐目录 attempt、**失败继续**（不全停）；收到结构化错误的目录记入
 * 失败集合 F（留痕进点检记录，判别器 = 结构化错误的 category 分类字段，无留痕不可审计）；
 * F 内目录不进删除集、不计漏删；**F 非空 = 点检存量全集时判环境故障、整轮重来**（重跑时点检
 * 与删除清单重新求值，不重放上次冻结清单——端口对不存在路径上抛，重放必撞）。本轮 exit 2。
 *
 * 防误触：默认 dry-run（只读点检 + 打印删除清单）；真实删除须显式 `--apply`。目标位于 prod
 * 数据树（`~/.taiji`）内时 `--apply` 还须显式 `--allow-prod`（C-proc-26「prod 只能被显式声明
 * 触达」）；dry-run 只读不改任何数据，prod 树亦不禁读（打印醒目提示）。
 *
 * 点检记录（§7 项 14 ④）：`--record <path>` 落 JSON，逐条标注每个一级目录的三条件判定与证据
 * （形态 / mtime 主语与取值 / id 集合成员性），删除清单在点检时求值一次后冻结；验收方据记录
 * 独立复算「删除集 = 三条件命中的存量全集」（等号形态，漏删与多删都红），不采信脚本自报分类。
 *
 * 自检：`--selftest` 在 os.tmpdir() 下构造 tmp 树（六形态：空目录 / 仅 logs / 有兄弟域 /
 * 活跃会话树 / 保留期内新树 / 端口失败注入，外加非 sessionId 名、logs 是文件、btw 线树、
 * 仅轮转 gz、jsonl 新鲜但目录旧、tmp 残留文件名等边界），注入假端口，断言删除集等号 +
 * 零误删 + F 留痕 + prod 护栏。禁触真实数据目录（`~/.taiji` / `~/.taiji-dev`）——全部树走
 * mkdtemp，假 homeDir 注入。
 *
 * 用法：
 *   node scripts/sweep-orphan-session-dirs.mjs [--data-dir <path>] [--record <path>] [--json]
 *   node scripts/sweep-orphan-session-dirs.mjs --apply [--allow-prod] [--record <path>] [--json]
 *   node scripts/sweep-orphan-session-dirs.mjs --selftest
 */

import { execFileSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 常量（全局唯一定义处；与 TS 侧同值镜像，一致性靠注释锚点 + 自检锁定） ──────────

/** session 存储树根段名（`<dataDir>/<本段>/`，ADR-0141；shared session-store-paths.ts 同值）。 */
const SESSION_STORE_DIR_SEGMENT = 'ext-sessions'

/** pi 会话 id 同域校验正则（镜像 shared session-store-paths.ts PI_SESSION_ID_PATTERN）。 */
const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

/** 崩溃/导入残留文件名的精确形态（镜像 runtime session-residue-cleanup.ts TMP_RESIDUE_NAME_RE）。 */
const TMP_RESIDUE_NAME_RE = /\.tmp-(?:migrate|import)-\d+\.jsonl$/

/** 数据目录根名（prod / dev；shared paths.ts DATA_DIR_ROOT_NAMES 同值镜像）。 */
const DATA_DIR_ROOT_NAMES = { prod: '.taiji', dev: '.taiji-dev' }

/** 日志保留天数默认值（shared constants.ts DEFAULT_LOG_KEEP_DAYS 同值镜像）。 */
const DEFAULT_LOG_KEEP_DAYS = 7

/** 毫秒/天。 */
const MS_PER_DAY = 86_400_000

/** session header 首行读取上限（header 远小于此；超限按无 header 跳过并计数）。 */
const HEADER_READ_BYTES = 65_536

/** 树内 logs 域名（ADR-0141 域 9）。 */
const LOGS_DIR_NAME = 'logs'

/** session 文件后缀。 */
const JSONL_SUFFIX = '.jsonl'

/** header 首行 type 字段值（runtime isSessionHeaderEntry 同值）。 */
const SESSION_HEADER_TYPE = 'session'

/** mac 废纸篓通道：Finder AppleScript 回落脚本（infra/system/trash.ts FINDER_DELETE_SCRIPT 同值）。 */
const FINDER_DELETE_SCRIPT = 'on run argv\ntell application "Finder" to delete POSIX file (item 1 of argv)\nend run'

/** trash CLI / osascript 超时（infra/system/trash.ts 同值 5s）。 */
const TRASH_TIMEOUT_MS = 5_000

/** 退出码：清扫完成且失败集合为空。 */
const EXIT_OK = 0

/** 退出码：用法错误 / prod 未显式声明 / 自检断言失败。 */
const EXIT_USAGE = 1

/** 退出码：清扫已执行但失败集合 F 非空 = 环境故障，整轮重来。 */
const EXIT_ENV_FAILURE = 2

/** 自检构造的「早于保留期」偏移（天）。30 天 ≫ 默认保留期 7 天；env 被误设为非正数时自检按红处理。 */
const SELFTEST_OLD_DAYS = 30

const USAGE = `用法：
  node scripts/sweep-orphan-session-dirs.mjs [--data-dir <path>] [--record <path>] [--json]
  node scripts/sweep-orphan-session-dirs.mjs --apply [--allow-prod] [--record <path>] [--json]
  node scripts/sweep-orphan-session-dirs.mjs --selftest
`

// ── 路径 / env 推导（镜像 shared paths.ts 与 constants.ts 语义） ──────────────────

function toMessage(e) {
  return e instanceof Error ? e.message : String(e)
}

function isPathWithinTree(candidate, root, { casefold = false } = {}) {
  const a = casefold ? candidate.toLowerCase() : candidate
  const b = casefold ? root.toLowerCase() : root
  return a === b || a.startsWith(b + sep)
}

/** pi 会话 id 同域校验（shared session-store-paths.ts isPiSessionId 同值镜像）。 */
export function isPiSessionId(name) {
  return PI_SESSION_ID_PATTERN.test(name)
}

/** scanner 应收录的 session 文件名（runtime isScannableSessionFile 同值镜像：排除 tmp 残留家族）。 */
export function isScannableSessionFile(name) {
  return name.endsWith(JSONL_SUFFIX) && !TMP_RESIDUE_NAME_RE.test(name)
}

/** 日志保留天数：env `TAIJI_LOG_KEEP_DAYS` 覆盖 || 默认 7（shared constants.ts readLogKeepDays 同值镜像）。 */
export function readLogKeepDays(env = process.env) {
  return Number(env.TAIJI_LOG_KEEP_DAYS) || DEFAULT_LOG_KEEP_DAYS
}

/** 保留期取值来源（点检记录用：区分 env 覆盖与缺省）。 */
export function keepDaysSource(env = process.env) {
  const raw = env.TAIJI_LOG_KEEP_DAYS
  if (raw === undefined || raw === '') return `default(DEFAULT_LOG_KEEP_DAYS=${DEFAULT_LOG_KEEP_DAYS})`
  return `env(TAIJI_LOG_KEEP_DAYS=${raw})`
}

/**
 * 数据目录 / 存储树根解析（shared paths.ts getDataDir 缺省反转的同值镜像 + prod 树判定）。
 *
 * 缺省 = `<homeDir>/.taiji-dev`（裸跑一律落 dev 树，结构性杜绝脚本默认写 prod）；
 * `--data-dir` 显式覆盖优先于 env（自检与人工点检指定 tmp 树用）。
 */
export function resolveStoreRoot(env = process.env, { dataDir, homeDir = homedir() } = {}) {
  const raw = dataDir ?? env.TAIJI_AGENT_DATA_DIR ?? ''
  const resolvedDataDir = raw ? resolve(raw) : join(homeDir, DATA_DIR_ROOT_NAMES.dev)
  const prodRoot = join(homeDir, DATA_DIR_ROOT_NAMES.prod)
  return {
    dataDir: resolvedDataDir,
    storeRoot: join(resolvedDataDir, SESSION_STORE_DIR_SEGMENT),
    prodRoot,
    inProdTree: isPathWithinTree(resolvedDataDir, prodRoot, { casefold: true }),
  }
}

// ── 活跃会话 id 集合（条件② 的取数源） ────────────────────────────────────────

/**
 * 读 session JSONL 首行 header 的 id（runtime parseSessionHeader 的同值镜像：只读首行、
 * 容错归 null）。返回值 null = 无 header（读失败 / JSON 损坏 / type 非 session / 缺 id 字段），
 * 调用方计数留痕，不静默吞。
 */
function readSessionHeaderId(filePath) {
  let fd
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(HEADER_READ_BYTES)
    const bytesRead = readSync(fd, buf, 0, HEADER_READ_BYTES, 0)
    const text = buf.toString('utf8', 0, bytesRead)
    const newline = text.indexOf('\n')
    const firstLine = newline === -1 ? text : text.slice(0, newline)
    if (!firstLine) return null
    const entry = JSON.parse(firstLine)
    if (entry?.type !== SESSION_HEADER_TYPE) return null
    return typeof entry.id === 'string' ? entry.id : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function addHeaderId(filePath, ids, sources, key, notes) {
  const id = readSessionHeaderId(filePath)
  if (id === null) {
    notes.push(`无法解析 session header（跳过，不计入 id 集合）：${filePath}`)
    return
  }
  sources[key] += 1
  ids.add(id)
}

/** pi 宿主会话文件（`<dataDir>/agent/sessions/`）——scanSessions 的磁盘读取源。 */
function collectPiSessionIds(sessionsDir, ids, sources, notes) {
  let dirents
  try {
    dirents = readdirSync(sessionsDir, { withFileTypes: true })
  } catch {
    return // sessions/ 不存在（首启形态）= 无 pi 会话可收录
  }
  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      let files = []
      try {
        files = readdirSync(join(sessionsDir, dirent.name))
      } catch (e) {
        notes.push(`cwd 分组目录不可读（跳过）：${join(sessionsDir, dirent.name)}（${toMessage(e)}）`)
        continue
      }
      for (const file of files) {
        if (!isScannableSessionFile(file)) continue
        addHeaderId(join(sessionsDir, dirent.name, file), ids, sources, 'piSessionFiles', notes)
      }
    } else if (dirent.isFile() && isScannableSessionFile(dirent.name)) {
      addHeaderId(join(sessionsDir, dirent.name), ids, sources, 'piSessionFiles', notes)
    }
  }
}

/** btw 线会话文件（`<root>/<mainSid>/btw/`）——rebuildFromDisk 的磁盘读取源。 */
function collectBtwLineIds(btwDir, ids, sources, notes) {
  let files = []
  try {
    files = readdirSync(btwDir)
  } catch {
    return // 无 btw 域目录（常态）→ 跳过
  }
  for (const file of files) {
    if (!file.endsWith(JSONL_SUFFIX)) continue
    addHeaderId(join(btwDir, file), ids, sources, 'btwLineFiles', notes)
  }
}

/**
 * 活跃会话 id 集合 = pi 会话文件 header id ∪ btw 线文件 header id。
 *
 * 边界（登记接受，写入点检记录供验收方判断）：① runtime 内存注册表外部脚本不可读，已注册但
 * pi 尚未首 flush 的会话（规则 #6 延迟写入窗口）无 jsonl 可收——由条件③ 的 mtime 保留期兜底
 * （tee 日志在建线即时落盘，窗口内 mtime 必然新鲜）；② 归档会话不在 scanner 读取范围
 * （只扫 sessions/），其资产已随归档单元搬去 `<agentDir>/archive/`，残留的 logs-only 旧树
 * 按三条件判孤儿可回收，unarchive 会重建树。
 */
export function collectActiveSessionIds({ dataDir, storeRoot, entries }) {
  const ids = new Set()
  const sources = { piSessionFiles: 0, btwLineFiles: 0 }
  const notes = []
  collectPiSessionIds(join(dataDir, 'agent', 'sessions'), ids, sources, notes)
  for (const entry of entries) {
    if (!entry.isDirectory || !isPiSessionId(entry.name)) continue
    collectBtwLineIds(join(storeRoot, entry.name, 'btw'), ids, sources, notes)
  }
  return { ids, sources, notes }
}

// ── 点检（三条件判定 + 删除清单冻结） ─────────────────────────────────────────

/** 存储树根一级列举（根不存在 = 零存量，合法但须留点检记录证明真跑过）。 */
export function listTopLevelEntries(storeRoot) {
  try {
    const dirents = readdirSync(storeRoot, { withFileTypes: true })
    return {
      entries: dirents.map((d) => ({ name: d.name, isDirectory: d.isDirectory(), isSymbolicLink: d.isSymbolicLink() })),
      note: null,
    }
  } catch (e) {
    return { entries: [], note: `session 存储树根不存在或不可读（${toMessage(e)}）→ 按零存量处理` }
  }
}

/** 条件① 的形态判定：空 / 仅 logs（且 logs 是目录）/ 有兄弟域。 */
function describeForm(dirPath, names) {
  if (names.length === 0) return { form: 'empty', siblings: [] }
  if (names.length === 1 && names[0] === LOGS_DIR_NAME) {
    let logsIsDir = false
    try {
      logsIsDir = lstatSync(join(dirPath, LOGS_DIR_NAME)).isDirectory()
    } catch {
      logsIsDir = false
    }
    if (logsIsDir) return { form: 'logs-only', siblings: [] }
  }
  return { form: 'has-siblings', siblings: names }
}

/** 条件③ 的 mtime 主语：logs/*.jsonl 最新 mtime；无 jsonl 取目录自身 mtime。 */
function resolveMtimeSubject(dirPath) {
  const logsDir = join(dirPath, LOGS_DIR_NAME)
  const notes = []
  let files = []
  try {
    files = readdirSync(logsDir)
  } catch {
    files = [] // logs/ 缺失（空目录形态）→ 无 jsonl
  }
  let latestJsonl = null
  let jsonlCount = 0
  for (const file of files) {
    if (!file.endsWith(JSONL_SUFFIX)) continue
    jsonlCount += 1
    try {
      const st = statSync(join(logsDir, file))
      if (latestJsonl === null || st.mtimeMs > latestJsonl) latestJsonl = st.mtimeMs
    } catch (e) {
      notes.push(`logs/${file} stat 失败（${toMessage(e)}）`)
    }
  }
  if (latestJsonl !== null) return { mtimeMs: latestJsonl, mtimeSource: 'logs-jsonl', jsonlCount, notes }
  let dirMtime = null
  try {
    dirMtime = statSync(dirPath).mtimeMs
  } catch (e) {
    notes.push(`目录 stat 失败（${toMessage(e)}）`)
  }
  return { mtimeMs: dirMtime, mtimeSource: 'dir', jsonlCount, notes }
}

function annotateEntry({ storeRoot, entry, activeIds, cutoffMs }) {
  const dirPath = join(storeRoot, entry.name)
  const base = { name: entry.name, path: dirPath, isPiSessionId: isPiSessionId(entry.name) }
  if (!entry.isDirectory) {
    return {
      ...base,
      kind: entry.isSymbolicLink ? 'symlink' : 'non-dir',
      form: null,
      cond1: null,
      cond2: null,
      cond3: null,
      hit: false,
      skipReason: entry.isSymbolicLink
        ? '符号链接（不跟随、不代删）'
        : '非目录条目（存储树一级只应有会话目录）',
    }
  }
  let names = null
  let readNote = null
  try {
    names = readdirSync(dirPath)
  } catch (e) {
    readNote = `目录不可读（${toMessage(e)}）→ 保守判有兄弟域，不删`
  }
  const described = names === null ? { form: 'has-siblings', siblings: [] } : describeForm(dirPath, names)
  const mtime = resolveMtimeSubject(dirPath)
  const validId = isPiSessionId(entry.name)
  const cond1 = {
    pass: described.form === 'empty' || described.form === 'logs-only',
    detail: readNote ?? `形态=${described.form}${described.form === 'has-siblings' ? `（兄弟域：${described.siblings.join(', ')}）` : ''}`,
  }
  const cond2 = validId
    ? {
        pass: !activeIds.has(entry.name),
        detail: activeIds.has(entry.name) ? '目录名命中活跃会话 id 集合（不删）' : '目录名不在活跃会话 id 集合',
      }
    : { pass: false, detail: '一级目录名非合法 sessionId 形态（树内遍历规约：跳过，junk 归外部不代删）' }
  const cond3 = {
    pass: mtime.mtimeMs !== null && mtime.mtimeMs < cutoffMs,
    detail: `mtime 主语=${mtime.mtimeSource}（${mtime.mtimeMs === null ? '不可读' : new Date(mtime.mtimeMs).toISOString()}）`,
    mtimeMs: mtime.mtimeMs,
    mtimeSource: mtime.mtimeSource,
    jsonlCount: mtime.jsonlCount,
  }
  return {
    ...base,
    kind: 'dir',
    form: described.form,
    siblings: described.siblings,
    cond1,
    cond2,
    cond3,
    hit: cond1.pass && cond2.pass && cond3.pass,
    skipReason: validId ? null : cond2.detail,
    ...(mtime.notes.length > 0 ? { notes: mtime.notes } : {}),
  }
}

/**
 * 点检：对每个一级目录逐条求值三条件并冻结删除清单（等号形态的判据输入）。
 *
 * 时点语义（§7 项 14 ③）：三条件与 id 集合仅在本次调用时求值一次，返回的 deleteSet 即冻结
 * 清单；点检后新落的树不进入本清单（也不因缺席被误红）。
 */
export function planSweep({ storeRoot, entries, activeIds, nowMs, keepDays }) {
  const cutoffMs = nowMs - keepDays * MS_PER_DAY
  const annotated = entries.map((entry) => annotateEntry({ storeRoot, entry, activeIds, cutoffMs }))
  const deleteSet = annotated.filter((a) => a.hit).map((a) => a.name).sort()
  return { entries: annotated, deleteSet, cutoffMs, nowMs, keepDays }
}

// ── 删除（目录级端口镜像：失败保留原地 + 结构化错误上抛） ─────────────────────────

function deriveTrashCategory(e) {
  return e?.code === 'ENOENT' ? 'path_missing' : 'trash_failed'
}

function trashCategoryOf(e) {
  return typeof e?.category === 'string' && e.category.length > 0 ? e.category : deriveTrashCategory(e)
}

function capturedStderr(e) {
  const stderr = e?.stderr
  if (typeof stderr === 'string') return stderr.trim()
  if (Buffer.isBuffer(stderr)) return stderr.toString('utf-8').trim()
  return ''
}

function toTrashDirectoryError(e, dirPath) {
  const stderr = capturedStderr(e)
  const err = new Error(`移入废纸篓失败（目录已保留在原位置，未做任何删除）：${dirPath}；原因：${toMessage(e)}${stderr ? `（底层错误：${stderr}）` : ''}`)
  err.category = trashCategoryOf(e)
  err.path = dirPath
  return err
}

/**
 * `ISessionStore.trashDirectory` 的同语义镜像（scripts/ 无构建链、ESM 不可 import TS 端口，
 * 先例见 zcode-session-db-cleanup.mjs 的 db-path.ts 镜像）。
 *
 * 契约与端口逐条一致：Promise 语义；失败 = 目标保留原地 + reject 结构化错误（category 分类
 * 字段 + path）；mac 双通道（trash CLI → Finder AppleScript，5s 超时）；非 mac rmSync
 * recursive（端口内设计内平台分支，ENOENT 原生上抛不吞）。出站子进程 env 只给 PATH。
 */
export function createTrashDirectoryPort({ plat = platform(), exec = execFileSync, rm = rmSync } = {}) {
  const isMac = plat === 'darwin'
  const childOpts = { timeout: TRASH_TIMEOUT_MS, env: { PATH: process.env.PATH ?? '' } }
  return async function trashDirectory(dirPath) {
    try {
      if (isMac) {
        try {
          exec('trash', [dirPath], childOpts)
          return
        } catch {
          exec('osascript', ['-e', FINDER_DELETE_SCRIPT, dirPath], childOpts)
          return
        }
      }
      rm(dirPath, { recursive: true })
    } catch (e) {
      throw toTrashDirectoryError(e, dirPath)
    }
  }
}

/** 失败集合条目的留痕形态（判别器 = category 分类字段）。 */
export function describeTrashFailure(e, dirPath) {
  return {
    category: trashCategoryOf(e),
    path: dirPath,
    code: typeof e?.code === 'string' ? e.code : null,
    message: toMessage(e),
  }
}

/**
 * 执行冻结的删除清单：逐目录 attempt、失败继续（不全停）。
 *
 * F 内目录不进删除集（attempt 失败即未删）、不计漏删；F 非空 = 环境故障，调用方整轮重来
 * （重跑时重新点检，不重放本次清单——端口对不存在路径上抛）。
 */
export async function executeSweep({ storeRoot, deleteSet, apply, trashDirectory }) {
  const deleted = []
  const failureSet = []
  if (!apply) return { deleted, failureSet, attempted: 0 }
  for (const name of deleteSet) {
    const dirPath = join(storeRoot, name)
    try {
      await trashDirectory(dirPath)
      deleted.push(name)
    } catch (e) {
      failureSet.push({ name, path: dirPath, error: describeTrashFailure(e, dirPath) })
    }
  }
  return { deleted, failureSet, attempted: deleteSet.length }
}

/** 结果 → 退出码：F 非空 = 环境故障（exit 2），否则完成（exit 0）。 */
export function resolveExitCode({ failureSet }) {
  return failureSet.length > 0 ? EXIT_ENV_FAILURE : EXIT_OK
}

// ── 点检记录与报告 ───────────────────────────────────────────────────────────

export function buildRecord({ dataDir, storeRoot, inProdTree, keepDays, keepDaysSrc, plan, exec, applied, activeIdSources, topLevelNote, idNotes }) {
  return {
    schema: 'sweep-orphan-session-dirs.record/v1',
    generatedAt: new Date(plan.nowMs).toISOString(),
    dataDir,
    storeRoot,
    inProdTree,
    keepDays,
    keepDaysSource: keepDaysSrc,
    cutoffMs: plan.cutoffMs,
    activeIdSources,
    topLevelNote,
    idNotes,
    applied,
    counts: {
      topLevel: plan.entries.length,
      hit: plan.deleteSet.length,
      deleted: exec.deleted.length,
      failed: exec.failureSet.length,
    },
    deleteSet: plan.deleteSet,
    deleted: exec.deleted,
    failureSet: exec.failureSet,
    entries: plan.entries,
  }
}

function printReport({ out, err, root, keepDays, keepDaysSrc, listing, sources, notes, plan, exec, applied, recordPath }) {
  const cutoff = new Date(plan.cutoffMs).toISOString()
  out.write(`[sweep] 数据目录：${root.dataDir}${root.inProdTree ? '（prod 树：是——dry-run 只读；--apply 须 --allow-prod）' : ''}\n`)
  out.write(`[sweep] 存储树根：${root.storeRoot}\n`)
  out.write(`[sweep] 保留期：${keepDays} 天（${keepDaysSrc}）→ cutoff ${cutoff}\n`)
  if (listing.note) out.write(`[sweep] 一级列举注记：${listing.note}\n`)
  out.write(`[sweep] 一级条目：${plan.entries.length}\n`)
  out.write(`[sweep] 活跃会话 id 集合：${sources.piSessionFiles + sources.btwLineFiles}（pi 会话文件 ${sources.piSessionFiles} / btw 线文件 ${sources.btwLineFiles}）\n`)
  for (const note of notes) out.write(`[sweep] id 集合注记：${note}\n`)
  out.write(`[sweep] 三条件命中（删除清单，点检时求值一次后冻结）：${plan.deleteSet.length}\n`)
  for (const name of plan.deleteSet) {
    const entry = plan.entries.find((a) => a.name === name)
    out.write(`  - ${name}（形态=${entry.form}，mtime 主语=${entry.cond3.mtimeSource}）\n`)
  }
  // 点检记录确认行对两个形态都打印：dry-run 是默认形态且点检记录已先落盘
  // （main 先写文件再打报告）——操作者看不到确认会误判未生成而重跑或漏交验收凭据
  if (recordPath) out.write(`[sweep] 点检记录已写入 ${recordPath}\n`)
  if (!applied) {
    out.write('[sweep] dry-run：未执行任何删除（只读点检）。真实删除加 --apply；prod 树还须 --allow-prod。\n')
    return
  }
  out.write('[sweep] --apply：经目录级端口 trashDirectory 逐目录移入回收站（失败保留原地 + 结构化错误上抛）\n')
  out.write(`[sweep] 已删除 ${exec.deleted.length} / 尝试 ${exec.attempted} / 失败 ${exec.failureSet.length}\n`)
  if (exec.failureSet.length > 0) {
    out.write(`[sweep] 失败集合 F（${exec.failureSet.length}）——目录保留原地，按结构化错误 category 留痕：\n`)
    for (const failure of exec.failureSet) {
      out.write(`  - ${failure.name} category=${failure.error.category} path=${failure.error.path}\n`)
    }
    err.write('[sweep] 环境故障：失败集合 F 非空 → 本轮判环境故障、整轮重来（重跑时点检与删除清单重新求值，不重放本次冻结清单）。\n')
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { selftest: false, apply: false, allowProd: false, dataDir: null, record: null, json: false, error: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--selftest') args.selftest = true
    else if (arg === '--apply') args.apply = true
    else if (arg === '--allow-prod') args.allowProd = true
    else if (arg === '--json') args.json = true
    else if (arg === '--data-dir' || arg === '--record') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        args.error = `${arg} 缺值`
        return args
      }
      if (arg === '--data-dir') args.dataDir = value
      else args.record = value
      i += 1
    } else {
      args.error = `未知参数：${arg}`
      return args
    }
  }
  return args
}

export async function main(opts = {}) {
  const {
    argv,
    env = process.env,
    homeDir = homedir(),
    out = process.stdout,
    err = process.stderr,
    trashDirectory = createTrashDirectoryPort(),
  } = opts
  const args = parseArgs(argv)
  if (args.error) {
    err.write(`[sweep] 用法错误：${args.error}\n${USAGE}`)
    return EXIT_USAGE
  }
  if (args.selftest) return runSelftest({ out, err })

  const root = resolveStoreRoot(env, { dataDir: args.dataDir, homeDir })
  if (args.apply && root.inProdTree && !args.allowProd) {
    err.write(
      `[sweep] 拒绝执行：--apply 目标位于 prod 数据树（${root.prodRoot}）内。prod 存量清扫须显式加 --allow-prod（C-proc-26：prod 只能被显式声明触达）；dry-run 只读、不受此限。\n`,
    )
    return EXIT_USAGE
  }

  const keepDays = readLogKeepDays(env)
  const keepDaysSrc = keepDaysSource(env)
  const nowMs = Date.now()
  const listing = listTopLevelEntries(root.storeRoot)
  const active = collectActiveSessionIds({ dataDir: root.dataDir, storeRoot: root.storeRoot, entries: listing.entries })
  const plan = planSweep({ storeRoot: root.storeRoot, entries: listing.entries, activeIds: active.ids, nowMs, keepDays })
  const exec = await executeSweep({ storeRoot: root.storeRoot, deleteSet: plan.deleteSet, apply: args.apply, trashDirectory })
  const record = buildRecord({
    dataDir: root.dataDir,
    storeRoot: root.storeRoot,
    inProdTree: root.inProdTree,
    keepDays,
    keepDaysSrc,
    plan,
    exec,
    applied: args.apply,
    activeIdSources: active.sources,
    topLevelNote: listing.note,
    idNotes: active.notes,
  })
  if (args.record) {
    mkdirSync(dirname(resolve(args.record)), { recursive: true })
    writeFileSync(args.record, `${JSON.stringify(record, null, 2)}\n`)
  }
  if (args.json) out.write(`${JSON.stringify(record, null, 2)}\n`)
  else printReport({ out, err, root, keepDays, keepDaysSrc, listing, sources: active.sources, notes: active.notes, plan, exec, applied: args.apply, recordPath: args.record })
  return resolveExitCode({ failureSet: exec.failureSet })
}

// ── 自检（tmp 树六形态 + 边界 + prod 护栏 + 纯函数；禁触真实数据目录） ─────────────

function sessionHeaderLine(id, timestampMs) {
  return `${JSON.stringify({ type: 'session', id, cwd: '/tmp/sweep-selftest', timestamp: new Date(timestampMs).toISOString() })}\n`
}

/** 自检树的一级目录名（全部取合法 sessionId 形态，含四族孤儿代表）。 */
const SID = {
  emptyOld: '11111111-1111-4111-8111-111111111111',
  logsOnlyOld: '22222222-2222-4222-8222-222222222222',
  logsOnlyFreshJsonl: '33333333-3333-4333-8333-333333333333',
  siblings: '44444444-4444-4444-8444-444444444444',
  active: '55555555-5555-4555-8555-555555555555',
  fresh: '66666666-6666-4666-8666-666666666666',
  portFail: '77777777-7777-4777-8777-777777777777',
  logsIsFile: '88888888-8888-4888-8888-888888888888',
  btwLine: '99999999-9999-4999-8999-999999999999',
  rotatedGzOnly: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  btwCreate: 'btw-create-12121212-1212-4212-8212-121212121212',
  mainWithBtw: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  residueOnly: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  junkName: '--Users-x-proj--',
}

function buildSelftestTree(base) {
  const nowMs = Date.now()
  const oldMs = nowMs - SELFTEST_OLD_DAYS * MS_PER_DAY
  const dataDir = join(base, 'data')
  const storeRoot = join(dataDir, SESSION_STORE_DIR_SEGMENT)
  mkdirSync(storeRoot, { recursive: true })
  const mkDir = (rel, mtimeMs) => {
    const p = join(dataDir, rel)
    mkdirSync(p, { recursive: true })
    if (mtimeMs !== undefined) utimesSync(p, new Date(mtimeMs), new Date(mtimeMs))
    return p
  }
  const mkFile = (rel, content, mtimeMs) => {
    const p = join(dataDir, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
    if (mtimeMs !== undefined) utimesSync(p, new Date(mtimeMs), new Date(mtimeMs))
    return p
  }
  const tree = (sid) => `${SESSION_STORE_DIR_SEGMENT}/${sid}`

  // 活跃会话的 pi 宿主文件（条件② 取数源；文件名形如 <ts>_<sid>.jsonl）
  mkFile(`agent/sessions/--tmp-x--/1700000000000_${SID.active}.jsonl`, sessionHeaderLine(SID.active, nowMs), nowMs)
  // tmp 残留文件名（RT-3#10 形态）不得进 id 集合 → 其 id 的树按孤儿处理
  mkFile(`agent/sessions/--tmp-x--/1700000000000_${SID.residueOnly}.jsonl.tmp-migrate-1700000000001.jsonl`, sessionHeaderLine(SID.residueOnly, oldMs), oldMs)

  mkDir(tree(SID.emptyOld), oldMs) // 形态：空目录（族④ 主会话 tempId 残留）
  mkFile(`${tree(SID.logsOnlyOld)}/logs/pi-2026-01-01.jsonl`, sessionHeaderLine(SID.logsOnlyOld, oldMs), oldMs) // 形态：仅 logs，jsonl 旧
  mkFile(`${tree(SID.logsOnlyFreshJsonl)}/logs/pi-2026-01-01.jsonl`, sessionHeaderLine(SID.logsOnlyFreshJsonl, nowMs), nowMs) // jsonl 新
  utimesSync(join(dataDir, tree(SID.logsOnlyFreshJsonl)), new Date(oldMs), new Date(oldMs)) // 目录旧但主语是 jsonl
  mkFile(`${tree(SID.siblings)}/logs/pi-2026-01-01.jsonl`, sessionHeaderLine(SID.siblings, oldMs), oldMs) // 有兄弟域
  mkDir(`${tree(SID.siblings)}/attachments`, oldMs)
  mkFile(`${tree(SID.active)}/logs/pi-2026-01-01.jsonl`, sessionHeaderLine(SID.active, oldMs), oldMs) // 活跃会话树（日志旧）
  mkDir(tree(SID.fresh), nowMs) // 保留期内新树（空、mtime 新）
  mkDir(tree(SID.portFail), oldMs) // 端口失败注入目标
  mkFile(`${tree(SID.logsIsFile)}/logs`, 'not-a-directory', oldMs) // logs 是文件不是目录
  mkFile(`${tree(SID.btwLine)}/logs/pi-2026-01-01.jsonl`, sessionHeaderLine(SID.btwLine, oldMs), oldMs) // btw 线会话树
  mkFile(`${tree(SID.rotatedGzOnly)}/logs/pi-2026-01-01.jsonl.1.gz`, 'gzip-bytes', oldMs) // 仅轮转 gz（无 *.jsonl → 主语 = 目录）
  utimesSync(join(dataDir, tree(SID.rotatedGzOnly)), new Date(oldMs), new Date(oldMs))
  mkDir(tree(SID.btwCreate), oldMs) // 族① btw-create-* 形态
  mkDir(tree(SID.residueOnly), oldMs) // id 只存在于 tmp 残留文件名的树
  mkFile(`${tree(SID.mainWithBtw)}/logs/pi-2026-01-01.jsonl`, sessionHeaderLine(SID.mainWithBtw, oldMs), oldMs) // 主会话带 btw 域
  mkFile(`${tree(SID.mainWithBtw)}/btw/1700000000000_${SID.btwLine}.jsonl`, sessionHeaderLine(SID.btwLine, oldMs), oldMs)
  mkDir(tree(SID.junkName), oldMs) // 非 sessionId 形态目录名（树内遍历规约：跳过）
  mkFile(`${SESSION_STORE_DIR_SEGMENT}/stray.jsonl`, sessionHeaderLine(SID.active, oldMs), oldMs) // 顶层散文件
  return { dataDir, storeRoot, nowMs }
}

async function runTreeForms({ tmpRoot, check }) {
  const { dataDir, storeRoot, nowMs } = buildSelftestTree(tmpRoot)
  const keepDays = readLogKeepDays({})
  const listing = listTopLevelEntries(storeRoot)
  const active = collectActiveSessionIds({ dataDir, storeRoot, entries: listing.entries })
  const plan = planSweep({ storeRoot, entries: listing.entries, activeIds: active.ids, nowMs, keepDays })

  const expectedDeleteSet = [
    SID.emptyOld,
    SID.logsOnlyOld,
    SID.portFail,
    SID.rotatedGzOnly,
    SID.btwCreate,
    SID.residueOnly,
  ].sort()
  check('删除集 = 三条件命中的存量全集（等号）', JSON.stringify(plan.deleteSet) === JSON.stringify(expectedDeleteSet), `实际 ${JSON.stringify(plan.deleteSet)}`)

  const byName = new Map(plan.entries.map((a) => [a.name, a]))
  const entryOf = (name) => byName.get(name)
  check('一级条目逐条标注（15 条）', plan.entries.length === 15, `实际 ${plan.entries.length}`)
  check('活跃 id 集合含 pi 会话', active.ids.has(SID.active), '缺 pi 会话 id')
  check('活跃 id 集合含 btw 线会话', active.ids.has(SID.btwLine), '缺 btw 线 id')
  check('活跃 id 集合不含孤儿空目录', !active.ids.has(SID.emptyOld))
  check('tmp 残留文件名不进 id 集合', !active.ids.has(SID.residueOnly), '残留文件被误收')
  check('id 集合来源计数（pi=1 / btw=1）', active.sources.piSessionFiles === 1 && active.sources.btwLineFiles === 1, JSON.stringify(active.sources))

  check('条件①：仅 logs 通过', entryOf(SID.logsOnlyOld).cond1.pass === true)
  check('条件①：有兄弟域不通过', entryOf(SID.siblings).cond1.pass === false)
  check('条件①：logs 是文件不通过', entryOf(SID.logsIsFile).cond1.pass === false)
  check('条件①：主会话带 btw 域不通过', entryOf(SID.mainWithBtw).cond1.pass === false)
  check('条件②：活跃会话树不通过', entryOf(SID.active).cond2.pass === false)
  check('条件②：btw 线树不通过', entryOf(SID.btwLine).cond2.pass === false)
  check('条件②：非 sessionId 名跳过', entryOf(SID.junkName).cond2.pass === false && entryOf(SID.junkName).skipReason !== null)
  check('条件③：保留期内新树不通过', entryOf(SID.fresh).cond3.pass === false)
  check('mtime 主语 = logs jsonl', entryOf(SID.logsOnlyOld).cond3.mtimeSource === 'logs-jsonl')
  check('mtime 主语：jsonl 新则目录旧不删', entryOf(SID.logsOnlyFreshJsonl).hit === false && entryOf(SID.logsOnlyFreshJsonl).cond3.mtimeSource === 'logs-jsonl')
  check('mtime 主语：无 jsonl 取目录自身', entryOf(SID.rotatedGzOnly).cond3.mtimeSource === 'dir')
  check('非目录条目跳过', entryOf('stray.jsonl').kind === 'non-dir' && entryOf('stray.jsonl').hit === false)

  const portCalls = []
  const trashDirectory = async (dirPath) => {
    const name = basename(dirPath)
    portCalls.push(name)
    if (name === SID.portFail) {
      const injected = new Error(`注入失败（保留原地）：${dirPath}`)
      injected.category = 'injected_port_failure'
      injected.path = dirPath
      throw injected
    }
    rmSync(dirPath, { recursive: true }) // 假端口成功分支照真端口生效（删树），供磁盘态断言
  }
  const exec = await executeSweep({ storeRoot, deleteSet: plan.deleteSet, apply: true, trashDirectory })
  check('端口逐目录 attempt（6 次）', portCalls.length === 6, `实际 ${portCalls.length}`)
  check('已删除集 = 冻结清单 ∩ 端口成功', JSON.stringify(exec.deleted) === JSON.stringify(expectedDeleteSet.filter((n) => n !== SID.portFail)), `实际 ${JSON.stringify(exec.deleted)}`)
  check('失败集合 F 留痕（1 条）', exec.failureSet.length === 1 && exec.failureSet[0].name === SID.portFail, JSON.stringify(exec.failureSet))
  check('失败集合判别器 = category 分类字段', exec.failureSet[0]?.error?.category === 'injected_port_failure', JSON.stringify(exec.failureSet[0]?.error))
  check('F 非空 → 环境故障退出码', resolveExitCode({ failureSet: exec.failureSet }) === EXIT_ENV_FAILURE)
  check('F 内目录保留原地', existsSync(join(storeRoot, SID.portFail)), '失败目录被删')

  const exists = (sid) => existsSync(join(storeRoot, sid))
  for (const name of expectedDeleteSet.filter((n) => n !== SID.portFail)) {
    check(`命中目录已删除：${name}`, !exists(name), '仍存在')
  }
  for (const name of [SID.logsOnlyFreshJsonl, SID.siblings, SID.active, SID.fresh, SID.logsIsFile, SID.btwLine, SID.mainWithBtw, SID.junkName]) {
    check(`未命中目录保留（零误删）：${name}`, exists(name), '被误删')
  }
  check('顶层散文件保留', existsSync(join(storeRoot, 'stray.jsonl')), '被误删')

  const recordPath = join(tmpRoot, 'record.json')
  const record = buildRecord({
    dataDir, storeRoot, inProdTree: false, keepDays, keepDaysSrc: keepDaysSource({}), plan, exec,
    applied: true, activeIdSources: active.sources, topLevelNote: listing.note, idNotes: active.notes,
  })
  mkdirSync(dirname(recordPath), { recursive: true })
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`)
  const reread = JSON.parse(readFileSync(recordPath, 'utf8'))
  check('点检记录可回读且计数一致', reread.counts.topLevel === 15 && reread.counts.hit === 6 && reread.counts.deleted === 5 && reread.counts.failed === 1, JSON.stringify(reread.counts))
  check('点检记录含冻结删除清单', JSON.stringify(reread.deleteSet) === JSON.stringify(expectedDeleteSet))
  check('点检记录含失败集合分类字段', reread.failureSet[0].error.category === 'injected_port_failure')
  check('点检记录含逐条三条件标注', reread.entries.length === 15 && reread.entries.every((e) => (e.kind === 'dir' ? e.cond1 && e.cond2 && e.cond3 : e.skipReason !== null && e.cond1 === null)))
}

async function runGuardForms({ tmpRoot, check }) {
  const fakeHome = join(tmpRoot, 'guard-home')
  const prodDataDir = join(fakeHome, DATA_DIR_ROOT_NAMES.prod)
  const prodStore = join(prodDataDir, SESSION_STORE_DIR_SEGMENT)
  const oldMs = Date.now() - SELFTEST_OLD_DAYS * MS_PER_DAY
  const mkOrphan = (sid) => {
    const p = join(prodStore, sid)
    mkdirSync(p, { recursive: true })
    utimesSync(p, new Date(oldMs), new Date(oldMs))
    return p
  }
  const sink = { write: () => {} }
  const portCalls = []
  const trashDirectory = async (dirPath) => {
    portCalls.push(dirPath)
    rmSync(dirPath, { recursive: true }) // 假端口成功分支照真端口生效（删树），供 prod 护栏的磁盘态断言
  }

  const refuseTarget = mkOrphan(SID.emptyOld)
  const refuseCode = await main({ argv: ['--apply'], env: { TAIJI_AGENT_DATA_DIR: prodDataDir }, homeDir: fakeHome, out: sink, err: sink, trashDirectory })
  check('prod --apply 无 --allow-prod → 拒绝（exit 1）', refuseCode === EXIT_USAGE, `实际 ${refuseCode}`)
  check('prod 拒绝时未调用删除端口', portCalls.length === 0, `实际 ${portCalls.length}`)
  check('prod 拒绝时目录保留原地', existsSync(refuseTarget), '被删')

  const dryCode = await main({ argv: [], env: { TAIJI_AGENT_DATA_DIR: prodDataDir }, homeDir: fakeHome, out: sink, err: sink, trashDirectory })
  check('prod dry-run 放行（exit 0）', dryCode === EXIT_OK, `实际 ${dryCode}`)
  check('prod dry-run 不删', existsSync(refuseTarget), '被删')
  check('prod dry-run 未调用删除端口', portCalls.length === 0, `实际 ${portCalls.length}`)

  const applyCode = await main({ argv: ['--apply', '--allow-prod'], env: { TAIJI_AGENT_DATA_DIR: prodDataDir }, homeDir: fakeHome, out: sink, err: sink, trashDirectory })
  check('prod --apply --allow-prod → 执行（exit 0）', applyCode === EXIT_OK, `实际 ${applyCode}`)
  check('prod 显式声明后删除生效', !existsSync(refuseTarget), '仍存在')
  check('prod 显式删除经端口', portCalls.length === 1, `实际 ${portCalls.length}`)

  const prodOrphanForDefault = mkOrphan(SID.logsOnlyOld)
  const lines = []
  const capture = { write: (s) => lines.push(s) }
  const defaultCode = await main({ argv: [], env: {}, homeDir: fakeHome, out: capture, err: sink, trashDirectory })
  check('无 env 缺省落 dev 树（exit 0）', defaultCode === EXIT_OK, `实际 ${defaultCode}`)
  check('缺省 dev 树零存量合法', lines.join('').includes('一级条目：0'), lines.join(''))
  check('缺省不触 prod 树', existsSync(prodOrphanForDefault), 'prod 目录被动')

  const jsonDataDir = join(tmpRoot, 'json-data')
  const jsonStore = join(jsonDataDir, SESSION_STORE_DIR_SEGMENT)
  const jsonOrphan = join(jsonStore, SID.rotatedGzOnly)
  mkdirSync(jsonOrphan, { recursive: true })
  utimesSync(jsonOrphan, new Date(oldMs), new Date(oldMs))
  const jsonLines = []
  const jsonCapture = { write: (s) => jsonLines.push(s) }
  const jsonCode = await main({ argv: ['--json', '--data-dir', jsonDataDir], env: {}, homeDir: fakeHome, out: jsonCapture, err: sink, trashDirectory })
  check('--json 退出码 0', jsonCode === EXIT_OK, `实际 ${jsonCode}`)
  let parsed = null
  try {
    parsed = JSON.parse(jsonLines.join(''))
  } catch {
    parsed = null
  }
  check('--json 输出可解析', parsed !== null)
  check('--json 输出含 schema 与删除清单', parsed?.schema === 'sweep-orphan-session-dirs.record/v1' && parsed?.deleteSet?.[0] === SID.rotatedGzOnly, JSON.stringify(parsed?.deleteSet))

  check('未知参数 → 用法错误', parseArgs(['--nope']).error !== null)
  check('--record 缺值 → 用法错误', parseArgs(['--record']).error !== null)
}

function runPureForms({ check }) {
  check('保留期缺省 7 天', readLogKeepDays({}) === DEFAULT_LOG_KEEP_DAYS)
  check('保留期 env 覆盖', readLogKeepDays({ TAIJI_LOG_KEEP_DAYS: '3' }) === 3)
  check('保留期 env 0 回退缺省', readLogKeepDays({ TAIJI_LOG_KEEP_DAYS: '0' }) === DEFAULT_LOG_KEEP_DAYS)
  check('保留期 env 非数字回退缺省', readLogKeepDays({ TAIJI_LOG_KEEP_DAYS: 'abc' }) === DEFAULT_LOG_KEEP_DAYS)
  check('保留期 env 负数透传（登记行为）', readLogKeepDays({ TAIJI_LOG_KEEP_DAYS: '-1' }) === -1)
  check('isPiSessionId：v4 UUID 通过', isPiSessionId(SID.emptyOld))
  check('isPiSessionId：btw-create-* 通过', isPiSessionId(SID.btwCreate))
  check('isPiSessionId：ephemeral-* 通过', isPiSessionId('ephemeral-1700000000000-12121212-1212-4212-8212-121212121212'))
  check('isPiSessionId：btw 虚拟 id（含冒号）拒绝', !isPiSessionId('btw:abc'))
  check('isPiSessionId：encodeCwd 目录名拒绝', !isPiSessionId(SID.junkName))
  check('isPiSessionId：空串拒绝', !isPiSessionId(''))
  check('isScannableSessionFile：普通 jsonl 收录', isScannableSessionFile('1700000000000_abc.jsonl'))
  check('isScannableSessionFile：tmp-migrate 残留排除', !isScannableSessionFile('1700000000000_abc.jsonl.tmp-migrate-1700000000001.jsonl'))
  check('isScannableSessionFile：tmp-import 残留排除', !isScannableSessionFile('1700000000000_abc.jsonl.tmp-import-1700000000001.jsonl'))
  check('isScannableSessionFile：id 中段含标记串的真会话收录', isScannableSessionFile('a.tmp-migrate-b.jsonl'))
  check('prod 树判定：.taiji 树内', resolveStoreRoot({ TAIJI_AGENT_DATA_DIR: '/home/x/.taiji' }, { homeDir: '/home/x' }).inProdTree === true)
  check('prod 树判定：.taiji-dev 不在 prod 树', resolveStoreRoot({}, { homeDir: '/home/x' }).inProdTree === false)
  check('prod 树判定：tmp 目录不在 prod 树', resolveStoreRoot({ TAIJI_AGENT_DATA_DIR: '/tmp/x' }, { homeDir: '/home/x' }).inProdTree === false)
  check('缺省数据目录 = dev 树', resolveStoreRoot({}, { homeDir: '/home/x' }).dataDir === '/home/x/.taiji-dev')
}

export async function runSelftest({ out = process.stdout, err = process.stderr } = {}) {
  const failures = []
  const check = (label, ok, detail) => {
    if (!ok) failures.push(detail ? `${label}：${detail}` : label)
  }
  const tmpRoot = mkdtempSync(join(tmpdir(), 'sweep-orphan-selftest-'))
  try {
    runPureForms({ check })
    await runTreeForms({ tmpRoot, check })
    await runGuardForms({ tmpRoot, check })
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
  if (failures.length > 0) {
    err.write(`[sweep-selftest] 断言失败 ${failures.length} 条：\n`)
    for (const failure of failures) err.write(`  - ${failure}\n`)
    return EXIT_USAGE
  }
  out.write('[sweep-selftest] 绿：六形态 + 边界 + prod 护栏 + 纯函数断言全部通过\n')
  return EXIT_OK
}

const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  main({ argv: process.argv.slice(2) })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      process.stderr.write(`[sweep] 未预期错误：${toMessage(e)}\n`)
      process.exitCode = EXIT_USAGE
    })
}
