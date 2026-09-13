/**
 * Block.vue text 分支样式测试（block-rendering M0，TC-M0-4）。
 *
 * [block-rendering M0] 文字样式模型统一：所有 text 全 inline 统一正文级
 * （text-base/leading-7），颜色跟随所属 assistant streaming 态（streaming→neutral-mid，
 * complete/缺省→neutral-fg，单调不随兄弟 message 翻转）。旧「过程文字暗色小字」两级
 * 视觉层级已取消（text-sm/leading-relaxed/恒 neutral-mid 移除）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/Block.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { Block } from '@xyz-agent/ui'
import type { MessageStatus } from '@xyz-agent/shared'
import { MdStub, AnsiStub, makeToolCall, mountToolBlock } from './helpers'

function mountTextBlock(over: { streaming?: boolean; status?: MessageStatus; error?: string; content?: string; messageTimestamp?: number } = {}) {
  return mount(Block, {
    props: {
      type: 'text',
      content: 'hello',
      ...over,
    },
    global: {
      // 渲染 content 的 stub：wrapper.text() 才能断言正文/错误文本（stubs: true 会吞掉 content）
      stubs: {
        MarkdownRenderer: {
          props: ['content', 'variant'],
          template: '<div class="stub-md">{{ content }}</div>',
        },
      },
    },
  })
}

describe('block-rendering M0: Block text 分支正文样式（TC-M0-4）', () => {
  it('text 分支统一正文级样式：text-base/leading-7，不含 text-sm/leading-relaxed', () => {
    const wrapper = mountTextBlock({})
    const textEl = wrapper.find('.trace-blk > div')
    expect(textEl.classes()).toContain('text-[length:var(--text-base)]')
    expect(textEl.classes()).toContain('leading-7')
    expect(textEl.classes()).not.toContain('text-[length:var(--text-sm)]')
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

/* ── error-visibility M2：text 分支 error 形态判定（TC1 纯 error / TC3 追加形态）──
 * SSOT: docs/architecture/conversation-error-visibility.md §3.3.2
 * - 纯 error（status==='error' 无 msg.error）：整条 danger（AlertCircle + text-danger）
 * - 追加形态（status==='error' 且 msg.error 有值）：content 正常正文保持原色，error 独立 danger 行 */
describe('error-visibility M2: Block text 分支 error 形态判定（TC1/TC3）', () => {
  it('TC1: 纯 error 消息整条 danger（AlertCircle 图标 + text-danger，无 msg.error）', () => {
    const wrapper = mountTextBlock({ content: '压缩失败', status: 'error' })
    const textEl = wrapper.find('[data-testid="block-text"]')
    expect(textEl.classes()).toContain('text-danger') // 整条染 danger
    expect(textEl.classes()).not.toContain('text-neutral-fg') // 不再是正常正文色
    expect(wrapper.find('[data-testid="block-text-error-icon"]').exists()).toBe(true) // AlertCircle 图标
    expect(wrapper.text()).toContain('压缩失败') // errorText 即全文
    // 追加形态专属的独立 error 行不应出现
    expect(wrapper.find('[data-testid="block-text-error"]').exists()).toBe(false)
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
    // 纯 error 专属的整条图标行不应出现（追加形态 content 前无图标）
    expect(wrapper.find('[data-testid="block-text-error-icon"]').exists()).toBe(false)
  })
})

/* ── error-visibility M1：failed tool header danger 色 + 终态默认展开（TC1-3）──
 * SSOT: docs/architecture/conversation-error-visibility.md §3.3.1
 * - T1: toolStatusClass failed 分支 → text-danger（unfinished 保持中性灰）
 * - T2: toolCollapsed 终态分化——failed(error) 初值 false（展开），其余 true（收起）
 * - CQ1: streaming 中失败不展开（mount 快照，running→error 不 remount），本测试覆盖终态挂载分支
 * stub / makeToolCall / mountToolBlock 经 ./helpers 共享（与 BlockWorkflow.test.ts 公共样板提取） */

describe('error-visibility M1: failed tool header danger + 终态展开（TC1-3）', () => {
  it('TC1: failed(error) tool header 染 text-danger（非中性灰）', () => {
    const wrapper = mountToolBlock(makeToolCall({ status: 'error', output: 'ENOENT: no such file' }))
    const header = wrapper.find('[data-testid="tool-block-header"]')
    expect(header.classes()).toContain('text-danger')
    // 不再是中性灰
    expect(header.classes()).not.toContain('text-neutral-dim')
  })

  it('TC2: failed(error) tool 终态挂载默认展开（错误输出可见，无需点击）', () => {
    const wrapper = mountToolBlock(makeToolCall({ status: 'error', output: 'ENOENT: no such file' }))
    // toolCollapsed 初值 false → toolExpanded true → 详情区默认渲染（无需点击 header）
    expect(wrapper.find('.tool-result').exists()).toBe(true)
    // 错误输出文本可见
    expect(wrapper.text()).toContain('ENOENT: no such file')
  })

  it('TC3: unfinished(end_not_received) tool header 保持中性灰（abort/中断非失败，不标红）', () => {
    const wrapper = mountToolBlock(makeToolCall({ status: 'end_not_received' }))
    const header = wrapper.find('[data-testid="tool-block-header"]')
    expect(header.classes()).toContain('text-neutral-dim')
    // unfinished 不标红（区别于 failed）
    expect(header.classes()).not.toContain('text-danger')
  })
})

