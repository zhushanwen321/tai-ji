/**
 * Plan 族状态条测试共享骨架（plan-mode-bar / plan-review-bar 两文件挂载脚手架单源；
 * 范式同 preset-page-mount.ts——vi.mock 注册留在测试文件（hoisting 约束），工厂体与
 * 挂载编排经本 helper 导出转发）。
 *
 * 收敛内容：command 门面 spread-actual mock 体（RPC_BACKSTOP_TIMEOUT_MS 收窄 30s——
 * 受控 deferred 驱动下防用例真等 65s backstop）+ plan 帧工厂 + planReview 挂起请求
 * 注入 + flush 序列 + 状态条 mount 编排。
 *
 * 引用本 helper 的 vi.mock 工厂在「被 mock 模块首次被 import」时执行——测试文件的
 * helper import 必须排在首个传递引入 '@taiji/core/transport/api' 的 import（组件 /
 * store / composable import）之前，否则工厂闭包命中未初始化绑定（ReferenceError）。
 *
 * vitest 按测试文件隔离模块图：本 helper 导出在每个测试文件内是独立实例。
 */
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Component } from 'vue'
import { nextTick } from 'vue'
import type { Mock } from 'vitest'
import type { InternalEventBus } from '@taiji/core'
import type { PlanStateView } from '@taiji/shared'

/**
 * '@taiji/core/transport/api' 的 spread-actual mock 体：只换 command 门面与
 * RPC_BACKSTOP_TIMEOUT_MS，events/pending 等其余面保持真实（测试侧 dispatchSession /
 * bus 订阅与实现侧经同一真实 events 模块实例，帧链路不断）。
 * 返回类型不标注为模块类型——RPC_BACKSTOP 会被覆写成 30_000，与真实声明的字面量类型冲突。
 */
export function commandApiModule(
  actual: typeof import('@taiji/core/transport/api'),
  commandMock: Mock,
) {
  return { ...actual, command: commandMock, RPC_BACKSTOP_TIMEOUT_MS: 30_000 }
}

/** plan 帧工厂：激活态四必填字段为基线，用例按需覆写（D4：新字段 optional） */
export function planStateView(overrides: Partial<PlanStateView> = {}): PlanStateView {
  return {
    isActive: true,
    planFilePath: '/data/A/.tmp/plans/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'default',
    ...overrides,
  }
}

/** 挂起 planReview 审批请求（runtime event-adapter 广播形状，D5） */
export function emitPlanReviewRequest(
  bus: InternalEventBus,
  sid: string,
  requestId = 'pr-1',
): void {
  bus.emit({
    kind: 'ui-request',
    sessionId: sid,
    request: {
      requestId,
      pluginId: '',
      kind: 'select',
      method: 'select',
      title: '\x00TAIJI_PLAN_REVIEW:',
      options: [JSON.stringify({ docs: [] })],
      planReview: true,
    },
  } as never)
}

/** flush 序列：Vue 渲染两拍 + 微任务一拍（bus 事件 → store 写入 → computed 派发） */
export async function flushAsync(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

/**
 * plan 状态条 mount 编排：command 首拉回填（mockResolvedValue 快照）+ 固定
 * sessionId prop；attachTo 供 reka Popover Portal 用例挂 document.body（配
 * onMount 登记用例末尾统一 unmount，禁 innerHTML 强删——UpdateButton 先例）。
 */
export async function mountPlanBar(
  component: Component,
  opts: {
    commandMock: Mock
    sid: string
    view: PlanStateView | null
    attachTo?: HTMLElement
    onMount?: (wrapper: VueWrapper) => void
  },
): Promise<VueWrapper> {
  opts.commandMock.mockResolvedValue({ sessionId: opts.sid, planState: opts.view })
  const wrapper = mount(component, {
    props: { sessionId: opts.sid },
    ...(opts.attachTo ? { attachTo: opts.attachTo } : {}),
  })
  opts.onMount?.(wrapper)
  await flushAsync()
  return wrapper
}
