/**
 * Session store —— session 列表（薄壳，ADR-0059）。
 *
 * core createSessionStore factory 的 pinia 注册壳：core 拥有全部状态/业务逻辑（headless），
 * renderer 经 defineStore 注册到 pinia 供消费方使用。store 访问范式见 ADR-0059
 * （createUseXxx 经方法访问 + renderer cast 接缝）。
 *
 * 注：session 的派生 5 态（D6 derivedStatus）不在此 store，由 useSessionDerivations 派生
 * （它需同时读 chat store 的消息分区 + 全局 isStreaming，跨 store 协调属 composable 职责）。
 */
import { defineStore } from 'pinia'
import { createSessionStore } from '@taiji/core'

export const useSessionStore = defineStore('session', () => createSessionStore())
