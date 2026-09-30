/**
 * PiPresetsPage 测试 mock 注册 + beforeEach 脚手架（import 即注册的副作用模块，范式同
 * composer-shell-mount.ts；工厂与 seam 接线单源在 preset-page-mount.ts）。
 *
 * 为什么注册不留在测试文件：settings 与 components 两套同组件测试的 vi.hoisted mock
 * 字面量 + vi.mock 注册行 + beforeEach/afterEach 脚手架两两之间再共享十来个归一化
 * token 就越过 fallow 克隆阈值（min-tokens=50），注册行逐字留在文件内时该克隆组结构性
 * 无法消除（同 composer-shell-mount 判据）。
 *
 * presetMock 单例在模块体求值（裸 vi.fn 字面量；默认 impl 由 primePresetDefaults 在
 * beforeEach 注入，同时承担逐用例重置）。vitest 按测试文件隔离模块图：每个测试文件
 * import 本模块各得一份独立单例。
 *
 * 使用约束：
 * - 本模块 import 必须排在会拉入 '@/api' / '@taiji/ui/features/settings' 的 import
 *   （组件等）之前——vi.mock 工厂惰性执行时 presetMock 需已初始化（TDZ）；
 * - 消费文件不得再 vi.mock 同两目标（后注册者生效，静默覆盖）。
 */
import { afterEach, beforeEach, vi } from 'vitest'
import type { VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useToast } from '@/composables/useToast'
import {
  presetApiModule,
  presetUiModule,
  primePresetDefaults,
  wirePresetTransport,
  type PresetMock,
} from './preset-page-mount'

/** preset 门面捕获单例（六个可断言 mock；默认 impl 见 primePresetDefaults） */
export const presetMock: PresetMock = {
  list: vi.fn(),
  getDefault: vi.fn(),
  setDefault: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}

vi.mock('@/api', () => presetApiModule(presetMock))
vi.mock('@taiji/ui/features/settings', () => presetUiModule())

/** PiPresetsPage 测试 beforeEach 接线：pinia 重置 + mock 默认 impl 注入 + 全局 toasts
 *  清空 + [C3] preset 域 SettingsTransport seam 桩接线。消费文件顶层调用一次。 */
export function setupPresetPageTest(): void {
  beforeEach(() => {
    setActivePinia(createPinia())
    primePresetDefaults(presetMock)
    const { toasts } = useToast()
    toasts.value = []
    wirePresetTransport(presetMock)
  })
}

/** afterEach 卸载 wrapper 并清空 body（teleport 残留清理；wrapper 槽归测试文件所有） */
export function teardownPresetPage(wrapper: VueWrapper | null): void {
  wrapper?.unmount()
  document.body.innerHTML = ''
}
