/**
 * TrayWidgetButton / TrayWidgetPanel 组件 + widget 区依赖追踪测试（u-tray-widget）。
 *
 * 设计依据：docs/design/composer-task-tray.md §3.1 场景 B/C、§3.3 D3/D4/D6/D7、§3.4 终态
 * 数据流、§3.5 错误规格、§3.6 探针 P3/P6。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者（白盒）：icon fallback 链四档（自定义 paths / registry key / 内置 widgetKey 映射 /
 *   通用兜底）+ 越限落兜底与 warn 去重；badge fallback 链 + truncate 边界；status → 视觉映射
 * - 使用者（黑盒）：每条用例至少一个用户可见 DOM 断言——按钮 title/aria、badge 文本与 title
 *   全文、呼吸点元素存在性（归零不虚亮 = 元素不存在而非 opacity:0）、面板 head/正文
 * - 观察者（形态）：条目存在 ↔ entry 存在（推送出现 / invalidate 消失 / 重注册落尾部）；
 *   反证用例钉住「getViewIds + getView 同 computed 路径建链」不是空断言
 *
 * mock 策略：
 * - VIEW_HOST_SOURCE_KEY 注入响应式 mock（getViewIds 走分区键迭代 + getView 走分区值读，
 *   同构壳层 useExtensionHostBridge.createReactiveSessionScopedMap：外层 shallowReactive 分区
 *   Map + 内层 reactive 分区 Map）——推送（set）/ 清屏（delete）直接改分区即可驱动重算；
 *   数据源/夹具实现与 composer-tray.test.ts 共享 tray-view-host-mock.ts
 * - 真实 GuiComponentRenderer（经 @taiji/ui/rendering-protocol）：面板正文断言渲染到 DOM 的
 *   真实原语（ansi-text / list-tree），不 stub 渲染器
 * - i18n 走全局 setup mock（__tests__/vitest-i18n-setup.ts）；本单元组件零 i18n 文案（文本全
 *   来自 meta 数据），故无 i18n 断言
 *
 * timer 说明：本单元两组件无计时器（hover 160ms / 移出 240ms 归外壳 u-tray-shell），故无
 * fake timers 用例；后续若在组件内引入计时，用 vi.useFakeTimers({ now })（范式同
 * useTrayCounts.test.ts）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/tray/tray-widget.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import { computed, defineComponent, h, inject, ref } from 'vue'
import type { GuiComponent, WidgetMeta } from '@zhushanwen/extension-protocol'
import { VIEW_HOST_SOURCE_KEY } from '@taiji/ui/extension-host'
import type { ViewCacheEntry } from '@taiji/ui/extension-host'
import { ansiLine, makeEntry, makeWidgetSource } from './tray-view-host-mock'
import type { MockWidgetSource } from './tray-view-host-mock'
import TrayWidgetButton from '@/components/panel/tray/TrayWidgetButton.vue'
import TrayWidgetPanel from '@/components/panel/tray/TrayWidgetPanel.vue'
import { orderTrayWidgetIds } from '@/components/panel/tray/tray-order'

const SID = 's-widget'

function makeMeta(overrides: Partial<WidgetMeta> = {}): WidgetMeta {
  return { title: 'Todo', ...overrides }
}

// ── 组件直挂（按钮 / 面板：props 驱动，无数据源）──

function mountButton(props: {
  viewId: string
  meta?: WidgetMeta
  pinned?: boolean
  expanded?: boolean
}): VueWrapper {
  return mount(TrayWidgetButton, { props })
}

function mountPanel(props: {
  viewId: string
  meta?: WidgetMeta
  guiTree: GuiComponent[]
}): VueWrapper {
  return mount(TrayWidgetPanel, { props })
}

/** 按钮上的 icon 区（状态色断言宿主：状态色挂 icon 容器，便于断言「无状态色类」） */
function iconSpan(wrapper: VueWrapper): DOMWrapper<Element> {
  return wrapper.find('[data-testid="tray-widget-icon"]')
}

// ── widget 区（外壳契约复刻：ViewHostStore 响应式消费面 + 排序 + 按钮/面板组装）──

interface WidgetEntry {
  viewId: string
  entry: ViewCacheEntry
}

