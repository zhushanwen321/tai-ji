/**
 * Block.vue text 分支样式测试（block-rendering M0，TC-M0-4；D5 行类型定档更新）。
 *
 * [block-rendering M0] 文字样式模型统一：所有 text 全 inline 统一正文级，颜色跟随所属
 * assistant streaming 态（streaming→neutral-mid，complete/缺省→neutral-fg，单调不随兄弟
 * message 翻转）。旧「过程文字暗色小字」两级视觉层级已取消（text-sm/leading-relaxed/
 * 恒 neutral-mid 移除）。
 * [D5 行类型定档] 正文行字号档位从 --text-base（14px）抬到 --text-md（15px）——
 * 行类型「字号 × 明度」：正文 15px / 过程行（工具/思考）14px（M3b demo 复刻：demo
 * .line = fs-lg 14px，工作bench 行级档；命令摘要/尾行窗口为 mono 13px 子档）。
 * [M3b demo 复刻] 过程行状态色只落图标（running=accent 呼吸弧 / failed=danger 图标），
 * 行文字恒 --neutral-mid（demo .tool .t-name 恒 mid）；耗时槽常驻（demo .dur），时刻槽悬停（demo .ts）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/Block.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, h } from 'vue'
import { Block } from '@taiji/ui'
import type { MessageStatus, ToolCall } from '@taiji/shared'
import type { RunGroupBase, RunGroupMile } from '@taiji/core/domain/chat'
import zhPanel from '../../../locale/zh-CN/panel'
import enPanel from '../../../locale/en-US/panel'
import { MdStub, AnsiStub, GuiStub, makeToolCall, mountToolBlock, mockChatProvide } from './helpers'

function mountTextBlock(over: { streaming?: boolean; status?: MessageStatus; error?: string; content?: string; messageTimestamp?: number } = {}) {
  return mount(Block, {
    props: {
      type: 'text',
      content: 'hello',
      ...over,
    },
    global: {
      // Block 经 useChatViewDeps inject 消费壳依赖（N1 起，全块类型 setup 都执行 inject），
      // 直接 mount 必须注入 mock deps；渲染 content 的 stub：wrapper.text() 才能断言正文/错误文本
      provide: mockChatProvide(),
      stubs: {
        MarkdownRenderer: {
          props: ['content', 'variant'],
          template: '<div class="stub-md">{{ content }}</div>',
        },
      },
    },
  })
}


/** 工具行 header 中性档断言单源（行文字恒 mid，失败色不落文字），返回 header 供补断言。 */
function expectToolHeaderNeutral(wrapper: { find: (s: string) => { classes: () => string[]; find: (s: string) => { classes: () => string[] } } }) {
  const header = wrapper.find('[data-testid="tool-block-header"]')
  expect(header.classes()).toContain('text-neutral-mid')
  expect(header.classes()).not.toContain('text-danger')
  return header
}
/** 时刻/耗时槽文本断言单源（剥掉全部空白后整串比对；selector 由调用方给）。 */
function expectTimeSlotText(wrapper: { find: (s: string) => { exists: () => boolean; text: () => string } }, selector: string, expected: string) {
  const slot = wrapper.find(selector)
  expect(slot.exists()).toBe(true)
  expect(slot.text().replace(/\s+/g, '')).toBe(expected)
}

/** 双 bash 成员 run group mount 单源（b0/b1 同款输入，多数组行用例的基线形态）。 */
function mountBashPairGroup() {
  return mountRunGroup(makeRunGroupProp([
    makeToolCall({ id: 'b0', toolName: 'bash', input: { command: 'a' } }),
    makeToolCall({ id: 'b1', toolName: 'bash', input: { command: 'b' } }),
  ]))
}

describe('block-rendering M0 + D5: Block text 分支正文样式（TC-M0-4）', () => {
  it('text 分支统一正文级样式：text-md/leading-[1.8]（D5 正文档 15px，ui-optimize-unified 决策 7 行高 1.8），不含过程样式 text-sm/leading-relaxed', () => {
    const wrapper = mountTextBlock({})
    const textEl = wrapper.find('.trace-blk > div')
    expect(textEl.classes()).toContain('text-[length:var(--text-md)]')
    // 行高 leading-[1.8]（决策 7：正文行高 1.7/1.75 → 1.8 双生效点同改）
    expect(textEl.classes()).toContain('leading-[1.8]')
    expect(textEl.classes()).not.toContain('text-[length:var(--text-sm)]')
    expect(textEl.classes()).not.toContain('text-[length:var(--text-base)]')
    expect(textEl.classes()).not.toContain('leading-relaxed')
  })

  it('streaming=true → text-neutral-mid（流式暗色）', () => {
    const wrapper = mountTextBlock({ streaming: true })
    expect(wrapper.find('.trace-blk > div').classes()).toContain('text-neutral-mid')
  })

  it('streaming=false/缺省 → text-neutral-fg（完成全色）', async () => {
    const wrapper = mountTextBlock({ streaming: false })
    expect(wrapper.find('.trace-blk > div').classes()).toContain('text-neutral-fg')
    // 缺省（undefined）同样 fallback 到 fg
    const defaultWrapper = mountTextBlock({})
    expect(defaultWrapper.find('.trace-blk > div').classes()).toContain('text-neutral-fg')
    // streaming 布尔切换驱动颜色（单调，不随兄弟 message 翻转）
    // .vue shim 下 VTU setProps 的 $props 类型解析为 attrs-only（Block.vue 自定义 props 不可见），
    // 运行时 setProps 走 Record<string, unknown>，cast 仅为满足 tsc（同 search-modal.test.ts:86 模式）。
    await wrapper.setProps({ streaming: true } as never)
    expect(wrapper.find('.trace-blk > div').classes()).toContain('text-neutral-mid')
  })
})

/* ── error-visibility M2 [形态统一]：text 分支唯一 error 形态 = 追加形态 ──
 * 错误文本只住 msg.error，content 恒为崩溃前正文（可为空）——正文永不整条染红，
 * 错误始终渲染为独立 danger 行（纯 error 形态已随形态统一消灭）。 */
describe('error-visibility M2: Block text 分支 error 形态判定（TC1/TC3）', () => {
  it('TC1: 纯错误消息（content 空）→ 正文区空 + msg.error 独立 danger 行', () => {
    const wrapper = mountTextBlock({ content: '', status: 'error', error: '压缩失败' })
    const textEl = wrapper.find('[data-testid="block-text"]')
    // 正文容器保持正常正文色（永不因 error 整条染红）
    expect(textEl.classes()).toContain('text-neutral-fg')
    expect(textEl.classes()).not.toContain('text-danger')
    // 独立 error 行：text-danger + AlertCircle + 错误文本
    const errorRow = wrapper.find('[data-testid="block-text-error"]')
    expect(errorRow.exists()).toBe(true)
    expect(errorRow.classes()).toContain('text-danger')
    expect(errorRow.find('svg').exists()).toBe(true)
    expect(wrapper.text()).toContain('压缩失败')
  })

  it('TC3: 追加形态——正常正文（content）保持原色，msg.error 渲染独立 danger 行', () => {
    const wrapper = mountTextBlock({ content: '正常回复', status: 'error', error: '崩溃前追加的错误' })
    const textEl = wrapper.find('[data-testid="block-text"]')
    // content 正常正文不染 danger（text-neutral-fg，不误染崩溃前产出）
    expect(textEl.classes()).toContain('text-neutral-fg')
    expect(textEl.classes()).not.toContain('text-danger')
    // 独立 error 行：text-danger + AlertCircle + 错误文本
    const errorRow = wrapper.find('[data-testid="block-text-error"]')
    expect(errorRow.exists()).toBe(true)
    expect(errorRow.classes()).toContain('text-danger')
    expect(errorRow.find('svg').exists()).toBe(true) // AlertCircle 图标
    expect(wrapper.text()).toContain('崩溃前追加的错误')
    expect(wrapper.text()).toContain('正常回复')
  })

  it('TC4: error 终态缺 error 字段（漏网防御）→ 不整条染红，无 error 行（静默降级不误导）', () => {
    const wrapper = mountTextBlock({ content: '正常回复', status: 'error' })
    const textEl = wrapper.find('[data-testid="block-text"]')
    // 防御形态：正文保持原色（不因缺 error 字段误判整条 danger）
    expect(textEl.classes()).toContain('text-neutral-fg')
    expect(textEl.classes()).not.toContain('text-danger')
    expect(wrapper.find('[data-testid="block-text-error"]').exists()).toBe(false)
  })
})

/* ── error-visibility M1：failed tool header danger 色 + 终态默认展开（TC1-3）──
 * - T1: toolStatusClass failed 分支 → text-danger（unfinished 保持中性灰）
 * - T2: toolCollapsed 终态分化——failed(error) 初值 false（展开），其余 true（收起）
 * - CQ1: streaming 中失败不展开（mount 快照，running→error 不 remount），本测试覆盖终态挂载分支
 * stub / makeToolCall / mountToolBlock 经 ./helpers 共享（与 BlockWorkflow.test.ts 公共样板提取） */

