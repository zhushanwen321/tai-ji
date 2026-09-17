/**
 * Model 域 —— 模型列表订阅 + 切换动作。
 *
 * - onModels 走订阅（sendInitialState 推 model.list）。ModelInfo 统一用 shared/provider.ts
 *   的定义（runtime aggregateModels 生产的形状），不再本地臆造扁平结构。
 * - switchModel 是动作（确认由 model.switched 推回，本计划暂不订阅 switched，后续真实集成接）。
 *
 * 依赖方向：events（订阅）+ command（动作）。
 */
import type { ModelInfo, ProviderId } from '@taiji/shared'
export type { ModelInfo }
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'
import * as events from '../events'

/** 订阅模型列表（config.providers 解析后的聚合模型，sendInitialState 推） */
export function onModels(handler: (models: ModelInfo[]) => void): () => void {
  return events.onGlobalType('model.list', (msg) => {
    handler(msg.payload.models)
  })
}

/**
 * 主动拉取聚合模型列表（请求-响应兜底，对齐 config.listProviders 范式）。
 *
 * onModels 订阅覆盖 sendInitialState 首推与运行时广播；本函数解决「订阅注册时序竞态导致首推丢失」
 * 的兜底（runtime settings-message-handler.ts 的 model.list case reply { models }）。
 * 由 settings-lifecycle.refreshModels 在连接后调一次。mock 模式 WS 不回此 reply（mockSend 仅 ping/pong），
 * 故调用方须在非 mock 模式下调（否则 pending 65s 超时）。
 */
export async function listModels(): Promise<ModelInfo[]> {
  const reply = await command('model.list', {}, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.models
}

/**
 * 切换当前 session 的模型（动作）。
 * [U6/C-pi-13] 回执消费：reply（model.switched payload）回传 pi 生效值——runtime 侧
 * switchModel 经 set→get_state 读回，pi pattern 引擎静默换模（事故 A 形态）时
 * 生效值 ≠ 请求值；settings-message-handler 对无 '/' 形态（无活跃进程早退等）按
 * 请求值回显兜底。调用方须以回执值写显示态，禁用请求值乐观写。
 */
export async function switchModel(
  sessionId: string,
  provider: ProviderId,
  modelId: string,
): Promise<{ sessionId: string; provider: string; modelId: string }> {
  return command('model.switch', { sessionId, provider, modelId }, RPC_BACKSTOP_TIMEOUT_MS)
}

