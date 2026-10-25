/**
 * session occupancy 域形状与「回合进行中」判定集合（chat-flow-consistency D1 契约根，
 * u-foundation 单元交付，纯类型与常量导出——零行为变更）。
 *
 * 职责边界：本文件是 occupancy wire 域的形状 SSOT（protocol.ts 的 'session.occupancy'
 * 帧内联引用 SessionTurnPhase）与 turn 维「回合进行中」判定集合的唯一定义点。
 * 消费方（chat-flow-consistency U1/U2/U5 落地）：runtime laneOf 投递判定、发送位预测、
 * 前端回合判定引用 ACTIVE_TURN_PHASES——settling 纳入 steer 排队由该集合单点生效
 * （设计 §3.3 D1 采用 2）；活动条（ActivityStrip）消费 sessionPhase 派生视图按相位分行，
 * 不直接引用集合（grep 核实：packages/ui 全域零命中）。
 *
 * runtime 侧镜像类型 packages/runtime/src/services/session/types.ts SessionOccupancy
 * 的字段值域与本文件保持一致（广播帧由 updateSessionOccupancy 按字段展开构造）。
 */
import type { ServerMessageMap } from './protocol'

/**
 * turn 维四相位（protocol.ts 'session.occupancy' 帧 turn 字段值域 SSOT）：
 * - dispatching：prompt 已发、message_start 未到；
 * - generating：turn-start..turn-end；
 * - settling：turn-end..agent-settled（pi post-run 收尾期）；
 * - idle：空档。
 */
export type SessionTurnPhase = 'idle' | 'dispatching' | 'generating' | 'settling'

/**
 * 「回合进行中」判定集合（chat-flow-consistency §3.3 D1 定稿值）：turn ∈ 本集合的会话
 * 视为回合未结束。单一常量即单一判定源——投递判定、发送位预测、活动条、前端回合判定
 * 不各自维护相位子集，新增消费方声明即用。
 *
 * 值校准：探针 P1 实测通过（settling 窗口 pi prompt(steer) 三条受理路径全部正确受理、
 * 毫秒级自动开新回合——探针产物在工作流产物目录，不入仓库；结论如前内联），集合维持设计
 * §3.3 D1 定稿值 ['dispatching', 'generating', 'settling']，条件降级路径不再适用。
 */
export const ACTIVE_TURN_PHASES = ['dispatching', 'generating', 'settling'] as const

/** ACTIVE_TURN_PHASES 的元素类型（判定集合成员与 wire 类型同源：⊆ SessionTurnPhase，
 *  'idle' 恒不在集——回合进行中判定不含空档）。 */
export type ActiveTurnPhase = (typeof ACTIVE_TURN_PHASES)[number]

/** 「回合进行中」判定函数——ACTIVE_TURN_PHASES 的唯一函数读口（chat-flow-consistency §3.3
 *  D5 采用 4：角标判定与 Alt+⏎ 分流共用同一函数，判定恒等于真实去向）。 */
export function isActiveTurnPhase(turn: SessionTurnPhase): boolean {
  return (ACTIVE_TURN_PHASES as readonly SessionTurnPhase[]).includes(turn)
}

/** session occupancy 的 renderer/core 派生视图形状（= 'session.occupancy' 帧去 sessionId，
 *  现四维：turn × compacting/bash + 第四维 handingOff 过渡期可选——U1 已落地，runtime 广播
 *  恒带，见 protocol.ts 'session.occupancy' 帧注；原 core dispatch/send-route.ts 定义，随 D5
 *  六行预测表退役迁本文件——occupancy 形状 SSOT 同点收敛）。 */
export type SessionPhase = Omit<ServerMessageMap['session.occupancy'], 'sessionId'>

/** occupancy 缺省值（session 无 occupancy 记录时 = 全 idle；landing 无 session 同值）。
 *  四维全带（handingOff: false 与 runtime 广播恒带四维的形态对齐——消费方展开/读字段
 *  均按 undefined ≡ false 语义消费，补键零行为变化）。 */
export const IDLE_SESSION_PHASE: SessionPhase = { turn: 'idle', compacting: false, bash: false, handingOff: false }
