/**
 * RenameSessionPage 测试（rename-prompt-config，三视角）。
 *
 * 覆盖：
 *  - 首屏冒烟：页头 + 卡 1（开关/触发模式/模型/最大长度）+ 卡 2（风格/textarea）用户可见 DOM；
 *  - 触发模式：agent-tool 从 GUI 移除（下拉不含「agent 自主命名」）；首值回填；点选调 setRenameMode；
 *  - 标题模型：列表内 ref 显示模型名 / stale ref + （不可用）/ 未设置显示跟随；
 *    auto-rename 开关联动 disabled；下拉凭证过滤 + 点选 setRenameModel 收复合串；
 *  - 标题最大长度：默认 50；点选 80 → setRenameMaxLength(80)；
 *  - 标题提示词卡：slug 预览只读 + 三键禁用；custom 回填可编辑；编辑 → dirty → 保存调
 *    setRenamePrompt + 快照归零；放弃还原快照；恢复默认改草稿不写盘；超长禁存 + 计数警示
 *    （码点口径，含 emoji surrogate pair 边界）；getRenamePrompt 读失败禁用链 + 重试恢复；
 *    corrupted 提示条；参考折叠区内容（用户可见断言）。
 *
 * mock 策略：setupSystemPageTest 单源（pinia/store/seam mock 注入 + toast/ipc mock），
 * mount 分级：冒烟走 mountPage（全页编排回归锚，SystemPage 模块图经 beforeAll 预热），
 * 交互走 mountSection 直挂本页。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/settings/rename-session-page.test.ts
 */
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import {
  flushPromises,
  seedStore,
  setupSystemPageTest,
} from '../helpers/system-page-test-setup'

const { settingsMock, mountPage, mountSection, pageWrapper } = setupSystemPageTest(
  () => import('@/components/settings/rename-session/RenameSessionPage.vue'),
)

// SystemPage 模块图预热一次（h 类整治）：全树（7 Section + 头部）编译装载成本落文件级
// beforeAll，下方唯一的 mountPage 用例不再吸收装载成本。该用例不能改 mountSection 直挂：
// 断言对象是 SystemPage 编排 DOM 的否定形态（已迁出区块不出现），直挂 RenameSessionPage
// 时其根节点即携带 rename-session-page testid，否定断言恒假；且 mountSection 不 attach 到
// body，document.body.querySelector 形态断言会沦为恒真空转。vi.mock 注册在测试文件 import
// 期完成、先于本 hook，动态 import 保持 TDZ 安全（同 system-page-mount.mountSystemPage）。
beforeAll(() => import('@/components/settings/system/SystemPage.vue'))

/** 打开 reka Select 下拉（SelectTrigger pointerdown 开启，portal 挂 body；同 provider-edit-modal 模式）。 */
async function openSelect(testid: string): Promise<HTMLElement[]> {
  const trigger = pageWrapper()!.find(`[data-testid="${testid}"]`).element as HTMLElement
  trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  trigger.click()
  await flushPromises()
  return Array.from(document.body.querySelectorAll('[role="option"]'))
}

/** 点选下拉中含指定文案的 option。 */
async function pickOption(labels: HTMLElement[], text: string): Promise<void> {
  const target = labels.find((el) => (el.textContent ?? '').includes(text))
  expect(target, `option containing "${text}" should exist`).toBeTruthy()
  target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  target!.click()
  await flushPromises()
}

/** 指令计数用例共用：custom 风格（空指令）挂载，返回页面 wrapper。 */
async function mountCustomInstructionPage(): Promise<NonNullable<ReturnType<typeof pageWrapper>>> {
  settingsMock.getRenamePrompt.mockResolvedValue({ style: 'custom', instruction: '', corrupted: false })
  await mountSection()
  return pageWrapper()!
}

/**
 * 指令计数用例共用骨架：写入文本 → 断言计数文案、警示样式与保存键禁用态
 * （overLimit = 码点数超 2000 的期望形态）。
 */
