import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'

/**
 * CollapsibleContent 展开过渡守卫（Plan 01 续：collapsible enter transition）。
 *
 * 背景：tailwindcss-animate 插件未安装，旧 data-[state]:animate-in/out + fade-*
 * 是死类（不生成任何 CSS），展开/折叠完全瞬时。改用手写 CSS 原语类
 * .reka-collapsible-transition + @starting-style，由 reka data-state 驱动。
 *
 * reka CollapsibleRoot unmountOnHide 默认 true —— closed 时 slot 被 v-if 即时
 * 移除 + 元素 hidden(display:none)，退出动画无生效空间。故仅实现 open 进入动画
 * （方案 A，零风险不改消费点），closed 退出保持瞬时（与改前一致，不更差）。
 *
 * 分层：collapsible 是单组件样式，归 CollapsibleContent.vue <style scoped>
 * （§3 escape hatch：@starting-style + [data-state] 是 Tailwind 无法表达的）；
 * 多组件共享原语（popover/dialog/overlay）才进 style.css 全局层。故本测试锚定
 * 组件源文件的 scoped 块（而非 style.css）。
 *
 * 验证策略（非纯字符串断言）：
 *   1. 源文件层：CollapsibleContent.vue 的 <style scoped> 真实含规则 + @starting-style
 *   2. DOM 层：mount 真实组件，class 渲染 / data-state 切换 / hidden / reka 内联变量
 * 覆盖「class 字符串存在 ≠ CSS 生成 ≠ 动画生效」盲区。
 * 注：vitest + happy-dom 不注入 scoped CSS 到 document（实测验证），故运行时层
 * 锁定 DOM 机制 + 源文件 scoped 块正则（证明规则文本真实生成）。
 */
const collapsibleContentSrc = readFileSync(
  resolve(__dirname, '../../components/ui/collapsible/CollapsibleContent.vue'),
  'utf-8',
)

// 死类全集（与并入的浮层守卫共享；原 collapsible 版 4 项，zoom/slide 由 overlay 版补齐）
const DEAD_CLASSES = [
  'animate-in',
  'animate-out',
  'zoom-in-95',
  'zoom-out-95',
  'fade-in-0',
  'fade-out-0',
  'slide-in-from',
  'slide-out-to',
]

/** 从 .vue 源文件提取 <style scoped> 块文本 */
function extractScopedStyle(src: string): string {
  const m = src.match(/<style scoped>([\s\S]*?)<\/style>/)
  return m ? m[1] : ''
}

/**
 * mount 一个受控 open 的 Collapsible，返回 wrapper 与 open ref。
 * CollapsibleContent 原语类在组件内部已写死，这里不再额外传 class。
 */
function mountCollapsible(initialOpen: boolean) {
  const open = ref(initialOpen)
  const wrapper = mount({
    components: { Collapsible, CollapsibleContent },
    template: `
      <Collapsible v-model:open="open">
        <CollapsibleContent>
          <div data-testid="inner">详情内容</div>
        </CollapsibleContent>
      </Collapsible>
    `,
    setup() {
      return { open }
    },
  })
  return { wrapper, open }
}

