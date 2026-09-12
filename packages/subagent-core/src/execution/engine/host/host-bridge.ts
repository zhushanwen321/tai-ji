// src/execution/engine/host/host-bridge.ts
//
// HostBridge 契约 + core 侧实现（W6，impl-plan §2.6 / 设计 §3.8 D2 表 + 最小示例）。
//
// 归属裁定（设计 §3.8 D2 表逐条）：executeAndAwait / getRecordForAction /
// collectRecords / closeSubagent / cancel / record 状态回写 / idle+activate lock
// 定时器——都是「宿主执行链 / 数据所有权在宿主」，归 HostBridge（core）；pi 包（W7）
// 经 host/* 反向请求消费本面。spawnedChildren 归引擎进程（core 镜像见同目录
// spawned-children.ts）；sendPromptCommand / EPIPE 兜底归 pi 包（W7 迁移物）。
// [H1 U6] ChatRoundTicket 交接面与冷续轮 resume（stdin-writer）已随 chat 域退役。
//
// 本文件只依赖 core 公共类型（types.ts / record-store / stream-sink /
// lifecycle-manager / orchestration 类型），不 import inproc pi 引擎目录 内部——它是 pi 包
// 反向请求消费面的契约落点（协议无关，类型闭包经 HostBridgeServiceFace 泛型参数化）。
// [F-3] cancel 收敛等待面已删（无生产装配点）；D3 core 侧收敛语义由引擎面
// chat-session.cancel 等价承接，偏差登记见 chat-domain impl-plan §5。

import { armIdleTimer, disarmIdleTimer } from "../../lifecycle-manager.ts";
// u7a D5 在途记账迁移点（crash-forensics §3.3 D5）：idle timer arm/disarm 是「保活 ↔
// 正在执行」翻转的全部迁移点（agent_settled arm / 新 turn disarm / 热路径 re-arm 均经
// 本委托），迁移后推最新绝对计数给壳层监听者（同步 fire-and-forget，不进投递 await 面；
// 环规避同 inflight-snapshot.ts 头注释——挂桥层而非 lifecycle-manager）。
import { notifyInFlightChanged } from "../inflight-snapshot.ts";
import type { AgentResult as WorkflowAgentResult } from "../../../orchestration/models/types.ts";
import type { StatusFilter } from "../../record-store.ts";
import type { SubagentStream } from "../../stream-sink.ts";
import type {
  AgentEvent,
  ExecuteOptions,
  ExecutionRecord,
  SubagentRecord,
} from "../../types.ts";

/**
 * HostBridge 的服务实现面（SubagentService 的结构子集，鸭子类型——与原 pi-engine 的
 * PiEngineService 同一形态的协议化泛化）。为什么用结构接口而非 import SubagentService
 * 类型：防 Service 内部演进连锁影响契约面 + 测试可注入 fake（PiEngineService 的既有
 * 先例，语义照搬）。
 * [H1 U6] chat 域轮次交接可选面（HostChatRoundTicket / takeChatRound / runChatRound /
 * resumeChatRound）已随 chat 域退役删除——续聊 = Continuation → 新 run + resume，
 * 引擎经协议 converse，不再回调宿主编排面。
 */