async function assertCharCountState(
  w: NonNullable<ReturnType<typeof pageWrapper>>,
  text: string,
  expectedCount: string,
  overLimit: boolean,
): Promise<void> {
  await w.find('[data-testid="rename-instruction-input"]').setValue(text)
  expect(w.find('[data-testid="rename-instruction-charcount"]').text()).toContain(expectedCount)
  if (overLimit) {
    expect(w.find('[data-testid="rename-instruction-charcount"]').classes()).toContain('text-warn')
    expect(w.find('[data-testid="rename-prompt-save"]').attributes('disabled')).toBeDefined()
  } else {
    expect(w.find('[data-testid="rename-instruction-charcount"]').classes()).not.toContain('text-warn')
    expect(w.find('[data-testid="rename-prompt-save"]').attributes('disabled')).toBeUndefined()
  }
}

beforeEach(() => {
  seedStore()
})

describe('RenameSessionPage 首屏冒烟（迁移回归锚）', () => {
  it('SystemPage 编排下不再渲染自动重命名区块（已迁独立页），页头含新页入口不在此层断言', async () => {
    await mountPage()
    expect(document.body.querySelector('[data-testid="setting-auto-rename-session"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="rename-session-page"]')).toBeNull()
  })
})

describe('RenameSessionPage 直挂', () => {
  it('冒烟：开关 checked + 触发模式/模型/最大长度/风格/textarea 均渲染（用户可见 DOM）', async () => {
    await mountSection()
    const w = pageWrapper()!
    expect(w.find('[data-testid="rename-enabled-switch"]').attributes('data-state')).toBe('checked') // Switch on 态（开关默认开）
    expect(w.find('[data-testid="rename-trigger-mode"]').exists()).toBe(true)
    expect(w.find('[data-testid="rename-title-model"]').exists()).toBe(true)
    expect(w.find('[data-testid="rename-max-length"]').exists()).toBe(true)
    expect(w.find('[data-testid="rename-prompt-style"]').exists()).toBe(true)
    expect(w.find('[data-testid="rename-instruction-input"]').exists()).toBe(true)
    expect(w.text()).toContain('会话重命名')
  })

  it('触发模式下拉只含两档（agent-tool 从 GUI 移除，底层工具保留不受此影响）', async () => {
    await mountSection()
    const labels = await openSelect('rename-trigger-mode')
    const texts = labels.map((el) => el.textContent ?? '')
    expect(texts).toContain('首次请求时')
    expect(texts).toContain('首轮回复完成')
    expect(texts.join('|')).not.toContain('agent 自主命名')
  })

  it('getRenameMode 回填 first-prompt → trigger 显示「首次请求时」；点选 first-stop 调 setRenameMode', async () => {
    settingsMock.getRenameMode.mockResolvedValue({ mode: 'first-prompt' })
    await mountSection()
    expect(pageWrapper()!.find('[data-testid="rename-trigger-mode"]').text()).toContain('首次请求时')

    const labels = await openSelect('rename-trigger-mode')
    await pickOption(labels, '首轮回复完成')
    expect(settingsMock.setRenameMode).toHaveBeenCalledWith('first-stop')
  })

  it('模型 ref 在可选列表 → trigger 显示模型名；stale ref → 显示 ref +（不可用）', async () => {
    settingsMock.getRenameModel.mockResolvedValue({ model: 'p1/m1' })
    await mountSection()
    expect(pageWrapper()!.find('[data-testid="rename-title-model"]').text()).toContain('Model One')

    pageWrapper()!.unmount()
    settingsMock.getRenameModel.mockResolvedValue({ model: 'gone/model-x' })
    await mountSection()
    expect(pageWrapper()!.find('[data-testid="rename-title-model"]').text()).toContain('gone/model-x')
    expect(pageWrapper()!.find('[data-testid="rename-title-model"]').text()).toContain('（不可用）')
  })

  it('未设置模型 → trigger 显示「跟随会话模型」', async () => {
    await mountSection()
    expect(pageWrapper()!.find('[data-testid="rename-title-model"]').text()).toContain('跟随会话模型')
  })

  it('auto-rename 关 → 模型 trigger disabled；开 → 可用', async () => {
    settingsMock.getAutoRenameEnabled.mockResolvedValue({ enabled: false })
    await mountSection()
    expect(pageWrapper()!.find('[data-testid="rename-title-model"]').attributes('disabled')).toBeDefined()

    pageWrapper()!.unmount()
    settingsMock.getAutoRenameEnabled.mockResolvedValue({ enabled: true })
    await mountSection()
    expect(pageWrapper()!.find('[data-testid="rename-title-model"]').attributes('disabled')).toBeUndefined()
  })

  it('模型下拉只列已配凭证模型；点选 Model One → setRenameModel 收 "p1/m1"（迁移用例）', async () => {
    await mountSection()
    const labels = await openSelect('rename-title-model')
    const texts = labels.map((el) => el.textContent ?? '')
    expect(texts).toContain('Model One')
    expect(texts.join('|')).not.toContain('Model Two') // 无凭证 provider 过滤
    expect(texts).toContain('跟随会话模型')

    await pickOption(labels, 'Model One')
    expect(settingsMock.setRenameModel).toHaveBeenCalledWith('p1/m1')
  })

  it('最大长度默认 50；点选 80 → setRenameMaxLength(80)', async () => {
    await mountSection()
    expect(pageWrapper()!.find('[data-testid="rename-max-length"]').text()).toContain('50')

    const labels = await openSelect('rename-max-length')
    await pickOption(labels, '80')
    expect(settingsMock.setRenameMaxLength).toHaveBeenCalledWith(80)
  })
})

