/**
 * composer 域入口 —— @taiji/core 的 composer 域聚合 barrel。
 *
 * 子域：types（共享类型）/ dispatch（提交 + staging + fork/handoff 编排）/
 * context（注入通道 + 上下文 chip）/ model-thinking（模型 + 思考等级）/ thinking-level-sync（思考档同步）/
 * thinking-levels（思考档枚举与解析）/ model-thinking-memory + last-used-model（KV 单键双模块，
 * 见底部别名导出注释）。input 子域已迁 @taiji/dom-core（ADR-0058，composer/input
 * DOM-bound 逻辑整体迁出，core 恢复真 headless）。
 * 承接架构文档 §10.2（旧层 → core/domain/* 映射）。
 */
export * from './types'
export * from './dispatch'
export * from './context'
export * from './model-thinking'
export * from './model-thinking-memory'
export * from './thinking-level-sync'
export * from './thinking-levels'
// last-used-model 的 loadOnce/lookup/record/onLoaded 与 model-thinking-memory 星导重名
//（两模块同为 KV 单键族），不能 `export *`——按消费方（renderer 壳 launchConfig.getInput
// 注入 U2d / 壳接线测试种入）别名导出
export {
  lookup as lookupLastUsedModel,
  record as recordLastUsedModel,
  __resetLastUsedModelForTesting,
} from './last-used-model'