export interface HostBridgeServiceFace {
  executeAndAwait(
    opts: ExecuteOptions,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<WorkflowAgentResult>;
  getRecordForAction(id: string): ExecutionRecord;
  closeSubagent(record: ExecutionRecord, force: boolean): Promise<void>;
  cancel(id: string): boolean;
  collectRecords(limit: number, statusFilter?: StatusFilter): SubagentRecord[];
  /** record 状态迁移上报（热路径投递后让 runtime 派生缓存失效 / GUI 回流）。 */
  reportRecordTransition?(record: ExecutionRecord): void;
}

/**
 * HostBridge 接口（设计 §3.8 最小示例的协议化视图）。core 侧实现；pi 包经 host/*
 * 反向请求消费。签名与最小示例的实现级偏差（均按现状语义落地）：
 *   - getRecordForAction 返回 ExecutionRecord | null（现状实现面的活 record 形态；
 *     不存在 / 不可达 → null，引擎侧 resolveRecord 的 try/catch 语义内聚到本面）；
 *   - reportRecordTransition 收 record 对象（现状状态回写以 record 为单位整体上报，
 *     无 patch 增量形态——造 patch 形态属凭空造词，W7 反向通道载荷再议）。
 * [H1 U6] takeChatRound（chat 域轮次交接）已随 chat 域退役删除。
 */
export interface HostBridge {
  executeAndAwait(
    opts: ExecuteOptions,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void,
    stream?: SubagentStream,
  ): Promise<WorkflowAgentResult>;
  getRecordForAction(id: string): ExecutionRecord | null;
  collectRecords(limit: number, filter?: StatusFilter): SubagentRecord[];
  closeSubagent(record: ExecutionRecord, force: boolean): Promise<void>;
  cancel(id: string): Promise<void>;
  reportRecordTransition(record: ExecutionRecord): void;
  armIdleTimer(id: string, ms: number): void;
  disarmIdleTimer(id: string): void;
}

/** createHostBridge 依赖（服务面 + idle 超时处置）。 */
export interface HostBridgeDeps {
  /** HostBridge 服务实现面（生产 = SubagentService 的结构子集）。 */
  service: HostBridgeServiceFace;
  /**
   * idle timer 超时处置（回收层兜底）：宿主在 arm 时注入杀链回调（现状语义 =
   * killRecordChildWithEscalation 升级杀，pi-engine.rearmIdleTimerAfterHotPathFailure
   * 同款）。不注入则 arm 时 throw（无处置的 idle timer = 永不回收的泄漏源，宁可显式）。
   */
  onIdleTimeout: (recordId: string) => void;
  // [F-3 删除登记] 曾有的 waitForRoundTerminal / escalateKill 可选注入（W3 D3 cancel
  // 终态等待面）已删：createHostBridge 全仓无生产调用点，且该面与生产 cancel 链结构
  // 冲突（waitForRoundTerminal race 轮终相位恒等满 3s 超时）。[H1 U6] 注释内旧符号
  // （chat 轮路由注销 / chat-session.cancel）已随 chat 域退役消亡。
}

/** HostBridge core 实现（SubagentService 编排面的协议化视图）。 */
export function createHostBridge(deps: HostBridgeDeps): HostBridge {
  const { service } = deps;
  return {
    executeAndAwait: (opts, signal, onEvent, stream) =>
      service.executeAndAwait(opts, signal, onEvent, stream),
    getRecordForAction: (id) => {
      try {
        return service.getRecordForAction(id);
      } catch {
        return null;
      }
    },
    collectRecords: (limit, filter) => service.collectRecords(limit, filter),
    closeSubagent: (record, force) => service.closeSubagent(record, force),
    /**
     * cancel 语义 = 受理即返回（service.cancel 同步布尔 → 契约 void）。
     * [F-3 删除登记] 终态等待/杀链升级面已删（无生产装配点 + 与 cancelBackground 的
     * 路由注销冲突，见 HostBridgeDeps 尾注）；生产收敛语义由引擎面承接 =
     * chat-session.cancel（waiter 先于 kill 注册 → 等轮次终态相位 →
     * CANCEL_SETTLE_GRACE_MS 未收敛走 killChain 有界升级）。resolve 语义归引擎侧
     * 判 notResumable（契约注释，W6 起如此）。
     */
    cancel: async (id) => {
      service.cancel(id);
    },
    reportRecordTransition: (record) => service.reportRecordTransition?.(record),
    armIdleTimer: (id, ms) => {
      armIdleTimer(id, () => deps.onIdleTimeout(id), ms);
      notifyInFlightChanged();
    },
    disarmIdleTimer: (id) => {
      disarmIdleTimer(id);
      notifyInFlightChanged();
    },
  };
}
