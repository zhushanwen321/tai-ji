// src/execution/engine/common/journal-wiring.ts
//
// [D3-③ journal 接线合一] host 侧 event journal 接线的共享 helper（唯一实现，调用
// 点全部在 SubagentService：workflow 域 runWorkflowEngineTask（wireEventJournal
// taskId=record.id）+ chat 域 runEngineTask 与 tool 域 runAndFinalize 两处（同
// record.id））。设计权威源：docs/design/subagent-dual-track-convergence.md §3.3 D3-③（writer +
// retarget + handle 回填两份提为 common 层共享 helper）+ 双轨清单 #6。
//
// 收敛前形态（两份同构接线）：
//   - subagent-service.ts：new JournalWriter（占位池 key 'shared'）+ retarget 闭包 +
//     record.engineHandle.journalPath 回填；
//   - subprocess-agent-runner.ts：new JournalWriter（占位 PI_POOL_KEY）+ retarget 闭包 +
//     journalingOnEvent 包装（先落盘再转发 workflow liveRecord）+ handle.data.journalPath 回填。
//
// 机制语义（对齐点③：路径权威 = 引擎声明的池 key）：writer 初始用占位池 key 建路径，
// 非池化稳定引擎（zcode）在 prepare 期经 RunContext.onPoolResolved 声明实际池 key →
// retarget——保证 journal 落盘路径与 handle.poolKey 同源。run 终态后 close（flush +
// fsync 一次，§3.3.6 写入纪律；写失败已由 writer 内部 warn + failed 收口，close 不抛，
// journal 是②级尽力而为数据源）。

import { SHARED_POOL_KEY } from "@zhushanwen/subagent-engine-sdk";
import type { AgentEvent } from "../../../shared/agent-event.ts";
import { getEngineDataDir } from "./data-dir.ts";
import { JournalWriter } from "./event-journal.ts";
import { resolveJournalPath } from "../paths.ts";
import type { EngineHandle } from "../types.ts";

/**
 * journal 初始占位池 key（= pi 的恒定池 key 'shared'）。pi 无隔离池
 * （PI_CODING_AGENT_DIR 全局一份，设计 §3.3.9），占位即终值；zcode 在 prepare 期
 * retarget 到实际池 key。值与 RunContext.poolKey 的初始占位同源——值单源
 * SDK SHARED_POOL_KEY（L3 收编：原先 Service 用 'shared' 字面量、SAR 用 PI_POOL_KEY，
 * 等值异名；本名保留 journal 占位语义，值不再本地声明）。
 */
export const JOURNAL_INITIAL_POOL_KEY = SHARED_POOL_KEY;

/** wireEventJournal 的参数。 */
export interface JournalWiringOptions {
  /** 实际执行引擎 id（journal 路径分段 + line 元数据）。 */
  engineId: string;
  /** 宿主侧任务标识（journal 文件名与池引用计数 key；三处调用点统一 = record.id）。 */
  taskId: string;
  /**
   * journal 落盘后的事件转发（workflow 域的 liveRecord 通道）。缺省不转发（chat 域
   * 无下游 onEvent 消费者——journal 是事件唯一出口）。
   */
  forwardEvents?: (event: AgentEvent) => void;
}

/** wireEventJournal 的产物（喂给 RunContext 的回调簇 + 终态收口/回填面）。 */
export interface JournalWiring {
  /** journaling onEvent：先落盘再转发——RunContext.onEvent 的值。 */
  onEvent: (event: AgentEvent) => void;
  /** RunContext.onPoolResolved 的值（引擎声明实际池 key 后重定向落盘路径）。 */
  onPoolResolved: (poolKey: string) => void;
  /**
   * 终态落盘路径（writer 是路径权威——retarget 后的实际路径）。read 第②级的自描述
   * 定位符数据源：record.engineHandle.journalPath（chat 域）与 handle.data.journalPath
   * （workflow 域 backfillHandle）都取本值。
   */
  readonly path: string;
  /** run 终态收口（flush + fsync；幂等，不抛——见文件头）。 */
  close(): Promise<void>;
  /**
   * handle 回填：EngineHandleData.journalPath = writer 终态路径（read ②级经
   * handle.journalPath 自描述定位——运行期落盘路径权威在 writer）。
   */
  backfillHandle(handle: EngineHandle): void;
}

/**
 * 接线 host 侧 event journal（两域共用）：创建 writer（占位池 key）+ retarget 回调 +
 * journaling onEvent 包装 + 终态路径访问。close 在 run 终态（成功/失败路径均达）调用。
 */
export function wireEventJournal(opts: JournalWiringOptions): JournalWiring {
  const journal = new JournalWriter({
    path: resolveJournalPath(getEngineDataDir(), opts.engineId, JOURNAL_INITIAL_POOL_KEY, opts.taskId),
    taskId: opts.taskId,
    engineId: opts.engineId,
  });
  return {
    // 先落盘再转发（原 onEvent 未传时也恒传包装版——下游 onEvent 通道是事件生成后的
    // 纯转发，无行为分支，仅多一次入队）。
    //
    // activity 豁免 append：纯活性信号不进持久/重放面——双侧 reducer（SDK
    // journal-replay / core execution-record）对其 no-op，豁免不破坏 live≡reload
    // 重放等价性；seq 由 append 铸造、过滤在 append 前故无 seq 空洞；
    // forwardEvents 照发（workflow liveRecord reducer no-op，chat/守护刷新面在
    // observedEvent 上游不受影响）；取证面由 pi stdout/stderr tee 覆盖。
    onEvent: (event) => {
      if (event.type !== "activity") journal.append(event);
      opts.forwardEvents?.(event);
    },
    onPoolResolved: (poolKey) => {
      journal.retarget(resolveJournalPath(getEngineDataDir(), opts.engineId, poolKey, opts.taskId));
    },
    // getter 而非快照：retarget 后取实际落盘路径（writer 是路径权威）
    get path() {
      return journal.path;
    },
    close: () => journal.close(),
    backfillHandle: (handle) => {
      handle.data.journalPath = journal.path;
    },
  };
}