describe('error-visibility M1: failed tool header danger + 终态展开（TC1-3）', () => {
  it('TC1: failed(error) 行文字恒中性 text-neutral-mid，失败色常驻落在图标 text-danger（M3b demo 形态：.tool .t-name 恒 mid + .line.subagent.failed .sicon）', () => {
    const wrapper = mountToolBlock(makeToolCall({ status: 'error', output: 'ENOENT: no such file' }))
    // 行文字保持工具行档 mid（失败色不传染文字，demo 权威形态）
    const header = expectToolHeaderNeutral(wrapper)
    // 失败色常驻在图标（非 hover 变体）
    expect(header.find('svg').classes()).toContain('text-danger')
  })

  it('TC2: failed(error) tool 终态挂载默认展开（错误输出可见，无需点击）', () => {
    const wrapper = mountToolBlock(makeToolCall({ status: 'error', output: 'ENOENT: no such file' }))
    // toolCollapsed 初值 false → toolExpanded true → 详情区默认渲染（无需点击 header）
    expect(wrapper.find('.tool-result').exists()).toBe(true)
    // 错误输出文本可见
    expect(wrapper.text()).toContain('ENOENT: no such file')
  })

  it('TC3: unfinished(end_not_received) tool header 染 text-neutral-mid（D5 工具行档，abort/中断非失败不标红）', () => {
    const wrapper = mountToolBlock(makeToolCall({ status: 'end_not_received' }))
    // unfinished 不标红（区别于 failed）
    expectToolHeaderNeutral(wrapper)
  })

  it('[tool-detail-rich] 壳注入 toolDetailRenderer + edit 有 details.diff → 展开区走富渲染分支（纯文本输出不渲染）', async () => {
    const DetailStub = {
      name: 'ToolDetailRendererStub',
      props: { tool: { type: Object, required: true }, sessionId: { type: String, default: null } },
      setup: () => () => h('div', { 'data-testid': 'tool-detail-stub' }),
    }
    const wrapper = mountToolBlock(
      makeToolCall({ toolName: 'edit', input: { path: 'foo.ts' }, output: 'Successfully replaced 1 block(s)', details: { patch: '@@ -1,1 +1,2 @@\n a\n+b' } }),
      {},
      // 第三个参数：overrides 注入 toolDetailRenderer
      { toolDetailRenderer: DetailStub as never },
    )
    // 默认收起（completed 非失败），点击 header 展开
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(wrapper.find('[data-testid="tool-detail-stub"]').exists()).toBe(true)
    // 纯文本输出区（.tool-result）被富渲染分支替换（v-else-if 链序：gui → rich → text）
    expect(wrapper.find('.tool-result').exists()).toBe(false)
    wrapper.unmount()
  })

  it('[tool-detail-rich] 壳未注入（默认 mock deps）→ read 展开维持纯文本兜底（回归保护）', async () => {
    const wrapper = mountToolBlock(makeToolCall({ toolName: 'read', output: 'const a = 1' }))
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(wrapper.find('.tool-result').exists()).toBe(true)
    wrapper.unmount()
  })
})

/* ── D5 行类型定档（M3b demo 复刻修订）：工具行 = 14px（--text-base，demo .line fs-lg）
 * × --neutral-mid（ui-signal-density §3.3 D5 明度档保留）──
 * - completed/unfinished/running tool 行文字恒染 text-neutral-mid（工具行层级明度）
 * - 状态色只落图标不落文字（M3b demo 权威：demo .tool .t-name 恒 mid，running=accent
 *   呼吸弧、failed=danger 图标）——「状态色不是层级色」原则不变，落点从行文字改为图标 */
describe('D5 行类型定档: completed tool header 染 neutral-mid', () => {
  it('completed tool header 染 text-neutral-mid（工具行档，不再是最亮 neutral-fg）', () => {
    const wrapper = mountToolBlock(makeToolCall({ status: 'completed' }))
    const header = wrapper.find('[data-testid="tool-block-header"]')
    expect(header.classes()).toContain('text-neutral-mid')
    expect(header.classes()).not.toContain('text-neutral-fg')
  })

  it('running tool 行文字恒 text-neutral-mid，accent 只在专属动效图标（M3b demo 形态：状态色独占图标位）', () => {
    const wrapper = mountToolBlock(makeToolCall({ status: 'running' }))
    const header = wrapper.find('[data-testid="tool-block-header"]')
    expect(header.classes()).toContain('text-neutral-mid')
    expect(header.classes()).not.toContain('text-accent')
    // 专属动效款（RunningBlockIcon）：trace 块不再用全类型共用 loader，按 toolName 路由
    // （fixture 默认 read → 纵向扫描）
    expect(header.find('[data-running-icon="tool-read"]').exists()).toBe(true)
  })
})

/* ── ui-optimize-unified N1（决策 8）：edit/write 工具行文件 basename chip ──
 * - edit/write 行 = 工具名 + basename chip（title 完整路径、点击开 drawer detail、
 *   @click.stop 防行展开、超长 CSS ellipsis）——与 UserBubble 文件 badge 同语义双通道
 * - bash/read 等其他工具行不变（read 保持 shortenForHeader 摘要）
 * - 统计段 = edit 工具 diff +N −N（ToolCall.diffStat，core parseDiffStat 数据层；write/
 *   历史会话缺省不渲染） */
describe('ui-optimize-unified N1: edit/write 工具行 basename chip（决策 8）', () => {
  const FILE_PATH = '/home/user/project/src/app.ts'
  const CHIP_SEL = '[data-testid="tool-file-chip"]'

/** file chip 断言单源（文本 = basename、title = 完整路径），返回 chip。 */
  function expectFileChip(wrapper: { find: (s: string) => { exists: () => boolean; text: () => string; attributes: (a: string) => string | undefined } }) {
    const chip = wrapper.find(CHIP_SEL)
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toBe('app.ts')
    expect(chip.attributes('title')).toBe(FILE_PATH)
    return chip
  }
  const DIFFSTAT_SEL = '[data-testid="tool-file-chip-diffstat"]'

  /** mount 文件工具行 + 可引用的 deps mock（断言 onFileClick/openDrawer 双通道调用参数） */
  function makeChipWrapper(over: Partial<ToolCall> = {}) {
    const onFileClick = vi.fn()
    const openDrawer = vi.fn()
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeToolCall(over) },
      global: {
        provide: mockChatProvide({ onFileClick, openDrawer }),
        stubs: { GuiComponentRenderer: GuiStub, AnsiText: AnsiStub, MarkdownRenderer: MdStub },
      },
    })
    return { wrapper, onFileClick, openDrawer }
  }

  it('edit 行渲染 chip：文本 = basename、title = 完整路径（完整路径移 title 悬停）', () => {
    const { wrapper } = makeChipWrapper({ toolName: 'edit', input: { path: FILE_PATH } })
    expectFileChip(wrapper)
    // 完整路径不再以摘要形态出现在 header（移 title）
    const header = wrapper.find('[data-testid="tool-block-header"]')
    expect(header.text()).not.toContain(FILE_PATH)
  })

  it('write 行同样渲染 chip（主参数 path；file_path 死分支已删——pi 1.0.0 edit/write 主参数是 path）', () => {
    const { wrapper } = makeChipWrapper({ toolName: 'write', input: { path: FILE_PATH } })
    expectFileChip(wrapper)
  })

  it('edit 行 diffStat 有值：统计段渲染 +N −N（diff 数据层供给，登记 docs/todo 修复）', () => {
    const { wrapper } = makeChipWrapper({ toolName: 'edit', input: { path: FILE_PATH }, diffStat: { additions: 2, deletions: 1 } })
    const stat = wrapper.find(DIFFSTAT_SEL)
    expect(stat.exists()).toBe(true)
    expect(stat.text()).toBe('+2 −1')
    // 统计段在 chip 内（basename 之后同容器），dim 灰阶（与行尾耗时槽同档）
    expect(wrapper.find(CHIP_SEL).text()).toContain('+2 −1')
    expect(stat.classes()).toContain('text-neutral-dim')
  })

  it('diffStat 缺省（write 工具 details 恒 undefined / 历史会话）不渲染统计段，形态回退现状', () => {
    const { wrapper } = makeChipWrapper({ toolName: 'write', input: { path: FILE_PATH } })
    expect(wrapper.find(DIFFSTAT_SEL).exists()).toBe(false)
    expect(wrapper.find(CHIP_SEL).text()).toBe('app.ts')
  })

  it('chip 点击：@click.stop 不触发行展开 + onFileClick/openDrawer 双通道（UserBubble badge 同语义）', async () => {
    const { wrapper, onFileClick, openDrawer } = makeChipWrapper({ toolName: 'edit', input: { path: FILE_PATH } })
    await wrapper.find(CHIP_SEL).trigger('click')
    // 双通道：selectFile（选中态落位 + 注入 detail tab 实例）+ openDrawer（切 detail tab + 开抽屉）
    expect(onFileClick).toHaveBeenCalledWith(FILE_PATH)
    expect(openDrawer).toHaveBeenCalledWith('detail', { filePath: FILE_PATH })
    // 行未展开（stop 拦截 header 的 toggleTool；.tool-result = 展开输出区锚点）
    expect(wrapper.find('.tool-result').exists()).toBe(false)
  })

  it('chip 键盘 enter/space 触发同样双通道（role=button 键盘可达）', async () => {
    const { wrapper, onFileClick, openDrawer } = makeChipWrapper({ toolName: 'write', input: { path: FILE_PATH } })
    const chip = wrapper.find(CHIP_SEL)
    expect(chip.attributes('role')).toBe('button')
    await chip.trigger('keydown.enter')
    expect(onFileClick).toHaveBeenCalledTimes(1)
    await chip.trigger('keydown.space')
    expect(onFileClick).toHaveBeenCalledTimes(2)
    expect(openDrawer).toHaveBeenCalledTimes(2)
  })

  it('超长 basename CSS ellipsis：chip 容器 truncate + 320px 上限（MF-1-24 demo .fchip 形态），内层 fchip-roll 为 hover 滚动载体（inline-block + nowrap）', () => {
    const { wrapper } = makeChipWrapper({ toolName: 'edit', input: { path: '/a/very-long-basename-that-should-truncate.ts' } })
    const chip = wrapper.find(CHIP_SEL)
    // 容器承载截断（ellipsis）与 320px 上限（demo workbench.css .fchip max-width:320px）
    expect(chip.classes()).toContain('min-w-0')
    expect(chip.classes()).toContain('truncate')
    expect(chip.classes()).toContain('max-w-[320px]')
    // 内层双 span 轻方案：fchip-roll（hover 滚到文末停，动画在 Block.vue scoped）
    const name = chip.find('span')
    expect(name.classes()).toContain('fchip-roll')
    expect(name.classes()).toContain('inline-block')
    expect(name.classes()).toContain('whitespace-nowrap')
  })

  it('read 行不渲染 chip，保持 shortenForHeader 摘要形态（其他工具行不变）', () => {
    const wrapper = mountToolBlock(makeToolCall({ toolName: 'read', input: { path: FILE_PATH } }))
    expect(wrapper.find(CHIP_SEL).exists()).toBe(false)
    // 摘要形态（M3b demo 复刻：去「· 」前缀，demo .tool .cmd 为裸命令文本）：shortenForHeader 缩短路径
    const header = wrapper.find('[data-testid="tool-block-header"]')
    expect(header.text()).toContain('…/src/app.ts')
  })

  it('bash 行不渲染 chip（bash/其他工具行不变）', () => {
    const wrapper = mountToolBlock(makeToolCall({ toolName: 'bash', input: { command: 'pnpm build' } }))
    expect(wrapper.find(CHIP_SEL).exists()).toBe(false)
  })
})

