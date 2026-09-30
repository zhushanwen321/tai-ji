/**
 * SettingsModal 首屏冒烟（W4 · AC12 渲染 gate）。
 *
 * 验证 useSettingsShell 壳接入后 SettingsModal 能渲染关键 DOM（AGENTS.md 测试规范 §8）：
 * mount SettingsModal(open=true)，providePlatform(in-memory) + provideSettingsTransport(stub)
 * + provide ui 注入 key stub + mock @/api 门面（避免 WS），断言：
 *   ① Dialog 内容渲染（标题 + 导航）
 *   ② provider 导航项存在（settings-nav-provider）
 *   ③ 默认 provider 页区渲染（ProviderPage 表单区）
 *
 * 另含（原独立文件 settings-modal-skill-dirs.test.ts 并入，同 mount 脚手架）：
 * W2 · D10 回归——onUpdateSkillDirs 的 transport.setSkillDirs reject 时 error toast
 * 反馈（非静默吞，AGENTS.md 规则 #3）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/settings-modal-smoke.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import {
  providePlatform,
  provideSettingsTransport,
  __resetPlatformForTesting,
  provideSettingsStore,
  createSettingsStore,
} from '@taiji/core'
import {
  SETTINGS_TOAST_KEY,
  QUOTA_CONFIGURE_FACTORY_KEY,
} from '@taiji/ui/features/settings'

// @/api 门面 mock：所有 config/extension/model/settings 域返回空/resolved，避免 WS 调用。
// 成员面单源在 helpers/settings-modal-api-mock.ts（成员存在理由注释亦在该文件）。
vi.mock('@/api', () => settingsModalApiModule())

// lib/ipc mock：SystemPage/TerminalPage 读 systemSounds 等 ipc，避免 electronAPI 缺失报错。
vi.mock('@/lib/ipc', () => ({
  listSystemSounds: vi.fn(async () => ({ sounds: [] })),
  getProxyConfig: vi.fn(async () => ({})),
  setProxyConfig: vi.fn(async () => undefined),
  testProxy: vi.fn(async () => ({ success: true })),
  // SettingsResourcePage forcedDirs 动态化调用（返回 undefined → user 级强制目录不展示）
  getDataDir: vi.fn(async () => undefined),
  // 目录选择（SystemPage chooseDirectory）
  chooseDirectory: vi.fn(async () => null),
}))

// '@/api' mock 工厂 import 必须先于组件 import 求值：SettingsModal 模块图加载 '@/api' 时
// vi.mock 工厂立即执行，晚于组件 import 的工厂绑定仍在 TDZ（vi.hoisted 同族坑）。
import { settingsModalApiModule } from '../helpers/settings-modal-api-mock'
import { inMemoryStorage } from '../helpers/platform-storage-stub'
import SettingsModal from '@/components/settings/SettingsModal.vue'
import SettingsResourcePage from '@/components/settings/resource/SettingsResourcePage.vue'
import { makeQuotaModuleStub } from '@taiji/core/testing'
import type { SkillDirConfig } from '@taiji/shared'
import { useToast } from '@/composables/useToast'
import { getSettingsStore } from '@taiji/core'
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub'

/** 挂载 open=true 的 SettingsModal（spy toast provide：toast 三面用 spy，不桥接 useToast；
 *  quota 工厂键保留 InjectionKey 类型，契约门由 makeQuotaModuleStub 的 QuotaConfigureModule
 *  返回标注承担，契约漏成员即编译错）。 */
