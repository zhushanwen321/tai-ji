import type { TreeItem } from '@zhushanwen/extension-protocol';
import GuiComponentRenderer from '../GuiComponentRenderer.vue';
import { ACTION_EXECUTOR_KEY, type ActionArgs, type ActionExecutor } from '../action-executor-key';
import Actionbar from '../primitives/Actionbar.vue';
import AnsiText from '../primitives/AnsiText.vue';
import Card from '../primitives/Card.vue';
import Columns from '../primitives/Columns.vue';
import ListTree from '../primitives/ListTree.vue';
import ProgressBar from '../primitives/ProgressBar.vue';
import StatsLine from '../primitives/StatsLine.vue';
import TabBar from '../primitives/TabBar.vue';
import { GUI_CUSTOM_REGISTRY_KEY } from '@taiji/core/rendering-protocol/custom-registry';
import { flushPromises, mount } from '@vue/test-utils';
import type { GuiComponent, GuiComponentProps, HostContainerAction } from '@zhushanwen/extension-protocol';
import {
  CONTAINER_NAVIGATION_KEY,
  VIEW_SCOPE_SESSION_KEY,
  type ContainerNavigationExecutor,
} from '../container-navigation-key';
import { AnsiUp } from 'ansi_up';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← Actionbar.test.ts
// ======================================================================

type Items = GuiComponentProps['action-bar']['items']

type ExecuteFn = (id: string, args?: ActionArgs) => void

const makeExecutor = (): { execute: ReturnType<typeof vi.fn<ExecuteFn>> } & ActionExecutor => ({
  execute: vi.fn<ExecuteFn>(),
})

// console.warn spy 跨用例复位（vi.spyOn 对同方法复用底层 mock，不 restore 会累积调用计数）
afterEach(() => {
  vi.restoreAllMocks()
})

/** 应用路径喂树：GuiComponentRenderer 挂载（壳层 provide 执行器，同 renderer 组合形态） */
const mountViaRenderer = (items: Items, executor: ActionExecutor) =>
  mount(GuiComponentRenderer, {
    props: {
      component: { type: 'action-bar', props: { items } } satisfies GuiComponent<'action-bar'>,
    },
    global: { provide: { [ACTION_EXECUTOR_KEY as symbol]: executor } },
  })

