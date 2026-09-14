import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * 真实 pi agent 数据常量 + 存在性探测（MF-1：CI 无本机 ~/.pi/agent 目录，
 * 依赖真实数据的用例必须 skipIf 守卫，否则 CI `pnpm extensions:test` 必红）。
 *
 * 用法：测试文件 `import { REAL_AGENT_DIR, HAS_E6 } from './real-data.js'`，
 * 真实数据用例套 `it.skipIf(!HAS_X)` / `describe.skipIf(!HAS_X)`；
 * fixture 用例保持无条件跑。
 *
 * 本文件无 .test.ts 后缀，vitest include 只收集 `src/__tests__/` 下以 .test.ts 结尾的文件，不收集本文件。
 */

/** 真实 pi agent 目录（本机），用于集成测试。 */
export const REAL_AGENT_DIR = '/Users/zhushanwen/.pi/agent'

/**
 * 全量扫描类真实数据用例的统一超时标定（90s）。
 *
 * 这类用例遍历本机 ~/.pi/agent 全量会话语料（实测 4600+ 文件），空载单用例已需 6-10s；
 * 38 包并行全量测试时 CPU/IO 争抢可降速 3-4 倍，30s 标定必假红。90s ≈ 空载 9 倍余量，
 * 仍能兜住真正的挂死。仅用于遍历全量语料的用例（findSessions / buildFamilyFromFs /
 * resolveSessionRoots 等）；读已知单文件的用例不需要放宽。
 */
export const REAL_DATA_TIMEOUT_MS = 90_000

/** 5.4MB / 32 turn / 1204 entry 的真实 session（feat-plugin-arch-3 目录）。 */
export const E6 = '019e6c96-0a0c-74b8-a73f-d1854d88e2a7'
/** 真实 fork 家族根（fork 子代 019fe632，隔代 subagent 019fe635 挂在 019fe632 下）。 */
export const FAM = '019fe620-8ae1-78a7-b76a-43a1ba4cc3c7'

/** E6 的完整文件路径（parser/turns/render 直接 parseSessionFile 用）。 */
export const REAL_SESSION = join(
  REAL_AGENT_DIR,
  'sessions',
  '--Users-zhushanwen-Code-xyz-agent-workspace-feat-plugin-arch-3--',
  `2026-05-28T03-17-12-844Z_${E6}.jsonl`,
)

/** 同步探测真实 session 文件是否存在（不存在则 skip，避免在无该数据的机器上硬失败）。 */
export function hasRealSession(sid: string): boolean {
  if (!existsSync(REAL_AGENT_DIR)) return false
  try {
    return (
      execSync(
        `find ${REAL_AGENT_DIR}/sessions -name '*${sid}*' -name '*.jsonl' ! -name '*.finalized' 2>/dev/null | head -1`,
        { encoding: 'utf8' },
      ).trim().length > 0
    )
  } catch {
    return false
  }
}

/**
 * 同步探测真实数据中任意 session 文件存在（main sessions/ 与 subagents/ 双目录）。
 * 与 hasRealSession 的区别：subagent session 文件位于 subagents/<cwd>/sessions/ 下，
 * hasRealSession 只扫主 sessions/ 目录扫不到。用于对活跃数据目录中具体文件（如 fork
 * 子代/隔代 subagent）存在性的守卫探测。
 */
export function hasAnyRealSession(fragment: string): boolean {
  if (!existsSync(REAL_AGENT_DIR)) return false
  try {
    return (
      execSync(
        `find ${REAL_AGENT_DIR}/sessions ${REAL_AGENT_DIR}/subagents -name '*${fragment}*' -name '*.jsonl' ! -name '*.finalized' 2>/dev/null | head -1`,
        { encoding: 'utf8' },
      ).trim().length > 0
    )
  } catch {
    return false
  }
}

export const HAS_REAL_AGENT_DIR = existsSync(REAL_AGENT_DIR)
export const HAS_REAL_SUBAGENTS_DIR = existsSync(join(REAL_AGENT_DIR, 'subagents'))
export const HAS_REAL_SESSION = existsSync(REAL_SESSION)
export const HAS_E6 = hasRealSession(E6)
export const HAS_FAM = hasRealSession(FAM)
/** tool-handler 的 handleSessionRead 套件同时依赖 E6 + FAM。 */
export const HAS_REAL = HAS_E6 && HAS_FAM
