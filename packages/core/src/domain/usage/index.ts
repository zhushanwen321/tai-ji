/**
 * usage 域入口 —— @taiji/core 的用量聚合域（C 尾项下沉）。
 *
 * usage-aggregate：UsageRow[] 行集 → 七个 usage 子组件所需视图数据的纯聚合逻辑 + 类型。
 * 原居 renderer/components/settings/usage/aggregate.ts，纯搬家不改行为（消费方 = usage 子组件）。
 */
export * from './usage-aggregate'
