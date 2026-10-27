import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { handleImagePaste } from '@/composables/panel/useImageAttachment';
import { mount, flushPromises } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick, ref } from 'vue';

// wave3 簇 [renderer/happy-dom] 2 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/composables/useImageAttachment.test.ts
 * - __tests__/ui/collapsible-transition.test.ts
 */

// ======================================================================
// ← __tests__/composables/useImageAttachment.test.ts
// ======================================================================

// writeImage 可被每个测试替换三态：resolve({path,name,id}) / resolve(undefined) / reject
const writeImageMock = vi.hoisted(() => vi.fn())
vi.mock('@/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/api')>()
  return { ...orig, session: { ...orig.session, writeImage: writeImageMock } }
})

/** 构造最小 PNG（8 字节签名 + IHDR 占位，足够 FileReader.readAsArrayBuffer 产出非空 base64） */
function makePngFile(): File {
  // PNG signature + fake IHDR chunk（内容不要求是合法 PNG，只要求能读成 ArrayBuffer 转 base64）
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, // IHDR length
    0x49, 0x48, 0x44, 0x52, // "IHDR"
  ])
  return new File([bytes], 'image.png', { type: 'image/png' })
}

describe('useImageAttachment: handleImagePaste 降级矩阵', () => {
  beforeEach(() => {
    writeImageMock.mockReset()
  })

  it('TC1: writeSessionImage 成功（persisted=true）→ {kind:badge, ..., needsMigrate:false}', async () => {
    writeImageMock.mockResolvedValueOnce({ path: '/tmp/taiji-img-x.png', fileName: 'taiji-img-x.png', displayName: 'taiji-img-x.png', id: 'u1', persisted: true })
    const result = await handleImagePaste(makePngFile(), 'sess-1')
    expect(result).toEqual({ kind: 'badge', path: '/tmp/taiji-img-x.png', fileName: 'taiji-img-x.png', displayName: 'taiji-img-x.png', needsMigrate: false })
    // writeSessionImage 收到 base64 非空 + mimeType='image/png'
    expect(writeImageMock).toHaveBeenCalledTimes(1)
    const payload = writeImageMock.mock.calls[0][0]
    expect(payload.mimeType).toBe('image/png')
    expect(payload.base64.length).toBeGreaterThan(0)
  })

  it('W3TC9: sessionId 透传到 writeSessionImage payload', async () => {
    writeImageMock.mockResolvedValueOnce({ path: '/d/a.png', fileName: 'a.png', displayName: 'a.png', id: 'u1', persisted: true })
    await handleImagePaste(makePngFile(), 'sess-panel-9')
    expect(writeImageMock.mock.calls[0][0].sessionId).toBe('sess-panel-9')
  })

  it('sessionId=null（landing 态）→ payload.sessionId 为空字符串（IPC 内降级 tmpdir）+ needsMigrate=true', async () => {
    // persisted=false（落 tmpdir）→ needsMigrate=true（session 创建后需迁移到 attachments）
    writeImageMock.mockResolvedValueOnce({ path: '/tmp/x.png', fileName: 'x.png', displayName: 'x.png', id: 'u1', persisted: false })
    const result = await handleImagePaste(makePngFile(), null)
    expect(writeImageMock.mock.calls[0][0].sessionId).toBe('')
    expect(result).toEqual({ kind: 'badge', path: '/tmp/x.png', fileName: 'x.png', displayName: 'x.png', needsMigrate: true })
  })

  it('TC4: writeSessionImage reject → {kind:text, text:[图片粘贴失败]} 降级', async () => {
    writeImageMock.mockRejectedValueOnce(new Error('write failed'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await handleImagePaste(makePngFile(), 'sess-1')
    expect(result).toEqual({ kind: 'text', text: '[图片粘贴失败]' })
    errSpy.mockRestore()
  })

  it('TC5: writeSessionImage resolve(undefined)（非 electron）→ {kind:text, text:[图片粘贴：需桌面环境]}', async () => {
    writeImageMock.mockResolvedValueOnce(undefined)
    const result = await handleImagePaste(makePngFile(), 'sess-1')
    expect(result).toEqual({ kind: 'text', text: '[图片粘贴：需桌面环境]' })
  })

  it('读 blob 失败（FileReader.onerror）→ {kind:text, text:[图片读取失败]}', async () => {
    // 构造会触发 FileReader.onerror 的 blob：传入无效 Blob（readAsArrayBuffer 在某些实现下 onerror）
    // jsdom 的 FileReader 对空 ArrayBuffer 不会 onerror，这里用 spy 强制触发 error 事件
    const file = makePngFile()
    const orig = globalThis.FileReader
    class FailReader extends orig {
      override readAsArrayBuffer(_blob: Blob): void {
        // 模拟读取失败：异步派发 error
        setTimeout(() => {
          Object.defineProperty(this, 'error', { value: new Error('read fail'), configurable: true })
          this.dispatchEvent(new Event('error'))
        }, 0)
      }
    }
    globalThis.FileReader = FailReader as unknown as typeof FileReader
    try {
      const result = await handleImagePaste(file, 'sess-1')
      expect(result).toEqual({ kind: 'text', text: '[图片读取失败]' })
    } finally {
      globalThis.FileReader = orig
    }
  })
})

// ======================================================================
// ← __tests__/ui/collapsible-transition.test.ts
// ======================================================================

/**
 * CollapsibleContent 展开过渡检查（Plan 01 续：collapsible enter transition）。
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

// 死类全集（与并入的浮层检查共享；原 collapsible 版 4 项，zoom/slide 由 overlay 版补齐）
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

// ── 原 overlay-transitions.test.ts 并入（同族过渡原语检查，共享 DEAD_CLASSES 全集）──
const styleCss = readFileSync(resolve(__dirname, '../../style.css'), 'utf-8')
// 浮层四族实现已收敛至 @taiji/ui（renderer components/ui 降级 re-export），检查随实现走
const popoverContent = readFileSync(
  resolve(__dirname, '../../../../ui/src/primitives/popover/PopoverContent.vue'),
  'utf-8',
)
const selectContent = readFileSync(
  resolve(__dirname, '../../../../ui/src/primitives/select/SelectContent.vue'),
  'utf-8',
)
const hoverCardContent = readFileSync(
  resolve(__dirname, '../../../../ui/src/primitives/hover-card/HoverCardContent.vue'),
  'utf-8',
)
const dialogContent = readFileSync(
  resolve(__dirname, '../../../../ui/src/primitives/dialog/DialogContent.vue'),
  'utf-8',
)

describe('浮层进出场过渡原语（Plan 01）', () => {
  describe('style.css 定义 3 个过渡原语类', () => {
    it('.reka-popover-transition 透明度 + 3px 位移（data-side 定向，进 ease-out 出 ease-in）', () => {
      expect(styleCss).toContain('.reka-popover-transition')
      // spec overlays spec（demo） §2 动效：起止位随 reka data-side 朝锚点一侧偏移 3px
      expect(styleCss).toContain(".reka-popover-transition[data-side='top'] { --pop-offset: translateY(3px); }")
      expect(styleCss).toContain(".reka-popover-transition[data-side='bottom'] { --pop-offset: translateY(-3px); }")
      expect(styleCss).toContain('data-state=\'open\'')
      expect(styleCss).toContain('data-state=\'closed\'')
      // 进 ease-out（基类 transition）/ 出 ease-in（closed 态 timing 覆写）
      expect(styleCss).toMatch(/\.reka-popover-transition \{[^}]*var\(--ease-out\)/s)
      expect(styleCss).toMatch(/\.reka-popover-transition\[data-state='closed'\] \{[^}]*var\(--ease-in\)/s)
    })

    it('.reka-dialog-transition 统一升入（自下 8px 240ms ease-out-soft，关 150ms 纯淡出）', () => {
      expect(styleCss).toContain('.reka-dialog-transition')
      // spec overlays spec（demo） §2 动效：入场 240ms --ease-out-soft 自下 8px 升入（translate 保留居中）
      expect(styleCss).toMatch(/\.reka-dialog-transition\[data-state='open'\] \{[^}]*240ms var\(--ease-out-soft\)/s)
      expect(styleCss).toContain('translate(-50%, -50%) translateY(8px)')
      // 关闭 150ms ease-in 整层淡出（closed 态 transform 不带位移 = 盒不起落）
      expect(styleCss).toMatch(/\.reka-dialog-transition \{[^}]*150ms var\(--ease-in\)/s)
    })

    it('.reka-overlay-transition 纯 opacity', () => {
      expect(styleCss).toContain('.reka-overlay-transition')
    })

    it('@starting-style 提供入场起点（3 个原语类各一）', () => {
      expect(styleCss).toContain('@starting-style')
      // popover 族入场起点：锚侧 3px 位移 + opacity 0（spec overlays spec（demo） §2）
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
