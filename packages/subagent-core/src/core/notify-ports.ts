// src/core/notify-ports.ts
//
// 通知域窄端口（D2 计划期细化②）。pi 侧完成通知的两机制——@taiji/session-delivery
// 投递内核工厂 / @zhushanwen/pi-pending-notifications 活跃计数——经本端口结构化注入；
// HostServices.notify 事件推送按演进纪律②（禁止无真实触点的推测性预留）推迟到 P2
// zsw 壳首个真实触点（task-notification）再落。
//
// 闭包红线：本文件是 core 对上述两包的唯一替代面——下方 Delivery* 结构化类型为手工
// 转写（与 packages/session-delivery/src/types.ts 逐字段结构兼容），禁止 import 两包
// （D9 闭包守卫扫描对象）。结构兼容由注入点 typecheck 守护：pi 壳直传真实
// createDelivery、拆 CountActiveResult.count 时，上游签名漂移即 typecheck 红。
//
// 缺席语义（设计 §3.4 core_port_missing 精神：可选端口缺席是合法形态，不报错）：
//   - 计数器缺席 → 恒 0（零活跃）：pending 门全开，缺省内聚在本端口层。
//   - 投递工厂缺席 → 消费方降级直发：直发是消费方行为，端口层无法代为执行，
//     故 createDelivery 刻意保持缺席（undefined），由消费方判缺席降级。

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
  /** 是否有排队中的消息。 */
  hasPendingMessages(): boolean;
  /** 投递消息。返回受理回执或 void（扩展位——旧实现返回 void 兼容）。 */
  send(
    msg: DeliveryMessage,
    intent: DeliveryIntent,
  ): void | DeliverySendReceipt | Promise<void | DeliverySendReceipt>;
  /** agent_settled 边沿订阅。缺省时工厂退化退避轮询；返回退订函数。 */
  subscribeSettled?(cb: () => void): () => void;
}

/** 投递工厂 options（notifier 实际消费的字段集；其余策略字段未入端口面）。 */
export interface DeliveryConfig {
  intent?: DeliveryIntent;
  busyPolicy?: "retry-force" | "park";
  /** 合批窗口（ms）：0 = 关；>0 = 滑动窗口合批。 */
  mergeWindowMs?: number;
  /** 合批依赖谓词（禁止用 isIdle 代替——D4 must-fix 语义）。 */
  mergeHoldActive?: () => boolean;
  backoff?: { ms: number; max: number };
  dedupe?: { maxKeys: number };
  /** 投递失败警告出口（U4：装配方接 logger 使警告落日志盘而非 stderr）。 */
  warn?: (msg: string, err?: unknown) => void;
}

/** 投递句柄（notifier 消费面：send / flush / dispose——诊断面 depth 等不入端口）。 */
export interface DeliveryHandle {
  /** 唯一常规入口（合批窗口 + 空闲零延迟立即投）。 */
  send(msg: DeliveryMessage, opts?: { merge?: boolean }): void;
  /** 强制投递尝试（shutdown flush 等）。 */
  flush(): void;
  /** 销毁（清队列 + 清 timer + 退订）。 */
  dispose(): void;
}

/** countActiveFromEntries 的过滤选项（[F1] 与 pending-notifications 的
 *  CountActiveOptions 对齐的子集——core 契约面只暴露跨 session 基准一个字段）。 */
export interface CountActivePortOptions {
  /**
   * [W4 读侧过滤②] 跨 session 残留过滤基准：传入时端口实现按「register entry 的
   * sessionId ≠ 基准 → 跳过」过滤——fork 继承的父级注册残留（翻 process 档后 U4
   * 补注销不再中性化，永久留存于子 session 文件）不进差集。
   * 缺省（undefined）= 不过滤（向后兼容：既有调用方零改动行为不变）。
   */
  currentSessionId?: string;
}

export interface NotifyDomainPorts {
  /** pending 活跃计数（pi 会话 entries 中 register − unregister 差集的数值）。
   *  契约为 number 而非 pi 侧 CountActiveResult：core 消费面只读 count，契约面最窄；
   *  pi 壳注入时拆 `countActiveFromEntries(entries).count`。
   *  [F1] 第二参为可选过滤基准（CountActivePortOptions）——core 消费方（后代判定
   *  读侧）持有「被读 entries 所属 session」概念时必须传入，使跨 session 残留不进
   *  差集；与 pending-notifications 实装签名（entries, opts?) 对齐。 */
  countActiveFromEntries?(entries: unknown[], opts?: CountActivePortOptions): number;
  /** 投递内核工厂。签名与 @taiji/session-delivery 的 createDelivery 结构兼容，
   *  pi 壳直传其本体即可。缺席 = 消费方降级直发。 */
  createDelivery?(port: DeliveryPort, options?: DeliveryConfig): DeliveryHandle;
}

// 配置态持有：globalThis[Symbol.for] slot（与 host-services 同款覆盖式语义——重复
// 注入以后者覆盖；post-convergence D9 根治，dist 双形态下免模块副本分裂，范式与
// execution/subagent-service.ts 进程单例 slot 同型）。
const NOTIFY_PORTS_SLOT_KEY = Symbol.for("@zhushanwen/subagent-core.notify-ports");

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
  // createDelivery 刻意缺席（见文件头「缺席语义」）。
};

export function getNotifyDomainPorts(): NotifyDomainPorts {
  return getNotifyPortsSlot().current ?? DEFAULT_NOTIFY_PORTS;
}
