/**
 * SystemCodemodeSection 测试（codemode u3，三视角）。
 *
 * 覆盖（D3 定死形态 + A1 读侧错误态）：
 *  - 默认开渲染：get 返回 enabled=true → Switch checked + 说明文案（生效时机「新启动的会话」）可见；
 *  - 开关切换调协议：点击 Switch → setCodemodeEnabled(false) 被调 + 乐观更新后以服务端终态校准；
 *  - 乐观写失败回滚：setCodemodeEnabled reject → Switch 回滚 + error toast；
 *  - 损坏错误态渲染（D3 定死形态逐项断言）：corruption 非空 → Switch 禁用 + 完整路径渲染 +
 *    修复指引含「无需重启」；corruptCopyPath=null 无副本提示；
 *  - 隔离副本提示：corruptCopyPath 非空 → 渲染副本路径；
 *  - 复制按钮：点击 → clipboard.writeText(filePath) + info toast；
 *  - 损坏拒入：set 返回 ok:false 信封 → Switch 转禁用 + Section 错误态驻留 + toast 含路径；
 *  - 加载失败 best-effort：get reject → 保持默认开不崩溃；
 *  - i18n 双语 key 对齐：zh-CN / en-US 的 codemode 键集一致（pre-commit locale sync 同口径）。
 *
 * mock 策略：SettingsTransport seam 桩（[C3] 测试打 seam，不 mock 路由链）+ useToast mock 捕获
 * + navigator.clipboard 桩（happy-dom 无实现）。
 *
 * 运行：npx vitest run src/__tests__/settings/codemode-section.test.ts（packages/renderer 目录）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub'
import type { CodemodeEnabledResult } from '@taiji/shared'

const transportApiMock = vi.hoisted(() => ({
  getCodemodeEnabled: vi.fn(),
  setCodemodeEnabled: vi.fn(),
}))
const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ info: toastMock.info, error: toastMock.error, warning: vi.fn() }),
}))

import SystemCodemodeSection from '@/components/settings/system/SystemCodemodeSection.vue'
import zhCN from '@/i18n/locales/zh-CN/settings'
import enUS from '@/i18n/locales/en-US/settings'

function makeI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: { 'zh-CN': { settings: zhCN } },
  })
}

function defaultEnabledFixture(): CodemodeEnabledResult {
  return { enabled: true, corruption: null }
}

function corruptionFixture(corruptCopyPath: string | null): CodemodeEnabledResult {
  return {
    enabled: false,
    corruption: { filePath: '/home/demo/.taiji-dev/agent/settings.json', corruptCopyPath },
  }
}

function mountSection() {
  return mount(SystemCodemodeSection, {
    global: { plugins: [makeI18n()] },
  })
}

/** navigator.clipboard 桩（happy-dom 无实现；configurable 供 afterEach 清除，同 composer-shortcut-actions 先例）。 */
const writeText = vi.fn()
Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

