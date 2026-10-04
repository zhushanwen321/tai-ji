/**
 * UsagePage 测试 transport seam 桩脚手架（UsagePage.test.ts 与 UsagePage.filters.test.ts
 * 共用；范式同 preset-page-mock.ts——脚手架收敛单源，消费文件顶层调用一次）。
 *
 * 为什么收进 helper：两测试文件的 getUsageStats 捕获单例声明 + [C3] seam 桩 beforeEach
 * 逐字共享十几行（越过 fallow 克隆阈值 min-tokens=50），留在测试文件内时该克隆组结构性
 * 无法消除（同 preset-page-mock 判据）。
 *
 * 使用约束：无 vi.mock 注册，无 TDZ 风险；消费文件如需叠加自己的 beforeEach
 * （fake timers / DOM 补丁）照常另写，钩子按注册顺序叠加执行。
 */
import { beforeEach, vi } from 'vitest'
import { provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from './settings-transport-stub'

/** getUsageStats 捕获单例（用例经 mockResolvedValue / mockRejectedValue 注入场景）。 */
export const mockedGetUsageStats = vi.mocked(vi.fn())

/** UsagePage 测试 beforeEach 接线：[C3] getUsageStats 经 SettingsTransport seam 桩注入
 *  （替换原 domains/usage 模块 mock）。消费文件顶层调用一次。 */
export function setupUsagePageTest(): void {
  beforeEach(() => {
    provideSettingsTransport(makeSettingsTransportStub({ getUsageStats: mockedGetUsageStats }))
  })
}
