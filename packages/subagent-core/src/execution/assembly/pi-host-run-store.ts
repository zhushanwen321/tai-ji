// src/execution/assembly/pi-host-run-store.ts
//
// pi 宿主 workflow run 的 GC 读侧枚举（pi 壳装配点注入，跑在 pi 进程内）。
//
// 为什么存在：run state 写侧（pi 壳 JsonlRunStore）落盘 =
// <piAgentDir>/sessions/<cwd-slug>/workflow-state/。pi 的布局里这是两棵树：
// session 文件池在 <piHome>/sessions/（agent 目录的兄弟，平铺 <ts>_<id>.jsonl），
// run state 的 slug 树在 <piAgentDir>/sessions/<slug>/——从 session 文件路径
// 反推 agentDir 的推导会因两树相对位置不同而错位（2026-09-27 W2 D3 场景 3
// 真机链两轮定位：先排除 cwd/env 推导错位，再排除 sessionFile 反推——后者
// 恰好在自造布局上成立、在 pi 标准布局上错位）。终态裁决：读侧目录不从
// 任何路径猜，由 pi 壳装配点注入 pi SDK 的 getAgentDir() 活源（与壳
// resolveSessionDir 同源，pi 升级自动跟随），枚举全部 session 目录——
// same/cross-session 两形态一次覆盖（单目录扫描对 cross-session 形态结构性
// 不可达）+ agentDir 根 workflow-state（resolvePiSessionScopedDir 回退分支
// 兼容）。每轮 loadAll 现解析（目录集运行时可变，对齐 sessionFace 晚绑定
// 纪律）。
//
// 分层边界：本模块只消费 agentDir 注入，不 import pi SDK（core 约束）。
// zcode 宿主不适用本枚举（run state 落 FileRunStore 缺省 dataRoot 根）——
// 装配点不注入时走 FileRunStore() 缺省布局。

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { getLogger } from "../../core/logger.ts";
import { FileRunStore, STATE_DIR_NAME } from "../../orchestration/file-run-store.ts";
import type { WorkflowRunGcStore } from "../persistence/idle-gc.ts";

const logger = getLogger("subagents");

/** pi sessions 目录分量（pi 壳建目录方字面量，与 workflow-state-root.ts 的
 *  join(agentDir, "sessions", …) 同源约束：pi 布局演进须两侧同步）。 */
const SESSIONS_DIR_NAME = "sessions";

/**
 * pi 宿主全 session 的 run state 枚举 store（WorkflowRunGcStore 适配）。
 *
 * 目录不存在 = 从未落盘的正常空态（FileRunStore.loadAll 内部 ENOENT 承接）。
 */
export function createPiHostRunEnumeration(
  getAgentDir: () => string,
): WorkflowRunGcStore {
  let firstScanLogged = false;
  return {
    async loadAll() {
      const agentRoot = getAgentDir();
      const stateDirs = [join(agentRoot, STATE_DIR_NAME)];
      const sessionsRoot = join(agentRoot, SESSIONS_DIR_NAME);
      try {
        for (const ent of await readdir(sessionsRoot, { withFileTypes: true })) {
          if (ent.isDirectory()) {
            stateDirs.push(join(sessionsRoot, ent.name, STATE_DIR_NAME));
          }
        }
      } catch {
        // sessions 根不存在/不可读 = 从未有过 session 落盘（或已清理），
        // 空态不是错误——仅保留 agentDir 根回退目录的扫描。
      }
      const runs: Awaited<ReturnType<WorkflowRunGcStore["loadAll"]>> = [];
      for (const dir of stateDirs) {
        runs.push(...(await new FileRunStore({ stateDir: dir }).loadAll()));
      }
      if (!firstScanLogged) {
        firstScanLogged = true;
        logger.debug(
          `[subagents] GC: first enumeration scan: ${runs.length} run(s) across ${stateDirs.length} state dir(s) (agentRoot=${agentRoot})`,
        );
      }
      return runs;
    },
  };
}
