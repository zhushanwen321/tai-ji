/**
 * new-task-search 域入口 —— @taiji/core 的搜索/命令/文件候选域（p3-strangler-domains W1）。
 *
 * 承接架构文档 §10.2（旧层 → core/domain/* 映射）：renderer lib/search-types + match-engine +
 * file-candidates + file-match 下沉为本域类型/纯函数模块；command store 收口为本域
 * 纯 factory（D7 双轨收口，壳 stores/command.ts 已删除）——本域是唯一实现，
 * 壳消费方经 composables/features 适配层消费 core 单例。
 * fileSearch store 已随缓存治理 U1 1-3 退役（候选直读，无缓存实现）。
 */
export * from './types'
export * from './match-engine'
export * from './file-candidates'
export * from './file-match'
export * from './command-store'
export * from './ports'
export * from './flow-state'
export * from './branch'
export * from './dir-select'
export * from './flow'
export * from './search-ports'
export * from './search'
export * from './search-jump'
export * from './command-registry'
export * from './search-modal'
export * from './recents'
export * from './launch-config'
export * from './supported-levels'
