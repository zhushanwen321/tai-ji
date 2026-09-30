/**
 * transport command RPC 共享 mock 单源（plan 域 / gen-stats 域测试文件同构面）。
 *
 * 消费形态（vi.mock 注册留在测试文件，工厂经顶层 import 转发本 helper 导出）：
 *   vi.mock('@taiji/core/transport/api', () => transportApiCommandModule())
 *
 * 语义约束（不可丢，丢了帧链路断）：
 * - spread actual 保真实 events 通道：useSessionEvents / usePlanState 经主模块
 *   events.on 订阅，测试侧 dispatchSession 与实现侧订阅须经同一真实 events 模块实例
 *   （注册表共享），只换 command 单入口与超时常量；
 * - RPC_BACKSTOP_TIMEOUT_MS 固定 30_000：与真实导出同值，消费方按需断言不受 mock 干扰。
 *
 * 本 helper 禁止顶层 import 被 mock 的路径（'@taiji/core/transport/api'）：vi.mock 工厂
 * 在测试文件的 helper import 绑定初始化前就会因该 import 被触发（TDZ），故 actual 的
 * 获取收进 async 工厂内（vi.importActual，同 update-card-mock.ts 先例）。
 *
 * vitest 按测试文件隔离模块图：commandMock 在每个测试文件内是独立实例。
 */
import { vi } from 'vitest'

/** transport command RPC 单例（每测试文件独立；beforeEach mockReset 后按用例编排返回值） */
export const commandMock = vi.fn()

/** '@taiji/core/transport/api' mock 工厂（spread actual 只换 command 与超时常量） */
export async function transportApiCommandModule() {
  const actual = await vi.importActual<typeof import('@taiji/core/transport/api')>('@taiji/core/transport/api')
  return { ...actual, command: commandMock, RPC_BACKSTOP_TIMEOUT_MS: 30_000 }
}
