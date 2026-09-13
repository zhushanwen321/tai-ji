/**
 * 后台任务进程原语（pid 判活 / 进程树处置 / start time 身份判据）——跨端单一实现。
 *
 * 契约两端（此前各持一份逐字同构实现，对齐手段是注释，已归一到本模块）：
 *  - extension 侧：@zhushanwen/pi-base-tool-enhance（bash_kill 前校验 / 后台 timeout
 *    到点校验 / 对账判死），原实现在其 kill-tree.ts
 *  - runtime 侧：xyz-agent background-task-reaper（孤儿收殓三分支判定），原实现在
 *    background-task-reaper.ts 原语区
 *
 * 分支语义（与 pi 实装对齐，勿单侧擅改）：Windows `taskkill /F /T`；POSIX 杀进程组
 * `kill -- -<pgid>`（后台任务 detached spawn 自成进程组，pgid = pid）；进程组杀不到时
 * 回退单 pid + `pgrep -P` 递归杀残留子进程。
 *
 * 日志通道：本模块零日志依赖（protocol 零运行时依赖纪律）——回退路径的诊断经可选
 * 回调 `onFallback(step, err)` 上报，extension 侧注入 logger.debug 适配、runtime 侧
 * 注入 console.debug 适配。step 为稳定短标识符：
 *  - 'process-group-kill-missed'      POSIX 进程组 kill 失败（组长已死），走回退
 *  - 'single-pid-kill-missed'         单 pid kill 失败（目标已死，幂等语义）
 *  - 'taskkill-failed'                Windows taskkill 失败
 *  - 'descendant-enumeration-failed'  pgrep 不可用/失败，放弃子孙枚举
 *  - 'descendant-kill-missed'         子孙 kill 失败（已死，幂等语义）
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'

/** killProcessTree 回退路径诊断回调（落盘/console 通道由调用方适配注入）。 */
export type ProcessFallbackLogger = (step: string, err: unknown) => void

/** ps 调用超时：卡死的 ps 不拖垮调用方（超时按取不到处理 → 保守跳过）。 */
const PS_TIMEOUT_MS = 5_000
/** 毫秒 → 秒（epoch 秒换算；勿与 startedAt 的毫秒混用）。 */
const MS_PER_SECOND = 1_000

/**
 * pid 判活：kill(pid, 0) 不发信号只做存在性/权限校验。
 * ESRCH = 已死（含被 reap 后）；EPERM = 进程存在但属其他用户，仍视为活。
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 杀整棵进程树（同步；收殓路径在 process.on("exit") 里跑，必须同步）。
 * POSIX 杀进程组（pgid = pid）一次性覆盖全部子孙；进程组杀不到（组长已死）回退
 * 单 pid + pgrep -P 递归清理残留子进程（先杀孙辈再杀子辈，防孙辈在父死后被
 * reparent 逃逸枚举）。Windows taskkill /F /T。幂等：目标已死时静默成功
 * （回退路径的诊断经 onFallback 上报，无回调则静默）。
 */
export function killProcessTree(pid: number, onFallback?: ProcessFallbackLogger): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    killProcessTreeWindows(pid, onFallback)
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
    return
  } catch (err) {
    // best-effort 降级：组长已死（进程组不复存在）时走单 pid + 子孙递归兜底
    onFallback?.('process-group-kill-missed', err)
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch (err) {
    // best-effort：目标已死（kill 幂等语义），仅留诊断
    onFallback?.('single-pid-kill-missed', err)
  }
  killDescendantsRecursive(pid, onFallback)
}

function killProcessTreeWindows(pid: number, onFallback?: ProcessFallbackLogger): void {
  try {
    const result = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (result.error) throw result.error
  } catch (err) {
    // best-effort：taskkill 失败（进程已死/权限）仅留诊断——收殓路径不因处置失败中断
    onFallback?.('taskkill-failed', err)
  }
}

/** pgrep -P 递归杀子孙进程（组长已死、进程组不复存在时的残留清理）。 */
function killDescendantsRecursive(pid: number, onFallback?: ProcessFallbackLogger): void {
  let stdout: string
  try {
    const result = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
    if (result.error || result.status !== 0 || !result.stdout) return
    stdout = result.stdout
  } catch (err) {
    // best-effort：pgrep 不可用/失败时放弃子孙枚举（残留子进程交下个收殓周期）
    onFallback?.('descendant-enumeration-failed', err)
    return
  }
  for (const line of stdout.split('\n')) {
    const childPid = Number.parseInt(line.trim(), 10)
    if (Number.isInteger(childPid) && childPid > 0) {
      killDescendantsRecursive(childPid, onFallback)
      try {
        process.kill(childPid, 'SIGKILL')
      } catch (err) {
        // best-effort：已死（kill 幂等语义），仅留诊断
        onFallback?.('descendant-kill-missed', err)
      }
    }
  }
}

/**
 * 取进程 start time（epoch 秒）。ps -o lstart= 跨 macOS/Linux（= 号去表头；Linux
 * /proc/<pid>/stat 精度更高但 macOS 无 /proc，统一 ps 保跨平台一致）。
 * 返回 undefined：进程不存在 / ps 不可用（Windows）/ 输出不可解析——调用方一律按
 * 「无法校验 → 保守跳过」处理。
 */
export function getProcessStartTimeSec(pid: number): number | undefined {
  let result: SpawnSyncReturns<string>
  try {
    result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
    })
  } catch {
    return undefined
  }
  if (result.error || result.status !== 0 || !result.stdout) return undefined
  // lstart 形如 "Mon Aug 25 14:23:45 2026"（本地时区），Date.parse 按本地时区解释
  const ms = Date.parse(result.stdout.trim())
  return Number.isNaN(ms) ? undefined : Math.floor(ms / MS_PER_SECOND)
}

/**
 * pid 身份判据（「宁不杀勿误杀」的唯一判定点）。
 * true = 当前占用该 pid 的进程 start time 与登记值匹配，可安全 kill。
 *  - 有登记 start time（spawn 时 ps 读取成功）→ 精确比较（同单位 epoch 秒）
 *  - 缺登记 start time（旧条目 / ps 不可用平台登记）→ startedAtMs 秒级降级：
 *    登记发生在 spawn 之后（进程先启动、条目后登记），原进程 start time 必然
 *    ≤ floor(startedAtMs/1000)（floor 单调性，零误跳）
 */
export function pidStartMatchesRegistered(
  actualStartSec: number,
  registeredStartSec: number | undefined,
  startedAtMs: number,
): boolean {
  return registeredStartSec !== undefined
    ? actualStartSec === registeredStartSec
    : actualStartSec <= Math.floor(startedAtMs / MS_PER_SECOND)
}
