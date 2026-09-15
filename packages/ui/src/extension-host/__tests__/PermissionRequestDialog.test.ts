/**
 * PermissionRequestDialog 组件测试（W2 · T5，TC-7~TC-10）。
 *
 * 覆盖用例（design-review TC-7~TC-10，IF4 契约）：
 *  - TC-7 权限列表渲染（权限项 DOM）（AC4）
 *  - TC-8 部分批准回传：emit approve(selected) + transport.approve(pluginId, selected)（AC4）
 *  - TC-9 拒绝回传：emit revoke + transport.revoke(pluginId)（AC4）
 *  - TC-10 全选切换 + pending=false 不弹浮层
 *
 * Mock 策略：MockPermissionTransport（approve/revoke vi.fn）经 PERMISSION_TRANSPORT_KEY provide；
 * Dialog 原语经 stub 内联渲染（reka-ui DialogContent 在 happy-dom 下 Teleport 到 body 且时序不稳定
 * —— ProviderEditModal.test.ts 先例，故 stub 掉 Dialog 家族让内容渲染在 wrapper 内，测试确定性）。
 * Dialog stub 尊重 open prop（pending=false 时内容不渲染）。
 *
 * 运行：cd packages/ui && npx vitest run src/extension-host/
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import PermissionRequestDialog from '../PermissionRequestDialog.vue'
import { PERMISSION_TRANSPORT_KEY } from '../permission-transport'
import type { PermissionTransport } from '../permission-transport'

const PERMISSIONS = ['fs.read', 'net.http']

/** Dialog 家族 stub：内联渲染 slot，尊重 open（pending=false 时不渲染内容） */
const dialogStubs = {
  Dialog: { props: ['open'], template: '<div><slot v-if="open" /></div>' },
  DialogContent: { template: '<div><slot /></div>' },
  DialogHeader: { template: '<div><slot /></div>' },
  DialogTitle: { template: '<div><slot /></div>' },
  DialogDescription: { template: '<div><slot /></div>' },
}

function makeTransport(): PermissionTransport {
  return { approve: vi.fn(), revoke: vi.fn() }
}

function mountDialog(overrides: Partial<{ pluginId: string; permissions: string[]; pending: boolean }> = {}, transport?: PermissionTransport) {
  const wrapper = mount(PermissionRequestDialog, {
    props: { pluginId: 'p1', permissions: PERMISSIONS, pending: true, ...overrides },
    global: {
      provide: { [PERMISSION_TRANSPORT_KEY as symbol]: transport ?? makeTransport() },
      stubs: dialogStubs,
    },
  })
  return wrapper
}

describe('PermissionRequestDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('TC-7 权限列表渲染：权限项 DOM（label 文本）（AC4）', () => {
    const wrapper = mountDialog()
    expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="permission-dialog-title"]').text()).toBe('p1')
    const items = wrapper.findAll('[data-testid="permission-item-label"]')
    expect(items).toHaveLength(2)
    expect(items[0]!.text()).toBe('fs.read')
    expect(items[1]!.text()).toBe('net.http')
  })

  it('TC-8 部分批准：勾选 fs.read → 点批准 → emit approve(["fs.read"]) + transport.approve("p1", ["fs.read"])（AC4）', async () => {
    const transport = makeTransport()
    const wrapper = mountDialog({}, transport)

    // 未勾选任何权限：批准禁用
    const approveBtn = wrapper.find('[data-testid="permission-approve"]')
    expect(approveBtn.attributes('disabled')).toBeDefined()

    // 勾选 fs.read（不勾 net.http）
    await wrapper.find('[data-testid="permission-item-fs.read"]').trigger('click')
    expect(approveBtn.attributes('disabled')).toBeUndefined()
    await approveBtn.trigger('click')

    // emit approve + transport RPC
    expect(wrapper.emitted('approve')).toHaveLength(1)
    expect(wrapper.emitted('approve')![0]).toEqual([['fs.read']])
    expect(transport.approve).toHaveBeenCalledTimes(1)
    expect(transport.approve).toHaveBeenCalledWith('p1', ['fs.read'])
  })

  it('TC-10a 全选切换：toggle-all → 批准带全部权限', async () => {
    const transport = makeTransport()
    const wrapper = mountDialog({}, transport)

    // 全选
    await wrapper.find('[data-testid="permission-dialog-toggle-all"]').trigger('click')
    await wrapper.find('[data-testid="permission-approve"]').trigger('click')

    expect(wrapper.emitted('approve')![0]).toEqual([['fs.read', 'net.http']])
    expect(transport.approve).toHaveBeenCalledWith('p1', ['fs.read', 'net.http'])

    // 再点全选 → 取消全选 → 批准禁用
    await wrapper.find('[data-testid="permission-dialog-toggle-all"]').trigger('click')
    expect(wrapper.find('[data-testid="permission-approve"]').attributes('disabled')).toBeDefined()
  })

  it('TC-9 拒绝：emit revoke + transport.revoke("p1")（AC4）', async () => {
    const transport = makeTransport()
    const wrapper = mountDialog({}, transport)

    await wrapper.find('[data-testid="permission-reject"]').trigger('click')

    expect(wrapper.emitted('revoke')).toHaveLength(1)
    expect(transport.revoke).toHaveBeenCalledTimes(1)
    expect(transport.revoke).toHaveBeenCalledWith('p1')
  })

  it('TC-10b pending=false → Dialog open=false，权限内容不渲染', () => {
    const wrapper = mountDialog({ pending: false })
    expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="permission-item-fs.read"]').exists()).toBe(false)
  })
})