beforeEach(() => {
  vi.clearAllMocks()
  transportApiMock.getCodemodeEnabled.mockResolvedValue(defaultEnabledFixture())
  transportApiMock.setCodemodeEnabled.mockResolvedValue({ ok: true, enabled: false })
  provideSettingsTransport(
    makeSettingsTransportStub({
      getCodemodeEnabled: transportApiMock.getCodemodeEnabled,
      setCodemodeEnabled: transportApiMock.setCodemodeEnabled,
    }),
  )
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

describe('SystemCodemodeSection（codemode u3）', () => {
  it('默认开渲染：Switch checked + 说明文案含生效时机（新启动的会话）', async () => {
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="codemode-enabled-switch"]').attributes('data-state')).toBe('checked')
    // 使用者黑盒：说明文案可见（模型能力 + 生效时机，D3 文案定死语义）
    expect(wrapper.find('[data-testid="codemode-section"]').text()).toContain('配置随新启动的会话读取')
    // 非损坏态无错误块
    expect(wrapper.find('[data-testid="codemode-corruption-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('开关切换调协议：点击 → setCodemodeEnabled(false) 被调，服务端终态校准显示', async () => {
    const wrapper = mountSection()
    await flushPromises()

    await wrapper.find('[data-testid="codemode-enabled-switch"]').trigger('click')
    await flushPromises()

    expect(transportApiMock.setCodemodeEnabled).toHaveBeenCalledTimes(1)
    expect(transportApiMock.setCodemodeEnabled).toHaveBeenCalledWith(false)
    expect(wrapper.find('[data-testid="codemode-enabled-switch"]').attributes('data-state')).toBe('unchecked')
    wrapper.unmount()
  })

  it('乐观写失败回滚：setCodemodeEnabled reject → Switch 回滚 checked + error toast 含错误详情（失败路径 2 的目标文件路径）', async () => {
    const wrapper = mountSection()
    await flushPromises()

    // 权限异常形态（设计 §3.1 失败路径 2）：runtime handler_error 信封 message = Node fs
    // 错误原文（server.ts toErrorMessage 透传），含目标 settings.json 路径
    transportApiMock.setCodemodeEnabled.mockRejectedValueOnce(
      new Error(
        "EACCES: permission denied, rename '/home/demo/.pi/agent/settings.json.tmp-1' -> '/home/demo/.pi/agent/settings.json'",
      ),
    )
    await wrapper.find('[data-testid="codemode-enabled-switch"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="codemode-enabled-switch"]').attributes('data-state')).toBe('checked')
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error.mock.calls[0][0]).toContain('开关操作失败')
    expect(toastMock.error.mock.calls[0][0]).toContain('/home/demo/.pi/agent/settings.json')
    wrapper.unmount()
  })

  it('损坏错误态渲染（D3 定死形态）：Switch 禁用 + 完整路径 + 修复指引含「无需重启」+ 无副本提示', async () => {
    transportApiMock.getCodemodeEnabled.mockResolvedValue(corruptionFixture(null))
    const wrapper = mountSection()
    await flushPromises()

    // Switch 呈禁用态（D3 定死）
    const sw = wrapper.find('[data-testid="codemode-enabled-switch"]')
    expect(sw.attributes('disabled')).toBeDefined()
    expect(sw.attributes('data-state')).toBe('unchecked')

    // 错误文案行：settings.json 完整路径（复制按钮旁）
    expect(wrapper.find('[data-testid="codemode-corruption-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="codemode-corruption-path"]').text()).toBe('/home/demo/.taiji-dev/agent/settings.json')
    expect(wrapper.find('[data-testid="codemode-copy-path-btn"]').exists()).toBe(true)

    // 修复指引含「无需重启」字样（D3 定死文案）
    const guide = wrapper.find('[data-testid="codemode-corruption-guide"]').text()
    expect(guide).toContain('无需重启')
    expect(guide).toContain('修复或删除该文件')

    // corruptCopyPath=null → 无副本提示
    expect(wrapper.find('[data-testid="codemode-corrupt-copy-path"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('隔离副本提示：corruptCopyPath 非空 → 渲染副本路径（原内容找回入口）', async () => {
    transportApiMock.getCodemodeEnabled.mockResolvedValue(
      corruptionFixture('/home/demo/.taiji-dev/agent/settings.json.corrupt-1730000000000'),
    )
    const wrapper = mountSection()
    await flushPromises()

    const hint = wrapper.find('[data-testid="codemode-corrupt-copy-path"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('settings.json.corrupt-1730000000000')
    wrapper.unmount()
  })

  it('复制按钮：点击 → clipboard.writeText(filePath) + info toast', async () => {
    transportApiMock.getCodemodeEnabled.mockResolvedValue(corruptionFixture(null))
    const wrapper = mountSection()
    await flushPromises()

    writeText.mockResolvedValueOnce(undefined)
    await wrapper.find('[data-testid="codemode-copy-path-btn"]').trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith('/home/demo/.taiji-dev/agent/settings.json')
    expect(toastMock.info).toHaveBeenCalledWith('路径已复制')
    wrapper.unmount()
  })

  it('损坏拒入：set 返回 ok:false 信封 → Switch 转禁用 + 错误态驻留 Section + toast 含路径', async () => {
    const wrapper = mountSection()
    await flushPromises()

    transportApiMock.setCodemodeEnabled.mockResolvedValueOnce({
      ok: false,
      error: 'settings.json corrupted',
      corruption: { filePath: '/home/demo/.taiji-dev/agent/settings.json', corruptCopyPath: null },
    })
    await wrapper.find('[data-testid="codemode-enabled-switch"]').trigger('click')
    await flushPromises()

    // 错误态驻留 Section（不止于 toast）：Switch 禁用 + 错误文案行渲染
    const sw = wrapper.find('[data-testid="codemode-enabled-switch"]')
    expect(sw.attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="codemode-corruption-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="codemode-corruption-path"]').text()).toContain('settings.json')
    // toast 同信息（含路径）
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error.mock.calls[0][0]).toContain('/home/demo/.taiji-dev/agent/settings.json')
    wrapper.unmount()
  })

  it('加载失败 best-effort：get reject → 保持默认开不崩溃（开关仍可操作）', async () => {
    transportApiMock.getCodemodeEnabled.mockRejectedValueOnce(new Error('rpc down'))
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="codemode-enabled-switch"]').attributes('data-state')).toBe('checked')
    expect(wrapper.find('[data-testid="codemode-corruption-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('i18n 双语 key 对齐：zh-CN 与 en-US 的 codemode 键集一致', () => {
    const zhKeys = Object.keys((zhCN as Record<string, Record<string, string>>).system)
      .filter((k) => k.startsWith('codemode')).sort()
    const enKeys = Object.keys((enUS as Record<string, Record<string, string>>).system)
      .filter((k) => k.startsWith('codemode')).sort()
    expect(enKeys).toEqual(zhKeys)
    // 键集非空（防对齐断言对空集恒真）
    expect(zhKeys.length).toBeGreaterThan(0)
  })
})
