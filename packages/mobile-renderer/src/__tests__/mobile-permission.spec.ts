// 移动壳权限审批链装配（remote-use-mobile-v2 §6.5/§6.18 消费半；v1 D7「权限审批 ✅ 手机可批」行的 v2 形态）。
//
// 链路锁定：bus 'plugin-permission-request'（companion-bridge 模块级 controller）→
// App watch(permission.pending) → openSheet('permission') → PermissionSheet 渲染
// （reka Dialog portal 到 body）→ 允许/拒绝 → transport RPC
// （plugin.approvePermissions / plugin.denyPermissions）→ pending 收尾关 Sheet。
//
// 状态机本体（畸形事件检查 / BM3 失败保持 / D3 expired 撤窗 / 新请求覆盖）单测在
// packages/ui extension-host __tests__/permission-request-controller.test.ts（双壳共享
// factory）；本文件只钉移动壳装配（App.vue 挂载 + openSheet 联动 + bus 单例接线）。
//
// [v2 形态适配（原 v1 PermissionRequestDialog spec 重写）]：审批呈现由 App 内联 Dialog
// 换为 PermissionSheet（sheet-manager 'permission' 槽位），交互 = 全量允许/拒绝（v1 的
// 逐项勾选「部分批准」是 Dialog 形态呈现细节，v2 Sheet 形态按 §5.1「拒绝在左 + 作用域
// 逐条列出」呈现；M-6 能力对账以 controller 复用为准）。
//
// mock 策略：
// - plugin 域（approvePermissions/denyPermissions）模块级 vi.mock 隔离 WS（断言回传参数）；
// - Sheet 内容经 reka DialogPortal 渲染到 document.body（happy-dom 实测可达，断言走
//   document 查询——SessionActionsSheet 组件测试同款）。
//
// 协议事实锚定（「无 sessionId」用例方向）：runtime permissionRequest 广播 payload 协议性
// 无 sessionId（plugin-service onPermissionRequest 直发 activator payload），审批全局
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
import { resetSheetManagerForTesting } from '../shell/sheet-manager'

// vi.hoisted：mock 工厂被 hoist 到 import 前，工厂内引用的变量须经 vi.hoisted 创建
const { mockApprove, mockDeny } = vi.hoisted(() => ({ mockApprove: vi.fn(), mockDeny: vi.fn() }))

vi.mock('@taiji/core/transport/api/domains/plugin', () => ({
  approvePermissions: mockApprove,
  denyPermissions: mockDeny,
}))

function mountApp() {
  return mount(App, { global: { plugins: [i18n] } })
}

function sheetQuery<T extends Element = Element>(selector: string): T | null {
  return document.querySelector<T>(selector)
}

/** 发一条 bridge 归一后的合法 permission-request 事件（sessionId 可选，协议性缺省） */
function emitPermissionRequest(pluginId: string, permissions: string[], sessionId?: string): void {
  __testing.mobileExtensionBus.emit({
    kind: 'plugin-permission-request',
    ...(sessionId !== undefined ? { sessionId } : {}),
    request: { pluginId, permissions, requestId: `perm_${pluginId}` },
  })
}

