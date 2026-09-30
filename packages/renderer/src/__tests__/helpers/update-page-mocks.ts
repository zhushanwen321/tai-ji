/**
 * UpdatePage 两套测试（update-page / update-page-source）的 vi.mock 注册单源（import 即注册，
 * 副作用模块，范式同 composer-queue-mount.ts）。
 *
 * 为什么注册不留在测试文件：两文件的 mock 注册块逐字趋同（≥50 归一化 token，fallow 克隆组），
 * 留在文件内时该克隆组结构性无法消除。
 *
 * 时序约束：本模块自身的 import 链（update-card-mock → update-ipc-mock）不触及被 mock 路径，
 * 注册先于消费文件的 UpdatePage 动态 import 执行；消费文件须把本模块的 import 排在会触发
 * mock 工厂的动态 import（mountUpdatePage 内）之前（TDZ，同 update-card-mock 文件头说明）。
 */
import { vi } from 'vitest'
import { settingsApiModule, toastMockModule, useAppUpdateCardModule } from './update-card-mock'

vi.mock('@/api/domains/settings', () => settingsApiModule())

vi.mock('@/composables/useToast', () => toastMockModule())

vi.mock('@/composables/features/settings/useAppUpdate', () => useAppUpdateCardModule())
