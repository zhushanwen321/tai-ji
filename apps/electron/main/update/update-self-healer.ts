/**
 * 启动自愈器（检测上次中断的升级并回滚）。
 *
 * 对应 slice auto-update-and-install w3：app 启动时（whenReady 内、bootstrapMainWindow 之前）
 * 读 update-result.json，若 status='replacing'（上次升级被中断：崩溃/断电/强杀），
 * 按备份存在与否区分两种情况：
 *   - .old 备份存在 → updater 脚本已把原版本 mv 到 .old（替换阶段被中断）→ 真正回滚
 *     （rm 半截态 + mv .old 回来）→ 写 status='rolled-back'，返回 true
 *   - .old 不存在 → 中断发生在下载/校验阶段（download-asset 在替换前就失败，原 app
 *     未被改动，无 .old 产物）→ 无需回滚 → 写 status='no-op'，返回 false
 *
 * 回滚策略（.old 存在时）：
 * - mac：原子化恢复——先把破损 .app rename 到 .broken，再 mv .old 回 .app，最后清理 .broken
 *   （避免 rm 后 rename 失败导致 app 路径为空）
 * - linux AppImage：同 mac 策略（.broken 中间态）
 * - 写 result status='rolled-back' 标记已处理（下次启动 no-op）
 *
 * [HISTORICAL] 不变量：
 * - 只在 status='replacing' 时进入回滚分支（done/failed/rolled-back 都是终态，no-op）
 * - 区分 .old 是否存在：避免误把"下载期失败"标成 rolled-back（语义误导，监控/用户
 *   会以为回滚了一个其实没动过的安装）
 * - 自愈失败绝不阻塞 app 启动（返回 false，仅 console.error 记录）
 * - mac 回滚依赖 updater.sh 写的 .old 备份（rm-then-mv 决策树产物）
 * - linux 回滚依赖 updater-linux.sh 的 mv .old 备份（v2 起 unlink → mv .old）
 * - result.json 解析失败时，若内容含 'replacing' 且 .old 存在，仍尝试回滚
 *   （写入中断的半截 JSON 不应让破损 app 蒙混过关）
 *
 * 依赖方向：update-self-healer → constants + types + compare-versions + electron + node:fs/path
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { LaunchResult } from '@taiji/shared'
import { buildOutboundChildEnv } from '@taiji/shared'
import { compare } from 'compare-versions'
import { app } from 'electron'
import {
  getLinuxUpdaterLogPath,
  getLinuxUpdaterScriptPath,
  getPendingUpdateFile,
  getPreloadedUpdateFile,
  getUpdateDir,
  getUpdateResultFile,
  getUpdaterLogPath,
  getUpdaterPidFile,
  getUpdaterScriptPath,
  getWinUpdaterLogPath,
  getWinUpdaterScriptPath,
} from './constants.js'
import type { UpdateResultStatus } from './types.js'

/** updater.pid 见 constants.js（批次 5 u5d 抽常量：写入方含 win 的 main 侧，路径需唯一） */

/**
 * 判断升级脚本是否仍在运行（跨进程互斥检查方，§3.7.1）。
 *
 * 读取 updater.pid：
 * - 文件不存在 → false（无 updater 在跑）
 * - PID 已死 → 清理残留 pid 文件（自愈）→ false
 * - PID 存活：
 *   - mac/linux：叠加 argv 校验（`ps -p <pid> -o command=` 含 updater.sh /
 *     updater-linux.sh）——PID 复用（其他进程占用该 pid）→ 视为不存活（清理残留，
 *     正常清理）。注意必须用 command=（完整 argv）而非 comm=：脚本进程的可执行
 *     映像是 bash 解释器，comm 恒为 "bash"，永远不含 updater 字样（2026-08 实证，
 *     用 comm= 会把真实存活的脚本 100% 误判为 PID 复用 → fail-open 清掉 pid 文件
 *     并放行清理，互斥完全失效——误判方向恰好是危险侧）。
 *   - win：仅 PID 存活检查（S-7：cmd.exe 进程映像名固定，无 updater 字样可验）
 *   - ps 调用异常（异常环境）→ 保守按存活处理（误判存活的后果 = 少做一次清理，
 *     良性且下次启动补做；误判不存活才危险）
 */
