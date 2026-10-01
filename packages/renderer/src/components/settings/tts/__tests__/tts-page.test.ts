// @vitest-environment happy-dom
/**
 * TtsPage 组件单测（ai-voice-tts 任务书 u4 验收 2/4：表单控件存在性 + capabilities 失败禁用重试）。
 *
 * 控件存在性断言全部由 u1 mock 投影数据（@taiji/core/transport/mock/tts-data）驱动，对应
 * 任务书验收 2 清单：
 * - MiniMax：情感/效果器/词典/AIGC 水印渲染；指令控件不渲染（supportsInstructions=false）
 * - StepFun：voice_label（音色标签）渲染且置灰（perModel.voiceLabelSupported=false）；
 *   情感/声道/效果器/水印不渲染
 * - MiMo：语速/音量/音调置灰（null 三分支）；情感/声道/语言增强/词典/效果器不渲染
 * - 三家输出格式/比特率控件均不渲染（D9 死控件禁令）
 * - capabilities 失败：表单区禁用 + 重试入口恢复（不渲染半态枚举）
 * - 保存提交：configure 整对象 + apiKeys（有输入才带 / 'from-provider' 仅在点了带入时）
 * - 保存并测试：调 useTtsPlayer.speak（settings-tts-test 伪 id + 固定样句）
 *
 * mock 策略：vi.mock('@/api') 注入 tts spy（数据 fixture 取 core mock 投影）；useTtsPlayer
 * 注入可控桩；@taiji/ui/features/settings 用轻量 GroupCard stub（保留具名 slot）。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/settings/tts/__tests__/tts-page.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { MOCK_TTS_FORMS, mockDefaultTtsConfig } from '@taiji/core/transport/mock/tts-data'
import type { SanitizedTtsConfig, TtsFormModel } from '@taiji/shared'

// ── mock：@/api tts 门面 + useTtsPlayer + GroupCard ──────────────────────────
const ttsApiMock = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getCapabilities: vi.fn(),
  configure: vi.fn(),
}))
vi.mock('@/api', () => ({ tts: ttsApiMock }))

const playerMock = vi.hoisted(() => ({
  speak: vi.fn(),
  stop: vi.fn(),
  speakStateOf: vi.fn((): 'idle' | 'loading' | 'playing' => 'idle'),
}))
vi.mock('@/composables/features/chat/useTtsPlayer', () => ({
  SETTINGS_TTS_TEST_MESSAGE_ID: 'settings-tts-test',
  useTtsPlayer: () => playerMock,
}))

vi.mock('@taiji/ui/features/settings', () => ({
  GroupCard: {
    name: 'GroupCard',
    template: '<div data-testid="group-card"><slot name="head" /><slot name="actions" /><slot /></div>',
  },
}))

import TtsPage from '@/components/settings/tts/TtsPage.vue'
import { useToast } from '@/composables/useToast'
import { useTtsSpeechEnabled } from '@/components/settings/tts/use-tts-enabled'

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function formsFixture(): Record<'stepfun' | 'minimax' | 'mimo', TtsFormModel> {
  return clone(MOCK_TTS_FORMS)
}

function configFixture(): SanitizedTtsConfig {
  return mockDefaultTtsConfig()
}

let wrapper: ReturnType<typeof mount> | null = null

async function mountPage(): Promise<ReturnType<typeof mount>> {
  wrapper = mount(TtsPage)
  await flushPromises()
  return wrapper
}

/** 只换 getConfig 的 providerKeyAvailable（联动提示行用例），其余字段保持 mock 骨架。 */
function configWithKeyAvailable(pid: 'minimax' | 'mimo'): SanitizedTtsConfig {
  const config = configFixture()
  config.providers[pid].providerKeyAvailable = true
  return config
}

