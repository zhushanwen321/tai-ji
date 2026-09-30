/**
 * ws 连接态受控 ref mock 单源（use-pi-presets / use-background-tasks / mode-declaration-row
 * 等文件同构段；原 ws-client-state-mock.ts 薄壳已并入本文件——消费方直接传 mock 目标路径）。
 *
 * mock 目标模块的 getState 重定向到受控 stateRef（initial 缺省 'disconnected'，测试经
 * holder.ref.value 摆置 connected / disconnected 边沿）；actual spread 保真实导出
 * （getSettingsTransport 等单例不被 shadow）。mock 目标模块因消费方而异
 * （@taiji/core 顶层 barrel vs @taiji/core/transport/ws-client 子路径），经 path 参数化。
 *
 * 消费形态（vi.mock 注册留在测试文件；holder 必须 vi.hoisted 创建——工厂执行早于
 * 模块体求值，引用普通 const 会 TDZ）：
 *   const wsMock = vi.hoisted(() => ({ ref: null as null | { value: string } }))
 *   vi.mock('@taiji/core', () => wsStateModuleWithControlledRef('@taiji/core', wsMock))
 *
 * 语义约束（不可丢）：
 * - getState 必须返回真实 Vue ref（消费方对它 watch，裸 { value } 对象不触发回调）；
 * - spread actual 保其余导出真实（ws 连接重建等旁路面不因 mock 断链）。
 *
 * 本 helper 禁止顶层 import 被 mock 的路径（vi.mock 工厂会因该 import 提前触发，TDZ）
 * ——actual 的获取收进 async 工厂内（vi.importActual，同 transport-command-mock.ts 先例）。
 * vue 的 ref 不在被 mock 面内，顶层 import 无 TDZ 风险。
 */
import { ref } from 'vue'
import { vi } from 'vitest'

/** ws 连接态受控 ref 的 mock 工厂（spread actual 只重写 getState → 受控 stateRef）。 */
export async function wsStateModuleWithControlledRef(
  path: string,
  holder: { ref: null | { value: string } },
  initial = 'disconnected',
) {
  const actual = await vi.importActual<Record<string, unknown>>(path)
  const stateRef = ref<string>(initial)
  holder.ref = stateRef
  return { ...actual, getState: () => stateRef }
}