export function isUpdaterInFlight(): boolean {
  const pidFile = getUpdaterPidFile()
  if (!existsSync(pidFile)) return false
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
  } catch {
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) return false

  let alive = false
  try {
    process.kill(pid, 0) // 信号 0：仅探测存活
    alive = true
  } catch {
    alive = false
  }
  if (!alive) {
    // 残留 pid（脚本已退出但 trap 未及清理，如 kill -9）：自愈清理
    try {
      unlinkSync(pidFile)
    } catch (err) {
      // best-effort：清理失败无害——残留 pid 文件下次启动会再次检测并重试清理
      console.warn('[update-self-healer] cleanup stale pid file failed:', err)
    }
    return false
  }

  // mac/linux argv 廉价加固：脚本进程的 argv 含 updater.sh / updater-linux.sh 路径
  // （spawn('bash', [scriptPath])）。不能用 ps -o comm=——comm 只看可执行映像名
  // （恒为 "bash"），脚本路径只在 argv（command=）里（S-7 win 侧无此信息，仅做 PID 存活）
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      const argv = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        env: buildOutboundChildEnv({ parentEnv: process.env }),
      })
      if (!/\/updater(?:-linux)?\.sh(?:\s|$)/.test(argv)) {
        // PID 已被复用（占位者非 updater 脚本）→ 视为不存活，清残留 pid 后正常清理
        try {
          unlinkSync(pidFile)
        } catch (err) {
          // best-effort：PID 复用清理失败无害——下次启动重新检测到复用会再清
          console.warn('[update-self-healer] cleanup reused pid file failed:', err)
        }
        return false
      }
    } catch (err) {
      // ps 不可用/失败：保守按存活 defer（误判存活的后果 = 少做一次清理，良性且
      // 下次启动补做；误判不存活才危险），不向上传播
      console.warn('[update-self-healer] ps argv check failed, treat updater as alive:', err)
    }
  }
  return true
}

/** update-result.json 的合法结构（运行时校验） */
interface UpdateResultData {
  status?: unknown
  version?: unknown
  /** 脚本 fail() 写入的失败原因码（仅 status='failed'），透传给 renderer 映射文案 */
  error?: unknown
}

/**
 * 原子写 update-result.json（[A-G1]）：先写 .tmp 再同目录 renameSync，读方不会读到
 * 半截 JSON——corrupt-json 分支会把半截 replacing 误判为「需回滚」触发误回滚。
 * tmp 命名与 orchestrator.writeUpdateResult / mac·linux·win 升级脚本模板一致
 * （`${getUpdateResultFile()}.tmp`）；写崩残留的孤儿 tmp 由 cleanupCompletedUpdate
 * 的 *.tmp 扫描兜底清理（[A-G2]）。
 */
function writeResultFileAtomic(content: string): void {
  const resultFile = getUpdateResultFile()
  const tmpPath = `${resultFile}.tmp`
  writeFileSync(tmpPath, content)
  renameSync(tmpPath, resultFile)
}

/**
 * 检测并回滚上次中断的升级。
 *
 * 在 app.whenReady 内、bootstrapMainWindow 之前调用。
 *
 * @returns true=执行了回滚（.old 存在，已 rm 半截 + mv .old 回来），
 *          false=无需回滚（终态/无 result/.old 不存在/自愈失败，均不阻塞启动）
 */
export async function maybeRollbackInterruptedUpdate(): Promise<boolean> {
  // 批次 5 互斥（§3.7.1）：升级脚本仍在跑 → 本次启动跳过回滚与清理（良性：少做一次，
  // 下次启动补做），正常进入应用；脚本退出删 pid 后下次启动恢复正常检查。
  if (isUpdaterInFlight()) {
    console.log('[update-self-healer] updater in flight, defer cleanup')
    return false
  }

  if (!existsSync(getUpdateResultFile())) return false

  // 读取与解析分开 try：解析失败时 catch 仍能访问 raw 内容，
  // 据此判断是否是「写入中断的半截 replacing JSON」并尝试回滚。
  let raw: string
  try {
    raw = readFileSync(getUpdateResultFile(), 'utf-8')
  } catch (e) {
    // 读文件本身失败（权限/IO 错误）：记录但不阻塞启动
    console.error('[update-self-healer] read result failed:', e)
    return false
  }

  let data: UpdateResultData
  try {
    data = JSON.parse(raw) as UpdateResultData
  } catch (e) {
    // JSON 解析失败：可能是写入中断导致半截 JSON（保守回滚判定见 helper）。
    if (tryRollbackAfterCorruptResult(raw)) return true
    console.error('[update-self-healer] failed to parse result:', e)
    return false
  }

  try {
    return rollbackParsedResult(data)
  } catch (e) {
    // 自愈失败不阻塞启动：仅记录，靠下次启动重试或用户手动恢复
    console.error('[update-self-healer] failed:', e)
    return false
  }
}