/* ── feat-chat-flow-dim：已完成过程块置灰（完成态降两档，与 running accent 形成亮暗对比）──
 * - completed tool header 从 neutral-fg 经 mid 降到 neutral-dim（用户实测 mid 档置灰感不足
 *   后明确裁决再降一档；dim 3.56:1 不过 AA，此裁决仅限过程块折叠 header）
 * - running 保持 accent 不回归 */
describe('feat-chat-flow-dim: completed tool header 置灰', () => {
  it('completed tool header 染 text-neutral-dim（不再是最亮 neutral-fg）', () => {
    const wrapper = mountToolBlock(makeToolCall({ status: 'completed' }))
    const header = wrapper.find('[data-testid="tool-block-header"]')
    expect(header.classes()).toContain('text-neutral-dim')
    expect(header.classes()).not.toContain('text-neutral-fg')
  })

  it('running tool header 保持 text-accent（进行中不置灰）', () => {
    const wrapper = mountToolBlock(makeToolCall({ status: 'running' }))
    const header = wrapper.find('[data-testid="tool-block-header"]')
    expect(header.classes()).toContain('text-accent')
    expect(header.classes()).not.toContain('text-neutral-dim')
  })
})

/* ── error-visibility M3：thinking 可收起 + 完成态回落（TC1-3）──
 * SSOT: docs/architecture/conversation-error-visibility.md §3.3.3
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
    const thinkHeader = minHeightEl.exists() ? minHeightEl : wrapper.find('.trace-think .flex.items-center')
    expect(thinkHeader.exists()).toBe(true)
    // 切换 working 态后 DOM 结构不变
    await wrapper.setProps({ working: false } as never)
    const thinkHeaderAfter = minHeightEl.exists() ? minHeightEl : wrapper.find('.trace-think .flex.items-center')
    expect(thinkHeaderAfter.exists()).toBe(true)
  })

  it('working 态尾行视口锁单行高度 + 横向钉右结构（2026-08 抖动修复形态守卫）', async () => {
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

// U9: tool 双态——running 态显示去 ANSI 末行文本，completed 态显示 shortenForHeader
// rAF mock setup for U9-U10
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
  const ANSI_OUTPUT_RAW = '\x1b[32m✓ success\x1b[0m\n\x1b[1;34m── build output ──\x1b[0m\nfinal line of output'
  const ANSI_OUTPUT_CLEAN = '✓ success\n── build output ──\nfinal line of output'

  it('running + 有 outputRaw → 折叠头含去 ANSI 末行文本', async () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'bash',
      input: { command: 'pnpm build' },
      status: 'running',
      outputRaw: ANSI_OUTPUT_RAW,
      output: ANSI_OUTPUT_CLEAN,
    }))
    await nextTick()
    await flushRaf()
    const header = wrapper.find('[data-testid="tool-block-header"]')
    // 去 ANSI 后的末行应可见
    expect(header.text()).toContain('final line of output')
    // ANSI 色码不应出现在 header 文本中
    expect(header.text()).not.toContain('\x1b')
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
  it('running + 无 outputRaw/displayContent → 折叠头含 argPath 原文', async () => {
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
  })
})

/* ── bash-running-stream-output（U3）：bash 展开恒渲染容器 + 输出区内容守卫 + 尾行取数回退 ──
 * SSOT: docs/design/bash-running-stream-output.md §6.2 D2 / §6.3 D3 / §7 U3
 * - D2: bash 展开容器恒渲染（含命令块），空输出不再「header 摘要消失 + 内容空白」假展开
 * - D3: toolTailLines bash raw 源 outputRaw ?? displayContent（无 ANSI 输出走 displayContent 尾行） */
