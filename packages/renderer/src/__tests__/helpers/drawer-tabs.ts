import type { SideDrawerTab } from '@taiji/core/domain/drawer'
import { RIGHT_DRAWER_REGISTRY } from '@taiji/core/domain/drawer'

/**
 * drawer 一级 tab 全量清单（@taiji/core domain SideDrawerTab 联合类型的运行时投影）。
 *
 * satisfies Record<SideDrawerTab, 1> 双向防漂移：生产联合加员未同步此表 → 缺键编译报错；
 * 写错 tab 名 → 多余键编译报错。
 *
 * 消费方：panel-container-drawer-mode.test.ts（tab 注册表契约用例，全量断言唯一收敛点）、
 * session-trace/trace-inspector.test.ts（「SideDrawerTab 体系不变」断言）。
 */
export const ALL_DRAWER_TABS = Object.keys({
  terminal: 1,
  browser: 1,
  git: 1,
  doc: 1,
  detail: 1,
  subagent: 1,
  workflow: 1,
  bashTask: 1,
  plan: 1,
  btw: 1,
} satisfies Record<SideDrawerTab, 1>) as SideDrawerTab[]

/**
 * 右抽屉 L1 tab 清单（display-containers §7.2 容器声明的运行时投影，终态 8 条——
 * terminal 已迁底抽屉、browser 已走浮层）。DrawerPanel L1 图标条的用户可见投影。
 * 消费方：panel-container-drawer-mode.test.ts（注册表契约用例）、
 * session-trace/trace-inspector.test.ts（「L1 体系不变」断言）。
 */
export const L1_DRAWER_TABS: readonly SideDrawerTab[] = RIGHT_DRAWER_REGISTRY.map(
  (entry) => entry.content,
)
