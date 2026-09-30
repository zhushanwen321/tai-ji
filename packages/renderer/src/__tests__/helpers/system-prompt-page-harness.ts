/**
 * 系统提示词域设置页测试共享 harness（settings/default-prompt-reference.test.ts 与
 * settings/system-prompt-page.test.ts 两文件逐字重复段单源；范式同 terminal-config-harness.ts
 * ——vi.mock 注册留在测试文件，工厂经顶层 import 转发本 helper 导出）。
 *
 * 收敛内容：SystemPromptConfig 类型 + 默认配置工厂 + config/settings 域捕获单例 +
 * '@/api' mock 工厂 + body 查询（$ / hasTestId）+ SettingsModal 挂载并切菜单（挂载槽）+
 * 生命周期（beforeEach 重置 / afterEach 卸载清 body）。
 *
 * SettingsModal 以参数传入而非本模块 import：组件依赖链会拉入 '@/api'，若在本模块
 * import 组件，工厂会在本模块初始化完成前执行（捕获单例 TDZ）；测试文件把组件作为
 * 实参在用例期传入（此时本模块已初始化），时序约束同 terminal-config-harness——本
 * helper 的 import 须排在任何会拉入 '@/api' 的 import（组件/@/composables）之前。
 *
 * vitest 按测试文件隔离模块图：捕获单例与挂载槽在每个测试文件内独立。
 */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { Component } from 'vue'
import { useToast } from '@/composables/useToast'
import { provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from './settings-transport-stub'
import { authEventCbs } from './oauth-auth-events-mock'

/** 系统提示词配置形状（replace / append 双卡） */
export interface SystemPromptConfig { // oe-exempt:20260930:test:测试 mock 的参数/返回值契约形状，捕获单例与默认工厂共用同一类型标注
  version: number
  replace: { enabled: boolean; prompt: string }
  append: { enabled: boolean; prompt: string }
}

/** 系统提示词默认配置（双卡 disabled + 空 prompt；getSystemPrompt / setSystemPrompt 基线） */
export function systemPromptDefaultConfig(): SystemPromptConfig {
  return { version: 1, replace: { enabled: false, prompt: '' }, append: { enabled: false, prompt: '' } }
}

/** config 域捕获单例（SettingsModal 全页树 mount 期最小消费集，各成员存在理由见行内注释） */
export const systemPromptConfigMock = {
  getSystemPrompt: vi.fn(() => Promise.resolve({ config: systemPromptDefaultConfig(), corrupted: false })),
  getSystemPromptSnapshot: vi.fn(() => Promise.resolve({ exists: false })),
  setSystemPrompt: vi.fn((cfg: SystemPromptConfig) => Promise.resolve({ config: cfg, corrupted: false })),
  listProviders: vi.fn(() => Promise.resolve({ providers: [] })),
  // SettingsModal → ProviderPage onMounted 按需刷新远程模型目录（缺则 unhandled rejection）
  refreshProviderCatalogs: vi.fn(() => Promise.resolve({ refreshed: [], failed: [] })),
  setSkillDirs: vi.fn(() => Promise.resolve()),
  setAgentDirs: vi.fn(() => Promise.resolve()),
  // wave-oauth：SettingsModal → ProviderPage → useProviderOAuth onMounted 订阅 4 个 auth.* 事件
  // （缺则 TypeError 崩 mount）；订阅捕获集单源在 oauth-auth-events-mock（ProviderPage 域测试同源）
  ...authEventCbs(),
  // P2：ProviderPage 默认 pill + 默认修复 toast（缺则 TypeError 崩 mount）
  onDefaultsWithSource: vi.fn(() => () => {}),
}

/** settings 域捕获单例（SettingsModal 外层 getSystem / updateSystem 消费面） */
const systemPromptSettingsMock = {
  getSystem: vi.fn(() => Promise.resolve({ locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue' })),
  updateSystem: vi.fn(() => Promise.resolve()),
}

/** '@/api' mock 工厂：config / settings 域转发捕获单例 + project 底盘（挂载期加载） */
export function systemPromptApiModule() {
  return {
    project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
    config: systemPromptConfigMock,
    settings: systemPromptSettingsMock,
  }
}

/** '@/i18n' mock 工厂：仅 stub setLocale，保留 t 行为（菜单 key 未翻译时回退 key） */
export async function systemPromptI18nModule(importOriginal: () => Promise<unknown>) {
  return { ...((await importOriginal()) as object), setLocale: vi.fn() }
}

/** 在 body 中查找元素并包装成 DOMWrapper（teleport/attachTo 目标查询；未找到即断言失败） */
export function $(selector: string): DOMWrapper<Element> {
  const node = document.body.querySelector(selector)
  expect(node).toBeTruthy()
  return new DOMWrapper(node!)
}

/** 检查 document.body 中是否存在指定 data-testid 的元素 */
export function hasTestId(id: string): boolean {
  return document.body.querySelector(`[data-testid="${id}"]`) !== null
}

/** 挂载槽：openSettingsModalPage 登记最近一次 wrapper，afterEach 统一卸载 */
let mounted: VueWrapper | null = null

/** 挂 SettingsModal（open=true，attachTo 供 teleport 查询）并点击「settings-nav-<menuId>」
 *  切到指定菜单，返回 wrapper。用 data-testid 定位，不依赖 nav button 索引——索引定位会
 *  因 nav 内新增非菜单按钮（如顶部退出按钮）而整体偏移，脆弱。 */
export async function openSettingsModalPage(modal: Component, menuId: string): Promise<VueWrapper> {
  const wrapper = mount(modal, { props: { open: true }, attachTo: document.body })
  mounted = wrapper
  await flushPromises()
  const btn = document.body.querySelector(`[data-testid="settings-nav-${menuId}"]`)
  expect(btn).toBeTruthy()
  btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
  return wrapper
}

/** 系统提示词域测试生命周期接线：beforeEach 重置（pinia / toast / 捕获单例计数 +
 *  SettingsTransport seam 桩）+ afterEach 卸载挂载槽并清 body teleport 残留。消费文件顶层调用一次。 */
export function setupSystemPromptPageHarness(): void {
  beforeEach(() => {
    setActivePinia(createPinia())
    const { toasts } = useToast()
    toasts.value = []
    systemPromptConfigMock.getSystemPrompt.mockClear()
    systemPromptConfigMock.setSystemPrompt.mockClear()
    systemPromptConfigMock.listProviders.mockClear()
    provideSettingsTransport(makeSettingsTransportStub(systemPromptConfigMock))
  })
  afterEach(() => {
    mounted?.unmount()
    mounted = null
    document.body.innerHTML = ''
  })
}