/* ── 工具行收起态摘要（tool-flow-summary 用户裁决）：details.summary 优先 + argPath 回落 ──
 * 优先级：details.summary（extension 自报一行摘要，约定见 docs/extensions/extension-conventions.md）
 * > argPath 参数派生 > 仅工具名。
 * argPath 识别集 = command/path/pattern/query/code（file_path/tasks 死分支已删）。 */
describe('ToolRow 收起态摘要: details.summary 优先 + argPath 回落', () => {
  const SUMMARY_SEL = '[data-testid="tool-details-summary"]'

  it('details.summary 存在 → header 显示摘要文本（用户可见 DOM 断言），样式同款 mono dim', () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'todo',
      input: { action: 'add', texts: ['a', 'b'] },
      details: { summary: 'Added 2 todos (#1-#2)' },
    }))
    const summary = wrapper.find(SUMMARY_SEL)
    expect(summary.exists()).toBe(true)
    expect(summary.text()).toBe('Added 2 todos (#1-#2)')
    // 与 argPath 摘要同款：mono 字族 + dim 灰阶（M3b demo .tool .cmd 档）
    expect(summary.classes()).toContain('font-mono')
    expect(summary.classes()).toContain('text-neutral-dim')
  })

  it('details.summary 存在且 argPath 可派生 → summary 优先（优先级：自报摘要 > 参数派生）', () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'read',
      input: { path: '/tmp/foo.txt' },
      details: { summary: 'Read 120 lines' },
    }))
    expect(wrapper.find(SUMMARY_SEL).text()).toBe('Read 120 lines')
    expect(wrapper.find(SUMMARY_SEL).exists()).toBe(true)
    expect(wrapper.find('[data-testid="tool-block-header"]').text()).not.toContain('/tmp/foo.txt')
  })

  it('details.summary 缺失 → 无 summary testid，回落 argPath 摘要（既有行为不回归）', () => {
    const wrapper = mountToolBlock(makeToolCall({ toolName: 'grep', input: { pattern: 'foo' } }))
    expect(wrapper.find(SUMMARY_SEL).exists()).toBe(false)
    expect(wrapper.find('[data-testid="tool-block-header"]').text()).toContain('foo')
  })

  it('details.summary 非字符串（脏 details）→ typeof 守卫不显示，回落 argPath', () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'grep',
      input: { pattern: 'foo' },
      details: { summary: 42 },
    }))
    expect(wrapper.find(SUMMARY_SEL).exists()).toBe(false)
    expect(wrapper.find('[data-testid="tool-block-header"]').text()).toContain('foo')
  })

  it('details 缺失（bash/read 等内置工具常态）→ 既有 argPath 摘要行为不变', () => {
    const wrapper = mountToolBlock(makeToolCall({ toolName: 'bash', input: { command: 'pnpm build' } }))
    expect(wrapper.find(SUMMARY_SEL).exists()).toBe(false)
    expect(wrapper.find('[data-testid="tool-block-header"]').text()).toContain('pnpm build')
  })

  it('两者皆无 → header 只显示工具名', () => {
    const wrapper = mountToolBlock(makeToolCall({ toolName: 'somecustom', input: {} }))
    const header = wrapper.find('[data-testid="tool-block-header"]')
    expect(header.text()).toContain('somecustom')
    expect(wrapper.find(SUMMARY_SEL).exists()).toBe(false)
    // 无 argPath 摘要 span（识别集外工具 header 仅工具名 + 行尾时刻槽）
    expect(header.text()).not.toContain('undefined')
  })

  it('input.query（tool_search）→ header 显示 query 值', () => {
    const wrapper = mountToolBlock(makeToolCall({ toolName: 'tool_search', input: { query: 'workflow resume' } }))
    expect(wrapper.find(SUMMARY_SEL).exists()).toBe(false)
    expect(wrapper.find('[data-testid="tool-block-header"]').text()).toContain('workflow resume')
  })

  it('input.code（codemode）→ header 显示 code 值', () => {
    const wrapper = mountToolBlock(makeToolCall({ toolName: 'codemode', input: { code: 'await agent("w")' } }))
    expect(wrapper.find(SUMMARY_SEL).exists()).toBe(false)
    expect(wrapper.find('[data-testid="tool-block-header"]').text()).toContain('await agent("w")')
  })
})

/* ── error-visibility M3：thinking 可收起 + 完成态回落（TC1-3）──
 * - T1: thinkingExpanded 去 props.working 短路（working 默认展开改由 collapsed 初值承担）
 *   ——working 挂载 collapsed 初值 false（展开）、非 working 挂载 true（收起，G3 骨架）
 * - T2: 删禁 toggle（working 中也可手动收起/展开）；watch working true→false 回落收起
 * - CQ1: 手动操作过（userToggled）→ working→false 不回落（显式意图优先） */
const THINK_HEADER_SEL = '.group\\/think'
const THINK_EXPANDED_SEL = '.group\\/result'

describe('error-visibility M3: thinking 可收起 + 完成态回落（TC1-3）', () => {
  function mountThinking(over: Record<string, unknown> = {}) {
    return mount(Block, {
      // collapsed 显式传 undefined（Vue Boolean prop 键缺失时缺省 false，会吃掉 `?? true` 的
      // fallback 导致误展开；显式 undefined 才等价「未提供」，`?? true` 正常生效）
      props: { type: 'thinking', content: 'deep reasoning content', thinkingId: 't-1', collapsed: undefined, ...over },
      global: {
        provide: mockChatProvide(), // N1 起 Block setup 执行 useChatViewDeps inject，直接 mount 必须注入
        stubs: { MarkdownRenderer: MdStub },
      },
    })
  }

  it('TC1: working=true 挂载默认折叠（60 字符预览；streaming-trace-window 验收修正：收编理念要求 thinking 折叠减体积）', () => {
    const wrapper = mountThinking({ working: true })
    // 展开内容区不渲染（折叠态，60 字符预览）
    expect(wrapper.find(THINK_EXPANDED_SEL).exists()).toBe(false)
  })

  it('TC2: 非 working 挂载默认收起（1 行摘要），点击可展开', async () => {
    const wrapper = mountThinking({})
    // 默认收起：展开内容区不渲染
    expect(wrapper.find(THINK_EXPANDED_SEL).exists()).toBe(false)
    // 点击 header 展开（toggle 对非 working 可用）
    await wrapper.find(THINK_HEADER_SEL).trigger('click')
    expect(wrapper.find(THINK_EXPANDED_SEL).exists()).toBe(true)
  })

  it('TC3: working 态折叠；手动展开后保持（用户意图优先，不因 working 变化回落）', async () => {
    // 场景 A：working=true 挂载默认折叠，working→false 仍折叠（默认折叠态不因 working 变化）
    const autoWrapper = mountThinking({ working: true })
    expect(autoWrapper.find(THINK_EXPANDED_SEL).exists()).toBe(false)
    // VTU setProps 的 $props 类型解析为 attrs-only（Block.vue 自定义 props 不可见），
    // cast 仅为满足 tsc（同 search-modal.test.ts:86 模式，见本文件 text 测试注释）
    await autoWrapper.setProps({ working: false } as never)
    expect(autoWrapper.find(THINK_EXPANDED_SEL).exists()).toBe(false)

    // 场景 B：手动展开 → working→false 保持展开（用户意图优先）
    const manualWrapper = mountThinking({ working: true })
    await manualWrapper.find(THINK_HEADER_SEL).trigger('click') // 手动展开
    expect(manualWrapper.find(THINK_EXPANDED_SEL).exists()).toBe(true)
    await manualWrapper.setProps({ working: false } as never)
    // 保持用户意图不回滚
    expect(manualWrapper.find(THINK_EXPANDED_SEL).exists()).toBe(true)
  })
})

