/**
 * ws 连接态受控 ref mock 单源（use-pi-presets / mode-declaration-row 等文件同构段）。
 *
 * mock 目标模块的 getState 重定向到受控 stateRef（默认 'disconnected'，测试经
 * holder.ref.value 摆置 connected / disconnected 边沿）；actual spread 保真实导出
 * （getSettingsTransport 等单例不被 shadow）。mock 目标模块因消费方而异
 * （@taiji/core 顶层 barrel vs @taiji/core/transport/ws-client 子路径），经 path 参数化。
 *
 * 消费形态（vi.mock 注册留在测试文件；holder 必须 vi.hoisted 创建——工厂执行早于
 * 模块体求值，引用普通 const 会 TDZ）：
 *   const wsMock = vi.hoisted(() => ({ ref: null as null | { value: string } }))
 *   vi.mock('@taiji/core', () => wsStateModuleWithControlledRef('@taiji/core', wsMock))
 *
 * 本 helper 禁止顶层 import 被 mock 路径（TDZ），actual 经 vi.importActual 在工厂内取。
 */
import { vi } from 'vitest'

/** ws 连接态受控 ref 的 mock 工厂（spread actual 只重写 getState → 受控 stateRef）。 */
export async function wsStateModuleWithControlledRef(
  path: string,
  holder: { ref: null | { value: string } },
) {
  const actual = await vi.importActual<Record<string, unknown>>(path)
  const { ref } = await import('vue')
  const stateRef = ref<string>('disconnected')
  holder.ref = stateRef
  return { ...actual, getState: () => stateRef }
}
