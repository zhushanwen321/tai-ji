/**
 * Session live state store（薄壳，ADR-0059）。
 *
 * core `createSessionLiveState` factory 的 pinia 注册壳：core 拥有状态层逻辑（headless），
 * renderer 经 defineStore 注册到 pinia 供消费方使用。与 `stores/session.ts` 对
 * `createSessionStore` 的包法完全同形。
 *
 * 为什么存在（会话架构四层分离 W1，设计 §3.3「状态层」）：
 * 会话运行时状态（modelId / thinkingLevel）按会话 id 独立寄存，生命周期与导航列表解耦——
 * 侧栏列表之外的会话（btw 线 runtime hidden 注册、任意未列入侧栏的 id）与主会话走同一条
 * 写入路径，`applyLiveState` 是唯一写入口。列表刷新 / 项目过滤 / 归档**不得**触碰本层，
 * 只有会话删除走 `removeLiveState`。
 *
 * 数据登记：docs/architecture/data-source-registry.md 主表 #76（core factory 声明处
 * `@data-owner #76`）；本条替代已退役的 #63（btw 线模型/思考档显示态 store）。
 */
import { defineStore } from 'pinia'
import { createSessionLiveState } from '@taiji/core'

export const useSessionLiveStateStore = defineStore('session-live-state', () => createSessionLiveState())