/**
 * JSON 解析失败后的保守回滚判定（maybeRollbackInterruptedUpdate corrupt-json 分支）。
 *
 * 半截 JSON 若含 'replacing' 子串（status 字段写了一半）且 .old 备份存在，仍尝试回滚
 * （宁可误回滚也不留破损 app）。返回 true = 已回滚；false = 不满足回滚条件或回滚失败
 * （调用方继续走「failed to parse result」路径）。
 */
function tryRollbackAfterCorruptResult(raw: string): boolean {
  if (typeof raw === 'string' && raw.includes('replacing')) {
    const oldPath = getOldBackupPath()
    if (oldPath && existsSync(oldPath)) {
      console.warn(
        '[update-self-healer] corrupt result.json but .old exists, attempting rollback',
      )
      try {
        rollbackCurrentPlatform()
        // m18（批次 5）：半截 raw 里 best-effort 提取 version（正则，提取不到则
        // rolled-back 标记无 version 字段 → renderer 无 toast，维持现状下限）
        const corruptVersion =
          typeof raw === 'string'
            ? raw.match(/"version":"(\d+\.\d+\.\d+(?:\.\d+)?)"/)?.[1]
            : undefined
        try {
          writeRolledBackMarker(corruptVersion, 'rolled back after corrupt result.json')
        // eslint-disable-next-line taste/no-silent-catch -- best-effort：标记写入失败不影响已完成的回滚
        } catch (writeErr) {
          console.warn('[update-self-healer] write rolled-back marker failed:', writeErr)
        }
        console.log('[update-self-healer] rolled back after corrupt result.json')
        return true
      // eslint-disable-next-line taste/no-silent-catch -- best-effort：回滚失败不阻塞启动
      } catch (rollbackErr) {
        console.error(
          '[update-self-healer] rollback after corrupt json failed:',
          rollbackErr,
        )
      }
    }
  }
  return false
}

/**
 * 写 status='rolled-back' 标记（原子写，下次启动 no-op）。
 *
 * version 缺失时省略字段（renderer 无 toast，维持下限）；reason 仅 corrupt-json
 * 回滚场景携带（区分标记成因）。
 */
function writeRolledBackMarker(version: string | undefined, reason?: string): void {
  writeResultFileAtomic(
    JSON.stringify({
      status: 'rolled-back',
      ...(typeof version === 'string' ? { version } : {}),
      at: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    }),
  )
}

/**
 * 平台分流执行回滚（maybeRollbackInterruptedUpdate 两处共用：corrupt-json 分支 +
 * 常规 replacing 分支；win 无 .old 备份机制，无可回滚形态）。
 */
function rollbackCurrentPlatform(): void {
  if (process.platform === 'darwin') rollbackMacBundle()
  else if (process.platform === 'linux') rollbackLinuxAppImage()
}

/**
 * 对解析成功的 result 执行回滚决策（maybeRollbackInterruptedUpdate 主体分支）。
 *
 * - 非 'replacing'（done/failed/rolled-back 都是终态）→ false
 * - .old 不存在：无需回滚 → 写 no-op 避免下次启动重复检测；返回 false 表示"没有回滚动作"。
 *   m15（批次 5）：win 走 NSIS 无 .old 备份机制，no-op 仅发生在 wrapper 早死场景，
 *   reason 与 mac/linux 区分（wrapper 化后原「无 .old 备份」描述对 win 不准确）。
 * - .old 存在：替换阶段被中断，半截态残留 → 真正回滚 + 写 rolled-back 标记 → true。
 *
 * @throws 回滚/标记写失败原样上抛（调用方外层 catch 记录后返回 false，不阻塞启动）
 */
