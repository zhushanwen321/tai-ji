/**
 * SystemPage 集成测试文件骨架单源（system-page-rename-model / system-page-smart-context
 * 两文件的公共样板收敛：vi.mock 注册 + 超时放宽 + 生命周期 + mount 编排一站式 setup）。
 *
 * 消费形态（测试文件头部，sectionPath 为目标 Section 组件的动态 import 表达式）：
 *   const { settingsMock, mountPage, mountSection, pageWrapper } = setupSystemPageTest(
 *     () => import(sectionPath),
 *   )
 *
 * import 本模块即完成两类注册（副作用模块形态，须先于任何被 mock 模块加载）：
 *  - vi.mock 三件套（useToast / useCommandStore / lib/ipc）——本模块求值时注册，组件经
 *    mountSystemPage/mountSystemSection 的动态 import 推迟到用例内，注册天然先行；
 *  - testTimeout 放宽 20s（SystemPage 集成 mount 重组件树，5s 默认预算插桩/全量并发下击穿）。
 *
 * setupSystemPageTest(sectionLoader) 调用时注册 per-file 生命周期：
 *  - beforeEach：pinia + settings store 全新实例 + settings API mock 重置 + seam 注入；
 *  - afterEach：wrapper 卸载 + body 清理。
 *  用例级默认值覆写（如 smart-context 的 setSmartContextEnabled resolved false）留在调用方
 *  文件自己的 beforeEach——setup 的 beforeEach 先注册先执行，调用方覆写在其后生效。
 *
 * mock 工厂本体（toastModule/commandStoreModule/ipcModule 等）仍在 system-page-mount.ts。
 */
import { beforeEach, afterEach, vi } from 'vitest'
import type { Component } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { provideSettingsStore, createSettingsStore } from '@taiji/core'
import {
  settingsApiMocks,
  provideSettingsApiMocks,
  resetSettingsApiMocks,
  mountSystemPage,
  mountSystemSection,
  toastModule,
  commandStoreModule,
  ipcModule,
} from './system-page-mount'

// [C3] settings API mock 经 SettingsTransport seam 注入（provideSettingsApiMocks，见 beforeEach）
vi.mock('@/composables/useToast', () => toastModule())
vi.mock('@/composables/features/command/useCommandStore', () => commandStoreModule())
vi.mock('@/lib/ipc', () => ipcModule())

vi.setConfig({ testTimeout: 20_000 })

/** seedStore / smartContextFixture 转发（调用方一站式 import，不再直连 system-page-mount）。 */
export { seedStore, smartContextFixture } from './system-page-mount'
/** 下拉/异步断言等待原语转发（同上）。 */
export { flushPromises } from '@vue/test-utils'

/** SystemPage 集成测试文件 setup 工厂（返回断言面与 mount 编排，见文件头）。 */
export function setupSystemPageTest(sectionLoader: () => Promise<{ default: Component }>) {
  let wrapper: Awaited<ReturnType<typeof mountSystemPage>> | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    provideSettingsStore(createSettingsStore())
    resetSettingsApiMocks(settingsApiMocks)
    provideSettingsApiMocks()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  return {
    /** seam 桩 spy 单例（mock 工厂与断言共享同一批 vi.fn 实例）。 */
    settingsMock: settingsApiMocks,
    /** mount SystemPage（集成入口）并完成异步加载。 */
    async mountPage(): Promise<void> {
      wrapper = await mountSystemPage()
    },
    /** 直挂单 Section（交互断言用例；loader 由调用方传入）。 */
    async mountSection(): Promise<void> {
      wrapper = await mountSystemSection(sectionLoader)
    },
    /** 当前挂载 wrapper（未挂载为 null；用例内 wrapper!.find 改写为 pageWrapper()!.find）。 */
    pageWrapper(): Awaited<ReturnType<typeof mountSystemPage>> | null {
      return wrapper
    },
  }
}
