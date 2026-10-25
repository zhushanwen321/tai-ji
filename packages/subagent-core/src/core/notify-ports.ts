// src/core/notify-ports.ts
//
// 通知域窄端口（D2 计划期细化②）。pi 侧通知的两机制——@zhushanwen/pi-pending-notifications
// 活跃计数 / @zhushanwen/pi-delivery-port 投递端口槽——经本端口结构化注入；HostServices.notify
// 事件推送按演进纪律②（禁止无真实触点的推测性预留）推迟到 P2 zsw 壳首个真实触点
// （task-notification）再落。
//
// 闭包红线：本文件是 core 对上述包的唯一替代面——下方 Delivery*/DeliveryPortHandle
// 结构化类型为手工转写（与 packages/session-delivery/src/types.ts、extensions/shared/
// delivery-port/src/types.ts 逐字段结构兼容），禁止 import 两包（D9 闭包检查扫描对象；
// core 是跨宿主包，extensions/shared 属 extensions 层，依赖方向 core ← extensions）。
// 上游增删字段须手工同步本转写类型，漏同步由
// extensions/universal/subagent-workflow/src/__tests__/notifier-receipt-anchor.test.ts
// 行为锁拦截——typecheck 对删字段形态不亮红（bivariance + optional 吸收漂移）。
//
// 缺席语义（设计 §3.4 core_port_missing 精神：可选端口缺席是合法形态，不报错）：
//   - 计数器缺席 → 恒 0（零活跃）：pending 门全开，缺省内聚在本端口层。
//   - 投递端口槽访问器缺席 → 消费方降级直发（notifier 既有最深层直发兜底 + warn +
//     诊断计数；降级代价显式登记：无判重无耐久，仅覆盖装配异常窗口——unified-
//     delivery 设计 §3.7）。port 恒装配（base-tool-enhance session_start，P6
//     infrastructure 档必载），缺席 = 装配异常 / 版本混装窗口的异常形态。

import { GLOBAL_SLOT_KEYS } from "../shared/global-slots.ts";

/** 投递意图（与 session-delivery 的 DeliveryIntent 字面量一致）。 */
export type DeliveryIntent = "interrupt-at-turn-boundary" | "after-run";

/** 文本 payload。 */
export interface DeliveryTextPayload {
  kind: "text";
  content: string;
}

/** custom message payload（extension 通路）。 */
export interface DeliveryCustomPayload {
  kind: "custom";
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}

/** 判别联合 payload（envelope / payload 分离）。 */
export type DeliveryPayload = DeliveryTextPayload | DeliveryCustomPayload;

/** 投递消息 envelope。 */
export interface DeliveryMessage {
  payload: DeliveryPayload;
  /** 缺省回落工厂 options.intent。 */
  intent?: DeliveryIntent;
  /** 去重 key（工厂开 dedupe 时必填）。 */
  dedupeKey?: string;
}

/** port.send 的受理回执（U2 扩展位；void = 受理未知，按成功处理）。 */
export interface DeliverySendReceipt {
  accepted: boolean;
  reason?: string;
}

/** 投递端口：内核与外部世界的唯一接口（notifier 装配，intent→宿主参数翻译在适配器内）。 */
export interface DeliveryPort {
  /** 本通路支持的 payload kind（不支持的 kind 由工厂 fail-fast）。 */
  supportedPayloads: readonly DeliveryPayload["kind"][];
  /** 主 agent 是否空闲（gate 投递时机）。 */
  isIdle(): boolean;
  /** 投递消息。返回受理回执或 void（扩展位——旧实现返回 void 兼容）。
   *  settle 契约（与 session-delivery DeliveryPort.send 一致）：返回 promise 时实现
   *  必须 settle——内核按控制范围粒度设有界兜底，超时按发送失败收尾（迟到原请求与
   *  重试可能构成重复投递，通道内判重由适配器/对端按裸标记负责）。 */
  send(
    msg: DeliveryMessage,
    intent: DeliveryIntent,
  ): void | DeliverySendReceipt | Promise<void | DeliverySendReceipt>;
  /** agent_settled 边沿订阅。缺省时工厂退化退避轮询；返回退订函数。 */
  subscribeSettled?(cb: () => void): () => void;
}

