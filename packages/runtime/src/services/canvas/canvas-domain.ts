/**
 * CanvasService 领域核心 —— mutate 主入口门面（problem-solve-canvas U2）。
 *
 * 设计锚点：.tmp/tech-design/problem-solve-canvas.md §3.1(1)（聚合根 mutate 唯一入口 +
 * 不变量 1-11 fail-fast + 时序纪律 + 原子事务）+ §5-U2；概念文档（不变量与状态机的
 * 上游 SSOT）：.tmp/problem-solve-canvas.md §2.3（就绪递归）/ §2.4（状态机）/
 * §2.5（聚合与不变量）/ §2.7（收敛判据）。
 *
 * 文件分层（依赖单向 foundation ← actions ← 本文件，无环；对外 import 面恒为本文件）：
 * - canvas-foundation.ts：错误 / 事件形状 / 图查询 / 状态机 / 就绪递归 / 收敛门禁
 * - canvas-actions.ts：per-action 状态应用（applyCreate / applyByAction）
 * - 本文件：applyMutation 主入口（主事件排序 + 对账违约 fail-fast）
 *
 * 本目录零 IO（落盘与广播在 canvas-service.ts 编排）——「U2 独立于一切 IO 可穷举单测」
 * 的落点。全部写路径（live mutate 与崩溃后重建回放）共用同一 apply 函数：直写 ≡ 重放
 * 由该共用构造性保证（等价性测试 canvas-persistence.test.ts 承接）。
 *
 * 时序纪律的承载方式：applyMutation / applyCreate 是同步纯函数（prev 状态 → 新状态 +
 * 事件集，零 await 零 IO），调用方在同一同步段内完成「校验 + 内存应用」；落盘与广播
 * 全部后置——「单进程串行化」承诺由该同步段构造性保证。原子事务：grow 批在副本上逐条
 * 应用，任一条 fail-fast 抛 CanvasDomainError，副本丢弃，prev 状态不变（无部分写入）。
 */
import { ACTION_EVENT_MAP } from '@zhushanwen/extension-protocol'
import type { CanvasActor, CanvasEventType, CanvasState } from '@zhushanwen/extension-protocol'
import { applyByAction } from './canvas-actions.js'
import {
  fail,
  type AppliedMutation,
  type CanvasEventBody,
  type CanvasTransformRequest,
  type IdGenerator,
} from './canvas-foundation.js'

// applyCreate（聚合根诞生）与 applyByAction 同层；对外与 applyMutation 一致从本文件取。
export { applyCreate } from './canvas-actions.js'

// 对外类型与原语面（测试 / service 的既有 import 路径保持本文件单点）。
export {
  CanvasDomainError,
  isCanvasDomainError,
  type CanvasMutationAction,
  type CanvasTransformAction,
  type CanvasTransformRequest,
  type CanvasEventBody,
  type GeneratedIds,
  type IdGenerator,
  replayIdGenerator,
  eventOf,
  eventData,
  type AppliedMutation,
  type CreateIds,
  nodeOf,
  edgeOf,
  isTrunkEdge,
  parentIdsOf,
  decomposeChildrenOf,
  selectedOptionOf,
  pathToRoot,
  subtreeOf,
  argumentPolarity,
  findTrunkCycle,
  LIFECYCLE_TRANSITIONS,
  isTransitionAllowed,
  isOptionReady,
  isQuestionReady,
  isRootReady,
  dispatchableLeaves,
  convergenceBlockers,
  markDirty,
  dirtyEvent,
  truncate,
  SUMMARY_TRUNCATE_MAX,
  CANVAS_NAME_MAX,
} from './canvas-foundation.js'

/**
 * 聚合根唯一写入函数（create 之外的 13 个 mutation action）。语义校验（存在性 / 邻接 /
 * 状态机 / 不变量）全部在本函数内的 action 应用层 fail-fast：任一失败抛 CanvasDomainError，
 * prev 不变。actor 权限矩阵校验归服务入口统一做（本函数不查矩阵——重放路径无矩阵问题）。
 */
export function applyMutation(
  prev: CanvasState,
  req: CanvasTransformRequest,
  actor: CanvasActor,
  at: string,
  idGen: IdGenerator,
): AppliedMutation {
  const draft = structuredClone(prev)
  const events: CanvasEventBody[] = []
  const summary = applyByAction(draft, req, actor, at, idGen, events)
  // 主事件 = ACTION_EVENT_MAP[req.action]，构造性置于 events[0]（广播 evType / reply
  // eventId 的取值位；附属事件 DirtiedPathMarked / ReviewConverged 落其后）。
  const mainType: CanvasEventType = ACTION_EVENT_MAP[req.action]
  const mainIdx = events.findIndex((e) => e.type === mainType)
  if (mainIdx === -1) {
    // 每个 mutation action 至少产出一个事件（对账 SSOT = ACTION_EVENT_MAP）——
    // 走到此处 = 某 action 分支漏产事件，fail-fast 暴露而非静默空转。
    fail('invalid_params', `action「${req.action}」未产出任何领域事件（对账违约，属实现缺陷）`)
  }
  if (mainIdx > 0) events.unshift(...events.splice(mainIdx, 1))
  return { state: draft, events, evType: mainType, summary }
}
