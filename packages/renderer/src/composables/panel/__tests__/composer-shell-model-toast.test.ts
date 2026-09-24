/**
 * composer-shell UI 路径错误→toast 包装直测（test-coverage SG-3 补防线）。
 *
 * 覆盖 onModelSelectUi / onThinkingSelectUi（composer-shell U4 包装，此前 6/6 全未覆盖）：
 * - core onModelSelect/onThinkingSelect reject → modelSwitchToastKey 单点映射 toast
 *   （已知专用码 + 未知码 general 兜底 + 后端 message 插值）
 * - 「不外抛」纪律：包装 resolve（await 不 reject），错误不上抛给模板绑定
 * - 成功路径不误报 toast
 * 键盘循环路径（原始 core 函数 + 内联 catch）归 composer-shortcut-actions.test.ts；
 * 文案 key 映射本体归 __tests__/model-switch-toast.test.ts（本文件只测壳层包装接线）。
 *
 * 装配形态：宿主组件 setup 内调 useComposerShell（core useComposerInjection 注册
 * onMounted，裸 effectScope 调用会产生 Vue lifecycle warn——挂真实组件实例消除）；
 * mock 骨架复用 helpers/composer-mount.ts（useChat/useNewTaskFlow/@/api/stores 四件套），
 * useComposerModelThinking 经部分 mock 注入可控 reject 源（唯一注入点，其余 core
 * composables 保持实装）。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/panel/__tests__/composer-shell-model-toast.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, defineComponent, effectScope, h, ref } from 'vue'
import { mount, enableAutoUnmount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import {
  composerApiModule,
  composerChatModule,
  composerChatStoreModule,
  composerFlowModule,
  composerSessionStoreModule,
} from '@/__tests__/helpers/composer-mount'
import {
  useComposerShell,
  type ComposerShellParams,
  type ComposerShellReturn,
} from '@/composables/panel/composer-shell'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'
import type { ProviderId } from '@taiji/shared'

// ── useComposerModelThinking 可控注入（reject 源；其余导出面保持实装）──
const modelThinking = vi.hoisted(() => ({
  onModelSelect: vi.fn((_payload: { modelId: string; provider: ProviderId }) => Promise.resolve()),
  onThinkingSelect: vi.fn((_level: string) => Promise.resolve()),
}))
vi.mock('@taiji/core/domain/composer', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const { ref } = await import('vue')
  return {
    ...actual,
    useComposerModelThinking: () => ({
      currentModelId: ref('prov/a'),
      currentThinkingLevel: ref('medium'),
      currentThinkingLevelMap: ref<string | undefined>(undefined),
      currentSupportedLevels: ref<string[] | undefined>(undefined),
      localThinkingLevel: ref<string | undefined>(undefined),
      switching: ref<unknown>(null),
      onModelSelect: modelThinking.onModelSelect,
      onThinkingSelect: modelThinking.onThinkingSelect,
      enterStagingMode: vi.fn(),
      exitStagingMode: vi.fn(),
      getStagingConfig: vi.fn(() => null),
    }),
  }
})

// ── toast spy（断言面：错误文案 + 恰一次）──
const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toastMock }))

// ── 公共 mock 骨架（helpers/composer-mount 单源转发）──
vi.mock('@/composables/features/chat/useChat', () => composerChatModule())
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => composerFlowModule())
vi.mock('@/api', () => composerApiModule())
vi.mock('@/stores/chat', () => composerChatStoreModule())
vi.mock('@/stores/session', () => composerSessionStoreModule())

/** 最小壳层参数（Composer.vue 局部状态的同构 stub；input/box ref 恒 null——不触发输入面） */
function shellParams(): ComposerShellParams {
  return {
    sessionIdRef: computed(() => 's1'),
    variantRef: computed(() => 'panel' as const),
    inputRef: ref(null),
    composerBoxRef: ref(null),
    draft: ref(''),
    isSending: ref(false),
    drafts: { getDraft: () => '', saveDraft: vi.fn(), deleteDraft: vi.fn() },
    isActive: computed(() => false),
    cmdOpen: ref(false),
  }
}

/** 宿主组件内装配壳层（真实组件实例：lifecycle/warn 干净），登记 wrapper 供 afterEach 统一卸载 */
const liveWrappers: VueWrapper[] = []
function mountShell(): ComposerShellReturn {
  let shell: ComposerShellReturn | null = null
  const Host = defineComponent({
    setup() {
      shell = useComposerShell(shellParams())
      return () => h('div')
    },
  })
  liveWrappers.push(mount(Host))
  return shell!
}

enableAutoUnmount(afterEach)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 单例首次创建放 active effect scope（onScopeDispose 注册 cleanup，防 Vue warn；
  // composer-smoke.test.ts 同款），并清空分区（单例跨用例共享）
  effectScope().run(() => {
    useCompactQueue()
  })
  useCompactQueue()._clearAllForTest()
})

describe('onModelSelectUi / onThinkingSelectUi 错误→toast 包装（U4 三纪律）', () => {
  it('模型切换 reject（已知专用码 MODEL_NOT_FOUND）→ 专用文案 toast，且不外抛（await resolve）', async () => {
    modelThinking.onModelSelect.mockRejectedValueOnce(
      Object.assign(new Error('model gone'), { code: 'MODEL_NOT_FOUND' }),
    )
    const shell = mountShell()

    // 「不外抛」纪律：包装吞错 resolve，模板绑定不产生 unhandled rejection
    await expect(
      shell.onModelSelect({ modelId: 'prov/b', provider: 'prov' as ProviderId }),
    ).resolves.toBeUndefined()

    expect(toastMock.error).toHaveBeenCalledTimes(1)
    // modelSwitchToastKey 单点映射：MODEL_NOT_FOUND → 专用文案（zh-CN 实文）
    expect(toastMock.error).toHaveBeenCalledWith('该模型已不存在，请重新选择')
  })

  it('模型切换 reject（未知码）→ general 兜底文案 + 后端 message 插值', async () => {
    modelThinking.onModelSelect.mockRejectedValueOnce(
      Object.assign(new Error('rpc boom'), { code: 'SOMETHING_ELSE' }),
    )
    const shell = mountShell()

    await expect(
      shell.onModelSelect({ modelId: 'prov/b', provider: 'prov' as ProviderId }),
    ).resolves.toBeUndefined()

    expect(toastMock.error).toHaveBeenCalledTimes(1)
    // 未知码落 general：'切换失败：{error}'，{error} = modelSwitchErrorMessage 提取的 message
    expect(toastMock.error).toHaveBeenCalledWith('切换失败：rpc boom')
  })

  it('档位切换 reject → 同款 toast 映射（onThinkingSelectUi 与 onModelSelectUi 同构）', async () => {
    modelThinking.onThinkingSelect.mockRejectedValueOnce(
      Object.assign(new Error('level boom'), { code: 'SESSION_ACTIVATE_TIMEOUT' }),
    )
    const shell = mountShell()

    await expect(shell.onThinkingSelect('high')).resolves.toBeUndefined()

    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error).toHaveBeenCalledWith('会话恢复超时，请稍后重试')
  })

  it('成功路径零 toast（不误报）', async () => {
    modelThinking.onModelSelect.mockResolvedValueOnce(undefined)
    modelThinking.onThinkingSelect.mockResolvedValueOnce(undefined)
    const shell = mountShell()

    await shell.onModelSelect({ modelId: 'prov/b', provider: 'prov' as ProviderId })
    await shell.onThinkingSelect('high')

    expect(toastMock.error).not.toHaveBeenCalled()
  })
})
