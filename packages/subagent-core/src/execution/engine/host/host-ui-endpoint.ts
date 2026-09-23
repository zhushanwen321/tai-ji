// src/execution/engine/host/host-ui-endpoint.ts
//
// core 壳侧 host/askUser 应答端登记处（W6，R3 MF-A / impl-plan §2.6 末条）。
//
// 接线链路：引擎进程经协议帧④ host/askUser 反向请求 → EngineClient reverse-router
// （W2 已交付，ack 两阶段 R9-2 语义）→ 本登记处的 getter（**消费时现读**，D3——
// 非 EngineClient 构造期固化）→ SubagentService init/initSession.uiRequestHandler
// （[D4-④] 唯一注入入口，应答处理复用 ui-request-handler-factory / dialog-queue
// 应答链路；chat 域 UI 请求同样经本通道，关联键 = spawn 轮 runId）。
//
// 为什么是登记处 + 消费时现读而非构造期传参固化：① EngineClient 在 discovery
// portFactory 内构造（惰性，首次 getEngine），构造点拿不到 Service 实例——进程级
// endpoint 槽位把「handler 何时注册」（session_start）与「EngineClient 何时构造」
// （首次引擎使用，晚于 session_start）解耦；② [D3] cli 引擎单例跨 reload 存活
// （registry D2b 幂等重注册不 dispose），adoption 只更新本槽、不重建 EngineClient
// ——若构造期固化，在飞 run 的 host/askUser 会路由到旧 ctx 的 handler（assertActive
// 抛错 → {cancelled:true} 静默取消）。globalThis[Symbol.for] 持有防 jiti 双路径
// 加载分裂（registry.ts 同款惯例）。

import type { UiRequestHandler } from "@zhushanwen/subagent-engine-sdk";

const ENDPOINT_SLOT_KEY = Symbol.for(
  "@zhushanwen/pi-subagent-workflow.hostUiRequestEndpoint",
);

function endpointSlot(): { handler: UiRequestHandler | undefined } {
  let slot = Reflect.get(globalThis, ENDPOINT_SLOT_KEY) as
    | { handler: UiRequestHandler | undefined }
    | undefined;
  if (!slot) {
    slot = { handler: undefined };
    Reflect.set(globalThis, ENDPOINT_SLOT_KEY, slot);
  }
  return slot;
}

/** 登记壳侧应答端（SubagentService 在 uiRequestHandler 三态写点同步调用：init / initSession / dispose）。 */
export function setHostUiRequestEndpoint(handler: UiRequestHandler | undefined): void {
  endpointSlot().handler = handler;
}

/** 读壳侧应答端（reverse-router host/askUser 消费时现读；undefined → 引擎收 {unsupported:true} 自行降级）。 */
export function getHostUiRequestEndpoint(): UiRequestHandler | undefined {
  return endpointSlot().handler;
}

/** 测试隔离：清空登记。 */
export function _resetHostUiRequestEndpointForTest(): void {
  endpointSlot().handler = undefined;
}