beforeEach(() => {
  vi.clearAllMocks()
  ttsApiMock.getConfig.mockImplementation(() => Promise.resolve({ config: configFixture() }))
  ttsApiMock.getCapabilities.mockImplementation(() => Promise.resolve({ forms: formsFixture() }))
  ttsApiMock.configure.mockImplementation(() => Promise.resolve({ ok: true, config: configFixture() }))
  playerMock.speakStateOf.mockReturnValue('idle')
  const { toasts } = useToast()
  toasts.value = []
  const { enabled, setEnabled } = useTtsSpeechEnabled()
  setEnabled(true)
  void enabled
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

const sel = (w: ReturnType<typeof mount>, testid: string) => w.find(`[data-testid="${testid}"]`)

/**
 * reka-ui Select 交互（先例 = system-page-smart-context.test.ts）：SelectContent 经
 * SelectPortal teleport 到 body 且仅 open 时挂载；Trigger 在 pointerdown 时打开，
 * happy-dom 下需显式 dispatch；选中项按可见文本点选（pointerup + click）。
 * 禁止事后清 body.innerHTML——Teleport 的 fragment 节点仍被 Vue 持有，强拆会在
 * 组件 unmount 时抛 nextSibling null。
 */
async function pickSelect(w: ReturnType<typeof mount>, triggerTestid: string, optionText: string): Promise<void> {
  const trigger = sel(w, triggerTestid).element as HTMLElement
  trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  trigger.click()
  await flushPromises()
  const options = Array.from(document.body.querySelectorAll('[role="option"]'))
  const target = options.find((o) => (o.textContent ?? '').includes(optionText))
  expect(target, `option "${optionText}" not found for ${triggerTestid}`).toBeTruthy()
  target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  target!.click()
  await flushPromises()
}

describe('表单控件存在性（u1 mock 投影数据驱动，验收 2）', () => {
  it('MiniMax（默认选中家）：情感/效果器/词典/水印/LaTeX 渲染；指令与音色标签不渲染', async () => {
    const w = await mountPage()
    // 投影 activeProvider = minimax
    expect(sel(w, 'tts-provider-card-minimax').attributes('aria-checked')).toBe('true')
    // 情感枚举（emotions ×9）与语言增强渲染
    expect(sel(w, 'tts-emotion-select-minimax').exists()).toBe(true)
    expect(sel(w, 'tts-lang-select-minimax').exists()).toBe(true)
    // 声道枚举（channels 单/双）渲染
    expect(sel(w, 'tts-channel-select-minimax').exists()).toBe(true)
    // 长尾：效果器档位 + 效果 + 词典行编辑器 + AIGC 水印开关（toggles 清单成员）
    expect(sel(w, 'tts-vm-minimax-pitch').exists()).toBe(true)
    expect(sel(w, 'tts-vm-effect-minimax').exists()).toBe(true)
    expect(sel(w, 'tts-pronunciation-add-minimax').exists()).toBe(true)
    expect(sel(w, 'tts-toggle-minimax-aigc_watermark').exists()).toBe(true)
    expect(sel(w, 'tts-toggle-minimax-latex_read').exists()).toBe(true)
    // MiniMax 无指令字段 → 指令控件不渲染（D1）；perModel 空 → 音色标签不渲染
    expect(sel(w, 'tts-instructions-input-minimax').exists()).toBe(false)
    expect(sel(w, 'tts-voicetag-select-minimax').exists()).toBe(false)
  })

  it('StepFun：voice_label 置灰；情感/声道/效果器/水印不渲染；指令/词典/文本归一渲染', async () => {
    const w = await mountPage()
    await sel(w, 'tts-provider-card-stepfun').trigger('click')
    await flushPromises()
    // voice_label：perModel 表非空 → 控件渲染；voiceLabelSupported=false → disabled + 置灰提示
    const voiceTag = sel(w, 'tts-voicetag-select-stepfun')
    expect(voiceTag.exists()).toBe(true)
    expect(voiceTag.attributes('disabled')).toBeDefined()
    expect(w.text()).toContain('当前模型不支持音色标签')
    // 指令（supportsInstructions=true）+ 词典 + 文本归一（toggles 成员）渲染
    const stepfunInstructions = sel(w, 'tts-instructions-input-stepfun')
    expect(stepfunInstructions.exists()).toBe(true)
    // perModel 显式条目：enabled 且 maxlength 按模型上限钳制（stepaudio-2.5-tts → 200）
    expect(stepfunInstructions.attributes('disabled')).toBeUndefined()
    expect(stepfunInstructions.attributes('maxlength')).toBe('200')
    expect(sel(w, 'tts-pronunciation-add-stepfun').exists()).toBe(true)
    expect(sel(w, 'tts-toggle-stepfun-text_normalization').exists()).toBe(true)
    // 枚举空数组 → 不渲染（emotions/channels/languages/效果器/水印/混合音色）
    expect(sel(w, 'tts-emotion-select-stepfun').exists()).toBe(false)
    expect(sel(w, 'tts-channel-select-stepfun').exists()).toBe(false)
    expect(sel(w, 'tts-lang-select-stepfun').exists()).toBe(false)
    expect(sel(w, 'tts-vm-effect-stepfun').exists()).toBe(false)
    expect(sel(w, 'tts-toggle-stepfun-aigc_watermark').exists()).toBe(false)
  })

  it('MiMo：语速/音量/音调置灰（null）；进阶整卡与情感/声道/语言增强不渲染', async () => {
    const w = await mountPage()
    await sel(w, 'tts-provider-card-mimo').trigger('click')
    await flushPromises()
    // 数值类 null = 置灰（渲染 disabled Select，非不渲染）
    for (const id of ['tts-speed-select-mimo', 'tts-volume-select-mimo', 'tts-pitch-select-mimo']) {
      const node = sel(w, id)
      expect(node.exists()).toBe(true)
      expect(node.attributes('disabled')).toBeDefined()
    }
    // 指令渲染（supportsInstructions=true）且可输入（perModel 无条目 = 默认支持无上限，不置灰）；
    // 词典/情感/声道/语言增强/效果器不渲染
    const mimoInstructions = sel(w, 'tts-instructions-input-mimo')
    expect(mimoInstructions.exists()).toBe(true)
    expect(mimoInstructions.attributes('disabled')).toBeUndefined()
    expect(mimoInstructions.attributes('maxlength')).toBeUndefined()
    expect(sel(w, 'tts-pronunciation-add-mimo').exists()).toBe(false)
    expect(sel(w, 'tts-emotion-select-mimo').exists()).toBe(false)
    expect(sel(w, 'tts-channel-select-mimo').exists()).toBe(false)
    expect(sel(w, 'tts-lang-select-mimo').exists()).toBe(false)
    expect(sel(w, 'tts-vm-effect-mimo').exists()).toBe(false)
  })

  it('三家输出格式与比特率控件均不渲染（D9：pcm 系内部固定，表单化即死控件）', async () => {
    const w = await mountPage()
    expect(w.findAll('[data-testid^="tts-format-"]').length).toBe(0)
    expect(w.findAll('[data-testid^="tts-bitrate-"]').length).toBe(0)
  })

  it('perModel 显式 null 条目 → 指令控件置灰（与「无条目默认支持」两形态区分，设计 §7.3）', async () => {
    const forms = formsFixture()
    forms.mimo.capabilities.perModel['mimo-v2.5-tts'] = { instructionMaxChars: null, voiceLabelSupported: true }
    ttsApiMock.getCapabilities.mockImplementation(() => Promise.resolve({ forms }))
    const w = await mountPage()
    await sel(w, 'tts-provider-card-mimo').trigger('click')
    await flushPromises()
    expect(sel(w, 'tts-instructions-input-mimo').attributes('disabled')).toBeDefined()
  })
})

describe('capabilities 拉取失败：表单禁用 + 重试（验收 4）', () => {
  it('getCapabilities reject → 失败条 + 重试入口，表单区不渲染半态枚举；重试成功恢复', async () => {
    ttsApiMock.getCapabilities.mockRejectedValueOnce(new Error('rpc down'))
    const w = await mountPage()
    expect(sel(w, 'tts-caps-failed').exists()).toBe(true)
    expect(sel(w, 'tts-caps-retry').exists()).toBe(true)
    // 半态不渲染：无表单投影时表单区整体缺席
    expect(sel(w, 'tts-emotion-select-minimax').exists()).toBe(false)
    // 已保存配置值展示不受影响（§7.5）：服务商卡片 Key 状态点来自 getConfig 正常渲染
    expect(sel(w, 'tts-provider-card-minimax').exists()).toBe(true)
    // 重试 → 恢复
    await sel(w, 'tts-caps-retry').trigger('click')
    await flushPromises()
    expect(sel(w, 'tts-caps-failed').exists()).toBe(false)
    expect(sel(w, 'tts-emotion-select-minimax').exists()).toBe(true)
    expect(ttsApiMock.getCapabilities).toHaveBeenCalledTimes(2)
  })
})

describe('保存提交与保存并测试', () => {
  it('保存：configure 整对象（providerId + config）+ 成功回读刷新表单 + toast', async () => {
    const w = await mountPage()
    // 用户改情感（MiniMax）
    await pickSelect(w, 'tts-emotion-select-minimax', '开心')
    await sel(w, 'tts-save').trigger('click')
    await flushPromises()
    expect(ttsApiMock.configure).toHaveBeenCalledTimes(1)
    const payload = ttsApiMock.configure.mock.calls[0][0] as { providerId: string; config: { model: string; vendor: Record<string, unknown> }; apiKeys?: Record<string, unknown> }
    expect(payload.providerId).toBe('minimax')
    expect(payload.config.model).toBe('speech-2.6-hd')
    expect((payload.config.vendor as Record<string, unknown>).voice_setting).toMatchObject({ emotion: 'happy' })
    // 成功 toast（zh-CN locale）
    expect(useToast().toasts.value.some((x) => x.message.includes('已保存'))).toBe(true)
  })

  it('apiKeys：有输入才带；清除按钮 → null；联动带入 → from-provider（仅 providerKeyAvailable 时可点）', async () => {
    // a) 手动粘贴 Key
    let w = await mountPage()
    await sel(w, 'tts-apikey-input-minimax').setValue('sk-test-123')
    await sel(w, 'tts-save').trigger('click')
    await flushPromises()
    let payload = ttsApiMock.configure.mock.calls[0][0] as { apiKeys?: Record<string, unknown> }
    expect(payload.apiKeys).toMatchObject({ minimax: 'sk-test-123' })
    // 未输入且未点动作 → apiKeys 缺席该家（不动）
    w.unmount()
    ttsApiMock.configure.mockClear()
    w = await mountPage()
    await sel(w, 'tts-save').trigger('click')
    await flushPromises()
    payload = ttsApiMock.configure.mock.calls[0][0] as { apiKeys?: Record<string, unknown> }
    expect(payload.apiKeys?.minimax).toBeUndefined()
    w.unmount()
    ttsApiMock.configure.mockClear()

    // b) 联动（MiniMax providerKeyAvailable=true）：提示行渲染 + 带入 → 'from-provider'
    ttsApiMock.getConfig.mockImplementation(() => Promise.resolve({ config: configWithKeyAvailable('minimax') }))
    w = await mountPage()
    expect(sel(w, 'tts-key-link-hint-minimax').exists()).toBe(true)
    // StepFun 恒不参与联动（providerKeyAvailable false → 提示行不渲染）
    expect(sel(w, 'tts-key-link-hint-stepfun').exists()).toBe(false)
    await sel(w, 'tts-key-bring-minimax').trigger('click')
    await sel(w, 'tts-save').trigger('click')
    await flushPromises()
    payload = ttsApiMock.configure.mock.calls[0][0] as { apiKeys?: Record<string, unknown> }
    expect(payload.apiKeys).toMatchObject({ minimax: 'from-provider' })
    w.unmount()

    // c) 清除：hasApiKey 家点清除 → null
    ttsApiMock.configure.mockClear()
    const clearedConfig = configFixture()
    clearedConfig.providers.minimax.hasApiKey = true
    ttsApiMock.getConfig.mockImplementation(() => Promise.resolve({ config: clearedConfig }))
    w = await mountPage()
    expect(sel(w, 'tts-apikey-clear-minimax').exists()).toBe(true)
    await sel(w, 'tts-apikey-clear-minimax').trigger('click')
    await sel(w, 'tts-save').trigger('click')
    await flushPromises()
    payload = ttsApiMock.configure.mock.calls[0][0] as { apiKeys?: Record<string, unknown> }
    expect(payload.apiKeys).toMatchObject({ minimax: null })
  })

  it('configure 返回 ok=false → 错误 toast（error 带因），不刷新表单', async () => {
    ttsApiMock.configure.mockResolvedValueOnce({ ok: false, error: 'unsupported form shape' })
    const w = await mountPage()
    await sel(w, 'tts-save').trigger('click')
    await flushPromises()
    expect(useToast().toasts.value.some((x) => x.message.includes('unsupported form shape'))).toBe(true)
  })

  it('保存并测试：保存成功后经 useTtsPlayer.speak 发固定样句（settings-tts-test 伪 id）', async () => {
    const w = await mountPage()
    await sel(w, 'tts-save-and-test').trigger('click')
    await flushPromises()
    expect(ttsApiMock.configure).toHaveBeenCalledTimes(1)
    expect(playerMock.speak).toHaveBeenCalledTimes(1)
    const [sessionId, messageId, text] = playerMock.speak.mock.calls[0] as [string | undefined, string, string]
    expect(sessionId).toBeUndefined()
    expect(messageId).toBe('settings-tts-test')
    expect(text).toBe('你好，我是太极语音助手。')
  })

  it('保存并测试在保存失败时不触发播放', async () => {
    ttsApiMock.configure.mockResolvedValueOnce({ ok: false, error: 'invalid_payload' })
    const w = await mountPage()
    await sel(w, 'tts-save-and-test').trigger('click')
    await flushPromises()
    expect(playerMock.speak).not.toHaveBeenCalled()
  })
})

describe('通用开关与服务商卡片', () => {
  it('总开关切换写入本地偏好（useTtsSpeechEnabled 共享状态）', async () => {
    const w = await mountPage()
    const switchNode = sel(w, 'tts-enabled-switch')
    expect(switchNode.exists()).toBe(true)
    // reka-ui Switch 通过 click 切换并 emit update:model-value（system-page-smart-context 先例）
    await switchNode.trigger('click')
    await flushPromises()
    const { enabled } = useTtsSpeechEnabled()
    expect(enabled.value).toBe(false)
  })

  it('切服务商：通用开关保留，表单区切换到对应家（三家独立记忆）', async () => {
    const w = await mountPage()
    expect(sel(w, 'tts-emotion-select-minimax').exists()).toBe(true)
    await sel(w, 'tts-provider-card-mimo').trigger('click')
    await flushPromises()
    expect(sel(w, 'tts-emotion-select-minimax').exists()).toBe(false)
    const mimoInstructions = sel(w, 'tts-instructions-input-mimo')
    expect(mimoInstructions.exists()).toBe(true)
    expect(mimoInstructions.attributes('disabled')).toBeUndefined()
    // 切回 MiniMax：情感选择（未保存编辑态）保留（SelectValue 显示选中项 label）
    await sel(w, 'tts-provider-card-minimax').trigger('click')
    await flushPromises()
    await pickSelect(w, 'tts-emotion-select-minimax', '悲伤')
    await sel(w, 'tts-provider-card-mimo').trigger('click')
    await flushPromises()
    await sel(w, 'tts-provider-card-minimax').trigger('click')
    await flushPromises()
    expect(sel(w, 'tts-emotion-select-minimax').text()).toContain('悲伤')
  })
})
