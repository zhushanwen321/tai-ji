// src/shared/agent-stream.ts
//
// [§2.4 依赖方向] 增量文本流出口的**端口侧结构窄形态**。
//
// 为什么需要：`SubagentStream` 是应用/UI 层的具体类（`execution/assembly/stream-sink.ts`，
// 内含 widget 绘制与 sink 装配），但编排端口（`orchestration/models/ports.ts` 的
// AgentRunner）与引擎端口（`execution/engine/port.ts` 的 RunContext）此前直接 import
// 该类——**端口 → 应用实现类**的反向依赖；同一个类名还让「端口契约」与「UI 实现」在
// 阅读上无法区分。
//
// 端口真正需要的只是「能收增量、能释放」这两个方法（编排层对 stream 零调用，只透传；
// 引擎侧用它推 text_delta）。此处声明结构契约后，实现类无需改动（TS 结构化类型），
// 端口只依赖本契约。
//
// 注意：本文件属 shared 最低层（零内部依赖）——端口与实现都可 import，不制造新环。
export interface AgentStreamSink { // oe-exempt:20260930:framework:端口契约类型——端口只依赖结构窄形态（具体实现类 SubagentStream 在应用层），非单实现投机抽象
  /** 追加一段增量文本（引擎 text_delta 出口）。 */
  onDelta(delta: string): void;
  /** 释放：停止后续写入并清理挂载面（幂等）。 */
  dispose(): void;
}
