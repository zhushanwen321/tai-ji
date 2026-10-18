/**
 * 引擎组杀原语（M3，设计 relay-spawn-transport §3.3 D7）。
 *
 * 消费 extension-protocol 既有 killProcessTree（POSIX 负 pid 组杀 + 组长已死降级单杀
 * + 子孙递归兜底；Windows taskkill /PID /T /F）——不重写 relay-registry 的杀链。导出经
 * runtime 统一入口 utils/protocol-background-task.js（protocol 包 named re-export 单点）。
 *
 * 语义：SIGKILL 直杀、信号发出即返回（fire-and-forget）——真实 exit 由 child exit 事件
 * 收尾（pid 文件删除挂 exit 确认，D7「只有确认 exit/kill 成功才删 pid 文件」）。对已死
 * 组长负 pid 仍有效（组内幸存成员被收割），这正是 unexpected-exit 后孤儿 pi 的回收路径。
 */
import { killProcessTree } from '../../utils/protocol-background-task.js'

/** 杀组（best-effort；失败仅留 debug 诊断，失败残留的 pid 文件交启动 sweep 收割）。 */
export function killEngineGroup(pid: number | null | undefined, context: string): void {
  if (pid === null || pid === undefined || !Number.isInteger(pid) || pid <= 0) return
  killProcessTree(pid, (step, err) => {
    console.debug(`[subagent-control] group kill fallback (${step}) ${context} pid=${String(pid)}:`, err)
  })
}
