/**
 * D6 发送路由表（session-occupancy-send-closure u5b / 设计 §3.3 D6）。
 *
 * 统一发送分发器的路由判定纯函数：sessionPhase（occupancy 的 renderer 投影，chat store
 * session.occupancy 帧驱动）→ sendRoute。Composer 的 onSend / Enter / Alt+Enter 全部汇入
 * 单一分发器后按本表路由，替换此前 isActive→steer 与 isCompacting→queue-send 两套分散
 * 判定（优先级倒挂根因——分发逻辑不同源，行为随代码路径漂移）。
 *
 * 「turn 活跃」的精确定义 = turn ∈ {dispatching, generating}（**不含** settling——settling
 * 是 pi post-run 收尾不是活跃 turn；generating+compacting 仅 threshold turn 内压缩可达）。
 * 路由判定顺序即优先级：先 turn 活跃 → steer（行 2/3）；否则任一维度忙 → defer（行 4/5/6）；
 * 全 idle → direct（行 1）。
 *
 * flush 触发（useChat occupancy handler）与 defer 语义同源：sendRoute 解除（= resolveSendRoute
 * 返回 'direct' 的三维形态）即投递时机——flush 条件按三维全 idle 判定，与本表行 1 对齐。
 *
 * 类型从 shared wire 契约提取（SessionPhase = session.occupancy payload 去 sessionId），
 * 与 chat store 的 occupancy 投影同源（shared protocol 是唯一权威，无双真源）。
 */
import type { ServerMessageMap } from '@taiji/shared'

/** sessionPhase —— occupancy 的 renderer 投影三维（P4 ActivityStrip / 发送位同源取数）。 */
export type SessionPhase = Omit<ServerMessageMap['session.occupancy'], 'sessionId'>

/** occupancy 缺省值（session 无 occupancy 记录时 = 全 idle，路由 direct / flush 可触发）。 */
export const IDLE_SESSION_PHASE: SessionPhase = { turn: 'idle', compacting: false, bash: false }

/** 发送路由三态：direct 直发 / steer 并入当前回合 / defer 入 defer 队列占用解除后投递。 */
export type SendRoute = 'direct' | 'steer' | 'defer'

/**
 * D6 路由表（六行）：
 *
 * | # | sessionPhase                                | sendRoute |
 * |---|---------------------------------------------|-----------|
 * | 1 | 全 idle                                     | direct    |
 * | 2 | turn=dispatching 或 generating（无 compacting）| steer    |
 * | 3 | turn=generating + compacting（threshold）    | steer     |
 * | 4 | turn=settling（无论是否 compacting）          | defer     |
 * | 5 | turn=idle + compacting                       | defer     |
 * | 6 | bash=true 且 turn=idle                       | defer     |
 *
 * 行 3（generating+compacting → steer）即「优先级倒挂」的消除形态：turn 活跃优先于
 * compacting 维度——压缩后 turn 继续跑，消息经 steer 在压缩完成后的下一次 LLM 调用前
 * 投递（不产生 pending 气泡，steer 分档正确）。
 */
export function resolveSendRoute(phase: SessionPhase): SendRoute {
  if (phase.turn === 'dispatching' || phase.turn === 'generating') return 'steer'
  if (phase.turn === 'settling' || phase.compacting || phase.bash) return 'defer'
  return 'direct'
}
