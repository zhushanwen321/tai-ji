/**
 * 发送位四态预测表（session-occupancy u5b D6 → 投递所有权内核 u3b/D1 降级为 UI 预测）。
 *
 * [u3b/D1 降级] 本表**不再是投递决策**：lane 判定（direct/steer/queued）已收归 runtime
 * 投递所有权内核（单一判定源 = runtime 权威 occupancy 派生视图 + 内核队列态），renderer 发送
 * 链统一 delivery.submit，不做任何车道判定。本函数保留的唯一职责 = **⏎ 提交车道的
 * UI 预测**——Composer 键盘分发按 sessionPhase 预测「本次 Enter 直达 / 并入当前回合 /
 * 排队」（direct/steer/queued），供 composer-keydown 的 Alt+⏎ 分流用；真实车道以
 * session.delivery 帧的 lane 字段为准（提交后帧到达即校正预测偏差）。
 *
 * **与发送位按钮形态是两个问题**（2026-10 用户裁决）：按钮回答「现在能中止什么」
 * （忙 → 终止钮；压缩期 → 中止压缩流程，派生见 renderer composer-shell 的 sendButtonState /
 * sendButtonStopTarget），本表回答「这条消息走哪条车道」（compacting → queued 排队）。
 * 两者故意分立——a46f6fd7b 曾以「按钮跟随 lane」收敛（compacting → queue 按钮）修形态漂移，
 * 代价是压缩期 composer 失去全部中止能力；现由分立消除混谈，各自单一派生。
 *
 * 保留原六行表语义作车道预测依据（与 runtime 内核判定同构——同读 occupancy 三维派生视图、
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
 * 派生视图与 pi 真实状态间的窗口）不再有正确性后果——误预测只影响按钮形态一帧，内核判定权威。
 *
 * 类型从 shared wire 契约提取（SessionPhase = session.occupancy payload 去 sessionId），
 * 与 chat store 的 occupancy 派生视图同源（shared protocol 是唯一权威，无双真源）。
 */
import type { ServerMessageMap } from '@taiji/shared'

/** sessionPhase —— occupancy 的 renderer 派生视图三维（P4 ActivityStrip / 发送位同源取数）。 */
export type SessionPhase = Omit<ServerMessageMap['session.occupancy'], 'sessionId'>

/** occupancy 缺省值（session 无 occupancy 记录时 = 全 idle，预测 direct）。 */
export const IDLE_SESSION_PHASE: SessionPhase = { turn: 'idle', compacting: false, bash: false }

/** 发送位预测三态（[u3b/D1] UI 预测非投递决策）：direct 直达 / steer 并入当前回合 / queued 排队。 */
export type SendRoute = 'direct' | 'steer' | 'queued'

/**
 * ⏎ 提交车道预测表（六行，语义见文件头注）。纯函数、零副作用——只做 Enter 车道预测，
 * 投递行为与本表返回值无关（内核 lane 判定权威，session.delivery 帧 lane 字段校正）。
 * 注意：本表**不**预测发送位按钮形态（按钮 = 「现在能中止什么」，压缩期为 stop，派生在
 * renderer composer-shell）——两问题分立，见文件头注。
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
