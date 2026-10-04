// src/orchestration/startup-sweep.ts
//
// runtime 启动收编扫描——core 装配单点（30 天定时器回收机制退役后的替代实装；
// 决策与已接受代价登记见 docs/adr/decisions.md 启动扫描条目，规格出处 = 退役
// 设计 §3.1 规格 1/3/5/6、§3.3 决策 1/3/6）。
//
// 为什么存在：崩溃恢复的第三层兜底原是 pi 进程内的 30 天 TTL 定时器（对超龄
// running run 收编），但它跑在 pi 进程内，而 runtime 派生的 pi 在空闲态停止调度
// 一切周期任务——生产常态（宿主挂机）下停摆，是死机制。替代 = runtime 启动序列
// 的一次性全量收编扫描：单实例锁确立后、先于任何 pi spawn 的时点，全量枚举 pi
// 宿主形态 run（createPiHostRunEnumeration——[D16⑥] 枚举判据换源：候选 = record
// 事件流文件族，status = 共享判定核 fold record 读折叠投影，不读快照行），对
// 判读 running 且事件流静止超宽限窗的 run 逐个收编（adoptInterruptedRun →
// [D15] interruptRun 中断编排入口，run-interrupted 转移帧一件直落）。
//
// 判僵尸依据 = 双防线（决策 1）：①时序事实——扫描时点先于任何新 pi spawn（runtime
// 启动段不 spawn，挂点注释为时序硬声明）；②事件流静止宽限窗
// STARTUP_SWEEP_GRACE_WINDOW_MS——末帧距扫描时点不足窗的 run 跳过本轮（旧 pi 残活
// 的末帧新鲜形态防御），下次启动再收。「残活且末帧已超窗」形态（长 ask 静默期崩溃）
// 不设防，按四要素登记为已接受代价（决策 1）。
//
// 收编形态一件直落（[D15] 中断目标态）：只追加 run-interrupted 转移帧——不写
// manifest 派生缓存（manifest-write 仅 terminal 输出，interrupted 是 [D2] 暂停态
// 非终局、可 resume）、不写终态条目 / 注销条目（runtime 进程无 session 文件，条目
// 写达域不存在；宿主 session 重开由 reconcile-sweep 依 record 折叠 / manifest
// 终态证据自愈补写）。
//
// 失败语义（规格 5 / 决策 6）：单 run 收编失败 = warn 留痕 + 继续其余；枚举整体
// 失败（EACCES/EIO 等真 IO 故障——枚举读错分通道改造后该路径可达）= error 留痕。
// 两条路径都不抛出：扫描是旁路维护，绝不放大为启动失败（本函数结构性不 reject）。
//
// 日志通道（规格 6 签名定形）：注入 SweepLogChannel 三方法结构对象——core 不
// import runtime 类型，结构匹配即受；runtime 挂点直传自己的 logger（四方法对象
// 结构覆盖本三方法子集，零适配）。不复用 core logger：runtime 进程全程不
// configureCore，core logger 是 NULL_HOST 缺省实现（debug 级 no-op 且发生在
// console patch 之前），扫描结果行将无处落盘（决策 6 否决记录）。
//
// 分层边界：只消费 agentDir 注入与收编原语，零进程态依赖（不读 env/cwd——目录
// 活源由调用方注入，与 pi-host-run-store 同款纪律）。
//
// [D1 拆边 Class C] 2026-09-30 自 `execution/assembly/` 上移本目录：本模块的实质是
// 「启动收编」这一编排动作（枚举 execution 侧 record 流 → 经 [D15] 中断入口收编），
// 而唯一消费点就是它自己——上移后 execution 不再反向值导入 run-registry，依赖方向
// 回到 orchestration → execution（只消费枚举 store，同向）。

import { toErrorMessage } from "../core/error-message.ts";
import {
  adoptInterruptedRun,
  type AdoptInterruptedRunOutcome,
} from "./run-registry.ts";
import { createPiHostRunEnumeration } from "../execution/assembly/pi-host-run-store.ts";

/**
 * 扫描日志通道（结构子集，规格 6 签名定形）：runtime logger 的 `{debug, info,
 * warn, error}` 四方法对象结构覆盖本三方法子集，挂点直传零适配。级别信息在
 * 签名里有结构承载位——结果行 info 级、失败路径 warn/error 分级落位；不采用
 * 单回调形态（级别无承载位，失败分级会被压平）。
 */