function rollbackParsedResult(data: UpdateResultData): boolean {
  if (data.status !== 'replacing') return false // done/failed/rolled-back 都是终态

  const oldPath = getOldBackupPath()
  if (!oldPath || !existsSync(oldPath)) {
    const noOpReason =
      process.platform === 'win32'
        ? 'installer wrapper exited before completion'
        : 'no .old backup: interrupted before replace phase'
    writeResultFileAtomic(
      JSON.stringify({
        status: 'no-op',
        version: typeof data.version === 'string' ? data.version : undefined,
        at: new Date().toISOString(),
        reason: noOpReason,
      }),
    )
    console.log('[update-self-healer] interrupted update had no .old backup; no-op')
    return false
  }

  // .old 存在：替换阶段被中断，半截态残留 → 真正回滚
  rollbackCurrentPlatform()

  // 标记已回滚（下次启动 no-op）
  writeRolledBackMarker(typeof data.version === 'string' ? data.version : undefined)
  console.log('[update-self-healer] rolled back interrupted update')
  return true
}

/** cleanupCompletedUpdate 需处理的终态集合（replacing 由 maybeRollbackInterruptedUpdate 处理） */
const TERMINAL_CLEANUP_STATUSES: readonly UpdateResultStatus[] = [
  'done',
  'failed',
  'rolled-back',
  'no-op',
]

// ── m14 失败日志保留（批次 5）────────────────────────────────────
const LOG_RETENTION_DAYS = 7
const HOURS_PER_DAY = 24
const MINUTES_PER_HOUR = 60
const SECONDS_PER_MINUTE = 60
const MS_PER_SECOND = 1000
/** 归档日志保留窗口（m14：failed/rolled-back 的日志保留 7 天供排障） */
const LOG_RETENTION_MS =
  LOG_RETENTION_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND
/** 归档日志文件名 pattern（updater-<原名>-<date>.log） */
const LOG_ARCHIVE_RE = /^updater.*-\d{4}-\d{2}-\d{2}\.log$/

/** ISO 日期串（YYYY-MM-DD）长度，归档文件名的日期段截取用。 */
const ISO_DATE_LENGTH = 10

/**
 * 幂等删除：文件不存在(ENOENT)静默，其他错误 rethrow。
 *
 * 升级产物清理场景下，文件已被外部清理（用户手动删 / 上次清理已删）是常态而非异常，
 * 用本函数避免对每个产物逐一 existsSync 判空。仅吞 ENOENT（预期），其他 IO 错误需暴露
 * （交由 {@link cleanupCompletedUpdate} 的外层 try/catch 记录）。
 */