describe('CollapsibleContent 展开过渡（Plan 01 续）', () => {
  describe('scoped style 真实含 .reka-collapsible-transition 定义（非死类）', () => {
    it('<style scoped> 定义 .reka-collapsible-transition + opacity transition 声明', () => {
      // 死类不生成任何 CSS transition 声明；这里断言真实 scoped 块含 transition + opacity
      const scoped = extractScopedStyle(collapsibleContentSrc)
      expect(scoped, 'CollapsibleContent.vue 含 <style scoped> 块').not.toBe('')
      const block = scoped.match(/\.reka-collapsible-transition\s*\{([^}]*)\}/)
      expect(block, '.reka-collapsible-transition 规则块存在').not.toBeNull()
      expect(block![1]).toContain('transition')
      expect(block![1]).toContain('opacity')
    })

    it('data-state=open/closed 驱动 opacity 终态', () => {
      const scoped = extractScopedStyle(collapsibleContentSrc)
      expect(scoped).toContain(".reka-collapsible-transition[data-state='open']")
      expect(scoped).toContain(".reka-collapsible-transition[data-state='closed']")
    })

    it('@starting-style 提供 open 入场起点（opacity:0，跨 display:none→block 触发）', () => {
      const scoped = extractScopedStyle(collapsibleContentSrc)
      const startBlock = scoped.match(
        /@starting-style\s*\{[^}]*\.reka-collapsible-transition\[data-state='open'\][^}]*\}/s,
      )
      expect(
        startBlock,
        '@starting-style 块含 collapsible open 起点',
      ).not.toBeNull()
      expect(startBlock![0]).toContain('opacity: 0')
    })
  })

  describe('CollapsibleContent.vue 接入原语类且无死类', () => {
    it('使用 reka-collapsible-transition 原语类', () => {
      expect(collapsibleContentSrc).toContain('reka-collapsible-transition')
    })

    it.each(DEAD_CLASSES)('无死类 %s', (dead) => {
      expect(
        collapsibleContentSrc,
        `CollapsibleContent.vue 不应残留死类 ${dead}`,
      ).not.toContain(dead)
    })
  })

  describe('DOM 层：mount 真实组件验证动画机制生效', () => {
    it('原语类元素真实渲染于 DOM（非仅模板字符串）', async () => {
      const { wrapper } = mountCollapsible(false)
      await flushPromises()

      // CollapsibleContent 根元素始终在 DOM（reka Presence force-mount=true 保持挂载）。
      // 查询到 .reka-collapsible-transition 证明 class 经 reka Primitive 合并进了真实 DOM 节点。
      const content = wrapper.find('.reka-collapsible-transition')
      expect(content.exists(), '原语类元素真实渲染于 DOM').toBe(true)

      wrapper.unmount()
    })

    it('closed→open：data-state 切换为 open + 移除 hidden + slot 渲染', async () => {
      const { wrapper, open } = mountCollapsible(false)
      await flushPromises()

      // 初始 closed：data-state=closed（reka 初始 mount 防动画对 open=false 无影响）
      let content = wrapper.find('.reka-collapsible-transition')
      expect(content.attributes('data-state')).toBe('closed')
      // unmountOnHide 默认 true → 元素 hidden + slot 被 v-if 移除
      expect(content.attributes('hidden')).toBeDefined()
      expect(wrapper.find('[data-testid="inner"]').exists()).toBe(false)

      // 切换到 open
      open.value = true
      await flushPromises()
      await nextTick()
      await flushPromises()

      content = wrapper.find('.reka-collapsible-transition')
      expect(content.attributes('data-state')).toBe('open')
      expect(content.attributes('hidden')).toBeUndefined()
      expect(wrapper.find('[data-testid="inner"]').exists()).toBe(true)

      wrapper.unmount()
    })

    it('open 态 reka 注入内联尺寸 CSS 变量（--reka-collapsible-content-height）', async () => {
      // reka 测量后通过 style prop 注入 CSS 变量，是动画驱动的运行时证据
      // （死类方案下不会有任何 reka 变量与 transition 联动）
      const { wrapper, open } = mountCollapsible(false)
      await flushPromises()

      open.value = true
      await flushPromises()
      await nextTick()
      await flushPromises()

      const content = wrapper.find('.reka-collapsible-transition')
      const style = content.attributes('style') ?? ''
      expect(style).toContain('--reka-collapsible-content-height')

      wrapper.unmount()
    })

    it('closed 退出印证 unmountOnHide 默认 true：slot 即时移除（退出动画无生效空间）', async () => {
      const { wrapper, open } = mountCollapsible(true)
      await flushPromises()
      // open 态 slot 在
      expect(wrapper.find('[data-testid="inner"]').exists()).toBe(true)

      // 切 closed：slot 立即移除（unmountOnHide=true 默认行为）
      open.value = false
      await flushPromises()
      await nextTick()
      await flushPromises()

      expect(wrapper.find('[data-testid="inner"]').exists()).toBe(false)
      // 元素仍在 DOM（Presence force-mount），但 hidden + data-state=closed
      const content = wrapper.find('.reka-collapsible-transition')
      expect(content.exists()).toBe(true)
      expect(content.attributes('hidden')).toBeDefined()
      expect(content.attributes('data-state')).toBe('closed')

      wrapper.unmount()
    })
  })
})

// ── 原 overlay-transitions.test.ts 并入（同族过渡原语守卫，共享 DEAD_CLASSES 全集）──
const styleCss = readFileSync(resolve(__dirname, '../../style.css'), 'utf-8')
const popoverContent = readFileSync(
  resolve(__dirname, '../../components/ui/popover/PopoverContent.vue'),
  'utf-8',
)
const selectContent = readFileSync(
  resolve(__dirname, '../../components/ui/select/SelectContent.vue'),
  'utf-8',
)
const hoverCardContent = readFileSync(
  resolve(__dirname, '../../components/ui/hover-card/HoverCardContent.vue'),
  'utf-8',
)
const dialogContent = readFileSync(
  resolve(__dirname, '../../components/ui/dialog/DialogContent.vue'),
  'utf-8',
)