describe('标题提示词卡（风格 + 自定义指令 + 显式保存）', () => {
  it('默认 slug：textarea 只读预览内置模板，三键禁用（快照干净）', async () => {
    await mountSection()
    const w = pageWrapper()!
    const ta = w.find('[data-testid="rename-instruction-input"]')
    expect(ta.attributes('disabled')).toBeDefined()
    expect(ta.element.value).toContain('slug 式标题')
    for (const id of ['rename-prompt-discard', 'rename-prompt-reset', 'rename-prompt-save']) {
      expect(w.find(`[data-testid="${id}"]`).attributes('disabled')).toBeDefined()
    }
  })

  it('custom 回填：textarea 可编辑显示已存指令；示例行随风格切换', async () => {
    settingsMock.getRenamePrompt.mockResolvedValue({ style: 'custom', instruction: '生成不超过 12 字的中文标题', corrupted: false })
    await mountSection()
    const w = pageWrapper()!
    const ta = w.find('[data-testid="rename-instruction-input"]')
    expect(ta.attributes('disabled')).toBeUndefined()
    expect(ta.element.value).toBe('生成不超过 12 字的中文标题')
    expect(w.find('[data-testid="rename-style-example"]').text()).toContain('—') // custom 无固定示例

    // 切到 emoji：textarea 变只读预览，示例行显示 emoji 形态（用户可见反馈）
    const labels = await openSelect('rename-prompt-style')
    await pickOption(labels, 'Emoji 点缀')
    expect(w.find('[data-testid="rename-instruction-input"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="rename-style-example"]').text()).toContain('🔧')
  })

  it('编辑 → 三键启用 → 保存调 setRenamePrompt(custom, 文本) + 快照归零（按钮回禁用）', async () => {
    await mountSection()
    const w = pageWrapper()!
    // 切到 custom（style 变更即 dirty）
    const styles = await openSelect('rename-prompt-style')
    await pickOption(styles, '自定义…')
    expect(w.find('[data-testid="rename-prompt-save"]').attributes('disabled')).toBeUndefined()

    // 编辑指令
    await w.find('[data-testid="rename-instruction-input"]').setValue('新指令文本')
    expect(w.find('[data-testid="rename-prompt-discard"]').attributes('disabled')).toBeUndefined()

    await w.find('[data-testid="rename-prompt-save"]').trigger('click')
    await flushPromises()
    expect(settingsMock.setRenamePrompt).toHaveBeenCalledWith('custom', '新指令文本')
    // 保存后快照刷新 → 三键回禁用
    for (const id of ['rename-prompt-discard', 'rename-prompt-reset', 'rename-prompt-save']) {
      expect(w.find(`[data-testid="${id}"]`).attributes('disabled')).toBeDefined()
    }
  })

  it('放弃：还原已存快照（dirty 归零，不调 set）', async () => {
    settingsMock.getRenamePrompt.mockResolvedValue({ style: 'custom', instruction: '已存指令', corrupted: false })
    await mountSection()
    const w = pageWrapper()!
    await w.find('[data-testid="rename-instruction-input"]').setValue('改了一半')
    await w.find('[data-testid="rename-prompt-discard"]').trigger('click')
    await flushPromises()
    expect((w.find('[data-testid="rename-instruction-input"]').element as HTMLTextAreaElement).value).toBe('已存指令')
    expect(settingsMock.setRenamePrompt).not.toHaveBeenCalled()
  })

  it('恢复默认：slug + 空草稿（编辑态不写盘，保存才生效）', async () => {
    settingsMock.getRenamePrompt.mockResolvedValue({ style: 'custom', instruction: '自定义指令', corrupted: false })
    await mountSection()
    const w = pageWrapper()!
    // 先编辑制造 dirty（reset 键 dirty 才可用，与 save/discard 同门控）
    await w.find('[data-testid="rename-instruction-input"]').setValue('改了一半')
    await w.find('[data-testid="rename-prompt-reset"]').trigger('click')
    await flushPromises()
    // 风格回 slug → textarea 只读显示内置预览；保存键仍启用（dirty，等待用户确认）
    expect(w.find('[data-testid="rename-instruction-input"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="rename-instruction-input"]').element.value).toContain('slug 式标题')
    expect(w.find('[data-testid="rename-prompt-save"]').attributes('disabled')).toBeUndefined()
    expect(settingsMock.setRenamePrompt).not.toHaveBeenCalled()

    await w.find('[data-testid="rename-prompt-save"]').trigger('click')
    await flushPromises()
    expect(settingsMock.setRenamePrompt).toHaveBeenCalledWith('slug', '自定义指令') // 非 custom 保存透传快照原值（保留自定义文本）
  })

  it('超长指令：计数警示 + 保存禁用（2000 上限）', async () => {
    const w = await mountCustomInstructionPage()
    await assertCharCountState(w, 'a'.repeat(2001), '2001/2000', true)
  })

  it('emoji 按码点计数（与 runtime/extension 口径对齐）：1001 个 emoji 可保存、计数为码点数', async () => {
    const w = await mountCustomInstructionPage()
    // 1001 个 emoji 的 UTF-16 .length = 2002（旧口径误判超限），码点数 1001 ≤ 2000 → 可保存
    await assertCharCountState(w, '🔧'.repeat(1001), '1001/2000', false)
    await w.find('[data-testid="rename-prompt-save"]').trigger('click')
    await flushPromises()
    expect(settingsMock.setRenamePrompt).toHaveBeenCalledWith('custom', '🔧'.repeat(1001))
  })

  it('emoji 码点上限：2001 个 emoji（码点数超 2000）计数警示 + 保存禁用', async () => {
    const w = await mountCustomInstructionPage()
    await assertCharCountState(w, '🔧'.repeat(2001), '2001/2000', true)
  })

  it('getRenamePrompt 读失败：横幅可见 + 卡 2 风格/textarea/保存禁用；重试成功后恢复并回填快照', async () => {
    settingsMock.getRenamePrompt.mockRejectedValue(new Error('rpc down'))
    await mountSection()
    const w = pageWrapper()!
    expect(w.find('[data-testid="rename-load-error"]').exists()).toBe(true)
    expect(w.find('[data-testid="rename-prompt-style"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="rename-instruction-input"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="rename-prompt-save"]').attributes('disabled')).toBeDefined()

    settingsMock.getRenamePrompt.mockResolvedValue({ style: 'custom', instruction: '已存指令', corrupted: false })
    await w.find('[data-testid="rename-load-retry"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="rename-load-error"]').exists()).toBe(false)
    expect((w.find('[data-testid="rename-instruction-input"]').element as HTMLTextAreaElement).value).toBe('已存指令')
    expect(w.find('[data-testid="rename-instruction-input"]').attributes('disabled')).toBeUndefined()
  })

  it('corrupted：提示条渲染', async () => {
    settingsMock.getRenamePrompt.mockResolvedValue({ style: 'slug', instruction: '', corrupted: true })
    await mountSection()
    expect(pageWrapper()!.find('[data-testid="rename-prompt-corrupted"]').exists()).toBe(true)
  })

  it('参考折叠区：展开后展示内置 slug 模板 + 固定 system 骨架', async () => {
    await mountSection()
    expect(pageWrapper()!.find('[data-testid="rename-prompt-ref-content"]').exists()).toBe(false)
    await pageWrapper()!.find('[data-testid="rename-prompt-ref-toggle"]').trigger('click')
    await flushPromises()
    const content = pageWrapper()!.find('[data-testid="rename-prompt-ref-content"]').text()
    expect(content).toContain('slug 式标题')
    expect(content).toContain('只输出标题文本')
  })
})
