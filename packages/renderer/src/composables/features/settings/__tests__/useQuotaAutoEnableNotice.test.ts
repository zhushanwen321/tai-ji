/**
 * useQuotaAutoEnableNotice composable 单测（「新增即默认同意」额度自动开启 toast）。
 *
 * 覆盖 notifyQuotaAutoEnabled 判定矩阵（round3 MF-3-1：!name 守卫分支此前仅经
 * ProviderPage UI 级测试间接触达，无 enabled=true + name=undefined 组合的直接用例，
 * 守卫删除现有测试仍全绿）。UI 级正/反例已由
 * components/settings/provider/__tests__/ProviderPage.test.ts「新增即默认同意」组锁定，
 * 此处不重复建 UI 用例，只锁 composable 分支语义。
 *
 * mock 策略：对齐同目录 use-app-update-notes.test.ts / 同族 use-api-key-auto-enable.test.ts
 * 惯例——'@/i18n'（t 返回 key + 拼接 name，让 toast 断言能验证插值确有传入）
 * + '@/composables/useToast'。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/features/settings/__tests__/useQuotaAutoEnableNotice.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const toastMock = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }))

vi.mock('@/i18n', () => ({
  // t 返回 key；带 params 时拼接 name，让 toast 断言能验证插值确有传入
  default: { global: { t: (key: string, params?: Record<string, unknown>) =>
    params?.name ? `${key}:${String(params.name)}` : key } },
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toastMock,
}))

import { useQuotaAutoEnableNotice } from '../useQuotaAutoEnableNotice'

describe('notifyQuotaAutoEnabled 判定矩阵', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('enabled=true 且 name=undefined → 不 toast（!name 守卫：savedId 空时调用点真传 undefined）', () => {
    const { notifyQuotaAutoEnabled } = useQuotaAutoEnableNotice()
    notifyQuotaAutoEnabled(true, undefined)
    expect(toastMock.info).not.toHaveBeenCalled()
  })

  it('enabled=true 且 name 空串 → 不 toast（!name 同分支拦截无可展示名）', () => {
    const { notifyQuotaAutoEnabled } = useQuotaAutoEnableNotice()
    notifyQuotaAutoEnabled(true, '')
    expect(toastMock.info).not.toHaveBeenCalled()
  })

  it('enabled=true 且有展示名 → info toast 一次，payload 含 name（指引语境）', () => {
    const { notifyQuotaAutoEnabled } = useQuotaAutoEnableNotice()
    notifyQuotaAutoEnabled(true, 'Z.AI Coding CN')
    expect(toastMock.info).toHaveBeenCalledOnce()
    expect(toastMock.info).toHaveBeenCalledWith('settings.provider.quotaAutoEnabledToast:Z.AI Coding CN')
  })

  it('enabled=false → 不 toast（runtime 未开启额度显示）', () => {
    const { notifyQuotaAutoEnabled } = useQuotaAutoEnableNotice()
    notifyQuotaAutoEnabled(false, 'Z.AI Coding CN')
    expect(toastMock.info).not.toHaveBeenCalled()
  })

  it('enabled=undefined → 不 toast（旧 runtime 版本无该 reply 字段）', () => {
    const { notifyQuotaAutoEnabled } = useQuotaAutoEnableNotice()
    notifyQuotaAutoEnabled(undefined, 'Z.AI Coding CN')
    expect(toastMock.info).not.toHaveBeenCalled()
  })
})
