import { unlinkSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { platform } from 'node:os'
import { buildOutboundChildEnv } from '../spawn-env.js'
import { logger } from '../logger.js'
import { toErrorMessage } from '../../utils/errors.js'

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
    try {
      execSync(`trash "${filePath}" 2>/dev/null || osascript -e 'tell application "Finder" to delete POSIX file "${filePath}"' 2>/dev/null`, {
        stdio: 'ignore',
        timeout: 5000,
        // C-proc-09：出站契约构建器组装 env，deny 兜底剥凭证（trash/osascript 仅需
        // PATH，白名单基座保留），防 OS 工具后代进程读走 TAIJI_RUNTIME_TOKEN
        env: buildOutboundChildEnv({ parentEnv: process.env }),
      })
      return
    } catch (e) {
      // D4-2：失败必须落盘留痕（console 在打包环境不可观测），再抛结构化错误。
      // 快失败（trash CLI 缺失直接走 osascript 也失败）与超时同语义：保留文件 + 报错。
      logger.error('[trash] failed to move file to trash, file kept in place', {
        filePath,
        error: toErrorMessage(e),
      })
      throw new Error(
        `移入废纸篓失败（Finder 未在 5s 内响应或命令失败）。文件已保留在原位置，未做任何删除：${filePath}。👉 稍后重试删除；或手动在访达中将该文件拖入废纸篓。`,
      )
    }
  }
  unlinkSync(filePath)
}
