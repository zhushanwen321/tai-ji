/**
 * fake transport 工厂（[C3] seam 方法面全覆盖共享工厂）。
 *
 * 唯一实现 = packages/core/src/testing/settings-transport-stub.ts（core/renderer/ui 测试
 * 共用双，经 @taiji/core/testing 导出）；本文件是包内 __tests__ 的短转发（保留历史调用名
 * makeFakeTransport，避免 5 个测试文件改 import）。
 */
export {
  makeSettingsTransportStub as makeFakeTransport,
  type SettingsTransportStubOverrides,
} from '../../../../testing/settings-transport-stub'
