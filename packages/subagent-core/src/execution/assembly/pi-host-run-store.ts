// src/execution/assembly/pi-host-run-store.ts
//
// pi 宿主 workflow run 的读侧枚举（runtime 启动扫描的枚举原语——终态语境）。
//
// 为什么存在：run state 写侧（pi 壳 JsonlRunStore）落盘 =
// <piAgentDir>/sessions/<cwd-slug>/workflow-state/。pi 的布局里这是两棵树：
// session 文件池在 <piHome>/sessions/（agent 目录的兄弟，平铺 <ts>_<id>.jsonl），
// run state 的 slug 树在 <piAgentDir>/sessions/<slug>/——从 session 文件路径
// 反推 agentDir 的推导会因两树相对位置不同而错位（2026-09-27 W2 D3 场景 3
// 真机链两轮定位：先排除 cwd/env 推导错位，再排除 sessionFile 反推——后者
// 恰好在自造布局上成立、在 pi 标准布局上错位）。终态裁决：读侧目录不从
// 任何路径猜，由调用方注入 pi 布局的 agentDir 活源（pi 壳注入 pi SDK
// getAgentDir()，与壳 resolveSessionDir 同源，pi 升级自动跟随；runtime 侧注入
// getPiAgentDir() 自派生树）。消费方 = runtime 启动扫描（startup-sweep）：
// 全量枚举 + 逐 run 收编（adoptInterruptedRun 的 journalDir per-call 参数，
// idle-gc 退役 §3.3 决策 2），枚举全部 session 目录——same/cross-session 两
// 形态一次覆盖（单目录扫描对 cross-session 形态结构性不可达）+ agentDir 根
// workflow-state（resolvePiSessionScopedDir 回退分支兼容）。每轮 loadAll 现解析
//（目录集运行时可变，对齐 sessionFace 晚绑定纪律）。
//
// 读错分通道（idle-gc 退役 §3.1 规格 2）：sessions 根 ENOENT = 从未有过 session
// 落盘的正常空态（仅保留 agentDir 根回退目录扫描）；EACCES / EIO 等真 IO 故障
// 上抛给扫描层——静默折叠成空集会让持续 IO 故障伪装成「0 个 run 的成功扫描」
// （与 §2.3 批评的「静默跳过伪装成无 run 可回收」同病）。
//
// 分层边界：本模块只消费 agentDir 注入，不 import pi SDK（core 约束）。
// zcode 宿主不适用本枚举（run state 落 FileRunStore 缺省 dataRoot 根）——
// 装配点不注入时走 FileRunStore() 缺省布局。

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { FileRunStore, STATE_DIR_NAME } from "../../orchestration/file-run-store.ts";
import { errorCodeOf } from "../../shared/fs-error.ts";

/** pi sessions 目录分量（pi 壳建目录方字面量，与 workflow-state-root.ts 的
 *  join(agentDir, "sessions", …) 同源约束：pi 布局演进须两侧同步）。 */
const SESSIONS_DIR_NAME = "sessions";

/**
 * WorkflowRun 枚举 store 窄口（run 枚举读侧对 WorkflowRun store 的最小依赖面，
 * 结构类型——调用方传 FileRunStore 实例即可，不 import orchestration 具体类，
 * 保持本模块可独立编译 + 单测）。
 *
 * 返回形态（idle-gc 退役 §3.1 规格 2 终态重构）：`{ runId, stateDir, status }`
 * ——stateDir = 该 run 的 workflow-state 目录（FileRunStore 构造时已知），启动
 * 扫描收编按它传 journalDir 参数；不含 startedAt（旧 TTL 超龄判定字段，全量
 * 收编不判超龄，消费方为零的字段不进接口）。
 *
 * [W2/V1] transition/save 成员删除：终局化经收编原语（journal/manifest 写面，
 * 不经两态机快照）——快照写面不再是枚举读侧的职责（判据读者已随 D6 改接换源）。
 */
export interface WorkflowRunEnumerationStore {
  loadAll(): Promise<Array<{ runId: string; stateDir: string; status: string }>>;
}

/**
 * pi 宿主全 session 的 run state 枚举 store（WorkflowRunEnumerationStore 适配）。
 *
 * 读错分通道：sessions 根 ENOENT = 从未落盘的正常空态；EACCES/EIO 真故障上抛
 *（FileRunStore.loadAll 内部同款分通道）。
 */
export function createPiHostRunEnumeration(
  getAgentDir: () => string,
): WorkflowRunEnumerationStore {
  return {
    async loadAll() {
      const agentRoot = getAgentDir();
      const stateDirs = [join(agentRoot, STATE_DIR_NAME)];
      const sessionsRoot = join(agentRoot, SESSIONS_DIR_NAME);
      let sessionEntries: Dirent[] = [];
      try {
        sessionEntries = await readdir(sessionsRoot, { withFileTypes: true });
      } catch (err) {
        if (errorCodeOf(err) !== "ENOENT") throw err; // EACCES/EIO 真故障上抛（规格 2）
        // sessions 根不存在 = 从未有过 session 落盘（或已清理），空态不是错误——
        // 仅保留 agentDir 根回退目录的扫描。
      }
      for (const ent of sessionEntries) {
        if (ent.isDirectory()) {
          stateDirs.push(join(sessionsRoot, ent.name, STATE_DIR_NAME));
        }
      }
      const runs: Array<{ runId: string; stateDir: string; status: string }> = [];
      for (const dir of stateDirs) {
        for (const run of await new FileRunStore({ stateDir: dir }).loadAll()) {
          runs.push({ runId: run.runId, stateDir: dir, status: run.state.status });
        }
      }
      return runs;
    },
  };
}