export interface SweepLogChannel { // oe-exempt:20260928:framework:跨包契约类型——core 定义、runtime 启动链挂点直传（runtime logger 四方法结构覆盖），非可内联形态
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * 事件流静止宽限窗（规格 3 定形，勿改量级）：末帧 ts 距扫描时点不足窗的 running
 * run 判「可能仍在推进」跳过本轮（adoptInterruptedRun 返回 skippedGraceWindow，
 * 零写）。分钟级取值给旧 pi 的 stdin-EOF 退出留余量（runtime 崩溃自动重启——
 * 首次退避 1s / planned 0ms——可落在旧 pi 收尾窗口内，末帧极新 = 可能仍在推进）；
 * 校准依据见退役设计 §3.1 规格 3 与 ADR 启动扫描条目。
 */
export const STARTUP_SWEEP_GRACE_WINDOW_MS = 60_000;

/** startupSweep 的结果（计数 + 错误摘要，供调用方日志与单测断言）。 */
export interface StartupSweepResult { // oe-exempt:20260928:framework:startupSweep 返回契约——runtime 挂点与单测断言消费的跨包结构类型
  /** 收编成功数（run-interrupted 转移帧一件直落完成）。 */
  adopted: number;
  /**
   * 未收编的 running run 数 = 收编判定未通过（幂等跳过 / 宽限窗 / 坏链 / 空
   * record 流）+ 单 run 收编失败（warn 留痕）的总和。恒等式 adopted + skipped =
   * 本次枚举出的 running run 数（非 running 的终态 run 不进收编判定，两侧都不计）。
   */
  skipped: number;
  /** skipped 中宽限窗跳过数（skippedGraceWindow——事件流静止不足窗，下轮再收）。 */
  skippedGraceWindow: number;
  /**
   * 本次枚举发现的 run 所在的 state 目录数（结果行「across K state dir(s)」的
   * K）。口径 = 结果集 stateDir 去重（枚举接口不暴露候选目录集；无 run 的空
   * 目录对 adopted/skipped 均无贡献，不进本计数）。枚举整体失败时为 0。
   */
  stateDirs: number;
  /** 错误摘要（单 run 收编失败逐条 + 枚举整体失败一条；空数组 = 全程无失败）。 */
  errors: string[];
}

/** 结果行前缀（core 观测行惯例同款 `[subagents]` 通道前缀）。 */
const LOG_PREFIX = "[subagents] startup sweep:";

/**
 * runtime 启动收编扫描（一次性、旁路维护）：全量枚举 → running run 逐个收编 →
 * 结果日志一行。结构性不 reject——任何失败都折进返回对象的 errors 摘要并按
 * 级别留痕，调用方（runtime 启动序列）await 后照常继续。
 *
 * 结果行（info 级，规格 6）：
 * `[subagents] startup sweep: adopted N run(s), skipped M (grace W), across K state dir(s)`
 */
export async function startupSweep(
  getAgentDir: () => string,
  log: SweepLogChannel,
): Promise<StartupSweepResult> {
  const result: StartupSweepResult = {
    adopted: 0,
    skipped: 0,
    skippedGraceWindow: 0,
    stateDirs: 0,
    errors: [],
  };
  let runs: Array<{ runId: string; stateDir: string; status: string }>;
  try {
    runs = await createPiHostRunEnumeration(getAgentDir).loadAll();
  } catch (err) {
    // 枚举整体失败（EACCES/EIO 等真 IO 故障经读错分通道上抛到达）：error 留痕
    // + 不阻断启动——僵尸修正不是启动的前置条件，fail-fast 会把磁盘 IO 抖动
    // 放大为应用不可用（规格 5 / 决策 6）。收编幂等，下次启动重试安全。
    const message = toErrorMessage(err);
    log.error(`${LOG_PREFIX} failed (runtime continues): ${message}`);
    result.errors.push(message);
    return result;
  }
  result.stateDirs = new Set(runs.map((run) => run.stateDir)).size;
  for (const run of runs) {
    // 只收编判定核 fold record 判读 running 的 run——终态（判定核终态词，done
    // 派生族）不是僵尸，不进收编判定（adopted/skipped 两侧都不计数）。
    if (run.status !== "running") continue;
    try {
      // [D15 接线终态]：收编经 adoptInterruptedRun → interruptRun 中断编排入口，
      // 落 run-interrupted 转移事件（[D2] 后 run-settled(outcome=interrupted)
      // 形态非法——interrupted 是 lifecycle 暂停态）；中断来源由 errorCode 承载
      //（startup-sweep 为 RunErrorCode 现行成员复用，设计 §3.1 事件表明示）。
      const outcome: AdoptInterruptedRunOutcome = await adoptInterruptedRun(run.runId, {
        errorCode: "startup-sweep",
        reason: "runtime startup sweep: process-local run without live executor",
        // journalDir = 枚举出的 stateDir（per-call 目录参数——runtime 进程的
        // cwd/env 与落盘目录不相交，缺省模块锚在本形态结构性错位）。
        journalDir: run.stateDir,
        graceWindowMs: STARTUP_SWEEP_GRACE_WINDOW_MS,
      });
      if (outcome === "adopted") {
        result.adopted += 1;
      } else {
        result.skipped += 1;
        if (outcome === "skippedGraceWindow") result.skippedGraceWindow += 1;
      }
    } catch (err) {
      // 单 run 收编失败 = warn + 继续其余（bestEffort 同款容错，规格 5 / 决策 6）。
      const message = `run ${run.runId}: ${toErrorMessage(err)}`;
      log.warn(`${LOG_PREFIX} adopt failed, continuing: ${message}`);
      result.errors.push(message);
      result.skipped += 1;
    }
  }
  log.info(
    `${LOG_PREFIX} adopted ${result.adopted} run(s), ` +
      `skipped ${result.skipped} (grace ${result.skippedGraceWindow}), ` +
      `across ${result.stateDirs} state dir(s)`,
  );
  return result;
}
