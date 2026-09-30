/**
 * SettingsTransport 测试桩工厂（renderer 侧短转发，[C3]）。
 *
 * 唯一实现 = packages/core/src/testing/settings-transport-stub.ts（经 @taiji/core/testing
 * 导出，core/renderer/ui 测试共用双）；本文件保留 renderer 测试既有 import 路径
 * （../helpers/settings-transport-stub / @/__tests__/helpers/...）。
 *
 * 另供 makeSkillsReloadTransportStub：skill reload 链路（useGlobalSkills 订阅 →
 * loadGlobal(true) force 重拉）的 transport 桩——onSkillCacheInvalidated 桥到真实
 * events.onGlobalType，测试侧 events.dispatchGlobal 广播端到端触达订阅回调。
 * events 模块在工厂内动态 import：消费者若 vi.mock 了该路径，helper 顶层 import 会在
 * 测试文件的 helper import 绑定初始化前触发 mock 工厂（TDZ），动态 import 规避
 * （同 session-context-mock.ts 先例）。
 */
import { makeSettingsTransportStub, type SettingsTransportStubOverrides } from '@taiji/core/testing'

export { makeSettingsTransportStub, type SettingsTransportStubOverrides } from '@taiji/core/testing'

/** config.skillCacheInvalidated 广播载荷（scope=global 时无 cwd） */
type SkillCacheInvalidatedPayload = { scope: 'global' | 'project'; cwd?: string }

/**
 * onSkillCacheInvalidated → 真实 events 广播桥：handler 订阅挂到 events.onGlobalType，
 * 测试侧 events.dispatchGlobal 广播端到端触达 useGlobalSkills 订阅回调。realEvents 由
 * 调用方动态 import 后传入（TDZ 规避见文件头）。
 */
export function skillCacheInvalidatedBridge(realEvents: typeof import('@taiji/core/transport/api')) {
  return (handler: (p: SkillCacheInvalidatedPayload) => void) =>
    realEvents.onGlobalType('config.skillCacheInvalidated', (msg) => {
      handler(msg.payload as SkillCacheInvalidatedPayload)
    })
}

/**
 * skill reload 链路 transport 桩：getGlobalSkills 受控 mock（调用方传入，通常为
 * vi.hoisted 的 vi.fn）+ onSkillCacheInvalidated 桥真实 events 广播。异步工厂，
 * 调用形态：provideSettingsTransport(await makeSkillsReloadTransportStub(mock))
 */
export async function makeSkillsReloadTransportStub(
  getGlobalSkills: NonNullable<SettingsTransportStubOverrides['getGlobalSkills']>,
) {
  const realEvents = await import('@taiji/core/transport/api')
  return makeSettingsTransportStub({
    getGlobalSkills,
    onSkillCacheInvalidated: skillCacheInvalidatedBridge(realEvents),
  })
}
