// 移动壳权限审批链测试（remote-use D7「权限审批 ✅ 手机可批」接线，阶段 3 一致性修复）。
//
// 链路锁定：bus 'plugin-permission-request'（companion-bridge 订阅）→ App 内
// PermissionRequestDialog 渲染 → 勾选/批准/拒绝 → transport RPC
// （plugin.approvePermissions / plugin.revokePermissions）→ pending=false 收口。
//
// mock 策略：
// - plugin 域（approvePermissions/revokePermissions）模块级 vi.mock 隔离 WS（断言回传参数）；
// - Dialog 家族 stub 内联渲染（reka-ui DialogContent 在 happy-dom 下 Teleport 到 body 且
//   时序不稳定——ui PermissionRequestDialog.test.ts 同款先例），stub 尊重 open prop。
//
// 协议事实锚定（「无 sessionId」用例方向）：runtime permissionRequest 广播 payload 协议性
// 无 sessionId（plugin-service onPermissionRequest 直发 activator payload），审批弹窗全局
// 单例 session 无关——无 sessionId 事件必须照常弹出，warn+skip 只适用于结构坏事件。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/mobile-permission.spec.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { dispatchGlobal } from '@taiji/core/transport/api'
import App from '../App.vue'
import { i18n } from '../i18n'
import { mobileExtensionBus, useMobilePermissionRequest } from '../shell/companion-bridge'
import { shellConnectionState } from '../bootstrap'

// vi.hoisted：mock 工厂被 hoist 到 import 前，工厂内引用的变量须经 vi.hoisted 创建
const { mockApprove, mockRevoke } = vi.hoisted(() => ({ mockApprove: vi.fn(), mockRevoke: vi.fn() }))

vi.mock('@taiji/core/transport/api/domains/plugin', () => ({
  approvePermissions: mockApprove,
  revokePermissions: mockRevoke,
}))

// Dialog 家族 stub：内联渲染 slot，尊重 open（pending=false 时不渲染内容）
const dialogStubs = {
  Dialog: { props: ['open'], template: '<div><slot v-if="open" /></div>' },
  DialogContent: { template: '<div><slot /></div>' },
  DialogHeader: { template: '<div><slot /></div>' },
  DialogTitle: { template: '<div><slot /></div>' },
  DialogDescription: { template: '<div><slot /></div>' },
}

function mountApp() {
  return mount(App, { global: { plugins: [i18n], stubs: dialogStubs } })
}

/** 发一条 bridge 归一后的合法 permission-request 事件（sessionId 可选，协议性缺省） */
function emitPermissionRequest(pluginId: string, permissions: string[], sessionId?: string): void {
  mobileExtensionBus.emit({
    kind: 'plugin-permission-request',
    ...(sessionId !== undefined ? { sessionId } : {}),
    request: { pluginId, permissions, requestId: `perm_${pluginId}` },
  })
}

describe('移动壳权限审批链（D7 手机可批）', () => {
  let wrapper: ReturnType<typeof mountApp> | null = null

  beforeEach(() => {
    mockApprove.mockReset().mockResolvedValue(undefined)
    mockRevoke.mockReset().mockResolvedValue(undefined)
    // 模块级弹窗单例复位（跨用例隔离；pending 残留会让后续用例误判弹窗来源）
    const perm = useMobilePermissionRequest()
    perm.pending = false
    perm.pluginId = ''
    perm.permissions = []
    shellConnectionState.value = 'connecting'
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    shellConnectionState.value = 'connecting'
  })

  it('bus 事件 → 弹窗渲染（插件名 + 权限项）→ 部分批准 → transport 回传参数正确 → pending 收口关弹窗', async () => {
    wrapper = mountApp()
    expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(false)

    emitPermissionRequest('p1', ['fs.read', 'net.http'], 'sid-a')
    await nextTick()

    // 使用者视角：弹窗可见、插件名与权限项逐项渲染
    expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="permission-dialog-title"]').text()).toBe('p1')
    const items = wrapper.findAll('[data-testid="permission-item-label"]')
    expect(items).toHaveLength(2)
    expect(items[0]!.text()).toBe('fs.read')
    expect(items[1]!.text()).toBe('net.http')

    // 部分批准：只勾 fs.read
    await wrapper.find('[data-testid="permission-item-fs.read"]').trigger('click')
    await wrapper.find('[data-testid="permission-approve"]').trigger('click')
    await flushPromises()

    expect(mockApprove).toHaveBeenCalledTimes(1)
    expect(mockApprove).toHaveBeenCalledWith('p1', ['fs.read'])
    expect(mockRevoke).not.toHaveBeenCalled()
    // 回传成功 → pending=false → 弹窗关闭（状态收口）
    expect(useMobilePermissionRequest().pending).toBe(false)
    expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(false)
  })

  it('拒绝 → transport.revoke 回传 → 弹窗关闭', async () => {
    wrapper = mountApp()
    emitPermissionRequest('p2', ['fs.write'])
    await nextTick()

    await wrapper.find('[data-testid="permission-reject"]').trigger('click')
    await flushPromises()

    expect(mockRevoke).toHaveBeenCalledTimes(1)
    expect(mockRevoke).toHaveBeenCalledWith('p2')
    expect(mockApprove).not.toHaveBeenCalled()
    expect(useMobilePermissionRequest().pending).toBe(false)
    expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(false)
  })

  it('无 sessionId 事件照常弹出（协议事实：permissionRequest 广播无 sessionId，审批全局单例）', async () => {
    wrapper = mountApp()
    emitPermissionRequest('p3', ['net.http'])
    await nextTick()

    expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="permission-dialog-title"]').text()).toBe('p3')
  })

  it('畸形事件 warn+skip 不崩：空 pluginId / permissions 非数组均不弹窗，后续合法事件照常', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      wrapper = mountApp()

      // 空 pluginId
      emitPermissionRequest('', ['fs.read'])
      await nextTick()
      expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(false)
      // permissions 非数组（测试注入坏形状，受控 cast）
      mobileExtensionBus.emit({
        kind: 'plugin-permission-request',
        request: { pluginId: 'p4', permissions: 'fs.read' as unknown as string[], requestId: 'perm_p4' },
      })
      await nextTick()
      expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(false)

      expect(warnSpy).toHaveBeenCalledTimes(2)
      // 守卫只 skip 不毒害状态：合法事件照常弹出
      emitPermissionRequest('p5', ['fs.read'])
      await nextTick()
      expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('审批等待超时撤窗（D3 取消非判拒）：同 pluginId expired 关弹窗；异 pluginId 不误撤', async () => {
    wrapper = mountApp()
    emitPermissionRequest('p6', ['fs.read'])
    await nextTick()

    // 异 pluginId 的陈旧 expired 广播：noop（不误撤新弹窗）
    dispatchGlobal({ type: 'plugin:permissionRequestExpired', id: 't1', payload: { pluginId: 'other' } })
    expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(true)

    // 同 pluginId：撤窗
    dispatchGlobal({ type: 'plugin:permissionRequestExpired', id: 't2', payload: { pluginId: 'p6' } })
    expect(useMobilePermissionRequest().pending).toBe(false)
    await nextTick()
    expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(false)
  })
})