describe('Actionbar 渲染', () => {
  it('喂树渲染 N 按钮：容器 + 逐项 testid + label 文本可见（用户可见 DOM 断言）', () => {
    const executor = makeExecutor()
    const wrapper = mountViaRenderer(
      [
        { id: 'pause-1', label: '暂停', commandId: 'sched.toggle', args: { id: 'job-9' } },
        { id: 'run-1', label: '立即执行', commandId: 'sched.run', args: { id: 'job-9' } },
        { id: 'stat-1', label: '共 2 项' },
      ],
      executor,
    )
    expect(wrapper.find('[data-testid="gui-action-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gui-action-bar-item-pause-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gui-action-bar-item-run-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gui-action-bar-item-stat-1"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('暂停')
    expect(wrapper.text()).toContain('立即执行')
    expect(wrapper.text()).toContain('共 2 项')
  })

  it('空 items 渲染容器不崩', () => {
    const wrapper = mount(Actionbar, { props: { items: [] } })
    expect(wrapper.find('[data-testid="gui-action-bar"]').exists()).toBe(true)
    expect(wrapper.findAll('.action-bar__item')).toHaveLength(0)
  })

  it('danger 项走危险样式档（text-danger），普通项无 danger 色', () => {
    // danger 色只在 actionable 态生效（需执行器可用），故 provide 执行器挂载
    const executor = makeExecutor()
    const wrapper = mount(Actionbar, {
      props: {
        items: [
          { id: 'rm-1', label: '删除', kind: 'danger', commandId: 'sched.rm' },
          { id: 'pause-1', label: '暂停', commandId: 'sched.toggle' },
        ],
      },
      global: { provide: { [ACTION_EXECUTOR_KEY as symbol]: executor } },
    })
    const dangerBtn = wrapper.find('[data-testid="gui-action-bar-item-rm-1"]')
    const normalBtn = wrapper.find('[data-testid="gui-action-bar-item-pause-1"]')
    expect(dangerBtn.classes()).toContain('text-danger')
    expect(normalBtn.classes()).not.toContain('text-danger')
  })
})

describe('Actionbar 点击 → 执行器（D2 命令链契约）', () => {
  const items: Items = [
    { id: 'pause-1', label: '暂停', commandId: 'sched.toggle', args: { id: 'job-9' } },
    { id: 'run-1', label: '立即执行', commandId: 'sched.run' },
    { id: 'rm-1', label: '删除', kind: 'danger', disabled: true, commandId: 'sched.rm', args: { id: 'job-9' } },
    { id: 'stat-1', label: '共 2 项' },
  ]

  const mountWithExecutor = () => {
    const executor = makeExecutor()
    const wrapper = mount(Actionbar, {
      props: { items },
      global: { provide: { [ACTION_EXECUTOR_KEY as symbol]: executor } },
    })
    return { executor, wrapper }
  }

  it('点击可点项 → 执行器收到 (commandId, args)', async () => {
    const { executor, wrapper } = mountWithExecutor()
    await wrapper.find('[data-testid="gui-action-bar-item-pause-1"]').trigger('click')
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(executor.execute).toHaveBeenCalledWith('sched.toggle', { id: 'job-9' })
  })

  it('args 缺省 → 执行器收到 (commandId, undefined)', async () => {
    const { executor, wrapper } = mountWithExecutor()
    await wrapper.find('[data-testid="gui-action-bar-item-run-1"]').trigger('click')
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(executor.execute).toHaveBeenCalledWith('sched.run', undefined)
  })

  it('disabled 项禁点：disabled 属性 + 禁用样式 + 点击不触发执行器', async () => {
    const { executor, wrapper } = mountWithExecutor()
    const btn = wrapper.find('[data-testid="gui-action-bar-item-rm-1"]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.classes()).toContain('disabled:pointer-events-none')
    expect(btn.classes()).toContain('disabled:opacity-50')
    await btn.trigger('click')
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('commandId 缺省 = 纯展示：span 非按钮语义 + 弱化样式，点击不触发', async () => {
    const { executor, wrapper } = mountWithExecutor()
    const node = wrapper.find('[data-testid="gui-action-bar-item-stat-1"]')
    expect(node.element.tagName).toBe('SPAN')
    expect(node.classes()).toContain('text-neutral-dim')
    await node.trigger('click')
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('可点项 ghost 档可点样式（hover 反馈），disabled 属性不设置', () => {
    const { wrapper } = mountWithExecutor()
    const btn = wrapper.find('[data-testid="gui-action-bar-item-pause-1"]')
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(btn.classes()).toContain('hover:bg-surface-hover')
    expect(btn.classes()).not.toContain('text-danger')
  })

  it('danger + disabled 并存时 disabled 优先（禁点优先于样式档）', () => {
    const { wrapper } = mountWithExecutor()
    const btn = wrapper.find('[data-testid="gui-action-bar-item-rm-1"]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.classes()).toContain('text-danger')
  })
})

describe('Actionbar 执行器缺位降级（对齐 TabBar 降级出声范式）', () => {
  it('无执行器上下文：带 commandId 项禁用（不可点）+ warn 一次', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = mount(Actionbar, {
      props: {
        items: [
          { id: 'pause-1', label: '暂停', commandId: 'sched.toggle', args: { id: 'job-9' } },
          { id: 'stat-1', label: '共 2 项' },
        ],
      },
    })
    const btn = wrapper.find('[data-testid="gui-action-bar-item-pause-1"]')
    expect(btn.attributes('disabled')).toBeDefined()
    // 纯展示项本就不需要执行器 → 只因可执行项缺执行器出声一次
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('ACTION_EXECUTOR_KEY')

    // 禁用态点击不产生任何执行（无执行器可调，组件内 guard 拦截）
    await btn.trigger('click')
    // 重复推送同形态不重复出声
    await wrapper.setProps({ items: [{ id: 'pause-1', label: '暂停', commandId: 'sched.toggle' }] })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('纯展示 items（无 commandId）在无执行器上下文不出声', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount(Actionbar, { props: { items: [{ id: 'stat-1', label: '共 2 项' }] } })
    expect(warn).not.toHaveBeenCalled()
  })
})

// ── 容器导航执行器（§6.4 hostAction 交互路径，Actionbar / ListTree 两节共用）────

type NavigateFn = (action: HostContainerAction, options?: { viewSessionId?: string }) => void

const makeNavigationExecutor = (): { navigate: ReturnType<typeof vi.fn<NavigateFn>> } & ContainerNavigationExecutor => ({
  navigate: vi.fn<NavigateFn>(),
})

describe('Actionbar 容器导航（§6.4 hostAction 交互路径，U5 验收③）', () => {
  const drawerHostAction: HostContainerAction = {
    kind: 'drawer',
    tabId: 'probe.tab',
    params: { filePath: '/tmp/report.md' },
  }

  it('仅 hostAction 项渲染为可点按钮（用户可见 DOM 断言），点击触发导航执行器', async () => {
    const nav = makeNavigationExecutor()
    const wrapper = mount(Actionbar, {
      props: { items: [{ id: 'open-1', label: '打开详情', hostAction: drawerHostAction }] },
      global: {
        provide: {
          [CONTAINER_NAVIGATION_KEY as symbol]: nav,
          [VIEW_SCOPE_SESSION_KEY as symbol]: 'view-sid',
        },
      },
    })
    const btn = wrapper.find('[data-testid="gui-action-bar-item-open-1"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    expect(nav.navigate).toHaveBeenCalledTimes(1)
    expect(nav.navigate).toHaveBeenCalledWith(drawerHostAction, { viewSessionId: 'view-sid' })
  })

  it('commandId 与 hostAction 并存 → commandId 优先走命令链，导航执行器不被调用', async () => {
    const cmd = makeExecutor()
    const nav = makeNavigationExecutor()
    const wrapper = mount(Actionbar, {
      props: {
        items: [{ id: 'both-1', label: '两路', commandId: 'sched.run', hostAction: drawerHostAction }],
      },
      global: {
        provide: {
          [ACTION_EXECUTOR_KEY as symbol]: cmd,
          [CONTAINER_NAVIGATION_KEY as symbol]: nav,
        },
      },
    })
    await wrapper.find('[data-testid="gui-action-bar-item-both-1"]').trigger('click')
    expect(cmd.execute).toHaveBeenCalledTimes(1)
    expect(cmd.execute).toHaveBeenCalledWith('sched.run', undefined)
    expect(nav.navigate).not.toHaveBeenCalled()
  })

  it('hostAction 项但导航执行器缺位 → 禁用 + warn 一次（文案含 CONTAINER_NAVIGATION_KEY）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = mount(Actionbar, {
      props: { items: [{ id: 'open-1', label: '打开详情', hostAction: drawerHostAction }] },
    })
    const btn = wrapper.find('[data-testid="gui-action-bar-item-open-1"]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('CONTAINER_NAVIGATION_KEY')
    await btn.trigger('click')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('viewSessionId 未 provide → 导航请求 options.viewSessionId 为 undefined（执行器回退焦点会话）', async () => {
    const nav = makeNavigationExecutor()
    const wrapper = mount(Actionbar, {
      props: { items: [{ id: 'open-1', label: '打开详情', hostAction: drawerHostAction }] },
      global: { provide: { [CONTAINER_NAVIGATION_KEY as symbol]: nav } },
    })
    await wrapper.find('[data-testid="gui-action-bar-item-open-1"]').trigger('click')
    expect(nav.navigate).toHaveBeenCalledWith(drawerHostAction, { viewSessionId: undefined })
  })

  it('应用路径喂树：GuiComponentRenderer 挂载含 hostAction 的树照常触发导航执行器', async () => {
    const nav = makeNavigationExecutor()
    const wrapper = mount(GuiComponentRenderer, {
      props: {
        component: {
          type: 'action-bar',
          props: { items: [{ id: 'open-1', label: '打开详情', hostAction: drawerHostAction }] },
        } satisfies GuiComponent<'action-bar'>,
      },
      global: {
        provide: {
          [CONTAINER_NAVIGATION_KEY as symbol]: nav,
          [VIEW_SCOPE_SESSION_KEY as symbol]: 'view-sid',
        },
      },
    })
    await wrapper.find('[data-testid="gui-action-bar-item-open-1"]').trigger('click')
    expect(nav.navigate).toHaveBeenCalledTimes(1)
    expect(nav.navigate).toHaveBeenCalledWith(drawerHostAction, { viewSessionId: 'view-sid' })
  })
})

// ======================================================================
// ← AnsiText.test.ts
// ======================================================================

const ESC = String.fromCharCode(27)

/** ANSI fg 码 30-37（normal 8 色）+ 90-97（bright 8 色）→ ansi_up class 名映射 */
const FG_CASES: Array<{ code: number; cls: string }> = [
  { code: 30, cls: 'ansi-black-fg' },
  { code: 31, cls: 'ansi-red-fg' },
  { code: 32, cls: 'ansi-green-fg' },
  { code: 33, cls: 'ansi-yellow-fg' },
  { code: 34, cls: 'ansi-blue-fg' },
  { code: 35, cls: 'ansi-magenta-fg' },
  { code: 36, cls: 'ansi-cyan-fg' },
  { code: 37, cls: 'ansi-white-fg' },
  { code: 90, cls: 'ansi-bright-black-fg' },
  { code: 91, cls: 'ansi-bright-red-fg' },
  { code: 92, cls: 'ansi-bright-green-fg' },
  { code: 93, cls: 'ansi-bright-yellow-fg' },
  { code: 94, cls: 'ansi-bright-blue-fg' },
  { code: 95, cls: 'ansi-bright-magenta-fg' },
  { code: 96, cls: 'ansi-bright-cyan-fg' },
  { code: 97, cls: 'ansi-bright-white-fg' },
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AnsiText', () => {
  it('16 fg class 输出：use_classes=true 时 16 色 ANSI → 对应 ansi-{color}-fg class', () => {
    for (const { code, cls } of FG_CASES) {
      const wrapper = mount(AnsiText, { props: { content: `${ESC}[${code}mX${ESC}[0m` } })
      const html = wrapper.find('[data-testid="ansi-text"]').html()
      expect(html, `code ${code} 应输出 ${cls}`).toContain(cls)
    }
  })

  it('bg class 输出存在但无样式（ansi_up 输出 -bg class，CSS 不定义故丢弃）', () => {
    // ESC[41m = red bg
    const wrapper = mount(AnsiText, { props: { content: `${ESC}[41mX${ESC}[0m` } })
    const html = wrapper.find('[data-testid="ansi-text"]').html()
    // ansi_up 正常输出 ansi-red-bg class
    expect(html).toContain('ansi-red-bg')
    // bg span 不应有内联 style（CSS 不定义 -bg 规则，ansi_up use_classes 不输出内联色）
    expect(html).not.toContain('style')
    expect(html).not.toContain('background')
    expect(html).not.toContain('color:')
  })

  it('escape_html 默认 true：XSS 输入被转义（<script> → &lt;script&gt;）', () => {
    const wrapper = mount(AnsiText, { props: { content: '<script>alert(1)</scr' + 'ipt>' } })
    const html = wrapper.find('[data-testid="ansi-text"]').html()
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('降级回退：ansi_to_html 抛错时 catch 返回原 content 纯文本', () => {
    const spy = vi.spyOn(AnsiUp.prototype, 'ansi_to_html').mockImplementation(() => {
      throw new Error('parse fail')
    })
    const content = 'raw-fallback-text'
    const wrapper = mount(AnsiText, { props: { content } })
    const el = wrapper.find('[data-testid="ansi-text"]')
    // catch 分支：v-html 注入原 content 文本
    expect(el.text()).toContain(content)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('纯文本无 ANSI：原样输出无 span 着色', () => {
    const wrapper = mount(AnsiText, { props: { content: 'hello world' } })
    const html = wrapper.find('[data-testid="ansi-text"]').html()
    expect(html).toContain('hello world')
    // 纯文本无 ANSI 着色 span（ansi_up 不生成 class="ansi-* 着色 span）
    expect(html).not.toContain('class="ansi-')
  })

  // 增量渲染三分支（续喂 + 追加 / 重建）。辅助：本地 ref 驱动 AnsiText，
  // 避免 setProps 的 .vue shim 类型问题；返回容器元素 getter 与内容 ref。
  function mountDriven(initial: string) {
    const content = ref(initial)
    const wrapper = mount({
      setup() {
        return () => h(AnsiText, { content: content.value })
      },
    })
    const el = () => wrapper.find('[data-testid="ansi-text"]').element as HTMLElement
    return { content, el }
  }

  it('纯追加：前缀增长只追加节点，已有 DOM 节点原样保留（不重建）', async () => {
    const { content, el } = mountDriven(`${ESC}[31mred`)
    const first = el().children[0]
    expect(el().childElementCount).toBeGreaterThan(0)
    content.value = `${ESC}[31mred tail text`
    await flushPromises()
    expect(el().textContent).toContain('red tail text')
    // 旧节点引用恒等 = 走了追加分支（重建分支会整体替换出全新节点）
    expect(el().children[0]).toBe(first)
  })

  it('追加时颜色状态延续：未 reset 的 fg 状态跨段持续（复用实例续喂语义）', async () => {
    const { content, el } = mountDriven(`${ESC}[31mred`)
    content.value = `${ESC}[31mred plain-continues`
    await flushPromises()
    // 增量段在 red 状态内（无 reset），续喂后仍着 red（若重建实例只喂 delta 会丢失状态漏染）
    const redSpans = [...el().querySelectorAll('.ansi-red-fg')]
    expect(redSpans.length).toBeGreaterThan(0)
    expect(redSpans.at(-1)?.textContent).toContain('plain-continues')
  })

  // 整条替换（非前缀关系）→ 重建分支新建实例：颜色状态隔离，不串色。
  // 即原 MF-2 回归的语义反转：串色防护针对「换内容」，「同段增长」反而必须复用状态。
  it('整条替换为不同文本：重建实例，颜色状态隔离（无串色）', async () => {
    const { content, el } = mountDriven(`${ESC}[31mred${ESC}`)
    const first = el().children[0]
    expect(el().innerHTML).toContain('ansi-red-fg')
    content.value = 'plain'
    await flushPromises()
    const html = el().innerHTML
    expect(html, '整条替换后纯文本不应串色为 red').not.toContain('ansi-red-fg')
    expect(html).toContain('plain')
    // 节点被整体替换 = 走了重建分支（新建 AnsiUp 隔离旧状态）
    expect(el().children[0]).not.toBe(first)
  })

  it('前缀收缩（如流式尾窗头删）：触发重建，旧节点替换且内容更新', async () => {
    const full = `${ESC}[31mhead-${'x'.repeat(50)}`
    const { content, el } = mountDriven(full)
    const first = el().children[0]
    content.value = full.slice(20) // 头删：既非前缀增长也非整条同文，只能重建
    await flushPromises()
    expect(el().children[0]).not.toBe(first)
    expect(el().textContent).not.toContain('head-')
    expect(el().textContent!.length).toBeGreaterThan(0)
  })

  // MF-1 回归：catch 降级路径经命令式 DOM 注入渲染，含 HTML payload 时必须转义防 XSS
  it('catch 降级路径 XSS 防护：ansi_to_html 抛错且 content 含 <script> 时转义', () => {
    const spy = vi.spyOn(AnsiUp.prototype, 'ansi_to_html').mockImplementation(() => {
      throw new Error('parse fail')
    })
    const wrapper = mount(AnsiText, {
      props: { content: '<script>alert(1)</scr' + 'ipt>' },
    })
    const html = wrapper.find('[data-testid="ansi-text"]').html()
    // 转义后注入，不含可执行的 <script> 标签
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    spy.mockRestore()
  })

  // 降级冻结自愈回归：首渲降级（parser 置空 / processedLen=-1）后 content 继续追加，
  // watch 不得因 !parser 直接 return 冻结在降级文本，须全量重渲染呈现新内容
  it('降级自愈：首渲降级后追加 content，全量重渲染呈现新内容而非冻结', async () => {
    const spy = vi.spyOn(AnsiUp.prototype, 'ansi_to_html').mockImplementation(() => {
      throw new Error('parse fail')
    })
    const { content, el } = mountDriven('degraded-head')
    // 首渲降级：DOM 为转义纯文本
    expect(el().textContent).toContain('degraded-head')

    // 解析恢复后继续追加：修复前 watch 在 !parser 处冻结（DOM 停留旧文本）；自愈后全量重建
    spy.mockRestore()
    content.value = 'degraded-head-tail'
    await flushPromises()
    expect(el().textContent).toContain('degraded-head-tail')

    // 自愈后增量管线恢复：同前缀追加 ANSI 段走续喂分支，着色 span 正常生成
    content.value = `degraded-head-tail${ESC}[31m colored`
    await flushPromises()
    expect(el().querySelectorAll('.ansi-red-fg').length).toBeGreaterThan(0)
  })
})

// ======================================================================
// ← Card.test.ts
// ======================================================================

describe('Card', () => {
  it('header=string + body 嵌套 stats-line 子组件（variant=elevated）', () => {
    const body: GuiComponent[] = [
      { type: 'stats-line', props: { items: [{ value: '15' }] } },
    ]
    const wrapper = mount(Card, {
      props: { variant: 'elevated', header: 'CI Pipeline', body },
    })
    const card = wrapper.find('[data-testid="gui-card"]')
    expect(card.exists()).toBe(true)
    expect(wrapper.text()).toContain('CI Pipeline')
    // body 内嵌 GuiComponentRenderer 渲染出 stats-line
    expect(wrapper.find('[data-testid="gui-stats-line"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('15')
    // v6: elevated → bg-surface-2（去 border-border-strong）
    expect(card.classes()).toContain('bg-surface-2')
    expect(card.classes()).not.toContain('border-border-strong')
    // v6: header bg 浮起（elevated → bg-bg-card；2026-10-14 全族迁移，旧 bg-bg-elevated 退役）
    const header = wrapper.find('[data-testid="gui-card"] > div:first-child')
    expect(header.classes()).toContain('bg-bg-card')
  })

  it('variant=danger → bg-surface + header dot(bg-danger) + badge(失败/b-danger)', () => {
    const wrapper = mount(Card, {
      props: { variant: 'danger', header: 'Run', body: [] },
    })
    const card = wrapper.find('[data-testid="gui-card"]')
    // v6: danger → bg-surface（去 border-danger）
    expect(card.classes()).toContain('bg-surface')
    expect(card.classes()).not.toContain('border-danger')
    // v6: header dot 用 bg-danger
    const dot = wrapper.find('[data-testid="gui-card-dot"]')
    expect(dot.exists()).toBe(true)
    expect(dot.classes()).toContain('bg-danger')
    // v6: badge 显示「失败」+ bg-danger-soft/text-danger
    const badge = wrapper.find('[data-testid="gui-card-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('失败')
    expect(badge.classes()).toContain('bg-danger-soft')
    expect(badge.classes()).toContain('text-danger')
  })

  it('variant=success → bg-surface + header dot(bg-success) + badge(完成/b-success)', () => {
    const wrapper = mount(Card, {
      props: { variant: 'success', header: 'Deploy', body: [] },
    })
    const card = wrapper.find('[data-testid="gui-card"]')
    // v6: success → bg-surface（去 border-success）
    expect(card.classes()).toContain('bg-surface')
    expect(card.classes()).not.toContain('border-success')
    const dot = wrapper.find('[data-testid="gui-card-dot"]')
    expect(dot.classes()).toContain('bg-success')
    const badge = wrapper.find('[data-testid="gui-card-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('完成')
    expect(badge.classes()).toContain('bg-success-soft')
    expect(badge.classes()).toContain('text-success')
  })

  it('variant 未传 → default（bg-surface，无 border-border）', () => {
    const wrapper = mount(Card, {
      props: { body: [] },
    })
    const card = wrapper.find('[data-testid="gui-card"]')
    // v6: default → bg-surface（去 border-border）
    expect(card.classes()).toContain('bg-surface')
    expect(card.classes()).not.toContain('border-border')
  })

  it('v6: default/elevated 无 badge，danger/success 有 badge（header 存在时）', () => {
    const defaultCard = mount(Card, { props: { variant: 'default', header: 'h', body: [] } })
    expect(defaultCard.find('[data-testid="gui-card-badge"]').exists()).toBe(false)

    const elevatedCard = mount(Card, { props: { variant: 'elevated', header: 'h', body: [] } })
    expect(elevatedCard.find('[data-testid="gui-card-badge"]').exists()).toBe(false)

    const dangerCard = mount(Card, { props: { variant: 'danger', header: 'h', body: [] } })
    expect(dangerCard.find('[data-testid="gui-card-badge"]').exists()).toBe(true)

    const successCard = mount(Card, { props: { variant: 'success', header: 'h', body: [] } })
    expect(successCard.find('[data-testid="gui-card-badge"]').exists()).toBe(true)
  })

  it('v6: 无 header 时 dot/badge 均不渲染（header 容器整体不挂载）', () => {
    const wrapper = mount(Card, { props: { variant: 'danger', body: [] } })
    expect(wrapper.find('[data-testid="gui-card-dot"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="gui-card-badge"]').exists()).toBe(false)
  })

  it('v6: dot 全 variant 显示（default/elevated=neutral-ico，danger/success=对应色，header 存在时）', () => {
    const defaultCard = mount(Card, { props: { variant: 'default', header: 'h', body: [] } })
    expect(defaultCard.find('[data-testid="gui-card-dot"]').classes()).toContain('bg-neutral-ico')

    const elevatedCard = mount(Card, { props: { variant: 'elevated', header: 'h', body: [] } })
    expect(elevatedCard.find('[data-testid="gui-card-dot"]').classes()).toContain('bg-neutral-ico')

    const dangerCard = mount(Card, { props: { variant: 'danger', header: 'h', body: [] } })
    expect(dangerCard.find('[data-testid="gui-card-dot"]').classes()).toContain('bg-danger')

    const successCard = mount(Card, { props: { variant: 'success', header: 'h', body: [] } })
    expect(successCard.find('[data-testid="gui-card-dot"]').classes()).toContain('bg-success')
  })

  it('v6: header bg 浮起（default/danger/success→bg-surface-2，elevated→bg-bg-card）', () => {
    const defaultCard = mount(Card, { props: { variant: 'default', header: 'h', body: [] } })
    expect(defaultCard.find('[data-testid="gui-card"] > div:first-child').classes()).toContain('bg-surface-2')

    const elevatedCard = mount(Card, { props: { variant: 'elevated', header: 'h', body: [] } })
    expect(elevatedCard.find('[data-testid="gui-card"] > div:first-child').classes()).toContain('bg-bg-card')
  })

  it('header 为 GuiComponent 时递归渲染（dot + badge 仍在 header 容器）', () => {
    const headerComp: GuiComponent = {
      type: 'stats-line',
      props: { items: [{ label: 'x', value: '42' }] },
    }
    const wrapper = mount(Card, {
      props: { variant: 'danger', header: headerComp, body: [] },
    })
    // component header 递归渲染出 stats-line
    expect(wrapper.find('[data-testid="gui-stats-line"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('42')
    // v6: dot + badge 仍在 header 容器（component 模式不丢失）
    expect(wrapper.find('[data-testid="gui-card-dot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gui-card-badge"]').exists()).toBe(true)
  })

  it('根容器圆角 8px（spec .gcard border-radius: 8px，rounded-md 标准 scale）', () => {
    const wrapper = mount(Card, { props: { body: [] } })
    expect(wrapper.find('[data-testid="gui-card"]').classes()).toContain('rounded-md')
    expect(wrapper.find('[data-testid="gui-card"]').classes()).not.toContain('rounded-card')
  })
})

// ======================================================================
// ← Columns.test.ts
// ======================================================================

describe('Columns', () => {
  it('ratios=[2,1] 时子区域 flex-grow 分别为 2 和 1', () => {
    const children: GuiComponent[] = [
      { type: 'ansi-text', props: { lines: ['left'] } },
      { type: 'ansi-text', props: { lines: ['right'] } },
    ]
    const wrapper = mount(Columns, {
      props: { children, ratios: [2, 1] },
    })
    const container = wrapper.find('[data-testid="gui-columns"]')
    expect(container.exists()).toBe(true)
    // v6（§3.5）：容器 gap-3(12px) 标准间距，审计确认已达标
    expect(container.classes()).toContain('gap-3')
    const kids = wrapper.findAll('.columns__child')
    expect(kids).toHaveLength(2)
    expect(kids[0].attributes('style')).toContain('flex-grow: 2')
    expect(kids[1].attributes('style')).toContain('flex-grow: 1')
    // 子组件通过 GuiComponentRenderer 渲染
    expect(wrapper.text()).toContain('left')
    expect(wrapper.text()).toContain('right')
  })

  it('ratios 未传时等分（flex-grow: 1）', () => {
    const children: GuiComponent[] = [
      { type: 'ansi-text', props: { lines: ['a'] } },
      { type: 'ansi-text', props: { lines: ['b'] } },
      { type: 'ansi-text', props: { lines: ['c'] } },
    ]
    const wrapper = mount(Columns, {
      props: { children },
    })
    // v6（§3.5）：等分场景容器同样 gap-3 标准间距
    expect(wrapper.find('[data-testid="gui-columns"]').classes()).toContain('gap-3')
    const kids = wrapper.findAll('.columns__child')
    expect(kids).toHaveLength(3)
    for (const k of kids) {
      expect(k.attributes('style')).toContain('flex-grow: 1')
    }
  })

  it('空 children 不崩', () => {
    const wrapper = mount(Columns, {
      props: { children: [] },
    })
    const container = wrapper.find('[data-testid="gui-columns"]')
    expect(container.exists()).toBe(true)
    // v6（§3.5）：空容器仍保留 gap-3 标准间距
    expect(container.classes()).toContain('gap-3')
  })
})

// ======================================================================
// ← GuiComponentRenderer.test.ts
// ======================================================================

describe('GuiComponentRenderer 路由', () => {
  it('ansi-text 类型 → 渲染 AnsiText，lines join 成 content', () => {
    const component: GuiComponent = {
      type: 'ansi-text',
      props: { lines: ['\x1b[32mhello\x1b[0m', 'world'] },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })

    // AnsiText 渲染了 data-testid="ansi-text"
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(true)
    // lines 被 join('\n')：ansi_up 把 ANSI 转成 span，"world" 作为纯文本保留
    expect(wrapper.text()).toContain('world')
    // v6：ansi_up use_classes=true 输出 class（绿色 → ansi-green-fg），非 inline color
    expect(wrapper.html()).toContain('ansi-green-fg')
  })

  it('card 类型 → 路由到真实 Card 组件（不再降级 AnsiText JSON）', () => {
    const component: GuiComponent = {
      type: 'card',
      props: { variant: 'elevated', body: [] },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })

    // 路由到 Card 组件而非 AnsiText
    expect(wrapper.find('[data-testid="gui-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
  })

  it('custom 类型未注册 → 降级 AnsiText，content 为 JSON 文本', () => {
    const component: GuiComponent = {
      type: 'custom',
      props: { component: 'my-widget', props: { count: 3 } },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })

    // 降级到 AnsiText
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(true)
    // 未注册的 custom：序列化 props（含 component 名与嵌套 props）
    const text = wrapper.text()
    expect(text).toContain('"component": "my-widget"')
    expect(text).toContain('"count": 3')
  })

  it('custom 类型已注册（provide registry）→ 路由到注册组件', () => {
    // 一个桩注册组件，挂 data-testid 便于断言
    const MyWidget = defineComponent({
      name: 'MyWidget',
      props: { count: { type: Number, required: false } },
      setup(props) {
        return () =>
          h('div', { 'data-testid': 'my-widget' }, `count=${props.count ?? '-'}`)
      },
    })

    const component: GuiComponent = {
      type: 'custom',
      props: { component: 'my-widget', props: { count: 3 } },
    }
    const wrapper = mount(GuiComponentRenderer, {
      props: { component },
      global: {
        provide: { [GUI_CUSTOM_REGISTRY_KEY]: { 'my-widget': MyWidget } },
      },
    })

    // 路由到 MyWidget 而非 AnsiText
    expect(wrapper.find('[data-testid="my-widget"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
    // 注意：custom 的 props 形状是 { component, props }，注册组件收到的是整个 props 对象
    // （v-bind 直接展开 resolvedProps = component.props）
    expect(wrapper.text()).toContain('count=')
  })

  it('ansi-text 但 props 非 { lines: string[] } 形状（脏数据）→ 降级 AnsiText 序列化', () => {
    const component: GuiComponent = {
      type: 'ansi-text',
      props: { wrong: 'shape' } as unknown as GuiComponent['props'],
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })

    // 仍渲染 AnsiText（不崩），content 序列化脏数据
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('"wrong": "shape"')
  })

  it('progress-bar → 路由到真实 ProgressBar 组件', () => {
    const component: GuiComponent = {
      type: 'progress-bar',
      props: { current: 3, total: 4 },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })
    expect(wrapper.find('[data-testid="gui-progress-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
  })

  it('stats-line → 路由到真实 StatsLine 组件', () => {
    const component: GuiComponent = {
      type: 'stats-line',
      props: { items: [{ value: '42' }] },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })
    expect(wrapper.find('[data-testid="gui-stats-line"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
  })

  it('tab-bar → 路由到真实 TabBar 组件', () => {
    const component: GuiComponent = {
      type: 'tab-bar',
      props: { tabs: [{ label: 'tab1' }] },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })
    expect(wrapper.find('[data-testid="gui-tab-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
  })

  it('columns → 路由到真实 Columns 组件', () => {
    const component: GuiComponent = {
      type: 'columns',
      props: { children: [] },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })
    expect(wrapper.find('[data-testid="gui-columns"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
  })

  it('list-tree → 路由到真实 ListTree 组件', () => {
    const component: GuiComponent = {
      type: 'list-tree',
      props: { items: [{ label: 'item1' }] },
    }
    const wrapper = mount(GuiComponentRenderer, { props: { component } })
    expect(wrapper.find('[data-testid="gui-list-tree"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ansi-text"]').exists()).toBe(false)
  })
})

// ======================================================================
// ← ListTree.test.ts
// ======================================================================

describe('ListTree', () => {
  it('递归渲染：parent 含嵌套 children + status 圆点', () => {
    const items: TreeItem[] = [
      {
        label: 'parent',
        icon: 'arrow',
        children: [
          { label: 'child1', status: 'done' },
          { label: 'child2', status: 'running' },
        ],
      },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    expect(wrapper.find('[data-testid="gui-list-tree"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('parent')
    expect(wrapper.text()).toContain('child1')
    expect(wrapper.text()).toContain('child2')
    // v6: status 是圆点（bg-*），done→bg-success，running→bg-accent
    const statuses = wrapper.findAll('[data-testid="list-tree-status"]')
    expect(statuses).toHaveLength(2)
    expect(statuses[0].classes()).toContain('bg-success')
    expect(statuses[1].classes()).toContain('bg-accent')
  })

  it('failed status 圆点 bg-danger', () => {
    const items: TreeItem[] = [
      { label: 'failed-item', status: 'failed' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    expect(wrapper.find('[data-testid="list-tree-status"]').classes()).toContain('bg-danger')
  })

  it('v6: depth 缩进 16px/层，depth=2 时 padding-left=32px', () => {
    const items: TreeItem[] = [
      { label: 'deep' },
    ]
    const wrapper = mount(ListTree, { props: { items, depth: 2 } })
    const item = wrapper.find('.list-tree__item')
    expect(item.attributes('style')).toContain('padding-left: 32px')
  })

  it('递归 children 自动 depth+1 缩进（children padding > parent padding）', () => {
    const items: TreeItem[] = [
      {
        label: 'parent',
        children: [
          { label: 'child' },
        ],
      },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    const allItems = wrapper.findAll('.list-tree__item')
    expect(allItems).toHaveLength(2)
    // parent 在 depth=0 → padding-left: 0px
    expect(allItems[0].attributes('style')).toContain('padding-left: 0px')
    // v6: child 在 depth=1 → padding-left: 16px（比 parent 缩进）
    expect(allItems[1].attributes('style')).toContain('padding-left: 16px')
  })

  it('v6: status 改圆点后无文字标签（无进行中/完成/失败文本）', () => {
    const items: TreeItem[] = [
      { label: 'a', status: 'running' },
      { label: 'b', status: 'done' },
      { label: 'c', status: 'failed' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    const statuses = wrapper.findAll('[data-testid="list-tree-status"]')
    expect(statuses).toHaveLength(3)
    // 圆点无文字内容
    for (const s of statuses) {
      expect(s.text()).toBe('')
    }
    // 整体文本不含旧 STATUS_LABEL 中文
    expect(wrapper.text()).not.toContain('进行中')
    expect(wrapper.text()).not.toContain('完成')
    expect(wrapper.text()).not.toContain('失败')
  })

  it('v6: status 圆点右对齐 + 7px 尺寸 + rounded-full', () => {
    const items: TreeItem[] = [
      { label: 'a', status: 'done' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    const dot = wrapper.find('[data-testid="list-tree-status"]')
    expect(dot.classes()).toContain('ml-auto')
    expect(dot.classes()).toContain('size-[7px]')
    expect(dot.classes()).toContain('rounded-full')
    expect(dot.classes()).toContain('bg-success')
  })

  it('v6: icon size-3(12px) 且中性（无 status text-* 着色）', () => {
    const items: TreeItem[] = [
      { label: 'checked', icon: 'check', status: 'done' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    const icon = wrapper.find('.list-tree__icon svg')
    expect(icon.exists()).toBe(true)
    expect(icon.classes()).toContain('size-3')
    // v6: icon 不再着 status 色（中性，继承 label）
    expect(icon.classes()).not.toContain('text-success')
    expect(icon.classes()).not.toContain('text-accent')
    expect(icon.classes()).not.toContain('text-danger')
  })

  it('icon=check 渲染对应图标', () => {
    const items: TreeItem[] = [
      { label: 'checked', icon: 'check' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    // check icon 用 lucide Check 组件（svg）
    expect(wrapper.find('.list-tree__icon svg').exists()).toBe(true)
  })

  it('空 items 不崩', () => {
    const wrapper = mount(ListTree, { props: { items: [] } })
    expect(wrapper.find('[data-testid="gui-list-tree"]').exists()).toBe(true)
  })

  it('label 单行截断（min-w-0 + truncate）：todo/criteria/scheduler 长行不撑破托盘浮层', () => {
    const items: TreeItem[] = [
      { label: '把会话归属写入 sidecar 后补一组等价性测试，覆盖 fork 与 restore 两条路径' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    const label = wrapper.findAll('span').find((s) => s.text().includes('sidecar'))!
    expect(label.classes()).toContain('min-w-0')
    expect(label.classes()).toContain('flex-1')
    expect(label.classes()).toContain('truncate')
  })
})

describe('ListTree 行点击动作（§6.4 导航原语，U5 验收③④）', () => {
  const drawerHostAction: HostContainerAction = { kind: 'drawer', tabId: 'doc', params: { commandName: 'commit' } }

  const mountWithExecutors = (items: TreeItem[]) => {
    const cmd = makeExecutor()
    const nav = makeNavigationExecutor()
    const wrapper = mount(ListTree, {
      props: { items },
      global: {
        provide: {
          [ACTION_EXECUTOR_KEY as symbol]: cmd,
          [CONTAINER_NAVIGATION_KEY as symbol]: nav,
          [VIEW_SCOPE_SESSION_KEY as symbol]: 'view-sid',
        },
      },
    })
    return { cmd, nav, wrapper }
  }

  it('action 行渲染为原生 button（键盘可达探针 PB-4 的 DOM 层：Tab 可聚焦 + Enter/Space 触发 click）', () => {
    const { wrapper } = mountWithExecutors([
      { label: '可点行', action: { hostAction: drawerHostAction } },
      { label: '纯展示行' },
    ])
    const actionRow = wrapper.find('[data-testid="gui-list-tree-action-0"]')
    expect(actionRow.exists()).toBe(true)
    expect(actionRow.element.tagName).toBe('BUTTON')
    expect(actionRow.attributes('type')).toBe('button')
    expect(actionRow.attributes('disabled')).toBeUndefined()
    // 纯展示行维持 div（旧行为），无 action testid
    expect(wrapper.findAll('.list-tree__item')[1]!.element.tagName).toBe('DIV')
  })

  it('点击 hostAction 行 → 导航执行器收到 (action, { viewSessionId })，命令执行器不被调用', async () => {
    const { cmd, nav, wrapper } = mountWithExecutors([
      { label: '打开文档', action: { hostAction: drawerHostAction } },
    ])
    await wrapper.find('[data-testid="gui-list-tree-action-0"]').trigger('click')
    expect(nav.navigate).toHaveBeenCalledTimes(1)
    expect(nav.navigate).toHaveBeenCalledWith(drawerHostAction, { viewSessionId: 'view-sid' })
    expect(cmd.execute).not.toHaveBeenCalled()
  })

  it('点击 commandId 行 → 走既有命令链（并存 hostAction 时 commandId 优先，与 Actionbar 同源）', async () => {
    const { cmd, nav, wrapper } = mountWithExecutors([
      { label: '重试', action: { commandId: 'sched.retry', hostAction: drawerHostAction } },
    ])
    await wrapper.find('[data-testid="gui-list-tree-action-0"]').trigger('click')
    expect(cmd.execute).toHaveBeenCalledTimes(1)
    expect(cmd.execute).toHaveBeenCalledWith('sched.retry', undefined)
    expect(nav.navigate).not.toHaveBeenCalled()
  })

  it('递归 children 内的 action 行同样可点（inject 沿组件链取到同一执行器）', async () => {
    const { nav, wrapper } = mountWithExecutors([
      {
        label: 'parent',
        children: [{ label: 'child', action: { hostAction: drawerHostAction } }],
      },
    ])
    const childRow = wrapper.find('[data-testid="gui-list-tree-action-0"]')
    await childRow.trigger('click')
    expect(nav.navigate).toHaveBeenCalledTimes(1)
    expect(nav.navigate).toHaveBeenCalledWith(drawerHostAction, { viewSessionId: 'view-sid' })
  })

  it('纯展示行点击不触发任何执行器（旧行为零变化）', async () => {
    const { cmd, nav, wrapper } = mountWithExecutors([{ label: '纯展示行' }])
    await wrapper.findAll('.list-tree__item')[0]!.trigger('click')
    expect(cmd.execute).not.toHaveBeenCalled()
    expect(nav.navigate).not.toHaveBeenCalled()
  })

  it('action 空对象（两字段缺省）按纯展示行处理：无 action testid、不渲染 button', () => {
    const { wrapper } = mountWithExecutors([{ label: '空动作', action: {} }])
    expect(wrapper.find('[data-testid="gui-list-tree-action-0"]').exists()).toBe(false)
    expect(wrapper.findAll('.list-tree__item')[0]!.element.tagName).toBe('DIV')
  })
})

// ======================================================================
// ← ProgressBar.test.ts
// ======================================================================

describe('ProgressBar', () => {
  it('v6: severity=ok 时 fill 背景用 color-mix 柔化 success，按比例填充 width', () => {
    const wrapper = mount(ProgressBar, {
      props: { label: 'build', current: 7, total: 8, severity: 'ok' },
    })
    expect(wrapper.find('[data-testid="gui-progress-bar"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('build')
    expect(wrapper.text()).toContain('7')
    expect(wrapper.text()).toContain('8')
    const fill = wrapper.find('.progress-bar__fill')
    expect(fill.exists()).toBe(true)
    // v6: 显式 ok → color-mix + success（去 bg-success class）
    const style = fill.attributes('style') ?? ''
    expect(style).toContain('color-mix')
    expect(style).toContain('success')
    expect(fill.classes()).not.toContain('bg-success')
    // 7/8 = 87.5%
    expect(style).toContain('width: 87.5%')
  })

  it('v6: severity=warn/danger → color-mix 对应色', () => {
    const w1 = mount(ProgressBar, { props: { current: 3, total: 4, severity: 'warn' } })
    const s1 = w1.find('.progress-bar__fill').attributes('style') ?? ''
    expect(s1).toContain('color-mix')
    expect(s1).toContain('warn')

    const w2 = mount(ProgressBar, { props: { current: 1, total: 4, severity: 'danger' } })
    const s2 = w2.find('.progress-bar__fill').attributes('style') ?? ''
    expect(s2).toContain('color-mix')
    expect(s2).toContain('danger')
  })

  it('v6: 推断 ok(ratio≥0.8) → neutral-dim（done 语义，非绿色 color-mix）', () => {
    const wrapper = mount(ProgressBar, { props: { current: 9, total: 10 } })
    const style = wrapper.find('.progress-bar__fill').attributes('style') ?? ''
    // v6: 推断 ok → neutral-dim（已完成弱化视觉权重）
    expect(style).toContain('neutral-dim')
    expect(style).not.toContain('color-mix')
  })

  it('v6: 推断 warn(0.5≤ratio<0.8) → color-mix warn', () => {
    const wrapper = mount(ProgressBar, { props: { current: 6, total: 10 } })
    const style = wrapper.find('.progress-bar__fill').attributes('style') ?? ''
    expect(style).toContain('color-mix')
    expect(style).toContain('warn')
  })

  it('v6: 推断 danger(ratio<0.5) → color-mix danger', () => {
    const wrapper = mount(ProgressBar, { props: { current: 3, total: 10 } })
    const style = wrapper.find('.progress-bar__fill').attributes('style') ?? ''
    expect(style).toContain('color-mix')
    expect(style).toContain('danger')
  })

  it('total=0 时不崩，width=0%', () => {
    const wrapper = mount(ProgressBar, { props: { current: 0, total: 0 } })
    expect(wrapper.find('[data-testid="gui-progress-bar"]').exists()).toBe(true)
    expect(wrapper.find('.progress-bar__fill').attributes('style')).toContain('width: 0.0%')
  })

  it('current > total 时不崩（溢出场景）', () => {
    const wrapper = mount(ProgressBar, { props: { current: 10, total: 8 } })
    expect(wrapper.find('[data-testid="gui-progress-bar"]').exists()).toBe(true)
    // 10/8 = 125%，fill width 超过 100%（track overflow-hidden 裁剪视觉溢出，但不崩渲染）
    expect(wrapper.find('.progress-bar__fill').attributes('style')).toContain('width: 125.0%')
  })

  it('v6: track/fill 圆角 rounded-sm', () => {
    const wrapper = mount(ProgressBar, { props: { current: 1, total: 2 } })
    expect(wrapper.find('.progress-bar__track').classes()).toContain('rounded-sm')
    expect(wrapper.find('.progress-bar__fill').classes()).toContain('rounded-sm')
  })
})

// ======================================================================
// ← StatsLine.test.ts
// ======================================================================

describe('StatsLine', () => {
  it('v6: severity 收窄——danger 保留，ok/warn 降 neutral-fg', () => {
    const wrapper = mount(StatsLine, {
      props: {
        items: [
          { label: 'changes', value: '+142', severity: 'ok' },
          { label: 'warns', value: '3', severity: 'warn' },
          { label: 'fails', value: '1', severity: 'danger' },
        ],
      },
    })
    expect(wrapper.find('[data-testid="gui-stats-line"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('+142')
    expect(wrapper.text()).toContain('3')
    expect(wrapper.text()).toContain('1')
    const values = wrapper.findAll('.stats-line__value')
    expect(values).toHaveLength(3)
    // v6: ok → text-neutral-fg（原 text-success）
    expect(values[0].classes()).toContain('text-neutral-fg')
    expect(values[0].classes()).not.toContain('text-success')
    // v6: warn → text-neutral-fg（原 text-warn）
    expect(values[1].classes()).toContain('text-neutral-fg')
    expect(values[1].classes()).not.toContain('text-warn')
    // v6: danger → text-danger（保留）
    expect(values[2].classes()).toContain('text-danger')
  })

  it('v6: 无 severity → text-neutral-fg', () => {
    const wrapper = mount(StatsLine, {
      props: { items: [{ value: '42' }] },
    })
    const value = wrapper.find('.stats-line__value')
    expect(value.classes()).toContain('text-neutral-fg')
  })

  it('item 间用 border-l 分隔（首项无分隔线，hairline 保留）', () => {
    const wrapper = mount(StatsLine, {
      props: { items: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] },
    })
    const items = wrapper.findAll('.stats-line__item')
    expect(items).toHaveLength(3)
    // 首项无左边框
    expect(items[0].classes()).not.toContain('border-l')
    // 后续项有左边框（v6 hairline 保留）
    expect(items[1].classes()).toContain('border-l')
    expect(items[2].classes()).toContain('border-l')
  })

  it('label 可选，无 label 时只渲染 value', () => {
    const wrapper = mount(StatsLine, {
      props: { items: [{ value: '42' }] },
    })
    expect(wrapper.text()).toContain('42')
    expect(wrapper.find('.stats-line__label').exists()).toBe(false)
  })

  it('空 items 不崩', () => {
    const wrapper = mount(StatsLine, { props: { items: [] } })
    expect(wrapper.find('[data-testid="gui-stats-line"]').exists()).toBe(true)
    expect(wrapper.findAll('.stats-line__item')).toHaveLength(0)
  })
})

// ======================================================================
// ← TabBar.test.ts
// ======================================================================

/** section 子树用的最小 list-tree（断言渲染归属的文本载体） */
const listTree = (label: string): GuiComponent<'list-tree'> => ({
  type: 'list-tree',
  props: { items: [{ label }] },
})

/** tab-bar guiTree 构造（推送载荷形状；sections 缺省 = 纯展示） */
const tabBarTree = (
  tabs: GuiComponentProps['tab-bar']['tabs'],
  sections?: GuiComponentProps['tab-bar']['sections'],
): GuiComponent<'tab-bar'> => ({
  type: 'tab-bar',
  props: sections === undefined ? { tabs } : { tabs, sections },
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TabBar', () => {
  it('v6: 容器 bg-bg-input + rounded-lg（去 border-b）', () => {
    const wrapper = mount(TabBar, {
      props: { tabs: [{ label: 'a' }] },
    })
    const bar = wrapper.find('[data-testid="gui-tab-bar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.classes()).toContain('bg-bg-input')
    expect(bar.classes()).toContain('rounded-lg')
    // v6: 容器 padding 3px（spec .gtabbar padding:3px）
    expect(bar.classes()).toContain('p-[3px]')
    // v6: 去 border-b border-border
    expect(bar.classes()).not.toContain('border-b')
    expect(bar.classes()).not.toContain('border-border')
  })

  it('渲染 active + done + pending 三态', () => {
    const wrapper = mount(TabBar, {
      props: {
        tabs: [
          { label: 'node20', active: true },
          { label: 'node22', status: 'done' },
          { label: 'bun', status: 'pending' },
        ],
      },
    })
    expect(wrapper.find('[data-testid="gui-tab-bar"]').exists()).toBe(true)
    const tabs = wrapper.findAll('.tab-bar__tab')
    expect(tabs).toHaveLength(3)

    // v6: active tab 用 bg-surface-hover + text-neutral-fg（去 bg-accent-soft + text-accent；
    // 2026-10-14 全族迁移：旧 bg-bg-elevated 退役）
    expect(tabs[0].classes()).toContain('bg-surface-hover')
    expect(tabs[0].classes()).toContain('text-neutral-fg')
    expect(tabs[0].classes()).not.toContain('bg-accent-soft')
    // done tab 有绿点
    expect(tabs[1].find('.tab-bar__dot').classes()).toContain('bg-success')
    // pending tab 有灰点
    expect(tabs[2].find('.tab-bar__dot').classes()).toContain('bg-neutral-dim')
  })

  it('v6: tab 项圆角 rounded-sm', () => {
    const wrapper = mount(TabBar, {
      props: { tabs: [{ label: 'a' }] },
    })
    expect(wrapper.find('.tab-bar__tab').classes()).toContain('rounded-sm')
  })

  it('v6: label 无 text-success 条件（done && !active 时 label 不额外着色）', () => {
    const wrapper = mount(TabBar, {
      props: { tabs: [{ label: 'done-tab', status: 'done' }] },
    })
    const label = wrapper.find('.tab-bar__label')
    expect(label.classes()).not.toContain('text-success')
  })

  it('v6: 非 active tab 文字 neutral-dim，hover 升 neutral-fg', () => {
    const wrapper = mount(TabBar, {
      props: { tabs: [{ label: 'idle' }] },
    })
    const tab = wrapper.find('.tab-bar__tab')
    expect(tab.classes()).toContain('text-neutral-dim')
    expect(tab.classes()).toContain('hover:text-neutral-fg')
  })

  it('无 active 无 status 的 tab 只渲染 label 文本', () => {
    const wrapper = mount(TabBar, {
      props: { tabs: [{ label: 'plain' }] },
    })
    expect(wrapper.text()).toContain('plain')
    expect(wrapper.find('.tab-bar__dot').exists()).toBe(false)
  })

  it('空 tabs 不崩', () => {
    const wrapper = mount(TabBar, { props: { tabs: [] } })
    expect(wrapper.find('[data-testid="gui-tab-bar"]').exists()).toBe(true)
    expect(wrapper.findAll('.tab-bar__tab')).toHaveLength(0)
  })

  it('向后兼容：无 sections = 纯展示（推送 active 驱动、无点击态、无 section 节点）', async () => {
    const wrapper = mount(TabBar, {
      props: { tabs: [{ label: 'a' }, { label: 'b', active: true }] },
    })
    const tabs = wrapper.findAll('.tab-bar__tab')
    expect(tabs).toHaveLength(2)
    // active 由推送值单方决定（现状语义）
    expect(tabs[1].classes()).toContain('bg-surface-hover')
    expect(tabs[0].classes()).not.toContain('bg-surface-hover')
    // 无点击态样式（旧 extension 的 tab-bar 不可被染上可点视觉）
    expect(tabs[0].classes()).not.toContain('cursor-pointer')
    expect(tabs[1].classes()).not.toContain('cursor-pointer')
    expect(wrapper.find('[data-testid="gui-tab-bar-section"]').exists()).toBe(false)

    // 点击不改写视觉（无本地切换）
    await tabs[0].trigger('click')
    expect(wrapper.findAll('.tab-bar__tab')[1].classes()).toContain('bg-surface-hover')
    expect(wrapper.findAll('.tab-bar__tab')[0].classes()).not.toContain('bg-surface-hover')
  })
})

describe('TabBar 容器化（sections，协议 v1.1）', () => {
  it('sections 与 tabs 等长 → 渲染 active tab 对应子树（应用路径经渲染器递归）', () => {
    const wrapper = mount(GuiComponentRenderer, {
      props: {
        component: tabBarTree(
          [{ label: '待办' }, { label: '已完成' }],
          [[listTree('t1')], [listTree('t2')]],
        ),
      },
    })
    const section = wrapper.find('[data-testid="gui-tab-bar-section"]')
    expect(section.exists()).toBe(true)
    expect(section.find('[data-testid="gui-list-tree"]').exists()).toBe(true)
    expect(section.text()).toContain('t1')
    expect(section.text()).not.toContain('t2')
    // 容器化态 tab 可点（cursor-pointer 只在 sections 合法时出现）
    expect(wrapper.findAll('.tab-bar__tab')[0].classes()).toContain('cursor-pointer')
  })

  it('首挂载取推送 tabs[i].active（无 active 取 0）', () => {
    const pushedSecond = mount(GuiComponentRenderer, {
      props: {
        component: tabBarTree(
          [{ label: '待办' }, { label: '已完成', active: true }],
          [[listTree('t1')], [listTree('t2')]],
        ),
      },
    })
    expect(pushedSecond.findAll('.tab-bar__tab')[1].classes()).toContain('bg-surface-hover')
    expect(pushedSecond.find('[data-testid="gui-tab-bar-section"]').text()).toContain('t2')

    const noActive = mount(GuiComponentRenderer, {
      props: {
        component: tabBarTree(
          [{ label: '待办' }, { label: '已完成' }],
          [[listTree('t1')], [listTree('t2')]],
        ),
      },
    })
    expect(noActive.findAll('.tab-bar__tab')[0].classes()).toContain('bg-surface-hover')
    expect(noActive.find('[data-testid="gui-tab-bar-section"]').text()).toContain('t1')
  })

  it('点击 tab 只切本地 active（切换 section + active 视觉），不回传 extension', async () => {
    const wrapper = mount(GuiComponentRenderer, {
      props: {
        component: tabBarTree(
          [{ label: '待办' }, { label: '已完成' }],
          [[listTree('t1')], [listTree('t2')]],
        ),
      },
    })
    await wrapper.findAll('.tab-bar__tab')[1].trigger('click')

    const tabs = wrapper.findAll('.tab-bar__tab')
    expect(tabs[1].classes()).toContain('bg-surface-hover')
    expect(tabs[0].classes()).not.toContain('bg-surface-hover')
    const section = wrapper.find('[data-testid="gui-tab-bar-section"]')
    expect(section.text()).toContain('t2')
    expect(section.text()).not.toContain('t1')
    // 不回传：TabBar 无 emit（协议无 UI→extension 回传通道）
    expect(wrapper.findComponent(TabBar).emitted()).toEqual({})
  })

  it('探针 P5：后续推送新 tabs/sections 不重置本地选择（组件未重建）', async () => {
    const wrapper = mount(GuiComponentRenderer, {
      props: {
        component: tabBarTree(
          [{ label: '待办' }, { label: '已完成' }],
          [[listTree('t1')], [listTree('t2')]],
        ),
      },
    })
    await wrapper.findAll('.tab-bar__tab')[1].trigger('click')
    const barElement = wrapper.find('[data-testid="gui-tab-bar"]').element

    // 推送更新内容（含新 tabs/sections 对象）
    await wrapper.setProps({
      component: tabBarTree(
        [{ label: '待办' }, { label: '已完成' }],
        [[listTree('t1-new')], [listTree('t2-new')]],
      ),
    })

    // 组件未重建（同一 DOM 元素）→ 本地选择保持（仍渲染第二段新内容）
    expect(wrapper.find('[data-testid="gui-tab-bar"]').element).toBe(barElement)
    expect(wrapper.findAll('.tab-bar__tab')[1].classes()).toContain('bg-surface-hover')
    const section = wrapper.find('[data-testid="gui-tab-bar-section"]')
    expect(section.text()).toContain('t2-new')
    expect(section.text()).not.toContain('t1-new')
  })

  it('tabs 缩短 → 本地序号 clamp（不越界，不重置为推送值）', async () => {
    const wrapper = mount(GuiComponentRenderer, {
      props: {
        component: tabBarTree(
          [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
          [[listTree('t1')], [listTree('t2')], [listTree('t3')]],
        ),
      },
    })
    await wrapper.findAll('.tab-bar__tab')[2].trigger('click')
    expect(wrapper.find('[data-testid="gui-tab-bar-section"]').text()).toContain('t3')

    await wrapper.setProps({
      component: tabBarTree([{ label: 'a' }, { label: 'b' }], [[listTree('t1x')], [listTree('t2x')]]),
    })

    const tabs = wrapper.findAll('.tab-bar__tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[1].classes()).toContain('bg-surface-hover')
    expect(wrapper.find('[data-testid="gui-tab-bar-section"]').text()).toContain('t2x')
  })

  it('section 子树经渲染入口递归（容器原语嵌套可用）', () => {
    const wrapper = mount(GuiComponentRenderer, {
      props: {
        component: tabBarTree(
          [{ label: '待办' }, { label: '已完成' }],
          [
            [{ type: 'group', props: { children: [listTree('nested')] } }],
            [listTree('t2')],
          ],
        ),
      },
    })
    const section = wrapper.find('[data-testid="gui-tab-bar-section"]')
    expect(section.find('[data-testid="gui-group"]').exists()).toBe(true)
    expect(section.text()).toContain('nested')
  })

  it('sections 与 tabs 长度不等 → 忽略 sections 退化纯展示 + warn（§3.5）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = mount(GuiComponentRenderer, {
      props: {
        component: tabBarTree([{ label: 'a' }, { label: 'b' }], [[listTree('t1')]]),
      },
    })

    expect(wrapper.find('[data-testid="gui-tab-bar-section"]').exists()).toBe(false)
    const tabs = wrapper.findAll('.tab-bar__tab')
    expect(tabs).toHaveLength(2)
    // 退化纯展示：无点击态
    expect(tabs[0].classes()).not.toContain('cursor-pointer')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('长度不等')

    // 点击不产生本地切换（退化态无本地 active）
    await tabs[1].trigger('click')
    expect(wrapper.findAll('.tab-bar__tab')[1].classes()).not.toContain('bg-surface-hover')

    // 同形态重复推送不重复出声（防 warn 刷屏）
    await wrapper.setProps({
      component: tabBarTree([{ label: 'a' }, { label: 'b' }], [[listTree('t1')]]),
    })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('无渲染器上下文（standalone 直接挂载）→ 忽略 sections 退化纯展示 + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = mount(TabBar, {
      props: {
        tabs: [{ label: 'a' }, { label: 'b' }],
        sections: [[listTree('t1')], [listTree('t2')]],
      },
    })

    expect(wrapper.find('[data-testid="gui-tab-bar-section"]').exists()).toBe(false)
    expect(wrapper.findAll('.tab-bar__tab')[0].classes()).not.toContain('cursor-pointer')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('PRIMITIVE_RENDER_KEY')
  })
})

