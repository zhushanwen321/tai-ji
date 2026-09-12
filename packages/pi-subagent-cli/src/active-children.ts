// src/active-children.ts
//
// 当前活跃子进程记账（自 spawn-runner.ts 提取）：镜像上报 / dispose 收割
// 消费；引擎进程内权威。spawn-runner.ts re-export 全部导出保持既有导入面
// （index.ts / pi-engine.ts / __tests__ 均从 spawn-runner 导入）。

import type { ChildProcess } from "node:child_process";

import { killChain } from "@zhushanwen/subagent-engine-sdk";

import { PI_KILL_GRACE_MS } from "./constants.ts";

/** 活跃子进程表（recordId → child）。 */
const activeChildren = new Map<string, ChildProcess>();

/** 注册活跃子进程（interact 热路径投递面）。 */
export function registerActiveChild(recordId: string, child: ChildProcess): void {
  activeChildren.set(recordId, child);
}

/** 注销（close 后调用）。 */
export function unregisterActiveChild(recordId: string, child: ChildProcess): void {
  if (activeChildren.get(recordId) === child) activeChildren.delete(recordId);
}

/** 按 record 取活跃子进程（undefined = 无句柄，对齐 getChildByRecord 语义）。 */
export function getActiveChild(recordId: string): ChildProcess | undefined {
  return activeChildren.get(recordId);
}

/** 全量收割（dispose）：SIGTERM + 30s SIGKILL 升级；返回收割数。 */
export function killAllActiveChildren(signal: NodeJS.Signals = "SIGTERM"): number {
  let killed = 0;
  for (const [recordId, child] of activeChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      killed++;
      child.kill(signal);
      void killChain(child, {
        graceMs: PI_KILL_GRACE_MS,
        unrefTimers: true,
        escalationNote: `child ${recordId} (source: dispose killAll)`,
      });
    }
    activeChildren.delete(recordId);
  }
  return killed;
}
