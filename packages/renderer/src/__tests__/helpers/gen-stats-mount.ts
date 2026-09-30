/**
 * GenStats 面板测试共享骨架（composer-metrics-aggregate / gen-stats-triggers 两文件
 * 逐字重复段单源；gen-stats-composable 复用 genStatsFrame 帧工厂；范式同 composer-mount.ts）。
 *
 * 收敛内容：HoverCard 家族 stub（观察者形态常开）+ stats 帧工厂 + 帧派发 + GenStats
 * 面板 mount 编排（sessionId/modelId props + stubHover 开关）。
 *
 * vi.mock 注册留在测试文件（hoisting 约束）；本 helper 顶层 import 的
 * '@taiji/core/transport/api' 在测试文件模块图内命中其 spread-actual mock，
 * dispatchSession 仍是真实 events 通道（帧链路不断）。
 *
 * vitest 按测试文件隔离模块图：本 helper 导出在每个测试文件内是独立实例。
 */
import { mount } from '@vue/test-utils'
import type { Component } from 'vue'
import * as events from '@taiji/core/transport/api'
import type { GenStatsFrame, ServerMessage } from '@taiji/shared'

/** HoverCard 家族 stub：内容常开渲染（观察者形态——浮层/聚合页内容行可 DOM 断言）。模块私有：仅 mountGenStatsPanel 内部消费 */
const hoverCardStubs = {
  HoverCard: { name: 'HoverCard', template: '<div><slot /></div>' },
  HoverCardTrigger: { name: 'HoverCardTrigger', template: '<div><slot /></div>' },
  HoverCardContent: { name: 'HoverCardContent', template: '<div><slot /></div>' },
}

/** 帧工厂：合法全量帧为基线（ttft current=820 →「820ms」；ttft 为 GenStatsFrame 必填字段，
 *  缺省即类型漂移——typecheck:test 白名单收口后由编译期拦截），用例按需覆写 */
export function genStatsFrame(sessionId: string, overrides: Partial<GenStatsFrame> = {}): GenStatsFrame {
  return {
    sessionId,
    speed: { current: 35, day: 28, d7: 22, d30: 19 },
    cacheRatio: { current: 91, day: 87 },
    ttft: { current: 820, day: 900, d7: 1100, d30: 1300 },
    model: 'prov-a/m1',
    ...overrides,
  }
}

/** 真实 events.dispatchSession 通道派发 session.stats_update 帧（构建者白盒数据注入） */
export function pushSessionMsg(sid: string, msg: ServerMessage): void {
  events.dispatchSession(sid, msg)
}

/** GenStats 面板 mount 编排：固定 sessionId/modelId props；stubHover 切 HoverCard 家族
 *  常开 stub（观察者形态），缺省走真实 HoverCard 渲染路径（使用者黑盒） */
export function mountGenStatsPanel(component: Component, stubHover = false) {
  return mount(component, {
    props: { sessionId: 's1', modelId: 'prov-a/m1' },
    global: stubHover ? { stubs: hoverCardStubs } : {},
  })
}
