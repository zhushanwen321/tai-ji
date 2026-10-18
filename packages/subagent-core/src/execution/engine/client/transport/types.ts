// src/execution/engine/client/transport/types.ts
//
// [M3] EngineTransport 契约：local 与 runtime 二实现的共同签名（设计
// relay-spawn-transport §3.3 D5、§3.4.3）。本文件只立接口与类型，不写实现——
// 实现落点：local = ./local.ts（u-m3-local，从 EngineClient.spawnAndInitialize 抽出
// spawn/stdio/pidfile/reaper，行为不变）；runtime = ./runtime.ts（u-m3-rt-transport，
// control socket 客户端，经 SDK control-protocol/control-env 契约）。
//
// 契约边界（D5 采用段逐条）：
// - 契约定义在「extension ↔ engine」接缝：channelId 是 runtime 实现的内部键，不泄漏
//   给 EngineClient；transport 只负责帧搬运与通道生死。
// - 传输面错误订阅（onTransportError，可选成员）：runtime 实现提供——控制连接死亡
//   （engine_transport_lost）与通道级 error 帧（engine_frame_too_large /
//   engine_backpressure_overflow）经此 fan-out，宿主以具体码收口在途请求；local 实现
//   缺席（进程面错误由 onExit + writeFrame 回执表达，无第二个事实源）。
// - 送达回执不放进 transport：「prompt 已被 pi 受理」的事实源是 pi 的 prompt response /
//   stdout 活性，只有引擎能解析——回执留在引擎 run 生命周期（M2），transport 不理解
//   pi 协议。
// - initialize 握手保持在上层：EngineClient 的请求 id 关联、反向通道路由、超时、
//   initialize、崩溃重建策略不变；engineConfig 经上层 initialize 发送，transport 不携带。
// - 选择逻辑（单源 = SDK isControlEnvActive）：TAIJI_SUBAGENT_CONTROL_SOCKET 非空 →
//   runtime transport（连接失败/hello 被拒 → engine_transport_unavailable /
//   engine_protocol_mismatch，不静默 local）；空串/缺失 → local transport。谓词落点 =
//   EngineClient（两分支均已接线：local = ./local.ts，runtime = ./runtime.ts）。
// - pidfile/reaper 仅 local 模式注册（impl-plan u-m3-local 验收③）：进程面收割段
//   按 localTransport 实例有无编排，runtime 模式无 pidfile、无进程组收割。
// - 错误码面：transport 错误用 SDK ENGINE_TRANSPORT_ERROR_CODES 族
//   （engine_transport_unavailable / _lost / engine_open_timeout / engine_frame_too_large /
//   engine_backpressure_overflow），EngineClient.connectOnce 原样 preserve（不包装成
//   engine_crashed）；control socket 关闭的 fan-out 码 = engine_transport_lost。
//   engine_closed 的 reason 值域 = SDK SUBAGENT_CONTROL_CLOSED_REASONS（wire 契约；
//   本接口 reason 保持 string 形态——local 实现不产生该字段，运行时收窄由消费方做）。

import type { EngineSdkError } from "@zhushanwen/subagent-engine-sdk";

/**
 * 引擎启动规格（engine_open 帧的 launch 载荷，设计 §3.4.3 bounded launch spec）。
 * engineConfig 不在此传：它是引擎协议 initialize 的参数，由 EngineClient 在通道打开
 * 后照常发送，runtime 只做帧转发。runtime 侧以 rootSessionId 归属连接、以
 * parentRecordId/depth 建立 channel 树（嵌套递归收割）。
 */
export interface EngineLaunchSpec { // oe-exempt:20261018:framework:extension↔engine 传输契约的启动规格（local 忽略 runtime 归属键/runtime 消费；数据载荷形态）
  /** 引擎 id（runtime 校验在册 + 诊断日志）。 */
  engineId: string;
  /** 引擎 CLI 入口（extension 从 engine descriptor 解析；绝对路径）。 */
  entryPath: string;
  /** 引擎参数（当前为空）。 */
  args: string[];
  /** 引擎工作目录。 */
  cwd: string;
  /** 引擎 manifest 声明的 envPrefixes 放行前缀（runtime 构建 env 用）。 */
  envPrefixes: string[];
  /**
   * 主会话根 id（嵌套同值）——run 路径 = RunContext.sessionRootId（权威源）；未注入
   * （探针 / standalone）传空串占位，由 runtime transport 以 control env 回落。
   * 连接上第一个 engine_open 确定归属，后续不一致 → engine_open_failed；local 实现
   * 忽略（standalone 无 runtime 归属概念）。
   */
  rootSessionId: string;
  /** 嵌套：父 task pi 的 record id（来自 PI_SUBAGENT_SELF_RECORD_ID）。 */
  parentRecordId?: string;
  /** 嵌套深度（来自 PI_SUBAGENT_DEPTH）。 */
  depth?: number;
}

