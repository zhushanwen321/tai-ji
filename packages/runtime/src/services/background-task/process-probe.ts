/**
 * 进程 start time 探测（D6 身份验证两档的「按需现测」档）。
 *
 * 与 reaper 的 getProcessStartTimeSec（spawnSync + 5s 超时）的关键差异：本探测跑在
 * 在役 WS RPC 路径（用户点「终止任务」），必须异步执行且短超时（≤1s），不阻塞
 * runtime 事件循环——reaper 的同步实现是启动期/销毁期语境，不照搬（D6 明文）。
 *
 * 平台分支：
 *  - macOS/Linux：`ps -o lstart=`（与 reaper/登记侧同源解析，Date.parse 按本地时区解释）
 *  - Windows：`Get-Process` .StartTime → ToUniversalTime().ToString('o') 输出 ISO 8601
 *    round-trip（locale 无关，D6 两档规格的「输出格式固化」要求；权限拒绝/进程不存在
 *    均走非零退出 → undefined）
 *
 * 返回 epoch 毫秒（统一口径）；探测不可得（超时/进程已死/ps 不可用/权限拒绝）返回
 * undefined——调用方按 D6 分支④ identity-unverifiable 拒绝 kill（宁不杀勿误杀）。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** 探测超时（D6：短超时 ≤1s，不阻塞事件循环）。 */
export const PROBE_TIMEOUT_MS = 1_000

const execFileAsync = promisify(execFile)

/** 解析探测输出为 epoch 毫秒；不可解析返回 undefined。 */
function parseEpochMs(stdout: string): number | undefined {
  const ms = Date.parse(stdout.trim())
  return Number.isNaN(ms) ? undefined : ms
}

/** 探测目标 pid 进程的 start time（epoch ms）。undefined = 探测不可得（分支④拒绝）。 */
export async function probeProcessStartTimeMs(pid: number): Promise<number | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    if (process.platform === 'win32') {
      // Get-Process .StartTime → ISO 8601 round-trip（'o' 格式，locale 无关）；
      // -ErrorAction Stop 使「进程不存在」走异常退出（catch → undefined）。
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
        { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      )
      return parseEpochMs(stdout)
    }
    // macOS/Linux：与登记侧同源（ps -o lstart=，= 号去表头）
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      timeout: PROBE_TIMEOUT_MS,
    })
    return parseEpochMs(stdout)
  } catch {
    // 超时 / 进程不存在 / ps 不可用 / Windows AccessDenied → 探测不可得
    return undefined
  }
}
