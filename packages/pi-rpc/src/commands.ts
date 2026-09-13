// src/commands.ts
//
// pi RPC 命令帧组装（公共层）——prompt（含 streamingBehavior 语义）/ steer /
// followUp / abort / get_state / switch_session / extension_ui_response。
//
// 来源（行为逐字等价提取，非重写）：
//   - buildPromptParams / buildSteerParams / buildFollowUpParams /
//     buildSwitchSessionParams / buildExtensionUiResponsePayload
//     ← runtime rpc-client.ts 高层 API 方法的 params 组装段
//   - buildPromptCommandFrame / buildGetStateCommandFrame / buildUiResponseFrame
//     ← pi-subagent-cli stdin-writer.ts sendPromptCommand / sendGetStateCommand /
//     respond 的帧组装段
//
// 两个组装层的原因：runtime RpcClient 的 sendCommand 统一封装 {id,type,...params}
// 帧 + pending 配对（消费 params 形态）；pi-subagent-cli 是 fire-and-forget 裸写
// （消费完整帧形态，id 自生成且需回传匹配）。帧形状单源在 serializeCommandFrame。
//
// switch_session 仅主 agent（runtime）消费——subagent 侧续聊走 spawn 时 --session
// 直续（buildPiSubagentSpawnArgs），不运行时切换目标文件。防误认为双侧契约。
//
// abort / steer / followUp 当前仅主 agent 消费（subagent 的 busy 投递统一走
// prompt + streamingBehavior），帧形状双侧同构、一并列出。

import type { StreamingBehavior } from './types.ts'

/** 命令帧序列化：{id, type, ...params} 单行 JSON（不含换行——裸写层统一补 \n）。 */
export function serializeCommandFrame(id: string, type: string, params: Record<string, unknown>): string {
  return JSON.stringify({ id, type, ...params })
}

/**
 * shared 层图片附件形状（{data;base64;mimeType}，无 type 字段）。
 * buildPromptParams 是该形状 → pi ImageContent 的唯一组装点：map 时补
 * `type:'image'`，pi 私有 type 字段不出本包消费方的 shared 层。
 */
export interface PromptImageAttachment {
  data: string
  mimeType: string
}

/** prompt 命令参数（pi RPC 协议用 "message" 字段，非 "content"）。 */
export function buildPromptParams(input: {
  message: string
  images?: PromptImageAttachment[]
  streamingBehavior?: StreamingBehavior
}): Record<string, unknown> {
  const piImages = input.images && input.images.length > 0
    ? input.images.map(i => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType }))
    : undefined
  const params: Record<string, unknown> = { message: input.message }
  if (piImages) params.images = piImages
  if (input.streamingBehavior) params.streamingBehavior = input.streamingBehavior
  return params
}

/** steer 命令参数（抢占当前 turn）。 */
export function buildSteerParams(content: string): Record<string, unknown> {
  return { message: content }
}

/** followUp 命令参数（排队下一 turn）。 */
export function buildFollowUpParams(content: string): Record<string, unknown> {
  return { message: content }
}

/**
 * switch_session 命令参数（仅主 agent 消费，见文件头注）。
 * 永久重绑读写目标：pi open 新 SessionManager → teardownCurrent → createRuntime
 * 重绑，后续 get_state 返回新 session 的生效值。
 */
export function buildSwitchSessionParams(sessionPath: string): Record<string, unknown> {
  return { sessionPath }
}

/**
 * prompt 完整命令帧（fire-and-forget 裸写形态；pi-subagent-cli 消费）。
 * streamingBehavior 省略时帧不含该键（首帧 prompt 行为不变）。
 */
export function buildPromptCommandFrame(
  id: string,
  input: { message: string; streamingBehavior?: StreamingBehavior },
): string {
  const params: Record<string, unknown> = { message: input.message }
  if (input.streamingBehavior) {
    params.streamingBehavior = input.streamingBehavior
  }
  return serializeCommandFrame(id, 'prompt', params)
}

/** get_state 完整命令帧（仅 id + type，无其他字段；返回 id 供调用方匹配 response）。 */
export function buildGetStateCommandFrame(id: string): string {
  return serializeCommandFrame(id, 'get_state', {})
}

/** UI 应答形状（subagent 侧 UiResponse 的结构子集；ack = fire-and-forget 不写 stdin）。 */
export interface UiResponseShape {
  value?: unknown
  confirmed?: boolean
  cancelled?: boolean
  ack?: boolean
}

/**
 * extension_ui_response 帧（subagent 侧形态）：UiResponse 形状 tag 判别 → 单行 JSON。
 *
 * 判别优先级 value > confirmed > cancelled；ack（fire-and-forget method，SR-5）返回
 * undefined 表示不写 stdin。序列化失败（循环引用/BigInt）经 onSerializeError 出声后
 * 降级 cancelled——宁可取消单次 dialog 也不崩进程（R2）。
 */
export function buildUiResponseFrame(
  id: string,
  out: UiResponseShape,
  opts?: { onSerializeError?: (err: unknown) => void },
): string | undefined {
  let line: string | undefined
  try {
    if ('value' in out) line = serializeUiResponse({ type: 'extension_ui_response', id, value: out.value })
    else if ('confirmed' in out) line = serializeUiResponse({ type: 'extension_ui_response', id, confirmed: out.confirmed })
    else if ('cancelled' in out) line = serializeUiResponse({ type: 'extension_ui_response', id, cancelled: true })
  } catch (err) {
    opts?.onSerializeError?.(err)
    line = serializeUiResponse({ type: 'extension_ui_response', id, cancelled: true })
  }
  return line
}

function serializeUiResponse(payload: Record<string, unknown>): string {
  return JSON.stringify(payload)
}

/**
 * extension_ui_response payload（主 agent / bridge 形态：raw response + method 判别）。
 *
 * payload 格式（吸收 extension-message-handler 的 buildExtensionUiResponse 映射）——
 * pi 鸭子类型字段检测（rpc-mode.ts）：
 *    - response === null → {cancelled:true}（取消 / 超时）
 *    - method === 'confirm' → {confirmed:boolean}
 *    - 其余（select/input/editor）→ {value:string}（对象经 String 会变
 *      '[object Object]'，调用方传对象前必须自行 JSON.stringify——设计
 *      bridge-rewrite-pi-0.84 §3.3-D1 序列化陷阱）
 *
 * 判定优先级：null（取消）> confirm > value。
 */
export function buildExtensionUiResponsePayload(id: string, response: unknown, method?: string): Record<string, unknown> {
  if (response === null) {
    // 取消 / 超时（无论 method）
    return { type: 'extension_ui_response', id, cancelled: true }
  }
  if (method === 'confirm') {
    return { type: 'extension_ui_response', id, confirmed: response as boolean }
  }
  // select / input / editor → value
  return { type: 'extension_ui_response', id, value: String(response) }
}