export function ignoreENOENT(target: string): void {
  try {
    unlinkSync(target)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

/**
 * 推导当前平台的升级残留路径全集（批次 5 m13：终态时这些全是垃圾）。
 *
 * - mac：.old 备份 / .broken 回滚中间态 / .app.new（staging 换装残留）/
 *   .staging.<bundle>（批次 1 staging 解压目录，与 updater-script.ts 同推导）
 * - linux：.old / .broken（单文件 mv 无 .new/staging）
 * - win：无（NSIS 自管，无备份机制）
 *
 * .old 不再跨启动存活：消除「陈旧 .old 叠加预恢复分支回滚到远古版本」的风险。
 */
function getStaleArtifactPaths(): string[] {
  const paths: string[] = []
  const oldPath = getOldBackupPath()
  if (oldPath) {
    paths.push(oldPath)
    if (process.platform === 'darwin') {
      const appBundle = path.dirname(path.dirname(path.dirname(process.execPath)))
      paths.push(`${appBundle}.broken`, `${appBundle}.new`)
      paths.push(path.join(path.dirname(appBundle), `.staging.${path.basename(appBundle)}`))
    } else if (process.platform === 'linux') {
      const appImage = process.env.APPIMAGE
      if (appImage) paths.push(`${appImage}.broken`)
    }
  }
  return paths
}

/**
 * m14：失败态日志归档/保留（三平台升级日志同一策略：mac updater.log /
 * linux updater-linux.log / win updater-win.log）。
 *
 * failed / rolled-back：rename 为 updater-<原名>-<date>.log 保留（失败现场不被启动
 * 清理抹掉，排障依据）；同日多次失败覆盖同名归档（保留最新）。done / no-op 不处理。
 */
function archiveUpdaterLogs(dateStamp: string): void {
  for (const logPath of [getUpdaterLogPath(), getLinuxUpdaterLogPath(), getWinUpdaterLogPath()]) {
    if (!existsSync(logPath)) continue
    try {
      const dir = path.dirname(logPath)
      const ext = path.extname(logPath)
      const base = path.basename(logPath, ext)
      renameSync(logPath, path.join(dir, `${base}-${dateStamp}${ext}`))
    } catch (e) {
      // best-effort：单个日志归档失败（文件被占用/权限）只影响该份日志的保留形态，
      // 不阻塞其余日志归档，更不影响升级主流程
      console.warn('[update-self-healer] archive updater log failed:', e)
    }
  }
}

/** m14：清理超过保留期的归档日志（>7 天） */
function cleanupExpiredLogArchives(): void {
  const updateDir = getUpdateDir()
  if (!existsSync(updateDir)) return
  const cutoff = Date.now() - LOG_RETENTION_MS
  for (const f of readdirSync(updateDir)) {
    if (!LOG_ARCHIVE_RE.test(f)) continue
    const full = path.join(updateDir, f)
    try {
      if (statSync(full).mtimeMs < cutoff) {
        unlinkSync(full)
        console.log(`[update-self-healer] removed expired updater log archive: ${f}`)
      }
    } catch (err) {
      // best-effort：单个归档文件 stat/unlink 失败只跳过该份，不阻塞其余过期清理
      console.warn(`[update-self-healer] remove expired log archive failed: ${f}`, err)
    }
  }
}

/**
 * 启动时清理已完成/失败的升级产物，并返回终态上下文供 renderer 通知用户。
 *
 * 修复根因：升级成功后 update-result.json status='done'，但 maybeRollbackInterruptedUpdate
 * 只处理 'replacing'，done/failed/rolled-back/no-op 终态直接 return false 不清理 → 170MB zip
 * 永久残留 + preloaded-update.json 残留导致下次启动误恢复「已下载」态。本函数在
 * maybeRollbackInterruptedUpdate 之后调用，清理这些终态产物。
 *
 * 清理矩阵（终态简化为「全部清含 result 自身」，仅 done 做版本校验）：
 * - done + app.getVersion() >= data.version（真 done，已升级到目标版本）→ 清全部含 result
 * - done + app.getVersion() < data.version（假 done，app 仍旧版）→ 不清（result 未生效/过期）
 * - failed / rolled-back / no-op → 清全部含 result
 * - replacing → 不归本函数（maybeRollbackInterruptedUpdate 处理）
 *
 * 路径注入防护：删除 preloaded 记录的下载 zip 前，校验其 path.resolve 结果在
 * 升级工作目录（getUpdateDir()）之内，不在则 warn 跳过（防 preloaded 文件被篡改
 * 指向任意路径导致误删用户文件）。
 *
 * 永不抛错、永不阻塞启动：整体 try/catch + console.warn。在 main.ts 的 whenReady 内、
 * maybeRollbackInterruptedUpdate 之后调用。
 *
 * @returns 有意义的终态上下文（done/failed/rolled-back），供 renderer 通知用户；
 *          no-op 或无 result 返回 null（不通知）。
 */
export async function cleanupCompletedUpdate(): Promise<LaunchResult | null> {
  try {
    // 批次 5 互斥（§3.7.1）：updater 在跑时同样 defer 清理（与回滚检查同口径）
    if (isUpdaterInFlight()) {
      console.log('[update-self-healer] updater in flight, defer cleanup')
      return null
    }

    if (!existsSync(getUpdateResultFile())) return null

    const terminal = readTerminalUpdateResult()
    if (!terminal) return null
    if (shouldSkipFakeDone(terminal.status, terminal.data)) return null

    // ── 捕获终态上下文（在清理 result 自身之前）────────────────
    const launchResult = buildLaunchResult(terminal.status, terminal.data)

    // ── 清理产物（顺序保持：preloaded → 固定产物 → 残留矩阵 → 日志 → updateDir 残留 → result）──
    cleanupPreloadedUpdateArtifacts()
    cleanupFixedUpdateArtifacts()
    cleanupUpdaterLogs(terminal.status)
    cleanupUpdateDirResidues()

    // 4. result 自身最后删（标记本次清理完成；下次启动无 result → no-op）
    ignoreENOENT(getUpdateResultFile())

    return launchResult
  } catch (e) {
    // 永不阻塞启动：仅 warn
    console.warn('[update-self-healer] cleanupCompletedUpdate failed:', e)
    return null
  }
}

/** 终态 result 解析产物（status 已收敛为合法终态枚举）。 */
interface ITerminalUpdateResult {
  status: UpdateResultStatus
  data: UpdateResultData
}

/**
 * 读 update-result.json 并收敛到可清理终态（cleanupCompletedUpdate 步骤 2+3）。
 *
 * 文件读失败（existsSync 与 read 间竞态/权限）/ JSON 解析失败（半截写入）/
 * 非 terminal 状态（replacing / 未知状态：不归本函数）→ 返回 null（无可清理）。
 */
function readTerminalUpdateResult(): ITerminalUpdateResult | null {
  try {
    const data = JSON.parse(readFileSync(getUpdateResultFile(), 'utf-8')) as UpdateResultData
    const status = typeof data.status === 'string' ? (data.status as UpdateResultStatus) : undefined
    if (!status || !TERMINAL_CLEANUP_STATUSES.includes(status)) {
      return null // replacing / 未知状态：不归本函数
    }
    return { status, data }
  } catch {
    return null
  }
}

/**
 * done 终态的真假校验（cleanupCompletedUpdate 步骤 4）：仅当 app 确已升级到目标版本
 * （version <= current）才清理。非 semver 版本号无法判定真假 done → 保守不清
 * （与 readPendingUpdate 的 catch+keep 对称）。返回 true = 假 done / 校验失败，跳过清理。
 */
function shouldSkipFakeDone(status: UpdateResultStatus, data: UpdateResultData): boolean {
  if (status !== 'done') return false
  let realDone = false
  try {
    realDone = compare(
      app.getVersion(),
      typeof data.version === 'string' ? data.version : '',
      '>=',
    )
  } catch (e) {
    console.warn('[update-self-healer] done status version compare failed, skip cleanup:', e)
    return true
  }
  return !realDone // 假 done：app 仍旧版，result 可能未生效，不清
}

/**
 * 捕获终态上下文供 renderer 通知（cleanupCompletedUpdate 步骤 5，在清理前构造）。
 *
 * A-D1：failed 原因码透传（renderer 映射具体失败文案+恢复指引，G3）；
 * 仅 failed 态有意义，done/rolled-back 保持既有形状不带 error。
 * no-op / version 缺失 → null（不通知）。
 */
function buildLaunchResult(status: UpdateResultStatus, data: UpdateResultData): LaunchResult | null {
  const version = typeof data.version === 'string' ? data.version : ''
  const error = typeof data.error === 'string' ? data.error : undefined
  return (status === 'done' || status === 'failed' || status === 'rolled-back') && version
    ? { status, version, ...(status === 'failed' && error ? { error } : {}) }
    : null
}

/**
 * 清理 preloaded-update.json 及其记录的下载 zip（cleanupCompletedUpdate 步骤 1）。
 *
 * 路径注入防护：删除 zip 前校验其 path.resolve 结果在升级工作目录（getUpdateDir()）
 * 之内，不在则 warn 跳过（防 preloaded 文件被篡改指向任意路径导致误删用户文件）。
 * preloaded 损坏时无法取得可信 filePath，仅删 json 本身（zip 留待下次或手动清理）。
 */
function cleanupPreloadedUpdateArtifacts(): void {
  if (!existsSync(getPreloadedUpdateFile())) return
  const preloadedFilePath = readPreloadedFilePath()
  if (preloadedFilePath) {
    const resolved = path.resolve(preloadedFilePath)
    const updateDirPrefix = path.resolve(getUpdateDir()) + path.sep
    if (resolved.startsWith(updateDirPrefix)) {
      ignoreENOENT(resolved)
    } else {
      console.warn(`[update-self-healer] skip download zip outside UPDATE_DIR: ${resolved}`)
    }
  }
  ignoreENOENT(getPreloadedUpdateFile())
}

/** 读 preloaded-update.json 的 filePath 字段（缺失/损坏返回 null，不抛）。 */
function readPreloadedFilePath(): string | null {
  try {
    const pre = JSON.parse(readFileSync(getPreloadedUpdateFile(), 'utf-8')) as unknown
    if (
      pre &&
      typeof pre === 'object' &&
      typeof (pre as Record<string, unknown>).filePath === 'string'
    ) {
      return (pre as Record<string, unknown>).filePath as string
    }
  } catch (e) {
    // preloaded 损坏：无法取得可信 filePath，仅删 json 本身（zip 留待下次或手动清理）
    console.warn('[update-self-healer] preloaded parse failed, skip zip deletion:', e)
  }
  return null
}

/**
 * 清理固定路径产物 + 平台升级残留矩阵（cleanupCompletedUpdate 步骤 2 + 2.5）。
 *
 * 2. 其余产物（固定路径，无注入风险）。三平台脚本同清：mac updater.sh /
 *    linux updater-linux.sh / win updater.cmd（批次 2 产物，同入清理矩阵）
 * 2.5 m13：升级残留矩阵（.old/.broken/.new/staging）——终态时全是垃圾，
 *    .old 不再跨启动存活（消除陈旧 .old 回滚风险）。可能是目录（.broken/.staging），
 *    用 rmSync recursive+force（吞 ENOENT）而非 ignoreENOENT/unlink。
 */
function cleanupFixedUpdateArtifacts(): void {
  ignoreENOENT(getPendingUpdateFile())
  ignoreENOENT(getUpdaterScriptPath())
  ignoreENOENT(getLinuxUpdaterScriptPath())
  ignoreENOENT(getWinUpdaterScriptPath())

  for (const stale of getStaleArtifactPaths()) {
    rmSync(stale, { recursive: true, force: true })
  }
}

/**
 * 日志保留策略（cleanupCompletedUpdate 步骤 2.6，m14 三平台同口径）——
 * 仅 done 删日志；failed/rolled-back 归档保留；no-op 保留原样（无实质事件）。
 * 归档旧档（>7 天）在此一并清理。
 */
function cleanupUpdaterLogs(status: UpdateResultStatus): void {
  if (status === 'done') {
    ignoreENOENT(getUpdaterLogPath())
    ignoreENOENT(getLinuxUpdaterLogPath())
    ignoreENOENT(getWinUpdaterLogPath())
  } else if (status === 'failed' || status === 'rolled-back') {
    archiveUpdaterLogs(new Date().toISOString().slice(0, ISO_DATE_LENGTH))
  }
  cleanupExpiredLogArchives()
}

/**
 * 清理升级工作目录内的下载中断残留（.downloading 临时文件）+ 原子写孤儿 tmp
 * （cleanupCompletedUpdate 步骤 3，[A-G2]：update-result.json.tmp / resume-state.json.tmp
 * 写崩残留后无任何读方消费，终态清理一并扫掉；跨平台产物，与 .downloading 同属
 * 升级工作目录（getUpdateDir()）扫描，不入 getStaleArtifactPaths——那是 mac/linux
 * 平台残留推导且 gated on .old 存在）。
 */
function cleanupUpdateDirResidues(): void {
  if (!existsSync(getUpdateDir())) return
  for (const f of readdirSync(getUpdateDir())) {
    if (f.endsWith('.downloading') || f.endsWith('.tmp')) {
      ignoreENOENT(path.join(getUpdateDir(), f))
    }
  }
}

/**
 * 推导当前平台的 .old 备份路径（若平台/环境不支持自更新则返回 undefined）。
 *
 * - mac：execPath .../TaiJi.app/Contents/MacOS/TaiJi → dirname×3 得 .app，
 *   备份在 `<appBundle>.old`
 * - linux：process.env.APPIMAGE → 备份在 `${APPIMAGE}.old`
 * - win/其他：返回 undefined（win 走 NSIS，无 .old 备份机制）
 */
function getOldBackupPath(): string | undefined {
  if (process.platform === 'darwin') {
    const appBundle = path.dirname(path.dirname(path.dirname(process.execPath)))
    return `${appBundle}.old`
  }
  if (process.platform === 'linux') {
    const appImage = process.env.APPIMAGE
    return appImage ? `${appImage}.old` : undefined
  }
  return undefined
}

/**
 * mac .app bundle 回滚：.old 存在 → 原子化恢复。
 *
 * 原子化策略（避免 rm 后 rename 失败导致 app 路径为空）：
 *   1. 先把破损 .app rename 到 .broken（rename 失败才退回 rmSync）
 *   2. rename .old 回 .app（失败则把 .broken 还回去，至少有 app 可用）
 *   3. 成功后清理 .broken
 *
 * execPath 推导 .app 路径：.../TaiJi.app/Contents/MacOS/TaiJi → dirname×3
 */
function rollbackMacBundle(): void {
  const appBundle = path.dirname(path.dirname(path.dirname(process.execPath)))
  const oldBundle = `${appBundle}.old`
  const brokenBundle = `${appBundle}.broken`
  // 1. 把破损 .app 移到 .broken（不直接 rm：rename 失败时原 app 仍在原位）
  if (existsSync(appBundle)) {
    try {
      renameSync(appBundle, brokenBundle)
    } catch (renameErr) {
      // rename 失败（跨设备/权限）：rm 作为最后手段
      console.warn('[update-self-healer] rename to .broken failed, falling back to rm:', renameErr)
      rmSync(appBundle, { recursive: true, force: true })
    }
  }
  // 2. 恢复 .old 到原位
  try {
    renameSync(oldBundle, appBundle)
  } catch (e) {
    // rename .old 失败：尝试把 .broken 还回去（至少保留一个可用的 app）
    if (existsSync(brokenBundle)) {
      try {
        renameSync(brokenBundle, appBundle)
      // eslint-disable-next-line taste/no-silent-catch -- best-effort：.broken 无法恢复，记录即可
      } catch (restoreErr) {
        console.warn('[update-self-healer] restore .broken failed:', restoreErr)
      }
    }
    throw e
  }
  // 3. 成功后清理 .broken（清理失败不影响回滚结果）
  try {
    rmSync(brokenBundle, { recursive: true, force: true })
  // eslint-disable-next-line taste/no-silent-catch -- best-effort：清理失败不影响回滚结果
  } catch (cleanupErr) {
    console.warn('[update-self-healer] cleanup .broken failed:', cleanupErr)
  }
}

/**
 * linux AppImage 回滚：.old 存在 → 原子化恢复。
 *
 * 原子化策略与 mac 一致：先把破损 AppImage rename 到 .broken，再 rename .old 回原位，
 * 最后清理 .broken。AppImage 是单文件（非目录）。
 */
function rollbackLinuxAppImage(): void {
  const appImage = process.env.APPIMAGE
  if (!appImage) return
  const oldImage = `${appImage}.old`
  const brokenImage = `${appImage}.broken`
  // 1. 把破损 AppImage 移到 .broken
  if (existsSync(appImage)) {
    try {
      renameSync(appImage, brokenImage)
    } catch (renameErr) {
      // rename 失败：rm 作为最后手段
      console.warn('[update-self-healer] linux rename to .broken failed, falling back to rm:', renameErr)
      rmSync(appImage, { force: true })
    }
  }
  // 2. 恢复 .old 到原位
  try {
    renameSync(oldImage, appImage)
  } catch (e) {
    // rename .old 失败：把 .broken 还回去
    if (existsSync(brokenImage)) {
      try {
        renameSync(brokenImage, appImage)
      // eslint-disable-next-line taste/no-silent-catch -- best-effort：.broken 无法恢复，记录即可
      } catch (restoreErr) {
        console.warn('[update-self-healer] linux restore .broken failed:', restoreErr)
      }
    }
    throw e
  }
  // 3. 成功后清理 .broken
  try {
    rmSync(brokenImage, { force: true })
  // eslint-disable-next-line taste/no-silent-catch -- best-effort：清理失败不影响回滚结果
  } catch (cleanupErr) {
    console.warn('[update-self-healer] linux cleanup .broken failed:', cleanupErr)
  }
}
