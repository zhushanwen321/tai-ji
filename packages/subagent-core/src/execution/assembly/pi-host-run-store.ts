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
// ADR-0081），枚举全部 session 目录——same/cross-session 两
// 形态一次覆盖（单目录扫描对 cross-session 形态结构性不可达）+ agentDir 根
// workflow-state（resolvePiSessionScopedDir 回退分支兼容）。每轮 loadAll 现解析
//（目录集运行时可变，对齐 sessionFace 晚绑定纪律）。
//
// 候选与判据同源（workflow-run-store-convergence U2 枚举改接）：候选 runId 集合
// = state 目录下的 record 事件流文件族（<runId><RUN_EVENT_JOURNAL_SUFFIX>，
// runId 从文件名提取）——**journal 在即候选在**，不依赖 state 快照文件存在性
//（候选完备性正方向；反方向「快照在而 journal 不在」的残留 run 不再进枚举，
// 该形态本就无从收编——判定核与收编入口都以 journal 为证据源，设计 §3.1
// 步骤 2）。status 不再读快照行（快照对 v2 run 永停 running，非事实源），改调
// 共享判定核 findRunSettlementEvidence（journal run-settled 尾向帧 ∨ manifest
// 终局面 + 保守矩阵，与对账 sweep 判据字节级同源）：running → "running"；
// terminal → 对应终态词（reason）；missing → 候选跳过不入结果——候选来自
// journal 文件族，「journal 不存在」的 missing 仅竞态窗口（枚举中文件被删）
// 可达，无事实可保留、跳过是唯一诚实动作。
//
// 读错分通道（ADR-0081，两层）：候选目录扫描层——sessions 根 / 各 state 目录的
// readdir ENOENT = 从未落盘的正常空态；EACCES / EIO 等真 IO 故障上抛给扫描层
// ——静默折叠成空集会让持续 IO 故障伪装成「0 个 run 的成功扫描」（与 §2.3
// 批评的「静默跳过伪装成无 run 可回收」同病）。单 run 判定层——走判定核保守
// 矩阵（journal/manifest 读失败按 running 保守挂账 + warn 留证），枚举层不额外
// 吞错、不额外上抛。
//
// v1 旧形态触达（[D16⑥]，D15「触达 v1 形态实体直接跳过 + warn 留痕」）：旧
// journal 后缀（.events.jsonl）= 旧写入方 run 的确定标记——[D1] 历史数据处置
// 不读不写不主动删，枚举构造性跳过（不在 record 流候选族）+ 每目录一条聚合
// warn 留痕（core logger，与判定核读错 warn 同通道）。旧件随裁决点 7 对账清理
// （reapOrphanRuns 的候选并集含旧 journal 后缀）自然消亡，不新增删除动作。
//
// 分层边界：本模块只消费 agentDir 注入，不 import pi SDK（core 约束）。
// zcode 宿主不适用本枚举（core 无 run state 写方——写侧身份退役后 run 状态
// 由各宿主自有设施落盘）——该宿主不经此枚举消费（装配点不注入即不产生本枚举
// 实例）。

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { getLogger } from "../../core/logger.ts";
import { findRunSettlementEvidence, STATE_DIR_NAME } from "../persistence/run-state-evidence.ts";
import { RUN_EVENT_JOURNAL_SUFFIX } from "../../shared/run-vocabulary.ts";
import { errorCodeOf } from "../../shared/fs-error.ts";

const logger = getLogger("pi-host-run-store");

/** pi sessions 目录分量（pi 壳建目录方字面量，与 workflow-state-root.ts 的
 *  join(agentDir, "sessions", …) 同源约束：pi 布局演进须两侧同步）。 */
const SESSIONS_DIR_NAME = "sessions";

/** 旧 journal 后缀（[D1] 前旧写入方的事件流后缀）——v1 旧形态 run 的确定标记：
 *  在场即该 run 不属 record 流候选族（构造性跳过 + warn 留痕，见文件头注）。 */
const LEGACY_JOURNAL_SUFFIX = ".events.jsonl";

/**
 * WorkflowRun 枚举 store 窄口（run 枚举读侧对 run 持久化域的最小依赖面，结构
 * 类型——调用方传符合形态的枚举实现即可，不 import orchestration 具体类，
 * 保持本模块可独立编译 + 单测）。
 *
 * 返回形态（ADR-0081 终态重构）：`{ runId, stateDir, status }`
 * ——stateDir = 该 run 的 workflow-state 目录，启动扫描收编按它传 journalDir
 * 参数；status = 共享判定核的终局判读（"running" ∨ 终态词）——事实源推导，
 * 不再携带快照行投影。不含 startedAt（旧 TTL 超龄判定字段，全量收编不判超龄，
 * 消费方为零的字段不进接口）。
 *
 * [W2/V1] transition/save 成员删除：终局化经收编原语（journal/manifest 写面，
 * 不经两态机快照）——快照写面不再是枚举读侧的职责（判据读者已随 D6 改接换源；
 * 候选来源已随 U2 改接换 journal 文件族）。
 */
export interface WorkflowRunEnumerationStore { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  loadAll(): Promise<Array<{ runId: string; stateDir: string; status: string }>>;
}

/**
 * pi 宿主全 session 的 run state 枚举 store（WorkflowRunEnumerationStore 适配）。
 *
 * 读错分通道：候选目录层 readdir ENOENT = 从未落盘的正常空态；EACCES/EIO 真故障
 * 上抛（启动扫描 error 留痕承接）。单 run 判定层走判定核保守矩阵，枚举层不二次
 * 处置。
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
        let names: string[];
        try {
          names = await readdir(dir);
        } catch (err) {
          if (errorCodeOf(err) !== "ENOENT") throw err; // EACCES/EIO 真故障上抛（读错分通道，与候选目录扫描层同款纪律）
          // state 目录不存在 = 该 session 从未落过 run state，正常空态。
          continue;
        }
        // v1 旧形态触达留痕（[D16⑥]）：旧 journal 后缀在场 = 历史遗留 run，不进
        // 候选（构造性跳过）、不读不写（[D1]），每目录聚合一条 warn——静默空集
        // 与「这些 run 为什么永不被收编」之间需要一条排障线索。
        const legacyNames = names.filter((n) => n.endsWith(LEGACY_JOURNAL_SUFFIX));
        if (legacyNames.length > 0) {
          logger.warn(
            `[pi-host-run-store] legacy v1 journal(s) present, skipped (not adoptable; left to orphan reap): ${dir}: ${legacyNames.join(", ")}`,
          );
        }
        for (const name of names) {
          if (!name.endsWith(RUN_EVENT_JOURNAL_SUFFIX)) continue;
          const runId = name.slice(0, -RUN_EVENT_JOURNAL_SUFFIX.length);
          // status 调共享判定核（与对账 sweep 判据同源；读失败按 running 的保守
          // 矩阵内聚在判定核内）：missing 仅竞态窗口可达（候选来自 journal 文件
          // 族），跳过不入结果。
          const evidence = findRunSettlementEvidence(dir, runId);
          if (evidence.kind === "missing") continue;
          runs.push({
            runId,
            stateDir: dir,
            status: evidence.kind === "terminal" ? evidence.reason : "running",
          });
        }
      }
      return runs;
    },
  };
}
