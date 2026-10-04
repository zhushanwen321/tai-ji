import type { RightDrawerTab } from '@taiji/core/domain/drawer'
import { RIGHT_DRAWER_REGISTRY } from '@taiji/core/domain/drawer'

/**
 * 右抽屉 L1 tab 清单（display-containers §7.2 容器声明的运行时投影，终态 8 条——
 * terminal 在底抽屉、browser 在浮层）。DrawerPanel L1 图标条的用户可见投影；
 * 元素类型 = @taiji/core domain RightDrawerTab（右抽屉 tab 唯一类型，[U7] 收窄终态）。
 * 消费方：panel-container-drawer-mode.test.ts（tab 注册表契约用例，全量断言唯一收敛点）、
 * session-trace/trace-inspector.test.ts（「L1 体系不变」断言）。
 */
export const L1_DRAWER_TABS: readonly RightDrawerTab[] = RIGHT_DRAWER_REGISTRY.map(
  (entry) => entry.content,
)
