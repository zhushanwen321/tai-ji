import { unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'
import { buildOutboundChildEnv } from '../spawn-env.js'
import { logger } from '../logger.js'
import { toErrorMessage } from '../../utils/errors.js'

// RT-8#2：osascript 路径经 argv 注入（on run argv + item 1 of argv），文件路径
// 不进 AppleScript 源码字符串——无任何转义面，含 " / $() 的路径原样到达 Finder。
const FINDER_DELETE_SCRIPT = 'on run argv\ntell application "Finder" to delete POSIX file (item 1 of argv)\nend run'

/** 提取 execFileSync 失败时捕获的 stderr（Buffer 或 string），并入重抛消息用。 */
function capturedStderr(e: unknown): string {
  const stderr = (e as { stderr?: unknown }).stderr
  if (typeof stderr === 'string') return stderr.trim()
  if (Buffer.isBuffer(stderr)) return stderr.toString('utf-8').trim()
  return ''
}

/**
 * Move file to system trash (macOS) or permanently delete (non-mac).
 *
 * G4 语义（timeout-audit-hygiene-batch §3.4 D4-1）：mac 路径 trash 命令超时/失败
 * 不再降级 unlinkSync——文件保留原地并抛结构化错误（含路径与恢复指引），
 * 「可撤销操作永不静默变不可逆」由构造保证。5s 超时量级保持现状（D4-3：
 * AppleScript 正常 <1s，超时说明 Finder 不可用，再宽也无益）。
 */
export async function trash(filePath: string): Promise<void> {
  // platform() 进程内恒定，函数内求值仅为可测性（mock 注入后无需 resetModules）
  const isMac = platform() === 'darwin'
  if (isMac) {
    // C-proc-09：出站契约构建器组装 env，deny 兜底剥凭证（trash/osascript 仅需
    // PATH，白名单基座保留），防 OS 工具后代进程读走 TAIJI_RUNTIME_TOKEN
    const childEnv = buildOutboundChildEnv({ parentEnv: process.env })
    // RT-8#2：数组参数形态，filePath 不经 shell 解释（此前拼 shell 字符串，
    // 路径含 " / $() 即逃逸执行任意命令）。stdio 缺省 pipe：失败时 stderr 被
    // 捕获进 error.stderr，供下方并入错误消息（不再 2>/dev/null 吞真因）。
    const childOpts = { timeout: 5000, env: childEnv }
    try {
      try {
        execFileSync('trash', [filePath], childOpts)
        return
      } catch {
        // trash CLI 缺失/失败 → 回落 Finder AppleScript（同样数组参数）
        execFileSync('osascript', ['-e', FINDER_DELETE_SCRIPT, filePath], childOpts)
      }
      return
    } catch (e) {
      const stderr = capturedStderr(e)
      // D4-2：失败必须落盘留痕（console 在打包环境不可观测），再抛结构化错误。
      // 快失败（trash CLI 缺失直接走 osascript 也失败）与超时同语义：保留文件 + 报错。
      logger.error('[trash] failed to move file to trash, file kept in place', {
        filePath,
        error: toErrorMessage(e),
        ...(stderr ? { stderr } : {}),
      })
      const cause = stderr ? `（底层错误：${stderr}）` : ''
      throw new Error(
        `移入废纸篓失败（Finder 未在 5s 内响应或命令失败）。文件已保留在原位置，未做任何删除：${filePath}。👉 稍后重试删除；或手动在访达中将该文件拖入废纸篓。${cause}`,
      )
    }
  }
  unlinkSync(filePath)
}
