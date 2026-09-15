/**
 * OAuthDialog 组件单测（feat-optimize-ui · 路径 B 前端 · slice design I4）。
 *
 * 覆盖验收标准：
 * ① 首屏 idle 态：登录按钮存在（用户可见断言）
 * ② device pending 态：user_code 元素存在且文本正确 + 复制按钮存在
 * ③ callback pending 态：本地端口提示存在
 * ④ success 态：✓ 已授权文本存在（+ 自动关闭）
 * ⑤ error 态：错误信息 + 重试按钮存在
 * ⑥ 交互：点取消 → emit oauth-cancel；点登录 → emit oauth-login
 *
 * 测试模式：reka Dialog 经 Portal teleport 到 document.body，mount attachTo body 后
 * 用 document.body.querySelector 查询；点击用原生 HTMLElement.click()（Vue @click 监听
 * 原生 click event）。i18n 经 vitest.setup mock（t 返回 key，命名参数 append 值）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/settings/__tests__/OAuthDialog.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import OAuthDialog from '../provider/OAuthDialog.vue'

// ui 包 typecheck 用 plain tsc（*.vue shim 不导出命名类型），状态类型本地定义不跨 .vue 导入
type Status = 'idle' | 'pending' | 'success' | 'error'

interface MountOverrides {
  open?: boolean
  provider?: {
    id: string
    name: string
    oauthName?: string
    oauthConfig?: { flow: string; callbackPort?: number }
  } | null
  status?: Status
  deviceInfo?: { userCode: string; verificationUri: string; expiresIn?: number } | null
  authUrl?: { url: string; callbackPort?: number } | null
  errorMessage?: string
  authorized?: boolean
}

async function mountDialog(overrides: MountOverrides = {}) {
  const w = mount(OAuthDialog, {
    props: {
      open: true,
      provider: { id: 'openrouter', name: 'OpenRouter', oauthName: 'OpenRouter' },
      status: 'idle',
      ...overrides,
    },
    attachTo: document.body,
  })
  // reka Dialog 经 Portal 异步渲染到 body，需 flushPromises 等待 portal 挂载
  await flushPromises()
  return w
}

/** body 内元素点击（portal 内容触发 Vue @click） */
function clickBody(selector: string): void {
  const el = document.body.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`body 元素未找到: ${selector}`)
  el.click()
}

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  wrapper = null
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('OAuthDialog', () => {
  it('首屏 idle 态：Dialog + 登录按钮存在（用户可见断言）', async () => {
    wrapper = await mountDialog()
    // 弹窗容器存在
    expect(document.body.querySelector('[data-testid="oauth-dialog"]')).toBeTruthy()
    // 登录按钮存在且文本指向 provider 名（mock t 返回 key + append 命名值）
    const loginBtn = document.body.querySelector<HTMLElement>('[data-testid="oauth-login"]')
    expect(loginBtn).toBeTruthy()
    expect(loginBtn!.textContent).toContain('settings.provider.oauthDialog.login')
    expect(loginBtn!.textContent).toContain('OpenRouter')
    // idle 态不渲染 pending/success/error 分支
    expect(document.body.querySelector('[data-testid="oauth-pending"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="oauth-success"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="oauth-error"]')).toBeNull()
  })

  it('idle 已授权态：显示 ✓ 已授权 + 重新授权按钮', async () => {
    wrapper = await mountDialog({ authorized: true })
    const authorized = document.body.querySelector('[data-testid="oauth-authorized"]')
    expect(authorized).toBeTruthy()
    const loginBtn = document.body.querySelector<HTMLElement>('[data-testid="oauth-login"]')
    expect(loginBtn!.textContent).toContain('settings.provider.oauthDialog.reauthorize')
  })

  it('device pending 态：user_code 文本正确 + 复制按钮 + 打开浏览器按钮存在', async () => {
    wrapper = await mountDialog({
      status: 'pending',
      deviceInfo: {
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://openrouter.ai/device',
        expiresIn: 300,
      },
    })
    const codeEl = document.body.querySelector('[data-testid="oauth-user-code"]')
    expect(codeEl).toBeTruthy()
    // 验证码文本 = 事件 payload 原样展示
    expect(codeEl!.textContent).toBe('ABCD-EFGH')
    expect(document.body.querySelector('[data-testid="oauth-copy-code"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="oauth-open-browser"]')).toBeTruthy()
    // 倒计时展示（expiresIn 推进）
    const countdown = document.body.querySelector('[data-testid="oauth-countdown"]')
    expect(countdown).toBeTruthy()
    expect(countdown!.textContent).toContain('300')
  })

  it('callback pending 态：打开浏览器授权按钮 + 本地端口提示存在', async () => {
    wrapper = await mountDialog({
      provider: { id: 'openrouter', name: 'OpenRouter', oauthConfig: { flow: 'callback', callbackPort: 53692 } },
      status: 'pending',
      authUrl: { url: 'https://openrouter.ai/auth', callbackPort: 53692 },
    })
    expect(document.body.querySelector('[data-testid="oauth-open-browser"]')).toBeTruthy()
    const portHint = document.body.querySelector('[data-testid="oauth-callback-port"]')
    expect(portHint).toBeTruthy()
    // 端口提示含实际端口（mock t：key + append 命名值）
    expect(portHint!.textContent).toContain('53692')
  })

  it('success 态：✓ 已授权文本存在', async () => {
    wrapper = await mountDialog({ status: 'success' })
    const success = document.body.querySelector('[data-testid="oauth-success"]')
    expect(success).toBeTruthy()
    expect(success!.textContent).toContain('settings.provider.oauthDialog.success')
  })

  it('success 态自动关闭：1.2s 后 emit update:open false', async () => {
    vi.useFakeTimers()
    wrapper = await mountDialog({ status: 'success' })
    vi.advanceTimersByTime(1300)
    expect(wrapper.emitted('update:open')).toBeTruthy()
  })

  it('error 态：错误信息 + 重试按钮 + 取消按钮存在', async () => {
    wrapper = await mountDialog({ status: 'error', errorMessage: 'access_denied' })
    const error = document.body.querySelector('[data-testid="oauth-error"]')
    expect(error).toBeTruthy()
    // 错误信息为事件 payload 原样展示（用户可见）
    expect(error!.textContent).toContain('access_denied')
    expect(document.body.querySelector('[data-testid="oauth-retry"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="oauth-cancel"]')).toBeTruthy()
  })

  it('点登录按钮 → emit oauth-login', async () => {
    wrapper = await mountDialog()
    clickBody('[data-testid="oauth-login"]')
    expect(wrapper.emitted('oauth-login')).toBeTruthy()
  })

  it('点取消按钮 → emit oauth-cancel（idle 态）', async () => {
    wrapper = await mountDialog()
    clickBody('[data-testid="oauth-cancel"]')
    expect(wrapper.emitted('oauth-cancel')).toBeTruthy()
  })

  it('error 态点重试 → emit oauth-login；点取消 → emit oauth-cancel', async () => {
    wrapper = await mountDialog({ status: 'error', errorMessage: 'timeout' })
    clickBody('[data-testid="oauth-retry"]')
    expect(wrapper.emitted('oauth-login')).toBeTruthy()
    clickBody('[data-testid="oauth-cancel"]')
    expect(wrapper.emitted('oauth-cancel')).toBeTruthy()
  })
})
