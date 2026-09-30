/**
 * 设置域 composable 单测与 composer 集成测试（compact-queue / dispatch-route 的
 * queue 拒绝 toast）共享的 i18n key 回显 + toast spy mock（use-api-key-auto-enable /
 * useQuotaAutoEnableNotice 等 '@/i18n' + '@/composables/useToast' 前置段单源）。
 *
 * t 返回 key 本身；带 name 参数时拼接（`key:name`）——toast 断言据此验证插值确有传入
 * （断言完整 i18n 文案的用例不经本工厂，直接 import 真实 locale 比对）。
 *
 * vi.mock 注册留在测试文件（mock 是文件作用域），工厂经顶层 import 转发本 helper 导出
 * ——同 sidebar-mount.ts 先例。vitest 按测试文件隔离模块图：toastSpyMock 单例在每个
 * 测试文件内是独立实例（文件内 mock 工厂与断言共享同一批 vi.fn）。
 */
import { vi } from 'vitest'

/** toast spy 集（info/error/warning 三面，beforeEach vi.clearAllMocks 常规清理；
 *  warning 键供 compact-queue / dispatch-route 的 queue 拒绝 toast 断言，对其余
 *  消费文件为无害多余键）。 */
export const toastSpyMock = { info: vi.fn(), error: vi.fn(), warning: vi.fn() }

/** '@/i18n' mock 工厂（t = key 回显 + name 拼接，见文件头注释）。 */
export function i18nKeyEchoModule() {
  return {
    default: {
      global: {
        t: (key: string, params?: Record<string, unknown>) =>
          params?.name ? `${key}:${String(params.name)}` : key,
      },
    },
  }
}

/** '@/composables/useToast' mock 工厂（useToast 返回 toastSpyMock 单例）。 */
export function toastSpyModule() {
  return { useToast: () => toastSpyMock }
}
