/**
 * 引擎反向通道的 child pid 集合维护 + Windows 树杀目标计算（M3 设计 §3.3 D7）。
 *
 * runtime 只解析 `host/childSpawned` / `host/childStateChanged` 两个信封，其余 engine
 * 帧保持不透明。集合的唯一消费方 = Windows 意外退出兜底：引擎树根已死时
 * `taskkill /T <enginePid>` 无树可枚举，必须回退到逐个 child pid 树杀。
 */

/**
 * 从一行引擎 stdout 载荷中提取 child pid 登记（形状守卫失败静默忽略；解析失败不得
 * 影响帧转发）。`host/childStateChanged` 标 exited/killed 时从集合移除。
 */
export function trackEngineChildPid(pidSet: Set<number>, line: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return
  }
  if (typeof parsed !== 'object' || parsed === null) return
  const frame = parsed as Record<string, unknown>
  if (frame.method !== 'host/childSpawned' && frame.method !== 'host/childStateChanged') return
  const params = frame.params
  if (typeof params !== 'object' || params === null) return
  const pid = (params as Record<string, unknown>).pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return
  if (frame.method === 'host/childSpawned') {
    pidSet.add(pid)
    return
  }
  const state = (params as Record<string, unknown>).state
  const killed = (params as Record<string, unknown>).killed
  if (state === 'exited' || killed === true) pidSet.delete(pid)
}

/**
 * Windows 树杀目标（D7）：引擎仍存活 → 只杀引擎树（taskkill /T 可枚举子进程）；
 * 引擎已死 → 逐个杀反向通道登记且仍存活的 child pid。返回空数组 = 无可杀目标。
 */
export function collectWindowsTreeKillTargets(
  enginePid: number | null,
  pidSet: ReadonlySet<number>,
  isAlive: (pid: number) => boolean,
): number[] {
  if (enginePid !== null && isAlive(enginePid)) return [enginePid]
  const targets: number[] = []
  for (const pid of pidSet) {
    if (pid === enginePid || !isAlive(pid)) continue
    targets.push(pid)
  }
  return targets
}