/* ── JSON output 格式化：cw 命令等结构化输出的可读性 ──
 * 背景：subagent（cw 递归编排）常用 bash 执行 `cw ...` 命令，stdout 是 JSON
 * （cw execute/design/review 等结构化输出）。原样 whitespace-pre-wrap 渲染时
 * 单行压缩 JSON 不可读，展开工具卡片看到一整坨。修复：检测到合法 JSON 时
 * 用 <pre> 缩进格式化 + 限高滚动；非 JSON（普通命令输出/文本）回退原样 span。
 * 通用：非 bash 工具的 JSON output 同样适用（不绑定 cw）。 */
describe('Block tool output: JSON 格式化（cw 等命令的结构化输出）', () => {
  it('JSON 对象 output 渲染为 <pre> 格式化缩进（非原样压缩单行）', async () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'bash',
      input: { command: 'cw execute feat-x' },
      output: '{"status":"ok","nextAction":"design","unitId":"feat-x"}',
    }))
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    const pre = wrapper.find('.tool-result pre')
    expect(pre.exists()).toBe(true)
    // 格式化后键值间有空格、换行缩进（原样压缩单行无换行）
    expect(pre.text()).toContain('"status": "ok"')
    expect(pre.text()).toContain('\n')
  })

  it('JSON 数组 output 同样格式化', async () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'bash',
      output: '[{"id":1,"name":"a"},{"id":2,"name":"b"}]',
    }))
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    const pre = wrapper.find('.tool-result pre')
    expect(pre.exists()).toBe(true)
    expect(pre.text()).toContain('"id": 1')
  })

  it('非 JSON output（普通命令文本）回退原样 span，无 <pre>', async () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'bash',
      input: { command: 'ls -la' },
      output: 'total 0\ndrwxr-xr-x  3 user staff  96',
    }))
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(wrapper.find('.tool-result pre').exists()).toBe(false)
    expect(wrapper.find('.tool-result').text()).toContain('total 0')
  })

  it('首字符为 { 但非法 JSON 回退原样（不误判）', async () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'bash',
      output: '{ not valid json at all',
    }))
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(wrapper.find('.tool-result pre').exists()).toBe(false)
    expect(wrapper.find('.tool-result').text()).toContain('{ not valid json')
  })

  it('空 output 不触发 JSON 渲染（无 <pre>，无异常）', async () => {
    const wrapper = mountToolBlock(makeToolCall({ toolName: 'bash', output: '' }))
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(wrapper.find('.tool-result pre').exists()).toBe(false)
  })

  it('非 bash 工具的 JSON output 同样格式化（通用，不限于 bash）', async () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'cw_planning',
      output: '{"layer":"wave","status":"created","waves":3}',
    }))
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    const pre = wrapper.find('.tool-result pre')
    expect(pre.exists()).toBe(true)
    expect(pre.text()).toContain('"layer": "wave"')
  })
})

/* ── W4 流式 block 双轴尾部追踪：U8-U10 ──
 * thinking/tool 折叠头在 streaming 态渲染尾部行窗口 + useTailScroll 双轴追踪。 */

// U8: thinking 双态——working 态显示 content 末行文本，非 working 显示头部 60 字符摘要
describe('W4 tail-scroll: thinking 双态（U8）', () => {
  function mountThinkingWithContent(over: Record<string, unknown> = {}) {
    // 200+ 字符多行 content，确保尾行与头部 60 字符不同
    const content = 'first line of thinking\n'.repeat(5) + 'important final conclusion here'
    return mount(Block, {
      props: { type: 'thinking', content, thinkingId: 't-tail', collapsed: undefined, ...over },
      global: {
        provide: mockChatProvide(), // N1 起 Block setup 执行 useChatViewDeps inject，直接 mount 必须注入
        stubs: { MarkdownRenderer: MdStub },
      },
    })
  }

  it('working=true 折叠预览含 content 末行文本（tailLines 尾部窗口）', async () => {
    const wrapper = mountThinkingWithContent({ working: true })
    await nextTick()
    // 尾部行窗口应包含最后一行文本
    expect(wrapper.text()).toContain('important final conclusion here')
  })

  it('working=false 折叠预览含头部 60 字符摘要（previewText）', () => {
    const wrapper = mountThinkingWithContent({ working: false })
    // previewText 截取头部 60 字符 + 省略号
    const text = wrapper.text()
    expect(text).toContain('first line of thinking')
    expect(text).toContain('…')
  })

  it('两态容器 offsetHeight 相等（行高恒定，virtua 虚拟列表高度断言依赖此）', async () => {
    const wrapper = mountThinkingWithContent({ working: true })
    await nextTick()
    // jsdom 下 offsetHeight 为 0，但 DOM 结构应稳定（min-h-[1.5rem] 在父容器）
    const minHeightEl = wrapper.find('.min-h-\\[1\.5rem\\]')
    // Tailwind 类含方括号，选择器需转义；若未找到用备选方案
    const thinkHeader = minHeightEl.exists() ? minHeightEl : wrapper.find('.trace-think .flex.items-baseline')
    expect(thinkHeader.exists()).toBe(true)
    // 切换 working 态后 DOM 结构不变
    await wrapper.setProps({ working: false } as never)
    const thinkHeaderAfter = minHeightEl.exists() ? minHeightEl : wrapper.find('.trace-think .flex.items-baseline')
    expect(thinkHeaderAfter.exists()).toBe(true)
  })

  it('working 态尾行视口锁单行高度 + 横向钉右结构（2026-08 抖动修复形态检查）', async () => {
    const wrapper = mountThinkingWithContent({ working: true })
    await nextTick()
    // h-[1lh]：视口高度 = 1 行行高（CSS lh 单位），缺失即回归「多行内容撑高视口」抖动
    const viewport = wrapper.find('.h-\\[1lh\\]')
    expect(viewport.exists()).toBe(true)
    // 横向钉右 = justify-end + overflow-hidden（纯 CSS，无 scrollLeft 时序）；行容器右对齐
    expect(viewport.classes()).toContain('justify-end')
    expect(viewport.classes()).toContain('overflow-hidden')
    // leading-normal（无单位系数）必需：normal 行高下行盒高度随内容 fallback 字体变
    //（实测 system-ui 16px / PingFang 18px / emoji 21px——CJK 行被裁 2-5px）
    expect(viewport.classes()).toContain('leading-normal')
    const scroller = viewport.find('.flex-col')
    expect(scroller.exists()).toBe(true)
    expect(scroller.classes()).toContain('items-end')
    // self-start：脱离 flex cross 轴默认 stretch（否则滚动容器被拉到视口高度，
    // translateY(-50%) 变半行而非一行——sliding 新行错位，无头浏览器实测确认）
    expect(scroller.classes()).toContain('self-start')
    // mr-auto：短行左贴 label（恢复旧行为）、长行溢出时被 justify-end 钉右
    expect(scroller.classes()).toContain('mr-auto')
  })
})

// U9: tool 双态——running 态显示尾行文本（2026-10-17 方案 A 后仅非 bash 工具），completed 态显示 shortenForHeader
// rAF mock setup for U9-U10
const ANSI_OUTPUT_RAW = '\x1b[32m✓ success\x1b[0m\n\x1b[1;34m── build output ──\x1b[0m\nfinal line of output'
const ANSI_OUTPUT_CLEAN = '✓ success\n── build output ──\nfinal line of output'
const rafQueue: FrameRequestCallback[] = []
const originalRAF = globalThis.requestAnimationFrame
const originalCAF = globalThis.cancelAnimationFrame
beforeEach(() => {
  rafQueue.length = 0
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
})
afterEach(() => {
  globalThis.requestAnimationFrame = originalRAF
  globalThis.cancelAnimationFrame = originalCAF
})

async function flushRaf(): Promise<void> {
  const cbs = [...rafQueue]
  rafQueue.length = 0
  for (const cb of cbs) cb(0)
  await nextTick()
}

