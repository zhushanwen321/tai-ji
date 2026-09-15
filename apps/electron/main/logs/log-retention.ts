/**
 * logs/ 目录保留期清理扫描（main 进程侧）。
 *
 * [crash-resilience §3.3 D6-⑦] 现状缺口：runtime logger 的 cleanExpiredLogs 唯一调用点
 * 是 initLogger（只在 runtime 启动时跑一次）；桌面 app 长开（实测 uptime 20 天）下，
 * runtime-* / pi-*（tee 实测单 session 累计 198MB）/ plugin-crash-* 的超龄文件在长寿
 * 运行期间无任何清理触发。本模块由 main 进程挂**每日定时器复扫** logs/ 全部清理前缀，
 * 补上长寿运行窗口（「清理不只启动时跑」）。
 *
 * 跨进程安全性分工（D6-⑦）：超龄清理是 unlink + mtime 判定，跨进程安全——任何进程删
 * 超龄文件都不打断其他进程的 append fd（writer 侧 fd 已打开的 inode 删路径不影响写入，
 * 只是该文件不再可见，而超龄文件本就该消失）；**固定名 stderr 文件除外**（见下方常量
 * 注释）——它们的治理唯一归 writer 侧 size 轮转（process-control.ts / subagent-core）。
 *
 * 保留天数 = shared `readLogKeepDays()`（env `TAIJI_LOG_KEEP_DAYS` 覆盖 || 默认 7）：
 * main（本模块）与 runtime（initLogger 清理）两进程同调同一函数，不出现两套值域漂移。
 *
 * 领地注：本文件属 crash-resilience u5a-main-logging 单元；u2（renderer-log handler）
 * 落盘的 renderer-error-<date>.log 前缀已提前纳入清理清单（设计 D6-⑦ 全前缀覆盖）。
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir } from '@taiji/shared/paths'
import { readLogKeepDays } from '@taiji/shared'

/**
 * 清理前缀全集（logs/ 目录全部日志家族的写入面覆盖）：
 * - `runtime-`：runtime 主日志（runtime-<date>.log / .1 滚动）
 * - `pi-`：pi stdout tee（pi-<date>-<sid>.jsonl）、relay 镜像（pi-relay-*）、崩溃取证
 *   （pi-crash-*）——后两者复用 pi- 前缀使命名惯例自动纳入清理（logger.ts 既有注释）
 * - `plugin-crash-`：plugin worker 崩溃取证（u5b 落点，前缀先行登记）
 * - `main-`：main 进程日志（本单元 main-logger.ts 写入）
 * - `renderer-error-`：renderer JS 错误落盘（u2 写入，main 侧 writer 消费）
 */
const RETENTION_PREFIXES = ['runtime-', 'pi-', 'plugin-crash-', 'main-', 'renderer-error-'] as const

/**
 * 固定名 stderr 文件——**不进超龄清单**（设计 D6-⑦，v7 复审定案）。
 *
 * 它们是「固定名 + writer 持有型 append fd」的兜底取证类（常态零输出即健康）：mtime
 * 超龄被 unlink 后 writer 仍持有已删 inode 的 fd，写入静默落进孤儿文件（写成功、盘上
 * 无路径、零错误信号），到 fd 重建前新 stderr 全部丢失——恰在崩溃取证时刻失效。它们的
 * 治理唯一归 writer 进程侧 size 轮转：electron-runtime-stderr.log → main 的
 * process-control.ts；zcode-appserver-stderr.log 是 W5 前历史遗留固定名（现 writer =
 * zcode-subagent-cli，pid 维度文件名 zcode-appserver-stderr-<pid>.log 不匹配任何清理
 * 前缀），保留在集合中仅防御性排除。显式集合排除是防御性的：前缀清单演化（如出现
 * *-stderr 类前缀）时不会误伤这些文件。
 */
const FIXED_NAME_STDERR_FILES = new Set(['electron-runtime-stderr.log', 'zcode-appserver-stderr.log'])

