/**
 * useModel —— 模型切换 + 思考等级设置编排（R2 features 层，跨 api + stores 的唯一合法层）。
 *
 * 这是「api 调用只在 features 层」铁律（ADR-0028）的落点：所有 model.switch /
 * session.setThinkingLevel RPC 调用 + sessionStore 更新的编排统一收敛于此，
 * 上层（panel/useComposerModelThinking、features/useNewTaskFlow）不再直调 @/api。
 *
 * 两种态的统一处理：
 * - session 已建态：直接调 RPC + 写状态层 `applyLiveState`（modelId 与 thinkingLevel 均写
 *   回执生效值——U6 弃乐观写：pi 钳制档位 / pattern 引擎静默换模时回执 ≠ 请求值，显示值从
 *   第一毫秒起就是真值）——立即生效，不依赖广播到达——未发消息的 session 可能无
 *   streamSubscription，广播会丢。
 *   [W1 会话架构四层分离] 写入目标是状态层（按会话 id 寄存），**不再按 id 类别分流**：
 *   btw 线 vid 与主会话走同一个 apply 入口（旧实现 btw 分支 + 专用 store 已删除）。
 * - landing 延迟态（useNewTaskFlow）：session 尚未 create，无法调 RPC。本 composable
 *   不处理 pending 记录（那是 useNewTaskFlow 的状态机职责），只暴露「session 已建后 apply」
 *   的能力，供 submitFirstMessage 在 create session 后调用，消除 useNewTaskFlow 与
 *   useComposerModelThinking 中重复的切换编排逻辑。
 *
 * 与 useThinkingLevelSync 的联动：模型切换的回执写按 sessionId 经 applySnapshot 写
 * sessionStore 对应 session 的 modelId，useThinkingLevelSync 的 watch(currentThinkingLevelMap)
 * 会在 modelId 变化后自动对齐思考等级（同体系直接映射 / 跨体系重置到最高可用档，经 onReset →
 * onThinkingSelect → setThinkingLevel 回到此 composable）。本 composable 只负责单次 RPC +
 * 回执写，不破坏该 watch 链。
 */
import { model as modelApi, session as sessionApi } from '@/api'
import type { ProviderId } from '@taiji/shared'
import { useSessionLiveStateStore } from '@/stores/session-live-state'

export function useModel() {
  const liveState = useSessionLiveStateStore()

  /**
   * 切换回执显示态写入（U6 生效值）。
   *
   * [W1 会话架构四层分离] 统一写状态层 `applyLiveState`——状态按会话 id 寄存，与「是否在
   * 侧栏列表」无关。旧实现的「btw 虚拟 id 分流」（btw 线写专用 store、主会话写
   * sessionStore.applySnapshot）已删除：两条路径合并为一个 reducer（设计 §3.3 删除清单）。
   */
  function applySwitchReceipt(sessionId: string, patch: { modelId?: string; thinkingLevel?: string }): void {
    liveState.applyLiveState(sessionId, patch)
  }

  /**
   * 切换 session 的模型：调 runtime model.switch RPC，以回执生效值写状态层。
   *
   * 回执消费（U6/C-pi-13，与 setThinkingLevel 同标准）：reply 的 provider/modelId 是
   * pi 实际生效值（runtime set→get_state 读回；pi pattern 引擎静默换模——事故 A 形态——
   * 时生效值 ≠ 请求值），显示值从第一毫秒起就是真值，禁用请求值乐观写。
   * RPC 失败时不写 store（显示保持旧真值）；state_changed 广播收敛兜底保留不变。
   * 写入 "provider/modelId" 复合串（与 SessionSummary.modelId 同格式）。
   *
   * 调用方职责区分：
   * - session 已建（Composer 工具条切换）：直传 sessionId + provider + modelId
   * - landing 延迟态：调用方记 pendingModel，create session 后调本方法 apply
   *
   * @param sessionId 目标 session id（须已 create）
   * @param provider 模型 provider id
   * @param modelId 模型 id（不含 provider 前缀）
   */
  async function switchModel(sessionId: string, provider: ProviderId, modelId: string): Promise<void> {
    // 回执生效值写显示态（弃请求值乐观写）；无 '/' 的兜底 reply 已在 runtime 侧按
    // 请求值回显（settings-message-handler model.switch case），此处无需再兜底。
    const reply = await modelApi.switchModel(sessionId, provider, modelId)
    applySwitchReceipt(sessionId, { modelId: `${reply.provider}/${reply.modelId}` })
  }

  /**
   * 设置 session 的思考等级：调 runtime session.setThinkingLevel RPC，以回执生效值写状态层。
   *
   * level 是前端 7 级枚举字符串（off/minimal/low/medium/high/xhigh/max，
   * 集合来源 @taiji/shared PI_THINKING_LEVELS）。
   * 回执消费（U6 弃乐观写）：reply.level 是 pi 实际生效档（pi 会钳制模型族不支持的档位，
   * 如 mimo 族 max → high；钳制后 effective ≠ previous 时 pi 仍必发
   * thinking_level_changed 事件，isChanging=false 仅「值未变」场景——PS-04）——显示值从第一毫秒起就是真值，
   * 不存在「过一会自己变回去」（事故 B 根因 ③）。RPC 失败时不写 store（显示保持旧真值）。
   *
   * 调用方职责区分：
   * - session 已建（Composer 工具条切换档位）：直传 sessionId + level
   * - landing 延迟态：调用方记 localThinkingLevel，create session 后调本方法 apply
   *
   * @param sessionId 目标 session id（须已 create）
   * @param level 前端 6 级枚举字符串
   */
  async function setThinkingLevel(sessionId: string, level: string): Promise<void> {
    const reply = await sessionApi.setThinkingLevel(sessionId, level)
    applySwitchReceipt(sessionId, { thinkingLevel: reply.level })
  }

  return { switchModel, setThinkingLevel }
}
