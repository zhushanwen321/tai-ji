/**
 * 原语统一出口（DM2 barrel）。
 *
 * 消费方（GuiComponentRenderer / renderer 消费点）只从本 barrel 导入原语，
 * 不直接 import 单个 .vue 文件。新增原语时在此追加导出。
 * PrimitiveRouter 是内部递归路由，不进 barrel（Card/Group 内部相对路径引用）。
 */
import Card from './Card.vue'
import Columns from './Columns.vue'
import Group from './Group.vue'
import { registerPrimitiveContainers } from './container-registry'

// 断 PrimitiveRouter ↔ Card/Columns/Group 互引环（R2 S-1）：容器静态 import Router 作
// inject 回退，Router 不能反向 import 容器（静态/动态都会被依赖分析计边成环），故容器
// 经本 barrel（规范入口，不被 Router/容器反向引用）加载时注册进 Router 的查表注册表。
// 详见 container-registry.ts 头注释。
registerPrimitiveContainers({ card: Card, columns: Columns, group: Group })

export { default as AnsiText } from './AnsiText.vue'
export { default as Card } from './Card.vue'
export { default as Columns } from './Columns.vue'
export { default as Group } from './Group.vue'
export { default as ListTree } from './ListTree.vue'
export { default as ProgressBar } from './ProgressBar.vue'
export { default as StatsLine } from './StatsLine.vue'
export { default as TabBar } from './TabBar.vue'
