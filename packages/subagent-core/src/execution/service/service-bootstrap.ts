// [H3/R6] SubagentService 壳的支撑文件：聚合面接口类型声明（SubagentQueries /
// SubagentChatActions / SubagentServiceInit）+ 进程单例访问器族（SERVICE_SLOT_KEY /
// getServiceSlot / getSubagentService / setSubagentService / createSubagentService）。
// R6 前同居壳文件（impl-plan §2 R6 行），外移达成 G1 壳终态（类体 ≤500 折算 +
// 单类成员 ≤40）。符号体自壳逐字节搬运，仅 import 通道新设。
//
// 方向纪律（scripts/check-subagent-service-boundary.mjs R6 扩向守卫）：
//   - 壳→本文件：仅 type-only（接口类型标注——编译后擦除，不成值环）
//   - 本文件→壳：仅 SubagentService 类值 import（createSubagentService 构造依赖，
//     设计 v4 明文「bootstrap 必须 new SubagentService」；壳对本文件零 re-export，
//     防壳↔bootstrap 值环——壳侧 re-export 即成环）
//   - 聚合→本文件：仅 type-only（聚合不消费装配工厂）
//   - 本文件→聚合：无（现状零依赖）

import type { UiRequestHandler } from "../dialog-queue.ts";
import type { ModelConfigService } from "../model-config-service.ts";
import type { StatusFilter } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { ExecutionRecord, RecordSnapshot, SubagentRecord } from "../types.ts";

/** [D4 查询面聚合] 读模型轴（record 快照读取 + store 订阅）——Service 上的
 *  `service.queries` 消费面。变化轴：改查询投影 / 过滤 / 订阅语义，只动 queries 组；
 *  Service 本体保留编排核（execute/executeAndAwait/cancel）与生命周期面。 */
export interface SubagentQueries {
  /** 按 id 查内存 running record 的只读快照（G3-002 修复）。不存在返回 undefined。 */
  findRecord(id: string): RecordSnapshot | undefined;
  /** [v8.5 A1/B] 全态查找：任意状态 × 任意归属的 record 快照（message 拒绝文案分流
   *  与 fork-from 源解析共用）。id 在内存与磁盘均不存在返回 undefined。 */
  lookupRecordAnyState(id: string): SubagentRecord | undefined;
  /** 合并内存 + 磁盘 record（/subagents list + tool list 消费，按 rootSessionId 过滤）。
   *  [H2 W1] includeWorkflow 缺省 false = 过滤 origin==="workflow"（D1 投影过滤①③④）；
   *  true = 排查通道全量。 */
  collectRecords(limit: number, statusFilter?: StatusFilter, includeWorkflow?: boolean): SubagentRecord[];
  /** [H2 W1] 按 workflow run id 列 record（内存 ∪ 磁盘重建 ∪ manifest 口径，不过滤
   *  origin——W2 run 视图进度 / W3 下钻消费）。 */
  collectRecordsByParentRunId(parentRunId: string, limit: number): SubagentRecord[];
  /** [perf] 单 record 详情懒加载（全量：eventLog/displayItems/result/turns/tokens）。 */
  getFullRecord(id: string): SubagentRecord | undefined;
  /** 订阅 store 变更（widget/list requestRender）。返回取消订阅。 */
  onChange(listener: () => void): () => void;
}

/** [D4 对话 action 面聚合] chat 域 message/close action 轴（M2-B3，原 Service 同节三方法）
 *  ——Service 上的 `service.chatActions` 消费面。变化轴：改对话域归属校验 / close 分流 /
   投递编排，只动 chatActions 组。 */
export interface SubagentChatActions {
  /** 按 id 查 record 并做归属校验（message/close action 的统一入口）。 */
  getRecordForAction(id: string, opts?: { allowReconnect?: boolean }): ExecutionRecord;
  /** close action 的统一行为分流（running 子态 × force）。 */
  closeSubagent(record: ExecutionRecord, force: boolean): Promise<void>;
  /** chatMode 统一投递入口（message action → ConversationContinuation.onMessage，
   *  [H1 U6] interrupt 参数随 D2 打断统一语义退役）。 */
  deliverChatMessage(record: ExecutionRecord, text: string): Promise<void>;
}

/**
 * Service 构造参数（进程级）。
 *
 * @experimental execution 运行时面（设计 docs/design/subagent-core-sink-design.md §3.3 D6）：
 * 一个 minor 周期内允许签名微调，稳定后转常规 semver 承诺。
 */
export interface SubagentServiceInit {
  cwd: string;
  /** 配置/模型域 Service（execute 内部调其 resolveModel）。 */
  modelService: ModelConfigService;
  /** 缓存的主 session file 获取函数（fork source 解析用）。 */
  getMainSessionFile?: () => string | undefined;
  /** W2: UI 请求处理回调（ask_user 扩展）。
   *  签名见 dialog-queue.ts UiRequestHandler：接收 UiRequest，返回 UiResponse。 */
  uiRequestHandler?: UiRequestHandler;
}

// ── 进程单例访问器 ────────────────────────────────────
// globalThis[Symbol.for] 防 jiti 路径不同致单例分裂。详见 docs/standards.md §7.5。
const SERVICE_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.service");

type ServiceSlot = { current: SubagentService | null };

function getServiceSlot(): ServiceSlot {
  let slot = Reflect.get(globalThis, SERVICE_SLOT_KEY) as ServiceSlot | undefined;
  if (!slot) {
    slot = { current: null };
    Reflect.set(globalThis, SERVICE_SLOT_KEY, slot);
  }
  return slot;
}

/** 获取进程单例。session_start 前为 null。 */
export function getSubagentService(): SubagentService | null {
  return getServiceSlot().current;
}

/** 设置进程单例（session_start 首次创建时）。 */
export function setSubagentService(service: SubagentService): void {
  getServiceSlot().current = service;
}

/**
 * [U10① D6] 第三宿主最小构造入口：仅凭参数注入构造 SubagentService（无全局查找）。
 *
 * 构造依赖（modelService / getMainSessionFile / uiRequestHandler）全部经 init
 * 参数注入；本工厂是 `new SubagentService(init)` 的薄包装，不读也不写
 * getSubagentService/setSubagentService 的全局槽位——session_start 单例流程
 * 行为零改动，宿主自持实例时用本工厂。构造内部行为与直接 new 逐字等价。
 *
 * @experimental execution 运行时面（设计 docs/design/subagent-core-sink-design.md §3.3 D6）：
 * 一个 minor 周期内允许签名微调，稳定后转常规 semver 承诺。
 */
export function createSubagentService(init: SubagentServiceInit): SubagentService {
  return new SubagentService(init);
}
