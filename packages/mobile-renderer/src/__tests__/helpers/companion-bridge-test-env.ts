/**
 * companion-bridge 系三 spec（mobile-form.spec.ts / runtime-unavailable-form-reset.test.ts
 * / companion-exited-reset.spec.ts）的同构装配段单源：extension domain mock 工厂体 +
 * App 挂载 + 聊天视图进入 + form 帧注入 + 每用例重置/收尾。
 *
 * vi.mock 注册本身必须留在各 spec 顶层（vitest hoist 语义），工厂体经 factory 内动态
 * import 回本模块（官方推荐形态）：
 *   vi.mock('@taiji/core/transport/api/domains/extension', async () => {
 *     const { extensionDomainMocks } = await import('./helpers/companion-bridge-test-env')
 *     return extensionDomainMocks
 *   })
 *
 * 依赖边界：本模块顶层禁止静态 import 项目模块（App / companion-bridge / app-runtime /
 * connection-view）——它们的模块图含被 mock 的 extension domain，factory 执行时动态
 * import 本模块会经「factory → 本模块 → 项目模块 → extension domain → factory」链形成
 * ESM 循环求值。项目模块一律在函数体内动态 import（用例期所有 mock 注册已完成）。
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { vi } from 'vitest'
import type { InternalEventBus } from '@taiji/core'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'

/** extension api domain mock 模块体（三 spec 的 vi.mock factory 单源返回）：
 *  sendExtensionUIResponse 返 true = 送达（M1 环 3 后 respond 消费 boolean）。
 *  显式契约签名（而非裸 vi.fn() 实现推断）：spec 用例断言 mock.calls 索引位与
 *  mockResolvedValueOnce 注入快照条目，宽泛推断会把 resolved 值窄化成 never。 */
export const extensionDomainMocks = {
  sendExtensionUIResponse: vi.fn<(sessionId: string, requestId: string, kind: string, result: unknown) => boolean>(
    () => true,
  ),
  getPendingRequests: vi.fn<(sessionId: string) => Promise<ExtensionUIRequest[]>>(async () => []),
}

/** 挂真实 App（i18n 插件；动态 import 见文件头依赖边界） */
export async function mountCompanionApp(): Promise<VueWrapper> {
  const [{ default: App }, { i18n }] = await Promise.all([
    import('../../App.vue'),
    import('../../i18n'),
  ])
  return mount(App, { global: { plugins: [i18n] } })
}

/** 进入聊天页（v2 五态路由形态：connected 边沿驱动 sessions → 编程转移 chat），三 spec 同款。
 *  挂载后清 getPendingRequests 调用记录（初始订阅对账的 RPC 噪音不进用例断言）。
 *  v2 起聊天是详情页（remote-use-mobile-v2 §6.7）：无 chat tab 可点，经 navigateRoute 进
 *  （resetRouteForTesting 清单例路由态 + connected 边沿 → sessions → chat，与生产时序同形）。 */
export async function mountChatView(sessionId: string): Promise<VueWrapper> {
  const [{ hasConnectedOnce, shellConnectionState }, { sessionStore }, { navigateRoute, resetRouteForTesting }] =
    await Promise.all([
      import('../../shell/connection-view'),
      import('../../shell/app-runtime'),
      import('../../shell/route'),
    ])
  const { nextTick } = await import('vue')
  hasConnectedOnce.value = true
  shellConnectionState.value = 'connected'
  sessionStore.setActiveId(sessionId)
  resetRouteForTesting()
  const wrapper = await mountCompanionApp()
  await nextTick()
  navigateRoute('chat')
  await nextTick()
  // 挂载期 flush 全部微任务：mount 触发的初始 reconcile（useMobileFormRequests immediate +
  // connected 边沿 immediate）的空快照 promise 链在此消化完——用例体 emit 的请求不再被
  // 挂载期对账的迟到回调差集剔除（否则 emit 后空快照清分区 = 用例间脆弱时序）。
  await flushPromises()
  extensionDomainMocks.getPendingRequests.mockClear()
  return wrapper
}

/** 发一条 bus 归一后的富交互 form 类 ui-request（C4 放行面：form 帧；requestId 默认
 *  req-1，bus 由调用方传 __testing.mobileExtensionBus——生产订阅面 = form 通道订阅） */
export function emitFormRequest(
  bus: InternalEventBus,
  request: Record<string, unknown>,
  sessionId: string,
): void {
  bus.emit({
    kind: 'ui-request',
    sessionId,
    request: { requestId: 'req-1', pluginId: '', kind: 'select', ...request },
  })
}

/** 单选 form 帧载荷（db 题 pg/mysql 双选项；三 spec 的共用题干） */
export function singleChoiceRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    form: true,
    formQuestions: [
      { type: 'choice', header: 'db', question: '用哪个数据库？', options: [{ label: 'pg' }, { label: 'mysql' }] },
    ],
    ...overrides,
  }
}

/** 每用例前置重置（三 spec 同款全集）：RPC mock 复位 + form/errorBar/dialogQueue 三模块级
 *  单例清空 + Sheet 槽位归零 + 连接态回 connecting + 无活跃 session。对不消费某单例的
 *  spec 幂等无害。Sheet 槽位必须复位：sheet-manager activeSheet 是模块级单例，前序用例
 *  开槽未关（如 dialog 节用例无作答收尾）会污染后续用例的「请求到达自动开槽」时序。 */
export async function resetCompanionTestState(): Promise<void> {
  extensionDomainMocks.sendExtensionUIResponse.mockReset().mockReturnValue(true)
  extensionDomainMocks.getPendingRequests.mockReset().mockResolvedValue([])
  const { __testing } = await import('../../shell/companion-bridge')
  const { hasConnectedOnce, shellConnectionState } = await import('../../shell/connection-view')
  const { sessionStore } = await import('../../shell/app-runtime')
  const { resetSheetManagerForTesting } = await import('../../shell/sheet-manager')
  __testing.resetFormRequestsForTest()
  __testing.resetErrorBarForTest()
  __testing.resetFormSubmitSuspensionForTest()
  resetSheetManagerForTesting()
  shellConnectionState.value = 'connecting'
  hasConnectedOnce.value = false
  sessionStore.setActiveId(null)
}

/** 每用例收尾：unmount + 在途微任务消化 + 全量重置 + mock 恢复（幂等）。
 *  flushPromises 在 mockReset 之前：用例内在途 promise 链（reconcile 补挂等）先消化——
 *  未消费的 mockResolvedValueOnce 队列值 / 迟到 then 链跨用例泄漏的窗口在此收口。 */
export async function cleanupCompanionTestState(wrapper: VueWrapper | null): Promise<void> {
  wrapper?.unmount()
  await flushPromises()
  await resetCompanionTestState()
  vi.restoreAllMocks()
}
