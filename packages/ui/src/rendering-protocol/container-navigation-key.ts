/**
 * 容器导航执行器注入 key —— rendering-protocol 交互原语（action-bar / list-tree）与
 * 宿主壳层的注入契约（容器扩展点统一 §6.4 导航原语）。
 *
 * hostAction 的执行端（校验 + 容器状态写入）在 core ContainerNavigationExecutor，由壳层
 * （useExtensionHostBridge）装配并经本 key provide；原语组件只认 key 不认实现（对齐
 * ACTION_EXECUTOR_KEY 既有范式；key symbol 必须跨包同一实例，故经 barrel 导出给消费方）。
 * 本文件不 import core 类型，避免 ui→core 反向依赖（同 action-executor-key.ts 裁决）。
 *
 * VIEW_SCOPE_SESSION_KEY 是会话注入的第一档来源：视图宿主（ViewHost）按自身 scope provide
 * 组件树所属会话，原语 inject 后随导航请求透传；无视图上下文的挂载位（对话流内嵌树、
 * 托盘 widget）不 provide，inject 缺省 undefined → 执行器回退焦点会话（§6.4 优先级第二档）。
 */
import type { InjectionKey } from 'vue'
import type { HostContainerAction } from '@zhushanwen/extension-protocol'
import type { ActionExecutor, ActionArgs } from './action-executor-key'

/** 一次容器导航的视图会话选项（宿主注入优先级第一档；与 core NavigateOptions 结构同构）。 */
export interface NavigateOptions { // oe-exempt:20261025:framework:导航选项数据契约（与 core 结构同构，非抽象接口单实现）
  viewSessionId?: string
}

/**
 * 最小结构接口：壳层容器导航执行器的兼容范围（core ContainerNavigationExecutor 两参签名
 * 结构同构——壳层可直接 provide core 实例，零适配层）。
 */
export interface ContainerNavigationExecutor { // oe-exempt:20261025:framework:注入 key 的最小结构契约（壳层装配 core 单实现）
  navigate(action: HostContainerAction, options?: NavigateOptions): void
}

export const CONTAINER_NAVIGATION_KEY: InjectionKey<ContainerNavigationExecutor> = Symbol('container-navigation')

/** 视图 scope sessionId（ViewHost 按 scope provide；global scope 或无宿主时缺省 undefined）。 */
export const VIEW_SCOPE_SESSION_KEY: InjectionKey<string | undefined> = Symbol('view-scope-session')

/**
 * 树内交互分派单点：commandId 与 hostAction 并存时 commandId 优先走既有命令链
 * （extension-protocol action-bar 契约注释的同款裁决，action-bar 与 list-tree 两原语
 * 必须一致——分派优先级漂移会让同名声明在按钮与列表行行为不同）。commandId 缺省时
 * hostAction 走容器导航执行器。执行器缺位静默返回（禁用态由各组件的渲染侧 guard 承担，
 * 本函数只做分派不做降级出声）。
 */
export function dispatchTreeInteraction(input: {
  commandId?: string
  args?: ActionArgs
  hostAction?: HostContainerAction
  commandExecutor?: ActionExecutor
  navigationExecutor?: ContainerNavigationExecutor
  viewSessionId?: string
}): void {
  const commandId = input.commandId
  if (typeof commandId === 'string' && commandId !== '') {
    input.commandExecutor?.execute(commandId, input.args)
    return
  }
  if (input.hostAction !== undefined) {
    input.navigationExecutor?.navigate(input.hostAction, { viewSessionId: input.viewSessionId })
  }
}