function mountOpenModalWithSpyToasts(): ReturnType<typeof mount> {
  return mount(SettingsModal, {
    props: { open: true },
    attachTo: document.body,
    global: {
      provide: {
        [SETTINGS_TOAST_KEY as symbol]: { error: vi.fn(), info: vi.fn(), warning: vi.fn() },
        [QUOTA_CONFIGURE_FACTORY_KEY]: () => makeQuotaModuleStub(),
      },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  __resetPlatformForTesting()
  provideSettingsStore(createSettingsStore())
})

// 懒加载语义测试断言 document.activeElement，用例间必须卸载 teleport 到 body 的挂载件
enableAutoUnmount(afterEach)

describe('SettingsModal 首屏冒烟（AC12 渲染 gate）', () => {
  it('open=true 时渲染 Dialog 标题 + provider 导航项 + provider 页区', async () => {
    providePlatform({
      kind: 'mock',
      storage: inMemoryStorage(),
      webSocket: { create: () => ({ readyState: 0, send: () => {}, close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null }) },
    })
    provideSettingsTransport(makeSettingsTransportStub())

    mountOpenModalWithSpyToasts()
    await flushPromises()

    // ① Dialog 标题渲染（settings.title → 中文「设置」）
    const body = document.body.textContent ?? ''
    expect(body).toContain('设置')
    // ② provider 导航项存在（Dialog 内容 teleport 到 document.body，用 DOM 查询）
    expect(document.body.querySelector('[data-testid="settings-nav-provider"]')).not.toBeNull()
    // ③ provider 页区渲染（ProviderPage「添加供应商」按钮，i18n 中文）
    expect(body).toContain('添加') // settings.provider.add 含「添加」
  })
})

describe('SettingsModal 懒加载挂载即 open 的 open 语义（W31 review major-1 回归防护）', () => {
  it('挂载即 open=true：refreshProviders 被调用 + 首个 nav 项获得焦点', async () => {
    providePlatform({
      kind: 'mock',
      storage: inMemoryStorage(),
      webSocket: { create: () => ({ readyState: 0, send: () => {}, close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null }) },
    })
    // refreshProviders → getSettingsTransport().listProviders()（模块级单例）→ spy 在此
    const listProvidersSpy = vi.fn(async () => ({ providers: [] }))
    provideSettingsTransport({ ...makeSettingsTransportStub(), listProviders: listProvidersSpy })

    // 模拟 AppShell 懒加载场景：settingsOpen=true 与组件挂载同帧，props.open 初始即 true。
    // 修复前 watch 无 immediate，无变化沿 → 回调不执行 → refreshProviders/焦点初始化全部跳过。
    mountOpenModalWithSpyToasts()
    await flushPromises()

    // ① open 语义：providers 快照刷新被触发（settings-lifecycle「打开 modal 时刷新」契约）
    expect(listProvidersSpy).toHaveBeenCalledTimes(1)
    // ② 焦点语义：nextTick 后首个 nav 项（provider）获得焦点（键盘可达性）
    const firstNav = document.body.querySelector<HTMLElement>('[data-testid="settings-nav-provider"]')
    expect(firstNav).not.toBeNull()
    expect(document.activeElement).toBe(firstNav)
  })
})

describe('SettingsModal onUpdateSkillDirs 错误反馈（W2 D10，原 settings-modal-skill-dirs.test.ts 并入）', () => {
  it('transport.setSkillDirs reject → 触发 error toast（非静默失败）', async () => {
    providePlatform({
      kind: 'mock',
      storage: inMemoryStorage(),
      webSocket: { create: () => ({ readyState: 0, send: () => {}, close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null }) },
    })
    provideSettingsTransport(makeSettingsTransportStub({ setSkillDirs: () => Promise.reject(new Error('network down')) }))

    // toast 断言走真实 useToast 单例（SETTINGS_TOAST_KEY 桥接到 useToast）
    const { toasts } = useToast()
    toasts.value = []

    const wrapper = mount(SettingsModal, {
      props: { open: true },
      attachTo: document.body,
      global: {
        provide: {
          [SETTINGS_TOAST_KEY as symbol]: { error: (m: string) => useToast().error(m), info: (m: string) => useToast().info(m), warning: (m: string) => useToast().warning(m) },
          // 不再 `as symbol` 强转：保留 InjectionKey 类型；契约门由 makeQuotaModuleStub 的
          // QuotaConfigureModule 返回标注承担（契约漏成员即编译错）。
          [QUOTA_CONFIGURE_FACTORY_KEY]: () => makeQuotaModuleStub(),
        },
      },
    })
    await flushPromises()

    // 切到 skill 菜单（SettingsResourcePage 在 skill 菜单下渲染）
    const skillBtn = document.body.querySelector('[data-testid="settings-nav-skill"]')
    expect(skillBtn).toBeTruthy()
    skillBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    const resourcePage = wrapper.findComponent(SettingsResourcePage)
    expect(resourcePage.exists()).toBe(true)
    const dirs: SkillDirConfig[] = [{ path: '/x', enabled: true, scope: 'global' }]
    resourcePage.vm.$emit('update-dirs', dirs)
    await flushPromises()

    // 断言：error toast 已产生（非静默吞）
    expect(toasts.value.some((t) => t.type === 'error')).toBe(true)
    expect(toasts.value.some((t) => t.message.includes('network down'))).toBe(true)
  })
})

describe('SettingsModal 路径保存失败回弹（RD-4#1：失败强制回弹 UI + LoadPaths 常驻错误态）', () => {
  /**
   * 权威值源说明：dirs 域无 getter RPC（协议仅 set + 成功后广播），store 的 *Dirs 镜像只被
   * runtime 成功落盘后的广播写入，故镜像恒为「最近落盘值」。失败回弹 = LoadPaths 从该镜像
   * 重拉（saveError 通道驱动），行为级断言即「勾选态回弹 + 常驻红字」。
   */
  function mountModalWithFailingSkillDirs(): ReturnType<typeof mount> {
    providePlatform({
      kind: 'mock',
      storage: inMemoryStorage(),
      webSocket: { create: () => ({ readyState: 0, send: () => {}, close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null }) },
    })
    provideSettingsTransport(makeSettingsTransportStub({ setSkillDirs: () => Promise.reject(new Error('disk full')) }))
    return mount(SettingsModal, {
      props: { open: true },
      attachTo: document.body,
      global: {
        provide: {
          [SETTINGS_TOAST_KEY as symbol]: { error: (m: string) => useToast().error(m), info: (m: string) => useToast().info(m), warning: (m: string) => useToast().warning(m) },
          [QUOTA_CONFIGURE_FACTORY_KEY]: () => makeQuotaModuleStub(),
        },
      },
    })
  }

  it('skill 页勾选目录保存失败 → toast + 常驻红字 + 勾选态回弹至最近落盘值', async () => {
    // store 镜像预置最近落盘值（enabled:false——广播镜像即磁盘态）
    const persisted: SkillDirConfig[] = [{ path: '/persisted/skills', enabled: false, scope: 'global' }]
    getSettingsStore().skillDirs.value = persisted

    const { toasts } = useToast()
    toasts.value = []

    mountModalWithFailingSkillDirs()
    await flushPromises()

    // 切到 skill 菜单（SettingsResourcePage + LoadPaths 在该菜单下渲染）
    const skillBtn = document.body.querySelector('[data-testid="settings-nav-skill"]')
    expect(skillBtn).toBeTruthy()
    skillBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    // 用户勾选目录（LoadPaths 乐观编辑 → emit → 持久化 RPC reject）
    const checkbox = document.body.querySelector<HTMLElement>('[data-testid="dir-row"] button[role="checkbox"]')
    expect(checkbox).not.toBeNull()
    expect(checkbox!.getAttribute('data-state')).toBe('unchecked')
    checkbox!.click()
    await flushPromises()

    // 失败显形（三层）：error toast + 常驻红字 + 勾选态回弹（最近落盘值 enabled:false）
    expect(toasts.value.some((t) => t.type === 'error' && t.message.includes('disk full'))).toBe(true)
    expect(document.body.querySelector('[data-testid="load-paths-save-error"]')).not.toBeNull()
    expect(checkbox!.getAttribute('data-state')).toBe('unchecked')
  })
})