const SECONDS_PER_MINUTE = 60
const HOURS_PER_DAY = 24
const MS_PER_SECOND = 1000
const MS_PER_DAY = HOURS_PER_DAY * SECONDS_PER_MINUTE * SECONDS_PER_MINUTE * MS_PER_SECOND
/** 每日复扫间隔（24h）。 */
const LOG_RETENTION_INTERVAL_MS = HOURS_PER_DAY * SECONDS_PER_MINUTE * SECONDS_PER_MINUTE * MS_PER_SECOND

/** 一次清理扫描的结果计数（调用方日志/测试断言用）。 */
export interface LogRetentionResult {
  /** 匹配清理前缀且为文件（非目录）的条目数。 */
  scanned: number
  /** 实际删除（mtimeMs < cutoff）的文件数。 */
  removed: number
}

/**
 * 清理 logsDir 下超龄（mtimeMs < now - keepDays 天）的匹配前缀文件。
 *
 * 语义（设计 D6-⑦）：
 * - 目录不存在 → 静默跳过（首次启动 logs/ 可能尚未建立，非错误）
 * - 只处理匹配 RETENTION_PREFIXES 的条目；跳过目录与其他文件（token/缓存等非日志产物）
 * - 判定用 `statSync().mtimeMs`（不是文件名里的日期）：活跃文件（如跨天长寿命 tee）
 *   mtime 持续刷新，永不被误删；文件名日期只是命名惯例，不是清理依据
 * - 固定名 stderr 文件无条件排除（见 FIXED_NAME_STDERR_FILES 注释）
 * - 单文件失败（并发删除/权限）best-effort 跳过，不影响其他文件
 *
 * 纯逻辑（logsDir/keepDays 参数注入），可直接单测。
 */
export function cleanExpiredLogs(logsDir: string, keepDays: number, now: number = Date.now()): LogRetentionResult {
  const cutoff = now - keepDays * MS_PER_DAY
  let entries: string[]
  try {
    entries = readdirSync(logsDir)
  } catch {
    // 目录不存在（首次启动未建立）静默跳过——清理扫描不得反向制造目录或抛错
    return { scanned: 0, removed: 0 }
  }
  let scanned = 0
  let removed = 0
  for (const name of entries) {
    if (FIXED_NAME_STDERR_FILES.has(name)) continue
    if (!RETENTION_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    const full = join(logsDir, name)
    try {
      const st = statSync(full)
      if (st.isDirectory()) continue
      scanned++
      if (st.mtimeMs >= cutoff) continue
      unlinkSync(full)
      removed++
    // eslint-disable-next-line taste/no-silent-catch -- 单文件清理失败（并发删除/权限）不影响其他文件；best-effort 容错，对齐 runtime logger cleanExpiredLogs
    } catch {
      // no-op
    }
  }
  return { scanned, removed }
}

/**
 * logs 目录路径：从 shared getDataDir() 动态推导（`<dataDir>/logs`），禁止写死绝对路径
 * （仓规：dev/prod/dev-worktree 数据目录不同，硬编码会串实例）。
 */
export function getLogsDir(): string {
  return join(getDataDir(), 'logs')
}

/**
 * 立即执行一次清理扫描（保留天数读 shared readLogKeepDays()）。
 *
 * **清理定时器触发入口**（设计 A9② 长寿模拟验收定型）：dev 调试口 / 临时 IPC 可直接
 * 调用本函数验证「清理不只启动时跑」——配 `TAIJI_LOG_KEEP_DAYS=1` 之类小保留期 + 手动
 * 触发，断言超龄 runtime-* / pi-* 文件被清、固定名 stderr 文件不误删。main-logger init
 * 时与每日定时器触发时也走同一函数。
 */
export function runLogRetentionNow(now: number = Date.now()): LogRetentionResult {
  return cleanExpiredLogs(getLogsDir(), readLogKeepDays(), now)
}

/**
 * 挂每日复扫定时器（main-logger init 调用；间隔 24h，unref 不 hold 进程退出）。
 *
 * 返回 stop 函数（closeMainLogger / 测试清理用）。与启动时的一次性扫描互补：
 * init 时立即跑一次（对齐 runtime initLogger 惯例）+ 此后每日复扫（补长寿窗口）。
 */
export function startLogRetentionTimer(): () => void {
  const timer = setInterval(() => {
    runLogRetentionNow()
  }, LOG_RETENTION_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
