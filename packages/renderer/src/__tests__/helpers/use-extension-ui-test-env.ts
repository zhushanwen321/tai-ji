/**
 * useExtensionUI 测试族（composables/useExtensionUI.test.ts / composables/
 * useExtensionUI-form-normalize.test.ts / composables/use-extension-ui-plan-review.test.ts /
 * components/plan-review-bar.test.ts / components/plan-mode-bar.test.ts）的同构装配段单源：
 * extension domain mock 工厂体 + getExtensionBus 替身 + 每用例重置 + effectScope 运行器 +
 * bus 发帧入口 + 异步冲刷 + Portal wrapper 收尾。
 *
 * vi.mock 注册本身必须留在各测试文件顶层（vitest hoist 语义——注册跨文件不传递），
 * 工厂体经 factory 内动态 import 回本模块（官方推荐形态，规避 hoist 引用限制）：
 *   vi.mock('@taiji/core/transport/api/domains/extension', async () => {
 *     const { extensionDomainMocks } = await import('../helpers/use-extension-ui-test-env')
 *     return extensionDomainMocks
 *   })
 *
 * 依赖边界：本模块禁止静态 import 被测模块（@/composables/useExtensionUI 等）——它们的
 * 模块图含被 mock 的 useExtensionHostBridge，factory 执行时动态 import 本模块会经
 * 「factory → 本模块 → 被测模块 → mock factory」链形成 ESM 循环 await（实测挂死）。
 * 被测物的引用一律由测试文件经参数传入。
 */
import { nextTick } from 'vue'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { InternalEventBus } from '@taiji/core'
import { vi } from 'vitest'
import type { VueWrapper } from '@vue/test-utils'

/** extension api domain 的 mock 模块体（vi.mock factory 返回值）：
 *  - sendExtensionUIResponse 返 true = 送达（M1 环 3 后 respond 消费 boolean）
 *  - onExtensions 占位导出：[B9 agentcall LRU 联动] stores/chat 装配链把 settings.ts 的
 *    re-export 带进本测试模块图，vitest 对 re-export 绑定按具名导入校验（本套件不消费） */
export const extensionDomainMocks = {
  sendExtensionUIResponse: vi.fn((): boolean => true),
  onNotify: () => () => {},
  onExtensions: vi.fn(),
  getPendingRequests: vi.fn().mockResolvedValue([]),
}

/** getExtensionBus 替身读的 bus 槽（每用例换新实例；ESM 缓存保证测试文件与 mock factory
 *  拿到同一模块实例） */
export const busSlot: { current: InternalEventBus | null } = { current: null }

/** getExtensionBus 替身模块体（vi.mock factory 内组装：importOriginal 展开保留其余导出，
 *  真实 InternalEventBus 实例验证 emit/on 真实语义） */
export async function bridgeModuleMocks(
  importOriginal: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const original = await importOriginal()
  return { ...original, getExtensionBus: () => busSlot.current }
}

/** 每用例重置（beforeEach 单点）：refCount 订阅残留 + 新 pinia + 新 bus + RPC mock 复位。
 *  resetSubscription 由调用方传被测模块的 __testing.__resetExtensionBusSubscriptionForTesting
 *  （依赖边界见文件头）。 */
export function resetUseExtensionUITestEnv(resetSubscription: () => void): void {
  resetSubscription()
  setActivePinia(createPinia())
  busSlot.current = new InternalEventBus()
  vi.mocked(extensionDomainMocks.sendExtensionUIResponse).mockClear()
  vi.mocked(extensionDomainMocks.getPendingRequests).mockResolvedValue([])
}

/** 在独立 effectScope 内运行（useExtensionUI 注册 watch/onScopeDispose 的生命周期要求） */
export function runInExtensionUIScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, dispose: () => scope.stop() }
}

/** 触发某 session 的 bus ui-request 事件（真实 bus emit） */
export function emitBusUIRequest(sid: string, request: unknown): void {
  busSlot.current?.emit({ kind: 'ui-request', sessionId: sid, request } as never)
}

/** 挂起 planReview 审批请求（runtime event-adapter 检测 PLAN_REVIEW_MARKER 后的广播
 *  形状，D5）；可带 selfReview（D9③，帧字段与 PlanReviewRequest.selfReview 同名同义） */
export function emitPlanReviewRequest(
  bus: InternalEventBus,
  sessionId: string,
  requestId = 'pr-1',
  selfReview?: string,
): void {
  bus.emit({
    kind: 'ui-request',
    sessionId,
    request: {
      requestId,
      pluginId: '',
      kind: 'select',
      dialogKind: 'select',
      title: '\x00TAIJI_PLAN_REVIEW:',
      options: [JSON.stringify({ docs: [], ...(selfReview !== undefined ? { selfReview } : {}) })],
      planReview: true,
      ...(selfReview !== undefined ? { selfReview } : {}),
    },
  } as never)
}

/** 异步冲刷（两轮微任务 + 一轮宏任务派生；组件首拉 RPC/快照对账 settle 的最短等待） */
export async function flushAsync(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

/** Portal 挂载注册表的用例末尾统一回收（fake timers 复位 + 逆序 unmount；
 *  reka Popover Portal 内容挂 document.body，须显式 unmount 防 jsdom 泄漏） */
export function unmountPortalWrappers(wrappers: VueWrapper[]): void {
  vi.useRealTimers()
  while (wrappers.length > 0) {
    wrappers.pop()?.unmount()
  }
}
