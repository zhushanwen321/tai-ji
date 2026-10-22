/**
 * UpdatePage 测试共享挂载骨架（update-page / update-page-source 两套同 SUT 测试单源；
 * 范式同 system-page-mount.ts）。收敛两文件逐字重复的脚手架：
 *  - beforeAll 模块图预热一次（UpdatePage 全树装载成本落文件级 hook，单条用例只付 mount 成本）
 *  - beforeEach 统一重置 + 默认解析值（primeUpdatePageDefaults）
 *  - UpdatePage mount 编排 + wrapper 生命周期（setupUpdatePageLifecycle 注册
 *    beforeAll/beforeEach/afterEach，afterEach 统一卸载并清 body teleport 残留）
 *
 * vi.mock 注册留在测试文件（hoisting 约束，工厂经顶层 import 转发 update-card-mock 导出）；
 * 用例断言与特定覆写（mockResolvedValue / mockRejectedValue）留在原测试文件——覆写在
 * primeUpdatePageDefaults 之后执行即生效。
 *
 * UpdatePage 经动态 import 加载：顶层静态 import 会经 vitest mock-hoist 在 vi.mock 工厂
 * 执行前触发被 mock 模块加载（TDZ 崩），理由同 system-page-mount.mountSystemPage。
 *
 * vitest 按测试文件隔离模块图：本 helper 的挂载槽在每个测试文件内独立。
 */
import { beforeAll, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { settingsMock, toastMock, resetCardUpdateHarness } from './update-card-mock'

/** 最近一次 mountUpdatePage 的挂载槽（afterEach 统一卸载；用例断言用 mountUpdatePage 返回值）。 */
let mounted: ReturnType<typeof mount> | null = null

/** beforeEach 统一重置 + 默认解析值（代理/更新设置五键 + toast 两键重置）。update harness
 *  的复位在 mountUpdatePage 内（见该函数注释）。 */
function primeUpdatePageDefaults(): void {
  settingsMock.getProxyConfig.mockReset()
  settingsMock.setProxyConfig.mockReset()
  settingsMock.testProxy.mockReset()
  settingsMock.getUpdateSettings.mockReset()
  settingsMock.setUpdateSettings.mockReset()
  toastMock.info.mockReset()
  toastMock.error.mockReset()
  // 默认解析值：与组件默认 ref 一致
  settingsMock.getProxyConfig.mockResolvedValue({ mode: 'system', httpProxy: '', httpsProxy: '' })
  settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: false })
  settingsMock.setUpdateSettings.mockResolvedValue(undefined)
}

/** mount UpdatePage 并完成异步加载（返回 wrapper 供用例断言；卸载由 afterEach 统一负责）。
 *  update harness 复位收在 mount 前：vi.mock 工厂（创建 harness）在首次 import UpdatePage
 *  时执行（beforeAll 预热或本函数，先于任何用例），resetCardUpdateHarness 时 harness 必然
 *  就绪，复位与 mount 的相对顺序不变。 */
export async function mountUpdatePage(): Promise<ReturnType<typeof mount>> {
  const { default: UpdatePage } = await import('@/components/settings/update/UpdatePage.vue')
  resetCardUpdateHarness()
  mounted = mount(UpdatePage)
  await flushPromises()
  return mounted
}

/** UpdatePage 测试生命周期接线：beforeAll 模块图预热 + beforeEach 重置/默认值 + afterEach
 *  卸载并清 body teleport 残留（更新来源 Select 下拉经 SelectPortal teleport 到 document.body）。
 *  预热 = beforeAll 内动态 import UpdatePage 全树一次：编译装载成本落文件级 hook，首条用例
 *  不再吸收（此前首条 mount 用例独付全树装载，负载下涨到秒级）。vi.mock 注册先于本 hook
 *  执行（注册在测试文件 import 期完成），动态 import 保持 TDZ 安全（同 mountUpdatePage 注释）。 */
export function setupUpdatePageLifecycle(): void {
  beforeAll(() => import('@/components/settings/update/UpdatePage.vue'))
  beforeEach(primeUpdatePageDefaults)
  afterEach(() => {
    mounted?.unmount()
    mounted = null
    document.body.innerHTML = ''
  })
}