/**
 * 提交选项转写（与 delivery-port 的 DeliveryDeliverOptions / 内核提交选项消费方字段
 * 结构兼容——手工转写契约，上游增删字段须同步本类型，漏同步由
 * extensions/universal/subagent-workflow/src/__tests__/notifier-receipt-anchor.test.ts
 * 行为锁拦截——typecheck 对删字段形态不亮红）。
 */
export interface DeliverySubmitOptions {
  /**
   * 期望注入时机（unified-delivery §3.3 timing 词条的转写位；与 pi-delivery-port
   * 的 DeliveryTiming 结构兼容）。直发兜底路径不消费（pi.sendMessage({triggerTurn})
   * 单通道 = steer 形态）；字段为影子契约对上游提交侧的同步修正位（波 2）。
   * "steer"/"followUp" 是 pi 注入通道词汇，合法持有点 = 通知域窄端口契约范围
   * （与 execution/notify/notify-host.ts PiLike.deliverAs 注解同位——core 内
   * pi 通道词汇的接口形状注解形态）。
   */
  timing?: "steer" | "followUp";
  /**
   * 送达回执锚申报（D1 申报制转写）：'marker' = 等裸标记回执（缺省）；'acceptance' =
   * 无回执锚点条目（notifier 通知出站文本无标记），受理即落 delivered 终态。
   * 无标记提交点漏申报 = 死锁形态复发（in-flight 永挂、gate 恒关）。
   */
  receiptAnchor?: "marker" | "acceptance";
}

/** 投递句柄（notifier 消费方：send / flush / dispose——诊断 depth 等不入端口）。 */
export interface DeliveryHandle {
  /** 唯一常规入口（边沿即投——攒批窗已删 §3.3.7③）。 */
  send(msg: DeliveryMessage, opts?: DeliverySubmitOptions): void;
  /** 强制投递尝试（shutdown flush 等）。 */
  flush(): void;
  /** 销毁（清队列 + 清 timer + 退订）。 */
  dispose(): void;
}

/** countActiveFromEntries 的过滤选项（[F1] 与 pending-notifications 的
 *  CountActiveOptions 对齐的子集——core 契约范围只暴露跨 session 基准一个字段）。 */
export interface CountActivePortOptions {
  /**
   * [W4 读侧过滤②] 跨 session 残留过滤基准：传入时端口实现按「register entry 的
   * sessionId ≠ 基准 → 跳过」过滤——fork 继承的父级注册残留（翻 process 档后 U4
   * 补注销不再中性化，永久留存于子 session 文件）不进差集。
   * 缺省（undefined）= 不过滤（向后兼容：既有调用方零改动行为不变）。
   */
  currentSessionId?: string;
}

// ─── 投递端口槽消费方（pi 半区 DeliveryPort 的 core 转写）─────────────────

/**
 * deliver 受理结果转写（与 pi-delivery-port 的 DeliveryDeliverResult 结构兼容）：
 * accepted = 已受理（缓冲或已入内核）；swallowed = 幂等吞；rejected = 拒收未受理
 * （persist-failed = 受理前落盘失败等，幂等键未登记、重提合法）。
 */
export type PortDeliverResult =
  | { kind: "accepted"; id: string }
  | { kind: "swallowed"; reason: string }
  | { kind: "rejected"; reason: string };

/** deliver envelope 转写（与 pi-delivery-port 的 DeliveryEnvelope 消费方结构兼容）。 */
export interface PortDeliverEnvelope {
  /** custom 载荷（原样透传；deliveryId 由端口在注入前统一写入 details）。 */
  payload: DeliveryCustomPayload;
  /** 幂等键（提交方提供即参与判重：notifyId / taskId 等）。缺省内部生成。 */
  id?: string;
}

/** deliver 提交选项转写（与 pi-delivery-port 的 DeliveryDeliverOptions 结构兼容）。 */
export interface PortDeliverOptions {
  /**
   * [subagent-observability §3.3.7③] 原 merge（合批窗口判定覆盖）已随攒批窗整机制
   * 退役删除——core 窄端口转写面无合批字段，提交方无合批控制面。
   */
  /**
   * 收取关联键（result-collect 设计 §3.1① 转写位）：世代首个通知申报债权键集
   * （notify() 申报判据见 notifier.ts）；后续轮次 undefined。字段实参一直在传
   * （notify deliverViaPort），转写声明此批补齐（先前靠结构兼容鸭子通过）。
   */
  collectKey?: string[];
}