describe('移动壳权限审批链装配（§6.5 PermissionSheet 形态）', () => {
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
    resetSheetManagerForTesting()
    shellConnectionState.value = 'connecting'
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    resetSheetManagerForTesting()
    shellConnectionState.value = 'connecting'
  })

  it('bus 事件 → 审批 Sheet 弹出（插件名 + 权限项逐条）→ 允许 → transport 全量回传 → pending 收尾关 Sheet', async () => {
    wrapper = mountApp()
    expect(sheetQuery('[data-testid="permission-sheet-permissions"]')).toBeNull()

    emitPermissionRequest('p1', ['fs.read', 'net.http'], 'sid-a')
    await nextTick()
    await nextTick()

    // 使用者视角：Sheet 可见（portal 在 body）、权限项逐条渲染
    expect(sheetQuery('[data-testid="permission-sheet-permissions"]')).not.toBeNull()
    expect(sheetQuery('[data-testid="permission-sheet-perm-fs.read"]')).not.toBeNull()
    expect(sheetQuery('[data-testid="permission-sheet-perm-net.http"]')).not.toBeNull()

    // 允许（全量作用域回传；拒绝在左/允许在右的布局由组件模板承载，此处锁回传参数）
    await sheetQuery<HTMLElement>('[data-testid="permission-sheet-approve"]')!.click()
    await flushPromises()

    expect(mockApprove).toHaveBeenCalledTimes(1)
    expect(mockApprove).toHaveBeenCalledWith('p1', ['fs.read', 'net.http'])
    expect(mockDeny).not.toHaveBeenCalled()
    // 回传成功 → pending=false → App watch 收 Sheet（状态收尾）
    expect(useMobilePermissionRequest().pending).toBe(false)
    await nextTick()
    expect(sheetQuery('[data-testid="permission-sheet-permissions"]')).toBeNull()
  })

  it('拒绝 → transport.deny 回传（denyPermissions 命令，拒绝本次申请）→ Sheet 关闭', async () => {
    wrapper = mountApp()
    emitPermissionRequest('p2', ['fs.write'])
    await nextTick()
    await nextTick()
    expect(sheetQuery('[data-testid="permission-sheet-permissions"]')).not.toBeNull()

    // 拒绝（destructive 档；安全侧在左的布局由组件模板承载）
    await sheetQuery<HTMLElement>('[data-testid="permission-sheet-deny"]')!.click()
    await flushPromises()

    expect(mockDeny).toHaveBeenCalledTimes(1)
    expect(mockDeny).toHaveBeenCalledWith('p2')
    expect(mockApprove).not.toHaveBeenCalled()
    expect(useMobilePermissionRequest().pending).toBe(false)
    expect(useMobilePermissionRequest().error).toBe(false)
    await nextTick()
    expect(sheetQuery('[data-testid="permission-sheet-permissions"]')).toBeNull()
  })

  it('无 sessionId 事件照常弹出（协议事实：permissionRequest 广播无 sessionId，审批全局单例；§6.18 无归属一等分支）', async () => {
    wrapper = mountApp()
    emitPermissionRequest('p3', ['net.http'])
    await nextTick()
    await nextTick()

    expect(sheetQuery('[data-testid="permission-sheet-permissions"]')).not.toBeNull()
    expect(sheetQuery('[data-testid="permission-sheet-perm-net.http"]')).not.toBeNull()
  })

  it('慢网连点防抖：approve 回执在途两按钮禁用（不二次回传、不覆盖动作标记——§6.20 通知与实际动作一致）', async () => {
    // 慢网形态：approve RPC 挂起不回执，手动 resolve 收尾
    let resolveApprove!: () => void
    mockApprove.mockReturnValue(new Promise<void>((res) => { resolveApprove = res }))
    wrapper = mountApp()
    emitPermissionRequest('p4', ['fs.read'])
    await nextTick()
    await nextTick()

    const approve = sheetQuery<HTMLElement>('[data-testid="permission-sheet-approve"]')!
    const deny = sheetQuery<HTMLElement>('[data-testid="permission-sheet-deny"]')!
    await approve.click()
    expect(mockApprove).toHaveBeenCalledTimes(1)

    // 在途：两按钮 disabled（模板禁用 + 提交门控双保险），deny 不被发出
    expect(approve.hasAttribute('disabled')).toBe(true)
    expect(deny.hasAttribute('disabled')).toBe(true)
    await deny.click()
    await flushPromises()
    expect(mockDeny).not.toHaveBeenCalled()
    expect(mockApprove).toHaveBeenCalledTimes(1)

    // 回执成功 → pending 收尾（submitting 随之复位）
    resolveApprove()
    await flushPromises()
    expect(useMobilePermissionRequest().pending).toBe(false)
  })

  it('失败复位可重试：approve RPC 失败（BM3 error 显形）按钮恢复可用，重试成功收尾', async () => {
    mockApprove.mockRejectedValueOnce(new Error('ws down')).mockResolvedValueOnce(undefined)
    wrapper = mountApp()
    emitPermissionRequest('p5', ['fs.read'])
    await nextTick()
    await nextTick()

    const approve = sheetQuery<HTMLElement>('[data-testid="permission-sheet-approve"]')!
    await approve.click()
    await flushPromises()
    expect(useMobilePermissionRequest().error).toBe(true)
    // 失败复位：按钮不再禁用（Sheet 留层供重试，pending 保持 true）
    expect(approve.hasAttribute('disabled')).toBe(false)
    expect(useMobilePermissionRequest().pending).toBe(true)

    await approve.click()
    await flushPromises()
    expect(mockApprove).toHaveBeenCalledTimes(2)
    expect(useMobilePermissionRequest().pending).toBe(false)
    expect(useMobilePermissionRequest().error).toBe(false)
  })
})
