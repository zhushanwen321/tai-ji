/**
 * session occupancy 域形状与「回合进行中」判定集合（chat-flow-consistency D1 契约根，
 * u-foundation 单元交付，纯类型与常量导出——零行为变更）。
 *
 * 职责边界：本文件是 occupancy wire 域的形状 SSOT（protocol.ts 的 'session.occupancy'
 * 帧内联引用 SessionTurnPhase）与 turn 维「回合进行中」判定集合的唯一定义点。
 * 消费方（chat-flow-consistency U1/U2/U5 落地）：runtime laneOf 投递判定、发送位预测、
 * 活动条、前端回合判定统一引用 ACTIVE_TURN_PHASES——settling 纳入 steer 排队由该
 * 集合单点生效（设计 §3.3 D1 采用 2）。
 *
 * runtime 侧镜像类型 packages/runtime/src/services/session/types.ts SessionOccupancy
 * 的字段值域与本文件保持一致（广播帧由 updateSessionOccupancy 按字段展开构造）。
 */

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
 * 值校准状态：按设计定稿值落地。探针 P1（settling 窗口 pi prompt(steer) 受理实测，
 * 结果文件 .tmp/tech-design/probes/p1-result.md）实施时点结论未出——若探针失败触发
 * 降级路径（settling 回退 direct 投递），本集合须缩窄为 ['dispatching', 'generating']
 * （设计探针清单登记的降级形态），校准由消费方单元（U1 laneOf）同批执行。
 */
export const ACTIVE_TURN_PHASES = ['dispatching', 'generating', 'settling'] as const

/** ACTIVE_TURN_PHASES 的元素类型（判定集合成员与 wire 类型同源：⊆ SessionTurnPhase，
 *  'idle' 恒不在集——回合进行中判定不含空档）。 */
export type ActiveTurnPhase = (typeof ACTIVE_TURN_PHASES)[number]
