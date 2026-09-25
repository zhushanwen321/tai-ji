/**
 * 发送位四态预测表（session-occupancy u5b D6 → 投递所有权内核 u3b/D1 降级为 UI 预测）。
 *
 * [u3b/D1 降级] 本表**不再是投递决策**：lane 判定（direct/steer/queued）已收归 runtime
 * 投递所有权内核（单一判定源 = runtime 权威 occupancy 投影 + 内核队列态），renderer 发送
 * 链统一 delivery.submit，不做任何车道判定。本函数保留的唯一职责 = **发送位按钮形态的
 * UI 预测**——Composer 发送位按 sessionPhase 预测「提交即送达 / 排队 / 停止」的按钮形态
 * （send/stop/queue），供壳层渲染；真实车道以 session.delivery 帧的 lane 字段为准
 * （提交后帧到达即校正预测偏差，渲染层不依赖本预测的正确性）。
 *
 * 保留原六行表语义作预测依据（与 runtime 内核判定同构——同读 occupancy 三维投影、
 * 同 hold 优先判定序：任一 hold 维度先于活跃 turn 判，对齐 laneOf/holdReasonOf。
 * generating∧compacting 组合现实可达——compacting-start 只 patch compacting 不动 turn——
 * 对该组合权威 lane 为 queued，故 compacting 必须先于 turn 活跃集判定）：
 *
 * | # | sessionPhase                                       | 预测形态 |
 * |---|----------------------------------------------------|-----------|
 * | 1 | 全 idle                                            | direct    |
 * | 2 | compacting=true（任意 turn）                        | queued    |
 * | 3 | bash=true（未压缩）                                 | queued    |
 * | 4 | turn=settling（未压缩、无 bash）                     | queued    |
 * | 5 | turn=dispatching 或 generating（无上述 hold 维度）   | steer     |
 * | 6 | 其余（turn=idle 且无 hold 维度）                     | direct    |
 *
 * 命名说明：'defer' 字面随 defer 队列退役改为 'queued'（内核车道语义，DeliveryFrameEntry
 * lane 同名）；SendRoute 类型字面保持 'direct' | 'steer' | 'queued'。TOCTOU 本质（renderer
 * 投影与 pi 真实状态间的窗口）不再有正确性后果——误预测只影响按钮形态一帧，内核判定权威。
 *
 * 类型从 shared wire 契约提取（SessionPhase = session.occupancy payload 去 sessionId），
 * 与 chat store 的 occupancy 投影同源（shared protocol 是唯一权威，无双真源）。
 */
import type { ServerMessageMap } from '@taiji/shared'

/** sessionPhase —— occupancy 的 renderer 投影三维（P4 ActivityStrip / 发送位同源取数）。 */
export type SessionPhase = Omit<ServerMessageMap['session.occupancy'], 'sessionId'>

/** occupancy 缺省值（session 无 occupancy 记录时 = 全 idle，预测 direct）。 */
export const IDLE_SESSION_PHASE: SessionPhase = { turn: 'idle', compacting: false, bash: false }

/** 发送位预测三态（[u3b/D1] UI 预测非投递决策）：direct 直达 / steer 并入当前回合 / queued 排队。 */
export type SendRoute = 'direct' | 'steer' | 'queued'

/**
 * 发送位四态预测表（六行，语义见文件头注）。纯函数、零副作用——只做按钮形态预测，
 * 投递行为与本表返回值无关（内核 lane 判定权威，session.delivery 帧 lane 字段校正）。
 *
 * 判定序与 runtime laneOf 同构：先 hold（任一不可收维度 → queued；内部序 compacting →
 * bash → settling 对齐 holdReasonOf，三者同返回值故序不影响行为，仅保持同构可读），
 * 再 steer（活跃 run），后 direct。
 */
export function resolveSendRoute(phase: SessionPhase): SendRoute {
  if (phase.compacting || phase.bash || phase.turn === 'settling') return 'queued'
  if (phase.turn === 'dispatching' || phase.turn === 'generating') return 'steer'
  return 'direct'
}