/** open() 的结果（pid 尽力而为：local=spawn 即知；runtime=engine_opened 帧；不可得时不谎报）。 */
export interface EngineTransportOpenResult { // oe-exempt:20261018:framework:extension↔engine 传输契约的 open 结果（数据载荷形态）
  pid?: number;
}

/**
 * 通道终局信息（onExit 载荷）：local = child exit 事件投影；runtime = engine_closed 帧
 * 映射（reason 值域 = SDK SUBAGENT_CONTROL_CLOSED_REASONS，stderrTail 为 runtime 侧
 * 400 字符环缓冲尾部）。区分两种失败（D5）：通道终局（引擎退出，连接仍活，同连接可
 * 重新 open）由 onExit 表达；控制连接自身死亡由 close 的错误 fan-out（engine_transport_lost）
 * 表达，不进本信息面。
 */
export interface EngineTransportExitInfo { // oe-exempt:20261018:framework:extension↔engine 传输契约的终局信息（数据载荷形态）
  /** 进程退出码（被信号终止时为 null）。 */
  code: number | null;
  /** 终止信号名（正常退出时为 null）。 */
  signal: string | null;
  /** stderr 尾部环缓冲（有界；排障用，缺席 = 无捕获）。 */
  stderrTail?: string;
  /** 终局归因（runtime 实现 = engine_closed 帧 reason 值域；local 实现缺席）。 */
  reason?: string;
}

/**
 * 引擎进程传输通道契约（extension ↔ engine 接缝的 local/runtime 共同签名）。
 * 生命周期：open → writeFrame/onFrame 帧交换 → close（或 onExit 终局）。
 */
export interface EngineTransport { // oe-exempt:20261018:framework:extension↔engine 传输契约端口（local/runtime 双实现）
  /**
   * 打开通道实际使用的根会话 id（runtime = open 时解析结果；local 恒 undefined——
   * standalone 无 runtime 归属面）。EngineClient 用于判定 run ctx 的权威根是否需要
   * 换代重连（B-U-1：engine_open 归属键在通道生命周期内不可变）。
   */
  readonly rootSessionId?: string;
  /**
   * 打开引擎通道。local = spawn 引擎 CLI 进程（stdio 接线，不等待 initialize）；
   * runtime = hello（同 (socket, rootSessionId) 共享连接时复用）+ engine_open，收到
   * engine_opened 才 resolve ——resolve 前 writeFrame 不得调用。
   */
  open(spec: EngineLaunchSpec): Promise<EngineTransportOpenResult>;
  /**
   * 写一行 engine-protocol 帧到引擎 stdin（runtime 实现包进 engine_frame 信封；
   * local 实现补换行直写）。返回 false = 帧未被受理（stdin 不可用/EPIPE / 控制连接
   * 不可写）——宿主据以把关联 in-flight 请求按通道死亡收口，故必须是回执形态而非 void。
   */
  writeFrame(line: string): boolean;
  /** 订阅引擎 stdout 行（runtime 实现解包 engine_frame.line 后回调；一行一调）。 */
  onFrame(handler: (line: string) => void): void;
  /** 订阅通道终局（引擎退出/被杀；幂等注册，多次终局只回调一次由实现保证）。 */
  onExit(handler: (info: EngineTransportExitInfo) => void): void;
  /**
   * 订阅传输面错误（可选；runtime 实现提供，local 缺席）。runtime 实现：控制连接死亡
   * → engine_transport_lost fan-out（D5「不是 engine_crashed」）；通道级 error 帧 →
   * engine_frame_too_large / engine_backpressure_overflow（D8「先具体码 reject 在途
   * 请求，再处理 engine_closed」，不被 engine_crashed 覆盖）。宿主消费 = 以该错误码
   * reject 全部在途请求 + 标记不可用（不在同一连接重试）。
   */
  onTransportError?(handler: (err: EngineSdkError) => void): void;
  /**
   * 优雅关闭本通道：local = 既有 teardown/kill 链语义；runtime = 发 engine_close，
   * 等待 engine_closed 或有界宽限（超时只放弃该 channel，不关闭共享连接）。
   * reason 可选（宿主收割场景的排障 reason 透传，实现记日志用）。
   * 控制连接死亡（runtime 死/断连）不是 close 的职责——实现以 engine_transport_lost
   * fan-out 拒绝全部 in-flight 并标记不可用，不在同一连接重试。
   */
  close(reason?: string): Promise<void>;
}
