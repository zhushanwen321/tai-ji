/**
 * '@taiji/core/transport/ws-client' 的 getState 受控 mock（use-background-tasks /
 * mode-declaration-row 等测试文件的 ws 连接态前置段单源）。
 *
 * 消费形态（vi.mock 注册留在测试文件，工厂经顶层 import 转发本 helper 导出）：
 *   const wsMock = vi.hoisted(() => ({ ref: null as null | { value: string } }))
 *   vi.mock('@taiji/core/transport/ws-client', () => wsClientStateModule(wsMock, 'connected'))
 *
 * 语义约束（不可丢）：
 * - spread actual 保其余导出真实（ws 连接重建等旁路面不因 mock 断链）；
 * - getState 必须返回真实 Vue ref（消费方对它 watch，裸 { value } 对象不触发回调）；
 * - 初始值 initial 由调用方按用例语义选定（'connected' / 'disconnected'），测试经
 *   wsMock.ref.value 驱动断连/重连边沿。
 *
 * 本 helper 禁止顶层 import 被 mock 的路径（vi.mock 工厂会因该 import 提前触发，TDZ）
 * ——actual 的获取收进 async 工厂内（vi.importActual，同 update-card-mock.ts 先例）。
 *
 * vitest 按测试文件隔离模块图：每个测试文件经 vi.mock 工厂各自取一份新 ref。
 */
import { ref } from 'vue'
import { vi } from 'vitest'

/** ws 连接态受控 mock 工厂（getState → 受控 ref，ref 落 wsMock 供测试侧驱动）。 */
export async function wsClientStateModule(
  wsMock: { ref: { value: string } | null },
  initial: string,
) {
  const actual = await vi.importActual<typeof import('@taiji/core/transport/ws-client')>(
    '@taiji/core/transport/ws-client',
  )
  const stateRef = ref(initial)
  wsMock.ref = stateRef
  return { ...actual, getState: () => stateRef }
}
