/**
 * SettingsTransport seam 测试缺省注入（[C3] 页面级行为测试不因内部改道失效）。
 *
 * settings 页 / settings composables 只经 SettingsTransport seam 访问 transport
 * （getSettingsTransport 注入前 fail-fast 抛错）。大量组件树测试（Composer / chat store /
 * landing 等）挂载链会碰 useGlobalSkills / useProjectSkills / usePiPresets，但其断言
 * 与 transport 行为无关——本 setup 每用例注入中性桩（@taiji/core/testing 共享工厂），
 * 让挂载不因缺注入而炸。
 *
 * 对 transport 行为有断言的测试在自己的 beforeEach 再 provideSettingsTransport
 * （setup 的 beforeEach 先于测试文件注册执行，测试文件后注册者覆盖本缺省桩）；
 * 生产装配序的 fail-fast 语义由 core 端测试检查（settings-lifecycle「transport 未注入
 * fail-fast」用例），不在此放松。
 */
import { beforeEach } from 'vitest'
// 深路径导入（不拉 @taiji/core 顶层 barrel）：本 setup 每个测试文件都要重新执行，
// barrel 的 ~117 个模块闭包会按文件重复装载。`@taiji/core/domain/settings` 是
// package.json exports 已声明的最窄入口（transport seam 所在域的 barrel），
// `@taiji/core/testing` 只含两个桩工厂模块；两者都与 core 顶层 barrel 的
// `export *` 命中同一模块 id，注入的仍是同一个模块级单例槽。
import { provideSettingsTransport } from '@taiji/core/domain/settings'
import { makeSettingsTransportStub } from '@taiji/core/testing'

beforeEach(() => {
  provideSettingsTransport(makeSettingsTransportStub())
})
