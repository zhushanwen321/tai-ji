import type { IllegalTransitionInfo } from './types'

/**
 * 表外转移默认错误（errorPolicy: 'throw' 且未声明 errorFactory 时抛出）。
 *
 * 消息形态对齐 run 域既有语义：当前态 + 事件 + detail（合法事件清单由内核
 * 组装进 detail）。迁移域保形既有错误类型走 errorFactory（构造既有类实例，
 * instanceof 分类分支仍命中，D4）。
 */
export class IllegalTransitionError extends Error {
  readonly machine: string
  readonly from: string
  readonly on: string
  constructor(info: IllegalTransitionInfo) {
    super(`非法状态转移[${info.machine}]：state=${info.from} 不接受事件 ${info.on}。${info.detail}`)
    this.name = 'IllegalTransitionError'
    this.machine = info.machine
    this.from = info.from
    this.on = info.on
  }
}
