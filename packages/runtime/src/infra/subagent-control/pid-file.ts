/**
 * control 目录 / 引擎 pid 文件的权限与原子写原语（M3 设计 §3.3 D4/D7）。
 *
 * 从 control-server 抽出的独立文件（max-lines 收口）：这两件事只依赖路径与 fs，
 * 不依赖通道状态机。
 */
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { toErrorMessage } from '../../utils/errors.js'

/** control 目录/文件权限（D4：run/ 0700，pid 文件 0600）。 */
const CONTROL_DIR_MODE = 0o700
const CONTROL_PID_FILE_MODE = 0o600
/** pid 临时文件随机后缀字节数（同目录并发 spawn 时文件名不碰撞）。 */
const PID_TMP_RANDOM_BYTES = 6

/**
 * 创建目录并强制收敛为 0700（含已存在目录；mkdirSync 的 mode 对存量目录不生效）。
 * win32 无 POSIX 权限位（named pipe 用默认 ACL，设计允许显式登记），跳过 chmod。
 * 失败 fail-fast：权限面是 socket 的认证边界，早发现优于降级。
 */
export function ensurePrivateControlDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: CONTROL_DIR_MODE })
  if (process.platform === 'win32') return
  try {
    chmodSync(dir, CONTROL_DIR_MODE)
  } catch (e) {
    throw new Error(
      `[subagent-control] failed to enforce 0700 on control dir ${dir}: ${toErrorMessage(e)}. `
      + 'Recovery: fix the directory ownership/permissions under the runtime data dir and restart.',
    )
  }
}

/**
 * pid 文件原子写（planner④）：同目录临时文件（0600）→ fsync → rename 原子替换。
 * 直接 writeFileSync 在崩溃/掉电时可能留下空/半截 JSON，而 sweep 对不可解析文件的
 * 处理无法恢复引擎 pid 锚点。失败清理 tmp 后上抛（调用方只 warn，不阻塞 spawn）。
 */
export function writeEnginePidFileAtomically(pidFile: string, payload: Record<string, unknown>): void {
  const tmpFile = `${pidFile}.tmp-${String(process.pid)}-${randomBytes(PID_TMP_RANDOM_BYTES).toString('hex')}`
  const data = Buffer.from(JSON.stringify(payload), 'utf8')
  let fd: number | null = null
  try {
    fd = openSync(tmpFile, 'wx', CONTROL_PID_FILE_MODE)
    writeSync(fd, data)
    // 可选 fsync：保证 rename 前内容已落盘（掉电形态下的原子性完整性）
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmpFile, pidFile)
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd)
      // eslint-disable-next-line taste/no-silent-catch -- 清理路径不叠加异常（原始错误在下方 throw）
      } catch {
        // 忽略：原始错误在下方 throw
      }
    }
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile)
    // eslint-disable-next-line taste/no-silent-catch -- tmp 残片不影响 rename 语义（唯一随机后缀不复用）
    } catch {
      // 忽略：tmp 残片不影响 rename 语义
    }
    throw e
  }
}