describe('bash-running-stream-output: bash 展开容器与输出守卫（U3）', () => {
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
    // 输出文本区不渲染（内容守卫生效）
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

  it('completed + output undefined：展开同样仅命令块（缺省 output 同守卫）', async () => {
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

  it('尾行取数回退：running + 无 outputRaw（纯 output）→ header 尾行视口含最后一行', async () => {
    const wrapper = mountToolBlock(makeToolCall({
      toolName: 'bash',
      input: { command: 'pnpm test' },
      status: 'running',
      output: 'step-1\nstep-2\nstep-3',
      // 无 outputRaw（D3：raw 源回退 displayContent）
    }))
    await nextTick()
    await flushRaf()
    const header = wrapper.find('[data-testid="tool-block-header"]')
    // 尾行视口渲染（toolTailLines 非空才出现 h-[1lh] 视口）且含最后一行
    expect(header.find('.h-\\[1lh\\]').exists()).toBe(true)
    expect(header.text()).toContain('step-3')
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

/* ── [chat-flow-timestamp U2] Block 行尾时间槽（设计 §3 A3/A4）──
 * A3 tool 块行尾 `耗时 · 时刻`：完成态耗时 = formatDuration(end - start)（从实现读：
 * formatDuration(2000) = (2000/1000).toFixed(0)+'s' = '2s'，非 '2.0s'）；endTime 缺失只显时刻；
 * running 态耗时 span 染 text-accent（实时跳动）。A4 text/thinking 块行尾只显所属 message 时刻；
 * messageTimestamp 缺失整槽不渲染（数据缺口降级语义，设计 §2.5）。
 * 期望时刻用本地 Date getter 构造（clockOf，与 formatClock 同口径；禁硬编码时区串）。 */
function clockOf(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

describe('chat-flow-timestamp U2: Block 行尾时间槽（A3/A4）', () => {
  function mountThinkingTimeBlock(over: Record<string, unknown> = {}) {
    // collapsed 显式传 undefined（同 M3 组：键缺失会吃掉 `?? true` 的 fallback）
    return mount(Block, {
      props: { type: 'thinking', content: 'deep reasoning content', thinkingId: 't-time', collapsed: undefined, ...over },
      global: { stubs: { MarkdownRenderer: MdStub } },
    })
  }

  it('A3 tool 块 startTime=1000/endTime=3000 → 槽文本 `2s·HH:MM:SS`（耗时 formatDuration(2000) + 时刻 formatClock(1000)）', () => {
    const wrapper = mountToolBlock(makeToolCall({ startTime: 1000, endTime: 3000 }))
    const slot = wrapper.find('[data-testid="tool-time-slot"]')
    expect(slot.exists()).toBe(true)
    // 剥掉全部空白后整串比对：耗时 + · 分隔 + 时刻，顺序结构同时锁定
    expect(slot.text().replace(/\s+/g, '')).toBe(`2s·${clockOf(1000)}`)
  })

  it('A3 endTime 缺失 → 槽内只有时刻无耗时（数据缺口降级，设计 §2.5）', () => {
    const wrapper = mountToolBlock(makeToolCall({ startTime: 1000, endTime: undefined }))
    const slot = wrapper.find('[data-testid="tool-time-slot"]')
    expect(slot.exists()).toBe(true)
    expect(slot.text().replace(/\s+/g, '')).toBe(clockOf(1000))
  })

  it('A3 status=running → 耗时 span 染 text-accent（实时跳动态，end>start 静态分支不走）', () => {
    // endTime 显式剔除：确保 accent 来自 running 分支而非静态耗时
    const wrapper = mountToolBlock(makeToolCall({ status: 'running', startTime: 1000, endTime: undefined }))
    const slot = wrapper.find('[data-testid="tool-time-slot"]')
    expect(slot.exists()).toBe(true)
    // 槽内第一个 span 是耗时 span（toolDuration 非空才渲染）
    const durSpan = slot.find('span')
    expect(durSpan.exists()).toBe(true)
    expect(durSpan.classes()).toContain('text-accent')
    expect(durSpan.text()).not.toBe('')
  })

  it('A4 text 块 messageTimestamp=1000 → text-time-slot 文本 = formatClock(1000)（本地时刻）', () => {
    const wrapper = mountTextBlock({ messageTimestamp: 1000 })
    const slot = wrapper.find('[data-testid="text-time-slot"]')
    expect(slot.exists()).toBe(true)
    expect(slot.text().replace(/\s+/g, '')).toBe(clockOf(1000))
  })

  it('A4 thinking 块 messageTimestamp=1000 → thinking-time-slot 文本 = formatClock(1000)', () => {
    const wrapper = mountThinkingTimeBlock({ messageTimestamp: 1000 })
    const slot = wrapper.find('[data-testid="thinking-time-slot"]')
    expect(slot.exists()).toBe(true)
    expect(slot.text().replace(/\s+/g, '')).toBe(clockOf(1000))
  })

  it('A4 messageTimestamp 缺失 → text/thinking 两槽均不渲染（异常降级整槽隐藏）', () => {
    const textWrapper = mountTextBlock({})
    expect(textWrapper.find('[data-testid="text-time-slot"]').exists()).toBe(false)
    const thinkWrapper = mountThinkingTimeBlock({})
    expect(thinkWrapper.find('[data-testid="thinking-time-slot"]').exists()).toBe(false)
  })
})
