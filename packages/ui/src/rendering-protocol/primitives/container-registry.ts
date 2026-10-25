import type { Component } from 'vue'
import type { GuiComponentType } from '@zhushanwen/extension-protocol'

/** 容器原语类型键（card/columns/group）——这 3 类原语递归渲染子组件，是环的来源 */
export type PrimitiveContainerType = Extract<GuiComponentType, 'card' | 'columns' | 'group'>

// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构）：容器原语查表——PrimitiveRouter ↔
// Card/Columns/Group 静态循环依赖的断环注册表，barrel 加载时一次性注册（§4 ⑧ 2026-10-04 批登记）
const containers = new Map<PrimitiveContainerType, Component>()

/**
 * 容器原语注册表 —— 断 PrimitiveRouter ↔ Card/Columns/Group 静态循环依赖（R2 S-1）。
 *
 * 环的成因：Card/Columns/Group 静态 import PrimitiveRouter 作 inject 回退（该方向必须
 * 保持同步——独立挂载时叶子子组件需同步渲染）；Router 若再静态 import 这 3 个容器、
 * 或经动态 import() 引用（依赖分析同样计边），即封住 3 组二文件环。故 Router 对容器
 * 只持本注册表查表函数，容器组件由 primitives barrel（index.ts，消费方规范入口）加载
 * 时注册。barrel 不被 Router/容器反向引用，静态依赖图无环。
 *
 * 边界：绕过 barrel 直接 import 单个容器 .vue 且子组件嵌套容器的独立使用场景，注册表
 * 未填充，Router 按降级 SSOT 回退 AnsiText（与 core resolveComponent「未知/缺位可见
 * 降级，不静默空白」哲学一致）。renderer 场景 GuiComponentRenderer import barrel
 * （注册表必然填充）并 provide 自身，容器子组件不经 Router 回退，行为不变。
 */
export function registerPrimitiveContainers(
  reg: Record<PrimitiveContainerType, Component>,
): void {
  for (const key of Object.keys(reg) as PrimitiveContainerType[]) {
    containers.set(key, reg[key])
  }
}

export function getPrimitiveContainer(type: PrimitiveContainerType): Component | undefined {
  return containers.get(type)
}

/**
 * 清空注册表，恢复模块初始空态（测试专用导出，运行时不消费）。
 *
 * 消费方：PrimitiveRouter.test.ts 的 beforeEach——「barrel 未加载回退」与「barrel 加载命中」
 * 两类用例共享本模块的模块级 Map，注册一经发生（动态 import barrel）不可逆；每用例前清空
 * 使各自前置状态自建，消除对文件内用例顺序的依赖（--sequence.shuffle 下双绿）。
 *
 * 清空 = 恢复初始空态（模块加载时 `new Map()` 的状态），不是部分删除的半清态；清空后
 * Router 回退 AnsiText 降级，与「绕过 barrel 独立使用」的生产形态一致。
 */
export function resetPrimitiveContainers(): void {
  containers.clear()
}