describe('W4 tail-scroll: tool 双态（U9）', () => {
  it('非 bash running + 有 output → 尾行视口保留（方案 A 只豁免 bash），折叠头含尾行 + 扫光', async () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'read',
      input: { path: '/tmp/foo.txt' },
      status: 'running',
      output: ANSI_OUTPUT_CLEAN,
    }))
    await nextTick()
    await flushRaf()
    const header = wrapper.find('[data-testid="tool-block-header"]')
    // 尾行视口渲染且含最后一行（非 bash 保持既有尾行形态）
    expect(header.find('.h-\\[1lh\\]').exists()).toBe(true)
    expect(header.text()).toContain('final line of output')
    // 非 bash running 扫光现状保持：视口内层挂 text-sweep
    expect(header.find('.text-sweep').exists()).toBe(true)
  })

  it('status=completed → 折叠头回落 shortenForHeader 形态', async () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'bash',
      input: { command: 'pnpm build' },
      status: 'completed',
      outputRaw: ANSI_OUTPUT_RAW,
      output: ANSI_OUTPUT_CLEAN,
    }))
    await nextTick()
    const header = wrapper.find('[data-testid="tool-block-header"]')
    // completed 态回落 shortenForHeader，显示缩短后的 argPath
    expect(header.text()).toContain('pnpm build')
    // 不应显示末行文本
    expect(header.text()).not.toContain('final line of output')
  })

  it('展开态 + copyContent 仍全量（tailLines 不影响展开内容）', async () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'bash',
      input: { command: 'pnpm build' },
      status: 'running',
      outputRaw: ANSI_OUTPUT_RAW,
      output: ANSI_OUTPUT_CLEAN,
    }))
    // 点击展开
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    // 展开内容区应有完整 output
    expect(wrapper.find('.tool-result').exists()).toBe(true)
  })
})

// U10: 无输出 tool——running 但无 outputRaw/displayContent → 折叠头保持 argPath
describe('W4 tail-scroll: 无输出 tool（U10）', () => {
  it('running + 无 outputRaw/displayContent → 折叠头含 argPath 原文（非 bash 摘要扫光现状保持）', async () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'read',
      input: { path: '/tmp/foo.txt' },
      status: 'running',
      // 无 output、无 outputRaw
    }))
    await nextTick()
    const header = wrapper.find('[data-testid="tool-block-header"]')
    // 无流式输出 → 回落 shortenForHeader(argPath)
    expect(header.text()).toContain('/tmp/foo.txt')
    // 非 bash running 摘要扫光保持现状（text-sweep 挂摘要 span）
    expect(header.find('.text-sweep').exists()).toBe(true)
  })
})

/* ── bash-running-stream-output（U3）：bash 展开恒渲染容器 + 输出区内容检查 ──
 * D2: bash 展开容器恒渲染（含命令块），空输出不再「header 摘要消失 + 内容空白」假展开
 *（原 D3 尾行取数回退随 2026-10-17 方案 A 移除：bash running 不再进尾行视口） */
describe('bash-running-stream-output: bash 展开容器与输出检查（U3）', () => {
  async function expand(wrapper: ReturnType<typeof mountToolBlock>) {
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
  }

  it('running + 有流式输出：展开渲染命令块（argPath）+ 输出文本', async () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'bash',
      input: { command: 'for i in 1 2 3; do echo step-$i; done' },
      status: 'running',
      output: 'step-1\nstep-2',
    }))
    await expand(wrapper)
    // 命令块可见（bg-input 容器内 argPath 文本）
    expect(wrapper.find('.bg-bg-input').text()).toContain('for i in 1 2 3')
    // 输出文本可见（displayContent 纯文本回退路径）
    expect(wrapper.find('.tool-result').text()).toContain('step-1')
    expect(wrapper.find('.tool-result').text()).toContain('step-2')
  })

  it('running + 空输出：展开仅渲染命令块，无输出 div（无空白假展开）', async () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'bash',
      input: { command: 'sleep 20' },
      status: 'running',
      output: '',
    }))
    await expand(wrapper)
    // 命令块存在（header 摘要 invisible 但命令在下方显示）
    expect(wrapper.find('.bg-bg-input').text()).toContain('sleep 20')
    // 输出文本区不渲染（内容检查生效）
    expect(wrapper.find('.tool-result').exists()).toBe(false)
  })

  it('completed + 空输出：展开同样仅渲染命令块（失败模式 C）', async () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'bash',
      input: { command: 'cd /tmp' },
      status: 'completed',
      output: '',
    }))
    await expand(wrapper)
    expect(wrapper.find('.bg-bg-input').text()).toContain('cd /tmp')
    expect(wrapper.find('.tool-result').exists()).toBe(false)
  })

  it('completed + output undefined：展开同样仅命令块（缺省 output 同检查）', async () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'bash',
      input: { command: 'pwd' },
      status: 'completed',
      output: undefined,
    }))
    await expand(wrapper)
    expect(wrapper.find('.bg-bg-input').text()).toContain('pwd')
    expect(wrapper.find('.tool-result').exists()).toBe(false)
  })

  it('非 bash 工具 running 且无 output：展开行为不变（v-if 不满足不渲染）', async () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'read',
      input: { path: '/tmp/foo.txt' },
      status: 'running',
      // 无 output、无 outputRaw、无 guiComponent
    }))
    await expand(wrapper)
    // 展开区不渲染（isBashTool 分支不命中非 bash 工具）
    expect(wrapper.find('.tool-result').exists()).toBe(false)
    expect(wrapper.find('.group\\/content').exists()).toBe(false)
  })
})

/* ── bash running 行形态（2026-10-17 方案 A 裁决）：执行中命令字符串常显 ──
 * bash 行 running 不再被「输出尾行视口」顶替 header，也不走呼吸弧动效图标：
 * header = 完成态同款静态展开箭头（tool-cmd）+「bash」工具名扫光（base=mid 档）
 * + 命令字符串（不扫光）；进度看展开区输出。非 bash 工具行一切保持现状。 */
describe('bash running 行形态（方案 A：命令常显 + 工具名扫光，2026-10-17 裁决）', () => {
  const CMD = 'pnpm build'
  function mountRunningBash(over: Partial<ToolCall> = {}) {
    return mountToolBlock(makeToolCall({ toolName: 'bash', input: { command: CMD }, status: 'running', ...over }))
  }

  it('header 命令字符串用户可见（不被尾行视口顶替）；尾行视口不渲染、尾行文本不出现', () => {
    const wrapper = mountRunningBash({ output: ANSI_OUTPUT_CLEAN, outputRaw: ANSI_OUTPUT_RAW })
    const header = wrapper.find('[data-testid="tool-block-header"]')
    // 用户可见 DOM 断言：命令字符串在 header 文本中
    expect(header.text()).toContain(CMD)
    // 尾行视口（bash 豁免）与尾行文本均不出现
    expect(header.find('.h-\\[1lh\\]').exists()).toBe(false)
    expect(header.text()).not.toContain('final line of output')
  })

  it('header 图标 = 完成态同款静态展开箭头（tool-cmd），非 RunningBlockIcon 动效款', () => {
    const runningHeader = mountRunningBash().find('[data-testid="tool-block-header"]')
    // running 不再渲染动效图标（bash 豁免 RunningBlockIcon）
    expect(runningHeader.find('[data-running-icon]').exists()).toBe(false)
    // 与 completed bash 行 svg 逐字节一致（不绑 lucide path 字面，防上游图标库漂移误报）
    const doneHeader = mountToolBlock(makeToolCall({ toolName: 'bash', input: { command: CMD }, status: 'completed' }))
      .find('[data-testid="tool-block-header"]')
    expect(runningHeader.find('svg').exists()).toBe(true)
    expect(runningHeader.find('svg').html()).toBe(doneHeader.find('svg').html())
    // 颜色与完成态同档（headerIconClass 非失败分支 = BLOCK_ICON_CLASS 常态档 dim）
    expect(runningHeader.find('svg').classes()).toContain('text-neutral-dim')
    expect(runningHeader.find('svg').classes()).not.toContain('text-danger')
  })

  it('工具名「bash」span 挂 text-sweep（base=mid 档，与 ThinkingRow label 同款）；命令 span 不扫光', () => {
    const header = mountRunningBash().find('[data-testid="tool-block-header"]')
    const nameSpan = header.findAll('span').find((s) => s.text() === 'bash')
    expect(nameSpan).toBeTruthy()
    expect(nameSpan!.classes()).toContain('text-sweep')
    expect(nameSpan!.classes()).toContain('[--sweep-base:var(--neutral-mid)]')
    // 命令 span（收起态可见，无 invisible）不带扫光——扫光只扫工具名不扫命令
    const cmdSpan = header.findAll('span').find((s) => s.text() === CMD)
    expect(cmdSpan).toBeTruthy()
    expect(cmdSpan!.classes()).not.toContain('invisible')
    expect(cmdSpan!.classes()).not.toContain('text-sweep')
  })

  it('非 running（completed）bash 行不挂任何 text-sweep（扫光只随 running）', () => {
    const wrapper = mountToolBlock(makeToolCall({ toolName: 'bash', input: { command: CMD }, status: 'completed' }))
    expect(wrapper.findAll('.text-sweep').length).toBe(0)
  })
})

/* ── [chat-flow-timestamp U2 + D2 悬停化] Block 行尾时间槽 ──
 * A3 tool 块行尾 `耗时 · 时刻`：完成态耗时 = formatDuration(end - start)（从实现读：
 * formatDuration(2000) = (2000/1000).toFixed(0)+'s' = '2s'，非 '2.0s'）；endTime 缺失只显时刻；
 * running 态耗时 span 染 text-accent（实时跳动）。A4 text/thinking 块行尾只显所属 message 时刻；
 * messageTimestamp 缺失整槽不渲染（数据缺口降级语义，设计 §2.5）。
 * [D2] 三槽（tool/text/thinking）从常驻改悬停按需：DOM 恒在（messageTimestamp 有值时），
 * 可见度由 `opacity-0 + group-hover/<group>:opacity-100 + group-focus-within/<group>:opacity-100`
 * 三件套控制（悬停该行 + 键盘焦点进入该行两翼）。happy-dom 无真实 hover（PR-2 探针结论：
 * 纯 CSS 手法下 DOM 存在性无前后差异），断言形态 = 三件套类名存在性（V2/V3 的形态等价物）。
 * 期望时刻用本地 Date getter 构造（clockOf，与 formatClock 同口径；禁硬编码时区串）。 */
