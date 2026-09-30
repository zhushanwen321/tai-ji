/**
 * session 域 getContext mock 的 '@/api' 门面重指单源（use-context-usage /
 * composer-metrics-aggregate / context-capacity-popover / context-usage-journeys 等
 * 测试文件的同构 mock 段）。
 *
 * 「domain mock + 门面重指」双 mock 形态：vitest 注入 VITE_MOCK=true 使 '@/api' 门面默认
 * 指向 mock 门面，须把门面的 session 域重指回（已被 vi.mock 的）session domain 模块，
 * 断言侧与实现侧才能共用同一 vi.fn 实例。
 *
 * 消费形态（vi.mock 注册留在测试文件；domain mock 本体只有一行，保持内联）：
 *   const getContextMock = vi.hoisted(() => vi.fn())
 *   vi.mock('@taiji/core/transport/api/domains/session', () => ({ getContext: getContextMock }))
 *   vi.mock('@/api', () => apiFacadeWithSessionDomain())
 *
 * 本 helper 禁止顶层 import 被 mock 路径（'@/api'）：vi.mock 工厂在测试文件的 helper
 * import 绑定初始化前就会因该 import 被触发（TDZ），actual 经 vi.importActual 在工厂内
 * 取（同 update-card-mock.ts 先例）。vitest 按测试文件隔离模块图。
 */
import { vi } from 'vitest'

/** '@/api' 门面 mock：spread actual 后把 session 域重指到（已被 mock 的）session domain 模块。 */
export async function apiFacadeWithSessionDomain() {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  const session = await import('@taiji/core/transport/api/domains/session')
  return { ...actual, session }
}
