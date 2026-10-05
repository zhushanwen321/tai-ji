/**
 * RemoteAccessPage · 远程访问设置页测试。
 *
 * 覆盖（design remote-use-mobile §3.1 成功路径 1-2 步 + U1.5 验收）：
 *  - 关态渲染：开关 unchecked + 连接入口区不渲染
 *  - 开态渲染：完整链接含 `?token=`、二维码 img src 经 qrcode toDataURL 生成、复制按钮在
 *  - 开关切换确认流：点击开关先弹「重启 runtime 生效」确认（不直调 IPC），确认后调
 *    setRemoteAccessEnabled 并以返回值刷新连接信息
 *  - 轮换流：点轮换按钮 → rotateRemoteAccessToken 被调 + 链接 token 刷新 + info toast
 *  - 复制按钮：clipboard.writeText 收到完整链接
 *  - 多地址：urls > 1 时渲染地址选择器且默认选中首个候选
 *  - 多地址切换跟随：下拉选中另一候选后，链接文本 / QR 生成入参 / 复制内容跟随新地址
 *
 * Mock 策略：
 *  - vi.mock('@/lib/ipc') 提供三方法 stub（组件唯一 IPC 消费面）
 *  - vi.mock('qrcode') 固定 toDataURL 返回（二维码生成是外部纯函数，断言 img src 转发）
 *  - useToast 用真实单例（toasts.value 断言，与 settings-modal-smoke 同形态）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/remote-access-page.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const ipcMocks = vi.hoisted(() => ({
  getRemoteAccessInfo: vi.fn(),
  rotateRemoteAccessToken: vi.fn(),
  setRemoteAccessEnabled: vi.fn(),
}))

vi.mock('@/lib/ipc', () => ipcMocks)

const qrMocks = vi.hoisted(() => ({
  toDataURL: vi.fn(),
}))

vi.mock('qrcode', () => ({ default: qrMocks }))

import RemoteAccessPage from '@/components/settings/remote-access/RemoteAccessPage.vue'
import { useToast } from '@/composables/useToast'
import { pickRekaOption } from '../helpers/reka-select-harness'
import type { RemoteAccessInfo, RemoteAccessToggleResult } from '@taiji/shared'

function makeInfo(overrides: Partial<RemoteAccessInfo> = {}): RemoteAccessInfo {
  return { enabled: false, token: '', createdAt: '2026-09-19T00:00:00Z', urls: [], mobileDistReady: true, ...overrides }
}

const ENABLED_INFO: RemoteAccessInfo = {
  enabled: true,
  token: 'a'.repeat(64),
  createdAt: '2026-09-19T00:00:00Z',
  urls: [{ url: 'http://192.168.1.5:3210', kind: 'lan' }],
  mobileDistReady: true,
}

const FAKE_QR = 'data:image/png;base64,FAKEQR'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  ipcMocks.getRemoteAccessInfo.mockReset()
  ipcMocks.rotateRemoteAccessToken.mockReset()
  ipcMocks.setRemoteAccessEnabled.mockReset()
  qrMocks.toDataURL.mockReset()
  qrMocks.toDataURL.mockResolvedValue(FAKE_QR)
  useToast().toasts.value = []
  // happy-dom 未实现 clipboard，逐用例注入 stub
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('RemoteAccessPage 关态渲染', () => {
  it('enabled=false：开关 unchecked，连接入口区与 Tailscale 指引不渲染', async () => {
    ipcMocks.getRemoteAccessInfo.mockResolvedValue(makeInfo())
    wrapper = mount(RemoteAccessPage)
    await flushPromises()

    expect(wrapper.find('[data-testid="remote-access-switch"]').attributes('data-state')).toBe('unchecked')
    expect(wrapper.find('[data-testid="remote-access-entry"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="remote-access-tailscale-hint"]').exists()).toBe(false)
  })
})

describe('RemoteAccessPage 开态渲染', () => {
  it('enabled=true：链接含 ?token=、二维码 img src 为 qrcode toDataURL 产物', async () => {
    ipcMocks.getRemoteAccessInfo.mockResolvedValue(ENABLED_INFO)
    wrapper = mount(RemoteAccessPage)
    await flushPromises()

    expect(wrapper.find('[data-testid="remote-access-switch"]').attributes('data-state')).toBe('checked')
    const urlEl = wrapper.find('[data-testid="remote-access-url"]')
    expect(urlEl.exists()).toBe(true)
    // 完整链接 = 地址候选 + remote token（design §3.1 第 2 步形态）
    expect(urlEl.text()).toBe(`http://192.168.1.5:3210/?token=${'a'.repeat(64)}`)
    // 二维码经 qrcode toDataURL 生成，img src 转发其产物，入参为完整链接
    const qr = wrapper.find('[data-testid="remote-access-qr"]')
    expect(qr.exists()).toBe(true)
    expect(qr.attributes('src')).toBe(FAKE_QR)
    expect(qrMocks.toDataURL).toHaveBeenCalledWith(
      `http://192.168.1.5:3210/?token=${'a'.repeat(64)}`,
      expect.anything(),
    )
    // 警告文案区渲染（design 指定文案 key）
    expect(wrapper.find('[data-testid="remote-access-warning"]').exists()).toBe(true)
    // 选中局域网候选（kind=lan）→ Tailscale 使用前提提示不渲染
    expect(wrapper.find('[data-testid="remote-access-tailscale-selected-hint"]').exists()).toBe(false)
    // 产物就绪（mobileDistReady=true）→ E5 警告条不渲染
    expect(wrapper.find('[data-testid="remote-access-dist-missing"]').exists()).toBe(false)
  })

  it('urls 为空（runtime 未运行）：渲染空态说明，不渲染链接与二维码', async () => {
    ipcMocks.getRemoteAccessInfo.mockResolvedValue(makeInfo({ enabled: true }))
    wrapper = mount(RemoteAccessPage)
    await flushPromises()

    expect(wrapper.find('[data-testid="remote-access-no-urls"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="remote-access-url"]').exists()).toBe(false)
  })

  it('E5 显形（AM1）：enabled 但 mobileDistReady=false → 渲染 role=alert 警告条（dev 文案指向恢复命令）', async () => {
    ipcMocks.getRemoteAccessInfo.mockResolvedValue(makeInfo({ enabled: true, mobileDistReady: false }))
    wrapper = mount(RemoteAccessPage)
    await flushPromises()

    const alert = wrapper.find('[data-testid="remote-access-dist-missing"]')
    expect(alert.exists()).toBe(true)
    expect(alert.attributes('role')).toBe('alert')
    // vitest 环境 import.meta.env.DEV=true → dev 文案（含本地恢复命令）；prod 文案分流在打包形态生效
    expect(alert.text()).toContain('pnpm --filter @taiji/mobile-renderer build')
  })

  it('多地址（Tailscale 优先排序由 main 侧保证）：默认选中数组首项，选中 Tailscale 项渲染使用前提提示', async () => {
    ipcMocks.getRemoteAccessInfo.mockResolvedValue(
      makeInfo({
        enabled: true,
        token: 'b'.repeat(64),
        // 形态对齐 main 侧枚举器输出：Tailscale 候选在前、局域网在后
        urls: [
          { url: 'http://100.82.44.102:3210', kind: 'tailscale' },
          { url: 'http://192.168.1.5:3210', kind: 'lan' },
        ],
      }),
    )
    wrapper = mount(RemoteAccessPage)
    await flushPromises()

    expect(wrapper.find('[data-testid="remote-access-url-select"]').exists()).toBe(true)
    // 默认选中数组首项（Tailscale 优先排序后的第一条）
    expect(wrapper.find('[data-testid="remote-access-url"]').text()).toBe(`http://100.82.44.102:3210/?token=${'b'.repeat(64)}`)
    // 选中 Tailscale 候选 → 使用前提提示渲染（下拉项切换交互归 reka Select 自身，此处验条件渲染分支）
    const hint = wrapper.find('[data-testid="remote-access-tailscale-selected-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('Tailscale')
  })

  it('多地址切换跟随：下拉选中另一候选后，链接文本 / QR 生成入参 / 复制内容跟随新地址', async () => {
    ipcMocks.getRemoteAccessInfo.mockResolvedValue(
      makeInfo({
        enabled: true,
        token: 'b'.repeat(64),
        // 形态对齐 main 侧枚举器输出：Tailscale 候选在前、局域网在后
        urls: [
          { url: 'http://100.82.44.102:3210', kind: 'tailscale' },
          { url: 'http://192.168.1.5:3210', kind: 'lan' },
        ],
      }),
    )
    wrapper = mount(RemoteAccessPage)
    await flushPromises()

    // 起点：默认选中数组首项（Tailscale）
    expect(wrapper.find('[data-testid="remote-access-url"]').text()).toBe(
      `http://100.82.44.102:3210/?token=${'b'.repeat(64)}`,
    )

    // 用户经下拉点选第二个候选（LAN 地址）——reka Select 真实交互链
    //（pointerdown 开下拉 + option 点选，单源在 helpers/reka-select-harness）
    await pickRekaOption(wrapper.find('[data-testid="remote-access-url-select"]').element, 'http://192.168.1.5:3210')

    // ① 链接文本跟随新选中地址（含 token）
    expect(wrapper.find('[data-testid="remote-access-url"]').text()).toBe(
      `http://192.168.1.5:3210/?token=${'b'.repeat(64)}`,
    )
    // ② QR 生成入参跟随：最新一代 toDataURL 调用参数 = 新地址完整链接
    expect(qrMocks.toDataURL).toHaveBeenLastCalledWith(
      `http://192.168.1.5:3210/?token=${'b'.repeat(64)}`,
      expect.anything(),
    )
    // ③ 复制内容跟随：clipboard.writeText 收到新地址完整链接
    await wrapper.find('[data-testid="remote-access-copy"]').trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`http://192.168.1.5:3210/?token=${'b'.repeat(64)}`)
    // 选中 LAN 候选 → Tailscale 使用前提提示随之消失（selectedKind 跟随）
    expect(wrapper.find('[data-testid="remote-access-tailscale-selected-hint"]').exists()).toBe(false)
  })

  it('单条 Tailscale 地址（无下拉）：链接正常展示且使用前提提示仍渲染', async () => {
    ipcMocks.getRemoteAccessInfo.mockResolvedValue(
      makeInfo({ enabled: true, token: 'b'.repeat(64), urls: [{ url: 'http://100.82.44.102:3210', kind: 'tailscale' }] }),
    )
    wrapper = mount(RemoteAccessPage)
    await flushPromises()

    expect(wrapper.find('[data-testid="remote-access-url-select"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="remote-access-url"]').text()).toBe(`http://100.82.44.102:3210/?token=${'b'.repeat(64)}`)
    expect(wrapper.find('[data-testid="remote-access-tailscale-selected-hint"]').exists()).toBe(true)
  })
})

describe('RemoteAccessPage 开关切换确认流', () => {
  it('点击开关先弹「重启 runtime 生效」确认，不直调 IPC；确认后调 setRemoteAccessEnabled(true) 并刷新连接信息', async () => {
    ipcMocks.getRemoteAccessInfo.mockResolvedValue(makeInfo())
    const toggleResult: RemoteAccessToggleResult = { ...ENABLED_INFO, restarted: true }
    ipcMocks.setRemoteAccessEnabled.mockResolvedValue(toggleResult)
    wrapper = mount(RemoteAccessPage)
    await flushPromises()

    await wrapper.find('[data-testid="remote-access-switch"]').trigger('click')
    await flushPromises()

    // 确认对话框出现（确认文案含「重启 runtime 生效」），IPC 未被调
    expect(document.body.textContent).toContain('重启 runtime 生效')
    expect(ipcMocks.setRemoteAccessEnabled).not.toHaveBeenCalled()

    // 确认按钮（ConfirmDialog 内非 ghost 的确认 Button，默认文案「确认」）
    const confirmBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.trim() === '确认')
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(ipcMocks.setRemoteAccessEnabled).toHaveBeenCalledWith(true)
    // 返回值刷新连接信息：入口区以开态渲染，链接含 token
    expect(wrapper.find('[data-testid="remote-access-entry"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="remote-access-url"]').text()).toBe(`http://192.168.1.5:3210/?token=${'a'.repeat(64)}`)
    // 开关态随返回值更新
    expect(wrapper.find('[data-testid="remote-access-switch"]').attributes('data-state')).toBe('checked')
  })

  it('取消确认：不调 IPC，开关保持关态', async () => {
    ipcMocks.getRemoteAccessInfo.mockResolvedValue(makeInfo())
    wrapper = mount(RemoteAccessPage)
    await flushPromises()

    await wrapper.find('[data-testid="remote-access-switch"]').trigger('click')
    await flushPromises()

    const cancelBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.trim() === '取消')
    expect(cancelBtn).toBeTruthy()
    cancelBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(ipcMocks.setRemoteAccessEnabled).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="remote-access-switch"]').attributes('data-state')).toBe('unchecked')
  })
})

describe('RemoteAccessPage 轮换流', () => {
  it('点轮换按钮：rotateRemoteAccessToken 被调、链接以新 token 重渲染、info toast 反馈', async () => {
    ipcMocks.getRemoteAccessInfo.mockResolvedValue(ENABLED_INFO)
    const rotated: RemoteAccessInfo = { ...ENABLED_INFO, token: 'c'.repeat(64) }
    ipcMocks.rotateRemoteAccessToken.mockResolvedValue(rotated)
    wrapper = mount(RemoteAccessPage)
    await flushPromises()

    await wrapper.find('[data-testid="remote-access-rotate"]').trigger('click')
    await flushPromises()

    expect(ipcMocks.rotateRemoteAccessToken).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="remote-access-url"]').text()).toBe(`http://192.168.1.5:3210/?token=${'c'.repeat(64)}`)
    const { toasts } = useToast()
    expect(toasts.value.some((toast) => toast.type === 'info' && toast.message.includes('已轮换'))).toBe(true)
  })

  // code-harden 观测项：fullUrl 快速切换（轮换 token）时 QR 多代生成并发在途，
  // 旧一代慢返回不得覆盖新一代（ConnectionEntrySection 序列号守卫防回归）
  it('QR 竞态守卫：旧一代生成慢返回不覆盖新一代二维码', async () => {
    // 第一代（旧 token URL）挂起、第二代（新 token URL）即刻返回——复现乱序返回时序
    let resolveStale!: (value: string) => void
    const staleGeneration = new Promise<string>((resolve) => {
      resolveStale = resolve
    })
    qrMocks.toDataURL.mockReturnValueOnce(staleGeneration).mockReturnValueOnce(Promise.resolve('data:image/png;base64,QR-NEW'))

    ipcMocks.getRemoteAccessInfo.mockResolvedValue(ENABLED_INFO)
    const rotated: RemoteAccessInfo = { ...ENABLED_INFO, token: 'c'.repeat(64) }
    ipcMocks.rotateRemoteAccessToken.mockResolvedValue(rotated)
    wrapper = mount(RemoteAccessPage)
    await flushPromises()

    // 第一代仍在途时轮换 → fullUrl 变化触发第二代生成并落 QR-NEW
    await wrapper.find('[data-testid="remote-access-rotate"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="remote-access-qr"]').attributes('src')).toBe('data:image/png;base64,QR-NEW')

    // 旧一代此刻才返回：序列号守卫拦截，不得覆盖
    resolveStale('data:image/png;base64,QR-STALE')
    await flushPromises()
    expect(wrapper.find('[data-testid="remote-access-qr"]').attributes('src')).toBe('data:image/png;base64,QR-NEW')
  })
})

describe('RemoteAccessPage QR 失败降级', () => {
  // code-harden 降级显形修复：toDataURL 失败不得只留空白块——占位块渲染提示文案（引导复制链接兜底），
  // 链接/复制通路不受 QR 失败影响
  it('toDataURL reject：占位块渲染失败提示文案，不渲染二维码 img，链接仍可用', async () => {
    qrMocks.toDataURL.mockRejectedValue(new Error('qr boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    ipcMocks.getRemoteAccessInfo.mockResolvedValue(ENABLED_INFO)
    wrapper = mount(RemoteAccessPage)
    await flushPromises()

    expect(wrapper.find('[data-testid="remote-access-qr"]').exists()).toBe(false)
    const placeholder = wrapper.find('[data-testid="remote-access-qr-placeholder"]')
    expect(placeholder.exists()).toBe(true)
    expect(placeholder.text()).toContain('二维码生成失败')
    expect(placeholder.text()).toContain('链接')
    // 降级不吞主通路：链接与复制按钮照常渲染
    expect(wrapper.find('[data-testid="remote-access-url"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="remote-access-copy"]').exists()).toBe(true)
    warn.mockRestore()
  })
})

describe('RemoteAccessPage 复制链接', () => {
  it('点复制按钮：clipboard.writeText 收到完整链接（含 token）', async () => {
    ipcMocks.getRemoteAccessInfo.mockResolvedValue(ENABLED_INFO)
    wrapper = mount(RemoteAccessPage)
    await flushPromises()

    await wrapper.find('[data-testid="remote-access-copy"]').trigger('click')

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`http://192.168.1.5:3210/?token=${'a'.repeat(64)}`)
  })
})