function clockOf(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

describe('chat-flow-timestamp U2: Block 行尾时间槽（A3/A4 + D2 悬停化）', () => {
  function mountThinkingTimeBlock(over: Record<string, unknown> = {}) {
    // collapsed 显式传 undefined（同 M3 组：键缺失会吃掉 `?? true` 的 fallback）
    return mount(Block, {
      props: { type: 'thinking', content: 'deep reasoning content', thinkingId: 't-time', collapsed: undefined, ...over },
      global: { provide: mockChatProvide(), stubs: { MarkdownRenderer: MdStub } },
    })
  }

  /** V2/V3 断言口径：槽未悬停视觉隐藏（opacity-0），悬停/键盘焦点两翼显现类在场 */
  function expectHoverVisibility(slot: { classes(): string[] }, group: string): void {
    expect(slot.classes()).toContain('opacity-0')
    expect(slot.classes()).toContain(`group-hover/${group}:opacity-100`)
    expect(slot.classes()).toContain(`group-focus-within/${group}:opacity-100`)
  }

  it('A3 tool 块 startTime=1000/endTime=3000 → 槽文本 `2s HH:MM:SS`（耗时 formatDuration(2000) + 时刻 formatClock(1000)；M3b demo 形态无 · 分隔点，行 gap 承担间距）', () => {
    const wrapper = mountToolBlock(makeToolCall({ startTime: 1000, endTime: 3000 }))
    // 剥掉全部空白后整串比对：耗时 + 时刻裸相邻（demo .dur/.ts 无分隔点），顺序结构同时锁定
    expectTimeSlotText(wrapper, '[data-testid="tool-time-slot"]', `2s${clockOf(1000)}`)
  })

  it('A3 endTime 缺失 → 槽内只有时刻无耗时（数据缺口降级，设计 §2.5）', () => {
    const wrapper = mountToolBlock(makeToolCall({ startTime: 1000, endTime: undefined }))
    expectTimeSlotText(wrapper, '[data-testid="tool-time-slot"]', clockOf(1000))
  })

  it('A3 status=running → 耗时 span 恒 text-neutral-dim（M3b demo 形态：.dur 无 accent，accent 只在呼吸弧图标）', () => {
    // endTime 显式剔除：确保断言对象是 running 耗时分支
    const wrapper = mountToolBlock(makeToolCall({ status: 'running', startTime: 1000, endTime: undefined }))
    const slot = wrapper.find('[data-testid="tool-time-slot"]')
    expect(slot.exists()).toBe(true)
    // 槽内第一个 span 是耗时 span（toolDuration 非空才渲染）
    const durSpan = slot.find('span')
    expect(durSpan.exists()).toBe(true)
    expect(durSpan.classes()).toContain('text-neutral-dim')
    expect(durSpan.classes()).not.toContain('text-accent')
    expect(durSpan.text()).not.toBe('')
  })

  it('A4 text 块 messageTimestamp=1000 → text-time-slot 文本 = formatClock(1000)（本地时刻）', () => {
    const wrapper = mountTextBlock({ messageTimestamp: 1000 })
    expectTimeSlotText(wrapper, '[data-testid="text-time-slot"]', clockOf(1000))
  })

  it('A4 thinking 块 messageTimestamp=1000 → thinking-time-slot 文本 = formatClock(1000)', () => {
    const wrapper = mountThinkingTimeBlock({ messageTimestamp: 1000 })
    expectTimeSlotText(wrapper, '[data-testid="thinking-time-slot"]', clockOf(1000))
  })

  it('A4 messageTimestamp 缺失 → text/thinking 两槽均不渲染（异常降级整槽隐藏）', () => {
    const textWrapper = mountTextBlock({})
    expect(textWrapper.find('[data-testid="text-time-slot"]').exists()).toBe(false)
    const thinkWrapper = mountThinkingTimeBlock({})
    expect(thinkWrapper.find('[data-testid="thinking-time-slot"]').exists()).toBe(false)
  })

  // ── D2 悬停化形态（V2/V3 的单测等价物；PR-2 探针结论：纯 CSS 手法下断言类名三件套）──

  it('V2: text 块无常驻时刻——text-time-slot 带 opacity-0 + 悬停/键盘两翼显现类（group/text）', () => {
    const wrapper = mountTextBlock({ messageTimestamp: 1000 })
    const slot = wrapper.find('[data-testid="text-time-slot"]')
    expect(slot.exists()).toBe(true)
    expectHoverVisibility(slot, 'text')
    // w-28 固定占位列已随悬停化移除（正文行恢复满宽），改 ml-auto 钉行尾
    expect(slot.classes()).toContain('ml-auto')
    expect(slot.classes()).not.toContain('w-28')
  })

  it('V2: thinking 块无常驻时刻——thinking-time-slot 三件套（group/think 行内已有命名分组容器）', () => {
    const wrapper = mountThinkingTimeBlock({ messageTimestamp: 1000 })
    const slot = wrapper.find('[data-testid="thinking-time-slot"]')
    expect(slot.exists()).toBe(true)
    expectHoverVisibility(slot, 'think')
  })

  it('V2: tool 块耗时常驻显形（M3b demo .dur 无显隐门控），时刻段悬停三件套（demo .ts hover 显形）', () => {
    const wrapper = mountToolBlock(makeToolCall({ startTime: 1000, endTime: 3000 }))
    const slot = wrapper.find('[data-testid="tool-time-slot"]')
    expect(slot.exists()).toBe(true)
    const spans = slot.findAll('span')
    // 耗时段常驻（无 opacity 门控）
    expect(spans[0]!.classes()).not.toContain('opacity-0')
    // 时刻段悬停/键盘两翼显现（group/tool）
    expectHoverVisibility(spans[1]!, 'tool')
  })

  it('V3: 三槽 group 容器在 DOM（悬停移开后回落 opacity-0 默认态 = 移开消失的结构前提）', () => {
    // 移开消失 / 不常驻的结构前提 = 显现类挂在 group 伪类上、默认态只有 opacity-0；
    // 本断言锁定三槽默认类集合不含任何恒显 opacity 类（如 opacity-100）
    const textWrapper = mountTextBlock({ messageTimestamp: 1000 })
    const textSlot = textWrapper.find('[data-testid="text-time-slot"]')
    expect(textSlot.classes()).not.toContain('opacity-100')
    const toolWrapper = mountToolBlock(makeToolCall({ startTime: 1000, endTime: 3000 }))
    expect(toolWrapper.find('[data-testid="tool-time-slot"]').classes()).not.toContain('opacity-100')
    const thinkWrapper = mountThinkingTimeBlock({ messageTimestamp: 1000 })
    expect(thinkWrapper.find('[data-testid="thinking-time-slot"]').classes()).not.toContain('opacity-100')
  })
})

// ═════════════════════════════════════════════════════════════════
// ui-optimize-unified 决策 8 N6（U14）：thinking 摘要行时长
// 数据源 = ThinkingBlock.startTime/endTime（Turn.vue kindBlockProps 透传）；双有值才渲染
// thinking-duration 槽（持久化重载链路 thinking part 无时间戳 → 缺值维持现状展示 = 设计
// 「推导不出则降级」分支）；形态对齐 tool-time-slot：时长 · 时刻，悬停两翼显现（group/think）。
// i18n mock 为 key-echo 模式（vitest.setup.ts：无占位符 key 追加命名值），断言数值与结构。
// ═════════════════════════════════════════════════════════════════

describe('ui-optimize-unified U14: thinking 行时长（N6）', () => {
  function mountThinkingDurationBlock(over: Record<string, unknown> = {}) {
    // collapsed 显式传 undefined（同 M3/U2 组：键缺失会吃掉 `?? true` 的 fallback）
    return mount(Block, {
      props: { type: 'thinking', content: 'deep reasoning content', thinkingId: 't-dur', collapsed: undefined, messageTimestamp: 5000, ...over },
      global: { provide: mockChatProvide(), stubs: { MarkdownRenderer: MdStub } },
    })
  }

  it('startTime=1000/endTime=3000 → thinking-duration 渲染，文本含 formatDuration(2000)（2s）', () => {
    const wrapper = mountThinkingDurationBlock({ thinkingStart: 1000, thinkingEnd: 3000 })
    const dur = wrapper.find('[data-testid="thinking-duration"]')
    expect(dur.exists()).toBe(true)
    expect(dur.text()).toContain('2s')
  })

  it('endTime 缺失（working 中 / 持久化重载链路）→ 不渲染（缺值维持现状展示）', () => {
    const wrapper = mountThinkingDurationBlock({ thinkingStart: 1000 })
    expect(wrapper.find('[data-testid="thinking-duration"]').exists()).toBe(false)
    // 时刻槽不受影响（两槽检查独立）
    expect(wrapper.find('[data-testid="thinking-time-slot"]').exists()).toBe(true)
  })

  it('startTime 缺失 / end<=start → 不渲染（检查与 useLiveToolDuration 终态分支同构）', () => {
    const noStart = mountThinkingDurationBlock({ thinkingEnd: 3000 })
    expect(noStart.find('[data-testid="thinking-duration"]').exists()).toBe(false)
    const inverted = mountThinkingDurationBlock({ thinkingStart: 3000, thinkingEnd: 1000 })
    expect(inverted.find('[data-testid="thinking-duration"]').exists()).toBe(false)
  })

  it('时长槽常驻显形（M3b demo 复刻：demo 思考行「· 持续了 X 秒」恒显，无悬停门控、无尾缀 ·）+ 时刻槽保留悬停三件套', () => {
    const wrapper = mountThinkingDurationBlock({ thinkingStart: 1000, thinkingEnd: 3000 })
    const dur = wrapper.find('[data-testid="thinking-duration"]')
    expect(dur.classes()).not.toContain('opacity-0')
    expect(dur.classes()).not.toContain('group-hover/think:opacity-100')
    expect(dur.text()).not.toContain('·')
    // 时刻槽（demo .ts）仍为悬停两翼显现
    const slot = wrapper.find('[data-testid="thinking-time-slot"]')
    expect(slot.classes()).toContain('opacity-0')
    expect(slot.classes()).toContain('group-hover/think:opacity-100')
    expect(slot.classes()).toContain('group-focus-within/think:opacity-100')
  })
})

describe('ui-optimize-unified 决策 10 修正: thinking 扫光生命周期（块级，随思考完结熄灭）', () => {
  function mountSweepBlock(over: Record<string, unknown> = {}) {
    return mount(Block, {
      props: { type: 'thinking', content: 'deep reasoning content', thinkingId: 't-sweep', collapsed: undefined, messageTimestamp: 5000, ...over },
      global: { provide: mockChatProvide(), stubs: { MarkdownRenderer: MdStub } },
    })
  }

  it('思考进行中（working + 有 start 无 end）→ 状态词与预览两挂点都挂 text-sweep（整体一起闪）', () => {
    const wrapper = mountSweepBlock({ working: true, thinkingStart: 1000 })
    expect(wrapper.findAll('.text-sweep').length).toBe(2)
  })

  it('思考完结但消息仍在流式（working + start/end 双有值）→ 扫光熄灭（工具行闪时思考行不再闪）', () => {
    const wrapper = mountSweepBlock({ working: true, thinkingStart: 1000, thinkingEnd: 3000 })
    expect(wrapper.findAll('.text-sweep').length).toBe(0)
  })

  it('非 working（历史/完结块）→ 恒不扫', () => {
    const idle = mountSweepBlock()
    expect(idle.findAll('.text-sweep').length).toBe(0)
    const ended = mountSweepBlock({ thinkingStart: 1000, thinkingEnd: 3000 })
    expect(ended.findAll('.text-sweep').length).toBe(0)
  })

  it('重载链路时间戳缺失（start/end 双 undefined）→ 跟随消息级 working 扫（恢复中会话无数据可判，活性优先）', () => {
    const wrapper = mountSweepBlock({ working: true })
    expect(wrapper.findAll('.text-sweep').length).toBe(2)
  })
})

// ═════════════════════════════════════════════════════════════════
// run 类型分组：Block 组块渲染
// 组头数据（base + 三条计数口径）由 core groupToolRuns 算好，本文件断言渲染形态：
// 组头 testid / 组名 / 统计段 / 失败段、默认开合（①A：挂载一律收起，running 组也不例外）、
// 成员默认收起态、两步路径、failed 成员默认展开。
// ═════════════════════════════════════════════════════════════════

/** 组块 fixture：ToolCall[] → Turn.vue 组分支透传的 group prop 形态（base/members/header/hasRunning/miles）。 */
function makeRunGroupProp(
  tools: ToolCall[],
  opts: { base?: RunGroupBase; miles?: RunGroupMile[] } = {},
) {
  return {
    base: opts.base ?? ('exec' as RunGroupBase),
    members: tools.map((tc, i) => ({
      assistantId: 'a1',
      assistantStatus: 'complete' as const,
      block: { kind: 'tool' as const, ref: tc },
      flatIndex: i,
    })),
    header: {
      count: tools.length,
      durationMs: tools.reduce((sum, t) => sum + Math.max(0, (t.endTime ?? 0) - t.startTime), 0),
      failedCount: tools.filter((t) => t.status === 'error').length,
    },
    hasRunning: tools.some((t) => t.status === 'running'),
    // miles 缺省不入键（对齐「字段缺席即无徽标」的生产路径；显式传 [] 走另一分支）
    ...(opts.miles ? { miles: opts.miles } : {}),
  }
}

function mountRunGroup(group: ReturnType<typeof makeRunGroupProp>) {
  return mount(Block, {
    props: { type: 'run-group', group, sessionId: 'sess-run-group-test' },
    global: {
      provide: mockChatProvide(), // N1 起 Block setup 执行 useChatViewDeps inject，直接 mount 必须注入
      stubs: { GuiComponentRenderer: GuiStub, AnsiText: AnsiStub, MarkdownRenderer: MdStub },
    },
  })
}

describe('run 类型分组: Block 组块', () => {
  it('组行形态：run-group / run-group-header testid 存在（e2e gui-components 组头分支的锚点）', () => {
    const wrapper = mountRunGroup(makeRunGroupProp([makeToolCall({ id: 'b0', toolName: 'bash', input: { command: 'echo hi' }, startTime: 0, endTime: 1000 })]))
    expect(wrapper.find('[data-testid="run-group"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="run-group-header"]').exists()).toBe(true)
  })

  it('组头文案：类型名键 + 统计段「{count} 步 · 耗时」+ 失败段（header 由 core 算好，组件零解析）', () => {
    const wrapper = mountRunGroup(
      makeRunGroupProp([
        makeToolCall({ id: 'b0', toolName: 'bash', input: { command: 'a' }, startTime: 0, endTime: 1500 }),
        makeToolCall({ id: 'b1', toolName: 'bash', input: { command: 'b' }, status: 'error', startTime: 2000, endTime: 3500 }),
        makeToolCall({ id: 'b2', toolName: 'bash', input: { command: 'c' }, startTime: 4000, endTime: 5000 }),
      ]),
    )
    const headerText = wrapper.find('[data-testid="run-group-header"]').text()
    // 组名走 runGroup* 键（测试环境 t() 返回 key；中文文案由文件末「组名文案」用例对 locale 断言）
    expect(headerText).toContain('panel.message.runGroupExec')
    expect(headerText).toContain('panel.message.runGroupSteps')
    expect(headerText).toContain('3') // N = 成员数（mock 把命名参数拼进 key 串）
    expect(headerText).toContain('4s') // 耗时 = 1500+1500+1000 = 4000ms → formatDuration '4s'
    expect(wrapper.find('[data-testid="run-group-failed"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="run-group-failed"]').text()).toContain('1') // · 含 M 次失败
  })

  it('组名按 base 走三档（探索 / 改动 / 执行命令）', () => {
    const headerOf = (base: RunGroupBase) =>
      mountRunGroup(makeRunGroupProp([makeToolCall({ id: 'r0', toolName: 'read', input: { path: '/x' } })], { base }))
        .find('[data-testid="run-group-header"]')
        .text()
    expect(headerOf('explore')).toContain('panel.message.runGroupExplore')
    expect(headerOf('edit')).toContain('panel.message.runGroupEdit')
    expect(headerOf('exec')).toContain('panel.message.runGroupExec')
  })

  it('序号下线（21243ca3a）回归护栏：组头组名后无「· N」序号段（单成员 + 多成员）', () => {
    // 单成员 explore 组（实测组头文本 = runGroupExplore + runGroupSteps 1 · 4s，· 4s 为合法
    // 耗时分隔符，故锚定组名之后的 · N）+ 多成员 exec 组（实测 = runGroupExec + runGroupSteps
    // 2 · 8s）：捕获「无条件复辟」与「members.length>1 条件复辟」两形态。
    // 忠实原形 v-if seq>1（第 2 个同名组才渲染，取决于同名组次序而非成员数）在 Block 单组
    // fixture 下 seq 恒 1 不渲染 span，该形态由 Turn.test.ts 路径 C 真实 Block mount 的
    // 双 explore 组护栏覆盖——两处互为补充，缺一即漏。
    const headerOf = (base: RunGroupBase) =>
      mountRunGroup(makeRunGroupProp([makeToolCall({ id: 'r0', toolName: 'read', input: { path: '/x' } })], { base }))
        .find('[data-testid="run-group-header"]')
        .text()
    expect(headerOf('explore')).not.toMatch(/runGroupExplore\s*·\s*\d+/)
    expect(mountBashPairGroup().find('[data-testid="run-group-header"]').text()).not.toMatch(/runGroupExec\s*·\s*\d+/)
  })

  it('耗时不足 1s 不显示（统计段只剩步数）', () => {
    const wrapper = mountRunGroup(
      makeRunGroupProp([makeToolCall({ id: 'b0', toolName: 'bash', input: { command: 'a' }, startTime: 0, endTime: 400 })]),
    )
    const headerText = wrapper.find('[data-testid="run-group-header"]').text()
    expect(headerText).toContain('panel.message.runGroupSteps')
    expect(headerText).toContain('1') // 1 步
    expect(headerText).not.toContain('400ms')
  })

  it('里程碑徽标（§3.6）：miles 非空 → 组头渲染 run-group-mile（文案键 + accent 低饱和 pill 类），空/缺省 → 不渲染', () => {
    const withMile = mountRunGroup(
      makeRunGroupProp([makeToolCall({ id: 'e0', toolName: 'edit', input: { path: '/x' }, startTime: 0, endTime: 800 })], {
        base: 'edit',
        miles: ['firstEdit'],
      }),
    )
    const badge = withMile.find('[data-testid="run-group-mile"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('panel.message.runGroupMileFirstEdit')
    // demo .rg-badge 视觉：mono + accent 字 / accent-ring 边 / accent-soft 底 / pill 圆角
    expect(badge.classes()).toContain('rg-badge') // scoped 动效钩子（pop 200ms）
    expect(badge.classes()).toContain('font-mono')
    expect(badge.classes()).toContain('text-accent')
    expect(badge.classes()).toContain('border-accent-ring')
    expect(badge.classes()).toContain('bg-accent-soft')
    expect(badge.classes()).toContain('rounded-full')

    // 无徽标两种输入（缺省字段 / 空数组）都不渲染
    expect(mountRunGroup(makeRunGroupProp([makeToolCall({ id: 'b0', toolName: 'bash', input: { command: 'a' } })])).find('[data-testid="run-group-mile"]').exists()).toBe(false)
    expect(mountRunGroup(makeRunGroupProp([makeToolCall({ id: 'b0', toolName: 'bash', input: { command: 'a' } })], { miles: [] })).find('[data-testid="run-group-mile"]').exists()).toBe(false)
  })

  it('里程碑徽标位置：位于组名之后、统计段之前（demo .rg-head 元素序：dot/图标 → 名 → badge* → stat）', () => {
    const wrapper = mountRunGroup(
      makeRunGroupProp([makeToolCall({ id: 'e0', toolName: 'edit', input: { path: '/x' } })], {
        base: 'edit',
        miles: ['firstEdit'],
      }),
    )
    const header = wrapper.find('[data-testid="run-group-header"]').element
    const badge = wrapper.find('[data-testid="run-group-mile"]').element
    // 统计段（mono 的「N 步」span）在徽标之后
    const statEl = [...header.children].find((el) => el.textContent?.includes('panel.message.runGroupSteps'))
    expect(statEl).toBeTruthy()
    expect(badge.compareDocumentPosition(statEl!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('failedCount=0 → 失败段不渲染（组行不虚构失败）', () => {
    const wrapper = mountBashPairGroup()
    expect(wrapper.find('[data-testid="run-group-failed"]').exists()).toBe(false)
  })

  it('hasRunning 执行态视觉：true → 组头专属动效款（tool-bash 光标闪烁）+ 行文字恒 text-neutral-mid；false → 静态图标 + text-neutral-mid', () => {
    const runningWrapper = mountRunGroup(makeRunGroupProp([
      makeToolCall({ id: 'b0', toolName: 'bash', input: { command: 'a' }, startTime: 0, endTime: 1000 }),
      makeToolCall({ id: 'b1', toolName: 'bash', input: { command: 'b' }, status: 'running', startTime: 2000 }),
    ]))
    const runningHeader = runningWrapper.find('[data-testid="run-group-header"]')
    // 行文字不染 accent（demo 运行态 = 状态色只在图标，.tool .t-name 恒 mid）
    expect(runningHeader.classes()).toContain('text-neutral-mid')
    expect(runningHeader.classes()).not.toContain('text-accent')
    // 组头动效 = 组类别同款（exec → tool-bash 光标闪烁，RUN_GROUP_RUNNING_ICON）
    expect(runningHeader.find('[data-running-icon="tool-bash"]').exists()).toBe(true)

    const doneWrapper = mountBashPairGroup()
    const doneHeader = doneWrapper.find('[data-testid="run-group-header"]')
    expect(doneHeader.classes()).toContain('text-neutral-mid')
    expect(doneHeader.classes()).not.toContain('text-accent')
    expect(doneHeader.find('[data-running-icon]').exists()).toBe(false)
  })

  it('默认开合（2026-10-15 裁决 ①A）：挂载一律收起——running 组也不例外（成员行不在场，与回看形态一致）；用户点击才展开', () => {
    const running = mountRunGroup(makeRunGroupProp([
      makeToolCall({ id: 'b0', toolName: 'bash', input: { command: 'a' } }),
      makeToolCall({ id: 'b1', toolName: 'bash', input: { command: 'b' }, status: 'running' }),
    ]))
    expect(running.find('[data-testid="run-group"]').findAll('[data-testid^="block-tool-"]').length).toBe(0)
    expect(running.find('[data-testid="run-group-header"]').attributes('aria-expanded')).toBe('false')

    const done = mountBashPairGroup()
    expect(done.find('[data-testid="run-group"]').findAll('[data-testid^="block-tool-"]').length).toBe(0)
    expect(done.find('[data-testid="run-group-header"]').attributes('aria-expanded')).toBe('false')
  })

  it('展开收起（用户手动开合）：点组头展开 → 成员行各自 1 行收起态；再点收起 → 成员消失', async () => {
    const wrapper = mountBashPairGroup()
    expect(wrapper.find('[data-testid="run-group"]').findAll('[data-testid^="block-tool-"]').length).toBe(0) // 默认收起（成员行锚点 = block-tool-<id> testid，W3 直递 ToolRow 后由 RunGroupBlock 补挂；外层查找收窄到组子树，排除组头自身）
    await wrapper.find('[data-testid="run-group-header"]').trigger('click')
    const members = wrapper.find('[data-testid="run-group"]').findAll('[data-testid^="block-tool-"]')
    expect(members.length).toBe(2) // 成员行出现
    // 成员保持各自 1 行收起态（PR-1 行高不变量）：无展开输出区
    expect(wrapper.find('.tool-result').exists()).toBe(false)
    // aria-expanded 翻转
    expect(wrapper.find('[data-testid="run-group-header"]').attributes('aria-expanded')).toBe('true')
    await wrapper.find('[data-testid="run-group-header"]').trigger('click')
    expect(wrapper.find('[data-testid="run-group"]').findAll('[data-testid^="block-tool-"]').length).toBe(0) // 收起
    expect(wrapper.find('[data-testid="run-group-header"]').attributes('aria-expanded')).toBe('false')
  })

  it('两步路径：组展开 → 点成员行 → 该成员完整输出可见', async () => {
    const wrapper = mountRunGroup(makeRunGroupProp([
      makeToolCall({ id: 'b0', toolName: 'bash', input: { command: 'echo step-one' }, output: 'step-one-output' }),
      makeToolCall({ id: 'b1', toolName: 'bash', input: { command: 'echo step-two' } }),
    ]))
    await wrapper.find('[data-testid="run-group-header"]').trigger('click')
    // 第一步：组展开（成员行在场、均收起）
    expect(wrapper.find('.tool-result').exists()).toBe(false)
    // 第二步：点成员行 → 完整输出可见（bash 凹槽命令头 + 输出）
    const firstHeader = wrapper.find('[data-testid="run-group"]').findAll('[data-testid^="block-tool-"]')[0].find('[data-testid="tool-block-header"]')
    await firstHeader.trigger('click')
    const expanded = wrapper.find('[data-testid="run-group"]').findAll('[data-testid^="block-tool-"]')[0]
    expect(expanded.text()).toContain('echo step-one')
    expect(expanded.text()).toContain('step-one-output')
  })

  it('失败成员行在组展开后挂载即默认展开（错误输出立即可见，无需再点）', async () => {
    const wrapper = mountRunGroup(makeRunGroupProp([
      makeToolCall({ id: 'b0', toolName: 'bash', input: { command: 'ok' } }),
      makeToolCall({ id: 'b1', toolName: 'bash', input: { command: 'boom' }, status: 'error', error: 'exit code 1' }),
      makeToolCall({ id: 'b2', toolName: 'bash', input: { command: 'after' } }),
    ]))
    await wrapper.find('[data-testid="run-group-header"]').trigger('click')
    const members = wrapper.find('[data-testid="run-group"]').findAll('[data-testid^="block-tool-"]')
    expect(members.length).toBe(3)
    // 失败成员（第 2 个）挂载即展开：输出区在场（displayContent 兜底 tool.error）
    expect(members[1].find('.tool-result').exists()).toBe(true)
    expect(members[1].text()).toContain('exit code 1')
    // 非失败成员保持收起
    expect(members[0].find('.tool-result').exists()).toBe(false)
  })

  it('组名与统计段文案在 zh / en 两侧都登记（键缺失时生产环境会把 key 原样渲染到界面）', () => {
    expect(zhPanel.message.runGroupExplore).toBe('探索')
    expect(zhPanel.message.runGroupEdit).toBe('改动')
    expect(zhPanel.message.runGroupExec).toBe('执行命令')
    expect(zhPanel.message.runGroupSteps).toBe('{count} 步')
    expect(enPanel.message.runGroupExplore).toBe('Explore')
    expect(enPanel.message.runGroupEdit).toBe('Edits')
    expect(enPanel.message.runGroupExec).toBe('Commands')
    expect(enPanel.message.runGroupSteps).toBe('{count} steps')
    // 里程碑徽标（§3.6）：信号来源 = core 结构派生（首个 completed edit/write）
    expect(zhPanel.message.runGroupMileFirstEdit).toBe('首个改动')
    expect(enPanel.message.runGroupMileFirstEdit).toBe('First edit')
  })
})
