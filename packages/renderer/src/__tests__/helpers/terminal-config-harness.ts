/**
 * 终端配置域设置页测试共享 harness（appearance-page / terminal-page 两文件逐字重复段
 * 单源；范式同 update-card-mock.ts + update-page-mount.ts 组合）。
 *
 * 收敛内容：TerminalConfig 默认值工厂 + getTerminalConfig/setTerminalConfig 捕获层单例 +
 * '@/api' mock 工厂（vi.mock 注册留在测试文件，工厂经顶层 import 惰性转发本 helper 导出）
 * + body 查询 $ + 挂载槽生命周期（beforeEach 重置 / afterEach 卸载清 body）。
 *
 * 时序约束：vi.mock('@/api', () => terminalConfigApiModule()) 的工厂在 '@/api' 首次被
 * import 时才执行，此时本 helper 模块已初始化——测试文件须把本 helper 的 import 放在
 * 任何会拉入 '@/api' 的 import（组件/@/composables）之前（TDZ，同 update-card-mock 注释）。
 *
 * vitest 按测试文件隔离模块图：捕获单例与挂载槽在每个测试文件内独立。
 */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useToast } from '@/composables/useToast'
import { provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from './settings-transport-stub'
import type { TerminalConfig } from '@taiji/shared'

/** TerminalConfig 全字段默认值（两页 mount 拉取的基线配置 fixture） */
export function defaultTerminalConfig(): TerminalConfig {
  return {
    version: 1,
    shell: '',
    shellArgs: [],
    fontSize: 14,
    fontFamily: '',
    scrollback: 1000,
    cursorStyle: 'block',
    bell: false,
  }
}

/** 终端配置读写捕获层单例（getTerminalConfig / setTerminalConfig；beforeEach 统一 mockClear） */
export const terminalConfigMock = {
  getTerminalConfig: vi.fn(() => Promise.resolve({ config: defaultTerminalConfig(), corrupted: false })),
  setTerminalConfig: vi.fn((cfg: TerminalConfig) => Promise.resolve({ config: cfg, corrupted: false })),
}

/** '@/api' mock 工厂：config 域转发捕获单例 + project load/save 惰性桩 */
export function terminalConfigApiModule() {
  return {
    project: {
      load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
      save: vi.fn().mockResolvedValue(undefined),
    },
    config: terminalConfigMock,
  }
}

/** 在 body 中查找元素并包装成 DOMWrapper（teleport/attachTo 目标查询；未找到即断言失败） */
export function $(selector: string): DOMWrapper<Element> {
  const node = document.body.querySelector(selector)
  expect(node).toBeTruthy()
  return new DOMWrapper(node!)
}

/** 挂载槽：trackBodyMount 登记最近一次 wrapper，afterEach 统一卸载（用例断言用返回值） */
let mounted: VueWrapper | null = null

/** 登记挂载到 body 的 wrapper 进挂载槽（返回原 wrapper 供链式断言） */
export function trackBodyMount<T extends VueWrapper>(wrapper: T): T {
  mounted = wrapper
  return wrapper
}

/** 终端配置域设置页测试生命周期接线：beforeEach 重置（pinia / toast / mock 计数 +
 *  SettingsTransport 桩注入）+ afterEach 卸载挂载槽并清 body teleport 残留。消费文件顶层调用一次。 */
export function setupTerminalConfigHarness(): void {
  beforeEach(() => {
    setActivePinia(createPinia())
    const { toasts } = useToast()
    toasts.value = []
    terminalConfigMock.getTerminalConfig.mockClear()
    terminalConfigMock.setTerminalConfig.mockClear()
    provideSettingsTransport(makeSettingsTransportStub(terminalConfigMock))
  })
  afterEach(() => {
    mounted?.unmount()
    mounted = null
    document.body.innerHTML = ''
  })
}
