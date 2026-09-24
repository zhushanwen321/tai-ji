/**
 * SettingsTransport 测试桩工厂（renderer 侧短转发，[C3]）。
 *
 * 唯一实现 = packages/core/src/testing/settings-transport-stub.ts（经 @taiji/core/testing
 * 导出，core/renderer/ui 测试共用双）；本文件保留 renderer 测试既有 import 路径
 * （../helpers/settings-transport-stub / @/__tests__/helpers/...）。
 */
export {
  makeSettingsTransportStub,
  type SettingsTransportStubOverrides,
} from '@taiji/core/testing'