/**
 * 外壳契约复刻宿主 = ComposerTray widget 区的最小形态（排序 → 按钮行 → 打开的面板）。
 *
 * 为什么在测试内复刻：本单元领地不含 ComposerTray.vue（归 u-tray-shell），而验收条款 ⑤/⑥
 * （推送后条目重算 / invalidate 后条目消失）必须落在本单元测试。故以同构宿主承载，关键形态
 * 与外壳一致：
 * - entries computed 内**同时**调用 getViewIds（分区键迭代）与 getView（分区值读）——承自已
 *   退役的对话流 widget pill entries 头注契约，拆开即断链；
 * - 面板随「打开 key 仍在 entries 内」渲染（entry 消失 → 面板消失，清屏即摘除）。
 */
const TrayWidgetStrip = defineComponent({
  props: { sessionId: { type: String, required: true } },
  setup(props) {
    const source = inject(VIEW_HOST_SOURCE_KEY, null)
    const openKey = ref<string | null>(null)

    const entries = computed<WidgetEntry[]>(() => {
      if (!source) return []
      return orderTrayWidgetIds(source.getViewIds(props.sessionId))
        .map((viewId) => ({ viewId, entry: source.getView(props.sessionId, viewId) }))
        .filter(
          (e): e is WidgetEntry =>
            e.entry !== undefined && e.entry.guiTree.length > 0,
        )
    })

    return () => {
      const openEntry = entries.value.find((e) => e.viewId === openKey.value)
      const children = entries.value.map((e) =>
        h(TrayWidgetButton, {
          key: e.viewId,
          viewId: e.viewId,
          meta: e.entry.meta,
          pinned: e.viewId === openKey.value,
          expanded: e.viewId === openKey.value,
          onTogglePin: () => {
            openKey.value = openKey.value === e.viewId ? null : e.viewId
          },
        }),
      )
      if (openEntry) {
        children.push(
          h(TrayWidgetPanel, {
            key: `panel-${openEntry.viewId}`,
            viewId: openEntry.viewId,
            meta: openEntry.entry.meta,
            guiTree: openEntry.entry.guiTree,
          }),
        )
      }
      return h(
        'div',
        { 'data-testid': 'tray-widget-strip', 'data-session-id': props.sessionId },
        children,
      )
    }
  },
})

/**
 * 反证宿主（断链形态）：setup 期一次性快照（非 effect 内 → 无依赖收集），
 * 用于钉住「响应式建链」用例不是空断言——断链时推送后条目不重算。
 */
const BrokenStrip = defineComponent({
  setup() {
    const source = inject(VIEW_HOST_SOURCE_KEY, null)
    const frozen: WidgetEntry[] = source
      ? orderTrayWidgetIds(source.getViewIds(SID))
          .map((viewId) => ({ viewId, entry: source.getView(SID, viewId) }))
          .filter((e): e is WidgetEntry => e.entry !== undefined)
      : []
    return () =>
      h(
        'div',
        { 'data-testid': 'tray-widget-strip' },
        frozen.map((e) => h(TrayWidgetButton, { key: e.viewId, viewId: e.viewId, meta: e.entry.meta })),
      )
  },
})

function mountStrip(mock: MockWidgetSource, component = TrayWidgetStrip): VueWrapper {
  return mount(component, {
    props: { sessionId: SID },
    global: { provide: { [VIEW_HOST_SOURCE_KEY as symbol]: mock.source } },
  })
}

/** widget 区按钮的 viewId 序列（用户看到的顺序） */
function stripKeys(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('[data-testid="tray-widget-button"]')
    .map((n) => n.attributes('data-widget-key') ?? '')
}

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

// ── ① icon fallback 链（D4 四档）──

