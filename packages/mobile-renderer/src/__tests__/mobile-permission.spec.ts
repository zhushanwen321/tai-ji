// 移动壳权限审批链装配 smoke（remote-use D7「权限审批 ✅ 手机可批」接线）。
//
// 链路锁定：bus 'plugin-permission-request'（companion-bridge 模块级 controller）→
// App 内 PermissionRequestDialog 渲染 → 勾选/批准/拒绝 → transport RPC
// （plugin.approvePermissions / plugin.denyPermissions）→ pending 收口。
//
// 状态机本体（畸形事件守卫 / permissions 拷贝 / BM3 失败保持 / D3 expired 撤窗 /
// 新请求覆盖）单测在 packages/ui extension-host
// __tests__/permission-request-controller.test.ts（双壳共享 factory）；错误行渲染
// 归 PermissionRequestDialog 组件测试。本文件只钉移动壳装配（App.vue provide +
// Dialog 挂载 + bus 单例接线）。
//
// mock 策略：
// - plugin 域（approvePermissions/denyPermissions）模块级 vi.mock 隔离 WS（断言回传参数）；
// - Dialog 家族 stub 内联渲染（reka-ui DialogContent 在 happy-dom 下 Teleport 到 body 且
//   时序不稳定——ui PermissionRequestDialog.test.ts 同款先例），stub 尊重 open prop。
//
// 协议事实锚定（「无 sessionId」用例方向）：runtime permissionRequest 广播 payload 协议性
// 无 sessionId（plugin-service onPermissionRequest 直发 activator payload），审批弹窗全局
// 单例 session 无关——无 sessionId 事件必须照常弹出。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/mobile-permission.spec.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import App from '../App.vue'
import { i18n } from '../i18n'
import { __testing, useMobilePermissionRequest } from '../shell/companion-bridge'
import { shellConnectionState } from '../shell/connection-view'

// vi.hoisted：mock 工厂被 hoist 到 import 前，工厂内引用的变量须经 vi.hoisted 创建
const { mockApprove, mockDeny } = vi.hoisted(() => ({ mockApprove: vi.fn(), mockDeny: vi.fn() }))

vi.mock('@taiji/core/transport/api/domains/plugin', () => ({
  approvePermissions: mockApprove,
  denyPermissions: mockDeny,
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
  __testing.mobileExtensionBus.emit({
    kind: 'plugin-permission-request',
    ...(sessionId !== undefined ? { sessionId } : {}),
    request: { pluginId, permissions, requestId: `perm_${pluginId}` },
  })
}

describe('移动壳权限审批链装配（D7 手机可批）', () => {
  let wrapper: ReturnType<typeof mountApp> | null = null

  beforeEach(() => {
    mockApprove.mockReset().mockResolvedValue(undefined)
    mockDeny.mockReset().mockResolvedValue(undefined)
    // 模块级弹窗单例复位（跨用例隔离；pending/error 残留会让后续用例误判弹窗来源）
    const perm = useMobilePermissionRequest()
    perm.pending = false
    perm.pluginId = ''
    perm.permissions = []
    perm.error = false
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
    expect(mockDeny).not.toHaveBeenCalled()
    // 回传成功 → pending=false → 弹窗关闭（状态收口）
    expect(useMobilePermissionRequest().pending).toBe(false)
    expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(false)
  })

  it('拒绝 → transport.deny 回传（denyPermissions 命令，拒绝本次申请）→ 弹窗关闭', async () => {
    wrapper = mountApp()
    emitPermissionRequest('p2', ['fs.write'])
    await nextTick()

    await wrapper.find('[data-testid="permission-reject"]').trigger('click')
    await flushPromises()

    expect(mockDeny).toHaveBeenCalledTimes(1)
    expect(mockDeny).toHaveBeenCalledWith('p2')
    expect(mockApprove).not.toHaveBeenCalled()
    expect(useMobilePermissionRequest().pending).toBe(false)
    expect(useMobilePermissionRequest().error).toBe(false)
    expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(false)
  })

  it('无 sessionId 事件照常弹出（协议事实：permissionRequest 广播无 sessionId，审批全局单例）', async () => {
    wrapper = mountApp()
    emitPermissionRequest('p3', ['net.http'])
    await nextTick()

    expect(wrapper.find('[data-testid="permission-dialog"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="permission-dialog-title"]').text()).toBe('p3')
  })
})
