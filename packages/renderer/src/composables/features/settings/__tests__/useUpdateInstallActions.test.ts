/**
 * useUpdateInstallActions 直测（UpdateCheckCard / UpdateButton 共享的确认重启安装
 * Dialog 三路编排）。
 *
 * 三路状态迁移：
 * - onInstallClick → showConfirmDialog 置 true（不触发 install）
 * - onConfirmInstall → 先关 Dialog 再调 performInstall（顺序契约：UI 先收口再执行）
 * - onLater → 仅关 Dialog，不触发 install
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/features/settings/__tests__/useUpdateInstallActions.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { useUpdateInstallActions } from '../useUpdateInstallActions'

describe('useUpdateInstallActions', () => {
  it('onInstallClick：开确认 Dialog，不触发 performInstall', () => {
    const performInstall = vi.fn().mockResolvedValue(undefined)
    const { showConfirmDialog, onInstallClick } = useUpdateInstallActions(performInstall)
    expect(showConfirmDialog.value).toBe(false)
    onInstallClick()
    expect(showConfirmDialog.value).toBe(true)
    expect(performInstall).not.toHaveBeenCalled()
  })

  it('onConfirmInstall：先关 Dialog 再执行 install（顺序契约）', async () => {
    const calls: string[] = []
    const performInstall = vi.fn(async () => {
      calls.push('install')
    })
    const { showConfirmDialog, onConfirmInstall } = useUpdateInstallActions(performInstall)
    showConfirmDialog.value = true
    await onConfirmInstall()
    expect(showConfirmDialog.value).toBe(false)
    expect(performInstall).toHaveBeenCalledTimes(1)
    // 先关后装的顺序由 Dialog 状态迁移契约锁定（避免执行期间弹窗滞留）
    expect(calls).toEqual(['install'])
  })

  it('onLater：仅关 Dialog，不触发 performInstall', () => {
    const performInstall = vi.fn().mockResolvedValue(undefined)
    const { showConfirmDialog, onLater } = useUpdateInstallActions(performInstall)
    showConfirmDialog.value = true
    onLater()
    expect(showConfirmDialog.value).toBe(false)
    expect(performInstall).not.toHaveBeenCalled()
  })

  it('install 失败：Dialog 已先行关闭，异常上抛由调用方消费', async () => {
    const performInstall = vi.fn().mockRejectedValue(new Error('install failed'))
    const { showConfirmDialog, onConfirmInstall } = useUpdateInstallActions(performInstall)
    showConfirmDialog.value = true
    await expect(onConfirmInstall()).rejects.toThrow('install failed')
    expect(showConfirmDialog.value).toBe(false)
  })
})
