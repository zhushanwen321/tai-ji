/**
 * custom-registry —— GUI custom 组件注册表的 provide/inject 机制（IF2/DM2）。
 *
 * 从 renderer gui-registry.ts 迁移（与现 renderer 同 Symbol 值，ui 集成 slice 零改动接入）。
 * 职责边界：core 只定义 key 常量 + 类型 + 空表常量 + 查询辅助；
 * provide/inject 的实际调用留在 ui 层（builtin 编译期 provide 是 ui 职责，core 不调 provide）。
 *
 * AC3「注册表 builtin-only 机制生效」三重落地：
 * 1. 类型层：Readonly<Record<string, Component>>（external 编译期不可 mutate）
 * 2. 无注册 API 导出：只有查询辅助，没有 add/register 入口
 * 3. 空表 freeze：EMPTY_CUSTOM_REGISTRY = Object.freeze({})（运行时也不可 mutate）
 */
import type { Component, InjectionKey } from 'vue'

/**
 * custom 组件注册表的 provide/inject key（与现 renderer gui-registry.ts 同 Symbol 值）。
 * 类型 Readonly 表达「external 运行时不可 mutate」。
 */
export const GUI_CUSTOM_REGISTRY_KEY: InjectionKey<Readonly<Record<string, Component>>> = Symbol('gui-custom-registry')

/**
 * 空表常量：builtin 未 provide 任何 custom 时的缺省值（ui 层 inject 缺省注入）。
 * freeze 落地「运行时不可 mutate」第二重防护。
 */
export const EMPTY_CUSTOM_REGISTRY: Readonly<Record<string, Component>> = Object.freeze({})

/**
 * 查询辅助：判断 custom 组件名是否已注册。
 *
 * @param registry 注册表（undefined = 未 provide，空表语义）
 * @param name custom 组件名（props.component）
 * @returns undefined → false；name in registry → true；否则 false
 */
export function isCustomRegistered(registry: Readonly<Record<string, Component>> | undefined, name: string): boolean {
  if (registry === undefined) return false
  return name in registry
}
