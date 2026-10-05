// src/active-children.ts
//
// 当前活跃子进程记账（自 spawn-runner.ts 提取）：镜像上报 / dispose 收割
// 消费；引擎进程内权威。spawn-runner.ts re-export 全部导出保持既有导入面
// （index.ts / pi-engine.ts / __tests__ 均从 spawn-runner 导入）。
//
// [U1 归并] dispose 收割切 pi-rpc killPiProcess（与 spawn-runner killChild /
// runtime 主链路同源）；原「SIGTERM → 30s grace → SIGKILL 升级链」随 ADR-0122
// 防御清理退役——killPiProcess 现为 SIGKILL 直杀 + 立即 resolve。

import type { ChildProcess } from "node:child_process";

import { getLogger } from "@zhushanwen/subagent-engine-sdk";
import { killPiProcess } from "@zhushanwen/pi-rpc";

const logger = getLogger("session-runner");

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

/**
 * 全量收割（dispose）：SIGKILL 直杀（pi-rpc killPiProcess 单源）；返回收割数。
 *
 * 杀决策落盘（2026-09-24 事故取证补口）：dispose 全量收割会连坐杀掉**正在运行**的
 * record 子进程（relay 形态下 = relay.mjs 代理 → runtime kill-on-disconnect 连坐真
 * pi child）——该决策此前零日志，主 pi 侧先杀代理的断连形态第一现场不可考。收割
 * 必记 warn：record 清单 + 各自进程态（在跑被杀 / 已退出仅销账）。
 */
export function killAllActiveChildren(): number {
  let killed = 0;
  const victims: string[] = [];
  const finished: string[] = [];
  for (const [recordId, child] of activeChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      killed++;
      victims.push(`${recordId}(pid=${String(child.pid)})`);
      void killPiProcess(child);
    } else {
      finished.push(recordId);
    }
    activeChildren.delete(recordId);
  }
  if (killed > 0) {
    // 运行中 record 被 dispose 连坐杀：这是「主 pi 侧先断 → runtime kill-on-disconnect」
    // 断连形态的上游触发指纹，warn 级必达（TAIJI_AGENT_EXT_LOG=1 即落盘，无需 DEBUG 档）
    logger.warn(
      `[session-runner] dispose killAll: killing ${killed} active child(ren) [${victims.join(", ")}]` +
        (finished.length > 0 ? `; ${finished.length} already-exited record(s) unregistered only [${finished.join(", ")}]` : ""),
    );
  }
  return killed;
}
