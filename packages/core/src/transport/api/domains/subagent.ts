/**
 * Subagent 域 —— subagent / workflow run 执行模型切换（subagent-model-switch §7.1）。
 *
 * 命令 `subagent.setModel` 照 `model.switch` 现役形态（command 类型化 RPC + 回执消费）；
 * wire 契约 SSOT = @taiji/shared protocol.ts（ClientMessageMap / SubagentSetModelReply 族），
 * 本域仅是 renderer 侧的类型化出口（u-foundation 定形 → U1 前端选择器接线消费）。
 *
 * 应答三形态按目标分流：
 *   - recordId（chat 域）→ 应答两型判别联合（kind: "effective" | "recorded"）；
 *   - runId（workflow run 级全切）→ 聚合应答三组件（members/failures/summary，无 kind
 *     字段——按调用参数分流判别）。
 *
 * 依赖方向：request（command 动作）+ shared 类型。
 */
import type {
  ProviderId,
  SubagentSetModelReply,
} from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'

/**
 * 切换 subagent / workflow run 的执行模型（动作）。
 *
 * 回执消费范式照 switchModel（U6 回执修型先例）：以应答值写显示态，禁用请求值
 * 乐观写——已生效型的生效模型可能 ≠ 请求目标（pi 模型族静默替换成同族模型）；
 * 已记账型不携带档位值（无回读源，档位由下次解析按现役候选链推导）。
 */
export async function setModel(params: {
  /** chat 域目标：subagent 会话 record id。与 runId 二选一。 */
  recordId?: string
  /** workflow 域目标：run id（run 级全切，聚合应答）。与 recordId 二选一。 */
  runId?: string
  provider: ProviderId
  modelId: string
  /** 可选 thinking 档位（用户显式选择时携带；缺省 = 引擎按新模型缺省裁决）。 */
  thinkingLevel?: string
}): Promise<SubagentSetModelReply> {
  return command('subagent.setModel', params, RPC_BACKSTOP_TIMEOUT_MS)
}