describe('浮层进出场过渡原语（Plan 01）', () => {
  describe('style.css 定义 3 个过渡原语类', () => {
    it('.reka-popover-transition 跟随触发点 scale（消费 --reka-popper-transform-origin）', () => {
      expect(styleCss).toContain('.reka-popover-transition')
      expect(styleCss).toContain(
        'transform-origin: var(--reka-popper-transform-origin, center)',
      )
      expect(styleCss).toContain('data-state=\'open\'')
      expect(styleCss).toContain('data-state=\'closed\'')
    })

    it('.reka-dialog-transition 居中缩放（transform 保留 translate 居中）', () => {
      expect(styleCss).toContain('.reka-dialog-transition')
      expect(styleCss).toContain('translate(-50%, -50%) scale(1)')
      expect(styleCss).toContain('translate(-50%, -50%) scale(0.96)')
    })

    it('.reka-overlay-transition 纯 opacity', () => {
      expect(styleCss).toContain('.reka-overlay-transition')
    })

    it('@starting-style 提供入场起点（3 个原语类各一）', () => {
      expect(styleCss).toContain('@starting-style')
      // popover 族入场起点：scale(0.96) opacity 0
      const popoverStart = styleCss.match(
        /@starting-style\s*\{[^}]*\.reka-popover-transition\[data-state='open'\][^}]*\}/s,
      )
      expect(popoverStart, '.reka-popover-transition 的 @starting-style 块存在').not.toBeNull()
      // dialog 入场起点
      const dialogStart = styleCss.match(
        /@starting-style\s*\{[^}]*\.reka-dialog-transition\[data-state='open'\][^}]*\}/s,
      )
      expect(dialogStart, '.reka-dialog-transition 的 @starting-style 块存在').not.toBeNull()
      // overlay 入场起点
      const overlayStart = styleCss.match(
        /@starting-style\s*\{[^}]*\.reka-overlay-transition\[data-state='open'\][^}]*\}/s,
      )
      expect(overlayStart, '.reka-overlay-transition 的 @starting-style 块存在').not.toBeNull()
    })
  })

  describe('popover 族组件接入 reka-popover-transition 且无死类', () => {
    it('PopoverContent.vue 接入原语类', () => {
      expect(popoverContent).toContain('reka-popover-transition')
    })

    it('SelectContent.vue 接入原语类', () => {
      expect(selectContent).toContain('reka-popover-transition')
    })

    it('HoverCardContent.vue 接入原语类', () => {
      expect(hoverCardContent).toContain('reka-popover-transition')
    })

    it.each(DEAD_CLASSES)('PopoverContent.vue 无死类 %s', (dead) => {
      expect(popoverContent, `PopoverContent.vue 不应残留死类 ${dead}`).not.toContain(dead)
    })

    it.each(DEAD_CLASSES)('SelectContent.vue 无死类 %s', (dead) => {
      expect(selectContent, `SelectContent.vue 不应残留死类 ${dead}`).not.toContain(dead)
    })

    it.each(DEAD_CLASSES)('HoverCardContent.vue 无死类 %s', (dead) => {
      expect(hoverCardContent, `HoverCardContent.vue 不应残留死类 ${dead}`).not.toContain(dead)
    })
  })

  describe('dialog 组件接入 reka-dialog/overlay-transition 且无死类', () => {
    it('DialogContent 接入 reka-dialog-transition', () => {
      expect(dialogContent).toContain('reka-dialog-transition')
    })

    it('DialogOverlay 接入 reka-overlay-transition', () => {
      expect(dialogContent).toContain('reka-overlay-transition')
    })

    it('DialogContent 不再用 -translate 居中（由 transition transform 承担）', () => {
      expect(dialogContent).not.toContain('-translate-x-1/2')
      expect(dialogContent).not.toContain('-translate-y-1/2')
    })

    it.each(DEAD_CLASSES)('DialogContent.vue 无死类 %s', (dead) => {
      expect(dialogContent, `DialogContent.vue 不应残留死类 ${dead}`).not.toContain(dead)
    })
  })
})