/**
 * 投递端口句柄转写（notifier 消费方：deliver / flush——recover / metrics / dispose
 * 等方面 notifier 零触达，不入转写；与 pi-delivery-port 的 DeliveryPortHandle 结构兼容）。
 */
export interface DeliveryPortHandle {
  /**
   * 唯一提交入口（unified-delivery §3.4 端点形态）：受理前落投递日志 → 缓冲或内核
   * send → 受理结果同步返回。fire-and-forget 语义：调用方忽略返回值不受影响；
   * rejected 条目由调用方裁决（幂等键未登记，重提合法）。
   */
  deliver(envelope: PortDeliverEnvelope, opts?: PortDeliverOptions): PortDeliverResult;
  /** 强制投递尝试（缓冲条目出站 + 内核 flush——shutdown flush 消费）。 */
  flush(): void;
}

export interface NotifyDomainPorts {
  /** pending 活跃计数（pi 会话 entries 中 register − unregister 差集的数值）。
   *  契约为 number 而非 pi 侧 CountActiveResult：core 消费方只读 count，契约范围最窄；
   *  pi 壳注入时拆 `countActiveFromEntries(entries).count`。
   *  [F1] 第二参为可选过滤基准（CountActivePortOptions）——core 消费方（后代判定
   *  读侧）持有「被读 entries 所属 session」概念时必须传入，使跨 session 残留不进
   *  差集；与 pending-notifications 实装签名（entries, opts?) 对齐。 */
  countActiveFromEntries?(entries: unknown[], opts?: CountActivePortOptions): number;
  /**
   * pi 半区投递端口槽访问器（C-ext-06 进程级槽；core 闭包红线禁 import 该包，
   * 由宿主壳注入访问器——pi 壳直传 pi-delivery-port 的 getDeliveryPort 本体）。
   * 每次消费即到即读（禁缓存实例引用——session_start 重绑语义，账本装配纪律⑤
   * 同律）；缺席（undefined / 未注入）= 消费方降级直发兜底。
   */
  getDeliveryPort?(): DeliveryPortHandle | undefined;
}

// 配置态持有：globalThis[Symbol.for] slot（与 host-services 同款覆盖式语义——重复
// 注入以后者覆盖；post-convergence D9 根治，dist 双形态下免模块副本分裂，范式与
// execution/subagent-service.ts 进程单例 slot 同型）。
const NOTIFY_PORTS_SLOT_KEY = Symbol.for(GLOBAL_SLOT_KEYS.notifyPorts);

type NotifyPortsSlot = { current: NotifyDomainPorts | undefined };

function getNotifyPortsSlot(): NotifyPortsSlot {
  let slot = Reflect.get(globalThis, NOTIFY_PORTS_SLOT_KEY) as NotifyPortsSlot | undefined;
  if (!slot) {
    slot = { current: undefined };
    Reflect.set(globalThis, NOTIFY_PORTS_SLOT_KEY, slot);
  }
  return slot;
}

export function configureNotifyDomain(ports: NotifyDomainPorts): void {
  getNotifyPortsSlot().current = ports;
}

/** 测试隔离专用：清空注入态（生产禁用——注入点在宿主壳初始化，生命周期与进程一致）。 */
export function resetNotifyDomainForTests(): void {
  getNotifyPortsSlot().current = undefined;
}

const DEFAULT_NOTIFY_PORTS: NotifyDomainPorts = {
  // 计数缺省恒 0：零活跃是安全侧语义（pending 门全开），且把「缺席按零处理」从
  // 消费方约定收敛为端口层的机器事实。
  countActiveFromEntries: () => 0,
  // getDeliveryPort 刻意缺席（见文件头「缺席语义」——消费方降级直发兜底）。
};

export function getNotifyDomainPorts(): NotifyDomainPorts {
  return getNotifyPortsSlot().current ?? DEFAULT_NOTIFY_PORTS;
}