describe('TrayWidgetButton icon fallback 链（D4）', () => {
  it('档① 自定义 paths（合法）→ 渲染 <path :d>，风格由宿主锁死', () => {
    const wrapper = mountButton({
      viewId: 'todo',
      meta: makeMeta({ icon: { paths: ['M4 6h16', 'M4 12h10'] } }),
    })

    const svg = wrapper.find('[data-testid="tray-widget-icon-paths"]')
    expect(svg.exists()).toBe(true)
    expect(svg.attributes('viewBox')).toBe('0 0 24 24')
    expect(svg.attributes('fill')).toBe('none')
    expect(svg.attributes('stroke')).toBe('currentColor')
    expect(svg.attributes('stroke-width')).toBe('1.75')
    expect(svg.attributes('stroke-linecap')).toBe('round')
    expect(svg.attributes('stroke-linejoin')).toBe('round')
    expect(svg.findAll('path').map((p) => p.attributes('d'))).toEqual(['M4 6h16', 'M4 12h10'])
    // 档① 命中即不再下探 lucide 档（即使 viewId 有内置映射）
    expect(wrapper.find('svg.lucide').exists()).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('档② lucide 名解析：registry 命中（拼写归一化：连字符/大小写/下划线同解）', () => {
    const meta = makeMeta({ icon: 'list-checks' })
    expect(mountButton({ viewId: 'w-a', meta }).find('svg.lucide-list-checks').exists()).toBe(true)
    expect(mountButton({ viewId: 'w-b', meta: makeMeta({ icon: 'ListChecks' }) }).find('svg.lucide-list-checks').exists()).toBe(true)
    expect(mountButton({ viewId: 'w-c', meta: makeMeta({ icon: 'list_checks' }) }).find('svg.lucide-list-checks').exists()).toBe(true)
    // 宿主锁死线宽（与档①同 1.75，非 lucide 默认 2）
    expect(mountButton({ viewId: 'w-d', meta }).find('svg.lucide-list-checks').attributes('stroke-width')).toBe('1.75')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('档③ 内置 widgetKey 映射：todo→ListChecks / goal→Target（无 icon 与未知 key 两路注入）', () => {
    const todoBtn = mountButton({ viewId: 'todo', meta: makeMeta() })
    expect(todoBtn.find('svg.lucide-list-checks').exists()).toBe(true)

    const goalBtn = mountButton({ viewId: 'goal', meta: makeMeta({ icon: 'no-such-icon' }) })
    expect(goalBtn.find('svg.lucide-target').exists()).toBe(true)
    // 未知 string key 落内置映射，且 warn 一次（可操作诊断）
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('unknown-key')
    expect(String(warnSpy.mock.calls[0][0])).toContain('goal')
  })

  it('档③ 非法 paths 越限 → 落内置映射 + warn（不崩渲染）', () => {
    // 'e' 与 '>' 均不在白名单字符集内（含 SVG 端点字符时同样拒绝）
    const wrapper = mountButton({
      viewId: 'todo',
      meta: makeMeta({ icon: { paths: ['M4 6h16<script>'] } }),
    })
    expect(wrapper.find('[data-testid="tray-widget-icon-paths"]').exists()).toBe(false)
    expect(wrapper.find('svg.lucide-list-checks').exists()).toBe(true)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('illegal-char')
  })

  it('档③ meta.icon 显式 null（协议可达坏形态）→ 落内置映射 + warn，不崩渲染', () => {
    // icon 类型不含 null，但 wire 上 stripUndefined 只删 undefined 不删 null（第三方独立
    // 安装扩展可达）——归 'not-array' 走兜底链，与非法 paths 同路（协议契约「坏数据不崩渲染」）
    const wrapper = mountButton({
      viewId: 'todo',
      meta: makeMeta({ icon: null as unknown as WidgetMeta['icon'] }),
    })
    expect(wrapper.find('[data-testid="tray-widget-icon-paths"]').exists()).toBe(false)
    expect(wrapper.find('svg.lucide-list-checks').exists()).toBe(true)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('not-array')
  })

  it('档④ 通用兜底：未知 viewId + 未知 key → LayoutGrid（与 view 兜底 icon 同源）', () => {
    const wrapper = mountButton({ viewId: 'custom-note', meta: makeMeta({ icon: 'no-such-icon' }) })
    expect(wrapper.find('svg.lucide-layout-grid').exists()).toBe(true)
  })

  it('warn 去重：同一 viewId 同因坏数据只提示一次（tool call 级重推不刷屏）', async () => {
    const badMeta = makeMeta({ icon: { paths: ['M4 6h16 bad;chars'] } })
    const wrapper = mountButton({ viewId: 'w-dedupe', meta: badMeta })
    expect(warnSpy).toHaveBeenCalledTimes(1)

    // 重推同因坏数据（组件重算）→ 仍只 1 次
    await wrapper.setProps({ meta: makeMeta({ icon: { paths: ['M4 6h16 worse;chars'] } }) })
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('脏数据防护：原型链键（viewId/status 为 constructor 类取值）不崩渲染、不取到原型成员', () => {
    // viewId 由 extension 决定（setWidget 第一参数），'constructor' 是合法 widget key——
    // 内置映射表必须是 Map（裸对象下标会取到 Object.prototype.constructor 当组件渲染）
    const protoKey = mountButton({ viewId: 'constructor', meta: makeMeta({ icon: 'unknown' }) })
    expect(protoKey.find('svg.lucide-layout-grid').exists()).toBe(true)

    // status 脏值同理：状态色查表走 switch，脏值落默认（无状态色类），不抛错
    const dirtyStatus: WidgetMeta = { title: 'X', status: 'constructor' as WidgetMeta['status'] }
    const dirty = mountButton({ viewId: 'todo', meta: dirtyStatus })
    expect(iconSpan(dirty).classes()).not.toContain('text-accent')
    expect(iconSpan(dirty).classes()).not.toContain('text-success')
    expect(dirty.find('[data-testid="tray-widget-pulse"]').exists()).toBe(false)
  })
})

// ── ② badge fallback 链 + truncate（D4/§3.5）──

describe('TrayWidgetButton badge fallback 链与 truncate（D4/§3.5）', () => {
  it('meta.badge 直用；超长 truncate 至 6 字符且 title 保留全文', () => {
    const short = mountButton({ viewId: 'todo', meta: makeMeta({ badge: '42%' }) })
    const shortBadge = short.find('[data-testid="tray-widget-badge"]')
    expect(shortBadge.text()).toBe('42%')
    expect(shortBadge.attributes('title')).toBe('42%')

    const long = mountButton({ viewId: 'todo', meta: makeMeta({ badge: '1234567890' }) })
    const longBadge = long.find('[data-testid="tray-widget-badge"]')
    expect(longBadge.text()).toBe('123456')
    expect(longBadge.text().length).toBe(6)
    expect(longBadge.attributes('title')).toBe('1234567890')
  })

  it('badge 缺省 → progress.label；无 label → String(progress.current)', () => {
    const withLabel = mountButton({
      viewId: 'goal',
      meta: makeMeta({ progress: { current: 2, total: 5, label: '2/5' } }),
    })
    expect(withLabel.find('[data-testid="tray-widget-badge"]').text()).toBe('2/5')

    const noLabel = mountButton({
      viewId: 'goal',
      meta: makeMeta({ progress: { current: 42, total: 100 } }),
    })
    expect(noLabel.find('[data-testid="tray-widget-badge"]').text()).toBe('42')
  })

  it('无 badge 且无 progress → 不渲染 badge 元素（归零不虚亮）', () => {
    const wrapper = mountButton({ viewId: 'todo', meta: makeMeta() })
    expect(wrapper.find('[data-testid="tray-widget-badge"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-widget-status"]').exists()).toBe(false)
  })
})

// ── ③ status 视觉（D4）──

describe('TrayWidgetButton status 视觉（D4：running=accent+呼吸点 / done / failed / idle）', () => {
  it('running → accent 色 + 呼吸点元素存在（badge 同色）', () => {
    const wrapper = mountButton({
      viewId: 'todo',
      meta: makeMeta({ status: 'running', badge: '2' }),
    })
    expect(iconSpan(wrapper).classes()).toContain('text-accent')
    expect(wrapper.find('[data-testid="tray-widget-pulse"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="tray-widget-badge"]').classes()).toContain('text-accent')
  })

  it('done / failed / idle 各取状态色，且非 running 无呼吸点元素（元素不存在而非隐藏）', () => {
    const done = mountButton({ viewId: 'todo', meta: makeMeta({ status: 'done', badge: '5' }) })
    expect(iconSpan(done).classes()).toContain('text-success')
    expect(done.find('[data-testid="tray-widget-pulse"]').exists()).toBe(false)

    const failed = mountButton({ viewId: 'todo', meta: makeMeta({ status: 'failed', badge: '!' }) })
    expect(iconSpan(failed).classes()).toContain('text-danger')
    expect(failed.find('[data-testid="tray-widget-pulse"]').exists()).toBe(false)

    const idle = mountButton({ viewId: 'todo', meta: makeMeta({ status: 'idle', badge: '2/5' }) })
    expect(iconSpan(idle).classes()).toContain('text-neutral-dim')
    expect(idle.find('[data-testid="tray-widget-pulse"]').exists()).toBe(false)
  })

  it('无 meta（v1 旧 extension）→ 标题回退 viewId、无状态色类、无呼吸点无 badge', () => {
    const wrapper = mountButton({ viewId: 'legacy-widget' })
    const button = wrapper.find('[data-testid="tray-widget-button"]')
    expect(button.attributes('title')).toBe('legacy-widget')
    expect(button.attributes('aria-label')).toBe('legacy-widget')
    // 无 status → icon 不挂状态色类（继承按钮中性色：常态 dim、hover 提亮）
    expect(iconSpan(wrapper).classes()).not.toContain('text-accent')
    expect(iconSpan(wrapper).classes()).not.toContain('text-success')
    expect(iconSpan(wrapper).classes()).not.toContain('text-danger')
    expect(button.classes()).toContain('text-neutral-dim')
    expect(wrapper.find('[data-testid="tray-widget-pulse"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-widget-badge"]').exists()).toBe(false)
    // 合规路径不刷 warn（A7：无 icon/badge 的旧 widget 正常挂载）
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

// ── ④ 按钮契约（外壳交互位 + 上抛事件）──

describe('TrayWidgetButton 外壳契约（hover/pin 状态由外壳持有）', () => {
  it('指针进 / 出 icon 上抛 hover-start / hover-end（计时由外壳承担）', async () => {
    const wrapper = mountButton({ viewId: 'todo', meta: makeMeta() })
    const button = wrapper.find('[data-testid="tray-widget-button"]')

    await button.trigger('pointerenter')
    expect(wrapper.emitted('hover-start')).toHaveLength(1)
    expect(wrapper.emitted('hover-end')).toBeUndefined()

    await button.trigger('pointerleave')
    expect(wrapper.emitted('hover-end')).toHaveLength(1)
  })

  it('点击 icon 上抛 toggle-pin（外壳切换 pin）；pinned/expanded 驱动 aria 与提亮', async () => {
    const wrapper = mountButton({ viewId: 'todo', meta: makeMeta() })
    const button = wrapper.find('[data-testid="tray-widget-button"]')
    expect(button.attributes('aria-pressed')).toBe('false')
    expect(button.attributes('aria-expanded')).toBe('false')

    await button.trigger('click')
    expect(wrapper.emitted('toggle-pin')).toHaveLength(1)

    await wrapper.setProps({ pinned: true, expanded: true })
    expect(button.attributes('aria-pressed')).toBe('true')
    expect(button.attributes('aria-expanded')).toBe('true')
    expect(button.classes()).toContain('bg-surface-hover')
  })

  it('title/aria-label 取 meta.title（面板标题同源），viewId 落 data-widget-key', () => {
    const wrapper = mountButton({ viewId: 'todo', meta: makeMeta({ title: '待办清单' }) })
    const button = wrapper.find('[data-testid="tray-widget-button"]')
    expect(button.attributes('title')).toBe('待办清单')
    expect(button.attributes('aria-label')).toBe('待办清单')
    expect(button.attributes('data-widget-key')).toBe('todo')
  })
})

// ── ⑤ 面板（meta head + GuiComponentRenderer 正文）──

describe('TrayWidgetPanel（meta head + guiTree 正文）', () => {
  it('head：标题 + 状态点色 + 进度计数文本 + mini bar 宽度', () => {
    const wrapper = mountPanel({
      viewId: 'todo',
      meta: makeMeta({
        title: 'Todo',
        status: 'running',
        progress: { current: 2, total: 5, label: '2/5' },
      }),
      guiTree: [ansiLine('body line')],
    })

    const panel = wrapper.find('[data-testid="tray-widget-panel"]')
    expect(panel.exists()).toBe(true)
    expect(panel.attributes('data-widget-key')).toBe('todo')
    expect(wrapper.find('[data-testid="tray-widget-panel-title"]').text()).toBe('Todo')
    expect(wrapper.find('[data-testid="tray-widget-panel-dot"]').classes()).toContain('bg-accent')
    expect(wrapper.find('[data-testid="tray-widget-panel-label"]').text()).toBe('2/5')
    const fill = wrapper.find('[data-testid="tray-widget-panel-progress-fill"]')
    expect(fill.attributes('style')).toContain('width: 40%')
    expect(fill.classes()).toContain('bg-accent')
  })

  it('head 进度：label 缺省 → current/total；severity=danger → fill 取 danger', () => {
    const wrapper = mountPanel({
      viewId: 'goal',
      meta: makeMeta({ progress: { current: 95, total: 100, severity: 'danger' } }),
      guiTree: [ansiLine('goal body')],
    })
    expect(wrapper.find('[data-testid="tray-widget-panel-label"]').text()).toBe('95/100')
    expect(wrapper.find('[data-testid="tray-widget-panel-progress-fill"]').classes()).toContain('bg-danger')
  })

  it('body = GuiComponentRenderer 渲染 guiTree（ansi-text + list-tree 落真实 DOM）', () => {
    const wrapper = mountPanel({
      viewId: 'todo',
      meta: makeMeta(),
      guiTree: [
        ansiLine('head line'),
        { type: 'list-tree', props: { items: [{ label: '写测试', status: 'running' }] } },
      ],
    })

    expect(wrapper.find('[data-testid="ansi-text"]').text()).toContain('head line')
    const tree = wrapper.find('[data-testid="gui-list-tree"]')
    expect(tree.exists()).toBe(true)
    expect(tree.text()).toContain('写测试')
    // 渲染协议容器在场的证据（渲染器 testid 不被子组件覆盖）
    expect(wrapper.findAll('[data-testid="gui-component-renderer"]')).toHaveLength(2)
  })

  it('无 meta（v1 旧 extension）→ 标题回退 viewId、无进度区；guiTree 为空 → 整体零 DOM', () => {
    const legacy = mountPanel({ viewId: 'legacy-widget', guiTree: [ansiLine('x')] })
    expect(legacy.find('[data-testid="tray-widget-panel-title"]').text()).toBe('legacy-widget')
    expect(legacy.find('[data-testid="tray-widget-panel-label"]').exists()).toBe(false)
    expect(legacy.find('[data-testid="tray-widget-panel-progress-fill"]').exists()).toBe(false)
    expect(legacy.find('[data-testid="tray-widget-panel-dot"]').classes()).toContain('bg-neutral-dim')

    const empty = mountPanel({ viewId: 'todo', meta: makeMeta(), guiTree: [] })
    expect(empty.find('[data-testid="tray-widget-panel"]').exists()).toBe(false)
  })
})

// ── ⑥ widget 区依赖追踪（验收 ⑤/⑥：推送重算 / invalidate 消失）──

describe('widget 区依赖追踪（getViewIds + getView 同 computed 路径建链）', () => {
  it('推送新 entry → 新条目出现，且顺序 = known-order 优先（未知 key 随后按插入序）', async () => {
    const mock = makeWidgetSource(SID)
    const wrapper = mountStrip(mock)
    expect(stripKeys(wrapper)).toEqual([])

    mock.push(makeEntry('custom-b', [ansiLine('b')], makeMeta({ title: 'B' })))
    await wrapper.vm.$nextTick()
    mock.push(makeEntry('goal', [ansiLine('g')], makeMeta({ title: 'Goal' })))
    await wrapper.vm.$nextTick()
    mock.push(makeEntry('todo', [ansiLine('t')], makeMeta({ title: 'Todo' })))
    await wrapper.vm.$nextTick()

    // known-order 优先：todo/goal 恒在前（与插入序无关），custom-b 追加其后
    expect(stripKeys(wrapper)).toEqual(['todo', 'goal', 'custom-b'])
    expect(wrapper.find('[data-testid="tray-widget-strip"]').attributes('data-session-id')).toBe(SID)
    expect(wrapper.findAll('[data-testid="tray-widget-button"]')).toHaveLength(3)
  })

  it('推送更新同一 key → 按钮与面板重算（非缓存 stale），面板随 pin 打开', async () => {
    const mock = makeWidgetSource(SID)
    mock.push(makeEntry('todo', [ansiLine('v1')], makeMeta({ title: 'Todo', badge: '1' })))
    const wrapper = mountStrip(mock)
    expect(wrapper.find('[data-testid="tray-widget-badge"]').text()).toBe('1')

    mock.push(makeEntry('todo', [ansiLine('v2')], makeMeta({ title: 'Todo', badge: '7' })))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="tray-widget-badge"]').text()).toBe('7')

    // 点 icon → pin → 面板出现（外壳契约：hover/pin 归外壳，本宿主用点击复刻 pin 路径）
    await wrapper.find('[data-testid="tray-widget-button"]').trigger('click')
    const panel = wrapper.find('[data-testid="tray-widget-panel"]')
    expect(panel.exists()).toBe(true)
    expect(panel.find('[data-testid="ansi-text"]').text()).toContain('v2')

    // 面板打开期间推送更新 → 正文随推送刷新（同 computed 链，非一次性快照）
    mock.push(makeEntry('todo', [ansiLine('v3')], makeMeta({ title: 'Todo', badge: '8' })))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="tray-widget-panel"]').find('[data-testid="ansi-text"]').text()).toContain('v3')
  })

  it('分区在挂载后才建（首帧短路陷阱）→ 推送仍触发重算', async () => {
    // 挂载顺序刻意颠倒：先 mount（此时无分区、无 entry）再首次 push
    const mock = makeWidgetSource(SID)
    const wrapper = mountStrip(mock)
    expect(stripKeys(wrapper)).toEqual([])

    mock.push(makeEntry('todo', [ansiLine('late')], makeMeta({ title: 'Todo' })))
    await wrapper.vm.$nextTick()
    expect(stripKeys(wrapper)).toEqual(['todo'])
  })

  it('清屏（gui:null → invalidate）→ 条目与已打开面板一并消失', async () => {
    const mock = makeWidgetSource(SID)
    mock.push(makeEntry('todo', [ansiLine('t')], makeMeta({ title: 'Todo' })))
    mock.push(makeEntry('goal', [ansiLine('g')], makeMeta({ title: 'Goal' })))
    const wrapper = mountStrip(mock)
    await wrapper.find('[data-testid="tray-widget-button"]').trigger('click')
    expect(wrapper.find('[data-testid="tray-widget-panel"]').exists()).toBe(true)

    mock.invalidate('todo')
    await wrapper.vm.$nextTick()

    expect(stripKeys(wrapper)).toEqual(['goal'])
    expect(wrapper.find('[data-testid="tray-widget-panel"]').exists()).toBe(false)
  })

  it('invalidate → 重注册的未知 key 落尾部（「当前插入序」契约在 DOM 上成立）', async () => {
    const mock = makeWidgetSource(SID)
    mock.push(makeEntry('todo', [ansiLine('t')], makeMeta()))
    mock.push(makeEntry('goal', [ansiLine('g')], makeMeta()))
    mock.push(makeEntry('alpha', [ansiLine('a')], makeMeta()))
    const wrapper = mountStrip(mock)
    expect(stripKeys(wrapper)).toEqual(['todo', 'goal', 'alpha'])

    mock.invalidate('alpha')
    await wrapper.vm.$nextTick()
    mock.push(makeEntry('alpha', [ansiLine('a2')], makeMeta()))
    await wrapper.vm.$nextTick()

    expect(stripKeys(wrapper)).toEqual(['todo', 'goal', 'alpha'])
    mock.push(makeEntry('beta', [ansiLine('b')], makeMeta()))
    await wrapper.vm.$nextTick()
    // alpha 已是「重注册后的插入序」，beta 后插 → alpha 在前（证明 alpha 确实落到尾部而非原位）
    expect(stripKeys(wrapper)).toEqual(['todo', 'goal', 'alpha', 'beta'])
  })

  it('反证：非响应式快照（断链形态）推送后条目不重算——正例断言不是空断言', async () => {
    const mock = makeWidgetSource(SID)
    mock.push(makeEntry('todo', [ansiLine('t')], makeMeta({ title: 'Todo' })))
    const wrapper = mountStrip(mock, BrokenStrip)
    expect(stripKeys(wrapper)).toEqual(['todo'])

    mock.push(makeEntry('goal', [ansiLine('g')], makeMeta({ title: 'Goal' })))
    await wrapper.vm.$nextTick()

    // setup 期一次性快照不建依赖链 → 新条目不出现（= 断链症状，验收 ⑤ 的反面）
    expect(stripKeys(wrapper)).toEqual(['todo'])
  })
})
