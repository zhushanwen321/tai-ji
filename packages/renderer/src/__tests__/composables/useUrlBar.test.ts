/**
 * useUrlBar 单测（地址栏编辑态管理）。
 *
 * 覆盖：
 * - 非编辑态：displayUrl 变化 → urlInput 同步
 * - 编辑态：displayUrl 变化 → urlInput 不覆盖
 * - 回车裸域名 → 补全 https:// + 触发 navigate
 * - 回车完整 URL → 不重复补全
 * - Escape → 回填 displayUrl + 不触发 navigate
 * - 聚焦 → 进入编辑态 + 全选
 * - 危险协议黑名单（PR #100 S2）：javascript:/data:/file:/blob:/chrome:/vbscript:/devtools:/about:
 *   命中时 navigateFn 不被调、urlInput 保留、isEditingUrl 保持 true、toast 推送
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useUrlBar.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { useUrlBar } from '@/composables/features/url-bar/useUrlBar'
import { useToast, setToastLimiter } from '@/composables/useToast'

describe('useUrlBar', () => {
  let displayUrl: ReturnType<typeof ref<string>>
  let navigateFn: ReturnType<typeof vi.fn>
  let result: ReturnType<typeof useUrlBar>

  beforeEach(() => {
    displayUrl = ref('https://example.com')
    navigateFn = vi.fn()
    result = useUrlBar(displayUrl, navigateFn)
  })

  it('初始 urlInput = displayUrl', () => {
    expect(result.urlInput.value).toBe('https://example.com')
  })

  it('非编辑态：displayUrl 变化 → urlInput 同步', async () => {
    displayUrl.value = 'https://redirected.com'
    await Promise.resolve()
    expect(result.urlInput.value).toBe('https://redirected.com')
  })

  it('编辑态：displayUrl 变化 → urlInput 不覆盖', async () => {
    result.isEditingUrl.value = true
    result.urlInput.value = '用户正在输入'
    displayUrl.value = 'https://redirected.com'
    await Promise.resolve()
    expect(result.urlInput.value).toBe('用户正在输入')
  })

  it('回车裸域名 → 补全 https:// + 触发 navigate', () => {
    result.urlInput.value = 'github.com'
    result.onUrlEnter()
    expect(navigateFn).toHaveBeenCalledWith('https://github.com')
    expect(result.isEditingUrl.value).toBe(false)
  })

  it('回车完整 URL → 不重复补全', () => {
    result.urlInput.value = 'http://foo.bar/baz'
    result.onUrlEnter()
    expect(navigateFn).toHaveBeenCalledWith('http://foo.bar/baz')
  })

  it('回车 https URL → 不重复补全', () => {
    result.urlInput.value = 'HTTPS://UPPER.COM'
    result.onUrlEnter()
    expect(navigateFn).toHaveBeenCalledWith('HTTPS://UPPER.COM')
  })

  it('回车空输入 → 不触发 navigate', () => {
    result.urlInput.value = '   '
    result.onUrlEnter()
    expect(navigateFn).not.toHaveBeenCalled()
  })

  it('Escape → 回填 displayUrl + 不触发 navigate', () => {
    result.urlInput.value = '未确认的输入'
    result.onUrlEscape()
    expect(result.urlInput.value).toBe('https://example.com')
    expect(navigateFn).not.toHaveBeenCalled()
    expect(result.isEditingUrl.value).toBe(false)
  })

  it('聚焦 → 进入编辑态', () => {
    const fakeInput = { select: vi.fn() }
    const fakeEvent = { target: fakeInput } as unknown as FocusEvent
    result.onUrlFocus(fakeEvent)
    expect(result.isEditingUrl.value).toBe(true)
    expect(fakeInput.select).toHaveBeenCalled()
  })
})

/**
 * PR #100 S2：危险协议黑名单测试（renderer 第一层防御）。
 *
 * 三视角断言：
 * - 黑盒（行为）：navigateFn 不被调
 * - 状态：urlInput 保留 + isEditingUrl 保持 true（用户输入不被擦掉，便于修正）
 * - 形态：toast 推送（useToast 模块级 toasts ref 含对应 message）
 *
 * 黑名单：javascript:/data:/file:/blob:/chrome:/devtools:/about:/vbscript:
 * （与主进程 url-scheme-validators DANGEROUS_SCHEMES 对齐，独立函数不互相依赖）
 */
describe('useUrlBar — 危险协议拦截（PR #100 S2）', () => {
  let displayUrl: ReturnType<typeof ref<string>>
  let navigateFn: ReturnType<typeof vi.fn>
  let result: ReturnType<typeof useUrlBar>

  beforeEach(() => {
    displayUrl = ref('https://example.com')
    navigateFn = vi.fn()
    result = useUrlBar(displayUrl, navigateFn)
    // 进入编辑态：与真实使用路径一致（聚焦后输入）
    result.isEditingUrl.value = true
    // 禁用限流：8 个 dangerous scheme 用例共享 toast 状态，需要每个都能创建 toast
    setToastLimiter(() => false)
  })

  // 恢复默认限流
  afterEach(() => {
    setToastLimiter(null)
  })

  // 危险 scheme 表格：[scheme, sample-url]
  const dangerousCases: Array<[string, string]> = [
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['file:', 'file:///etc/passwd'],
    ['blob:', 'blob:https://example.com/abc-123'],
    ['chrome:', 'chrome://settings'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['devtools:', 'devtools://devtools/bundled/inspector.html'],
    ['about:', 'about:blank'],
  ]

  for (const [scheme, url] of dangerousCases) {
    it(`${scheme} 协议被拒：navigateFn 不调、urlInput 保留、isEditingUrl=true、toast 推送`, () => {
      // 注入用户输入
      result.urlInput.value = url

      // 记录 toast 数（beforeEach 无清理，跨测试累积）
      const { toasts } = useToast()
      const toastsBefore = toasts.value.length

      // 触发回车
      result.onUrlEnter()

      // 黑盒：navigateFn 未被调
      expect(navigateFn).not.toHaveBeenCalled()
      // 状态：urlInput 保留用户输入（便于修正）
      expect(result.urlInput.value).toBe(url)
      // 状态：保持编辑态
      expect(result.isEditingUrl.value).toBe(true)
      // 形态：toast 推送（toasts 数 +1，新 toast.message 含 scheme 提示）
      expect(toasts.value.length).toBe(toastsBefore + 1)
      const latest = toasts.value[toasts.value.length - 1]!
      expect(latest.type).toBe('error')
      expect(latest.message).toContain(scheme.toUpperCase())
    })
  }

  it('大小写不敏感：JAVASCRIPT: 大写变体被拒', () => {
    result.urlInput.value = 'JavaScript:alert(1)'
    result.onUrlEnter()

    expect(navigateFn).not.toHaveBeenCalled()
    expect(result.urlInput.value).toBe('JavaScript:alert(1)')
    expect(result.isEditingUrl.value).toBe(true)
  })

  it('危险 scheme 后接空格被拒（trim 后检测）', () => {
    result.urlInput.value = '  javascript:alert(1)  '
    result.onUrlEnter()

    expect(navigateFn).not.toHaveBeenCalled()
    expect(result.urlInput.value).toBe('  javascript:alert(1)  ')
  })

  it('普通 http URL 仍能通过（不被误拦截）', () => {
    result.urlInput.value = 'http://safe.example.com/page?q=1'
    result.onUrlEnter()

    expect(navigateFn).toHaveBeenCalledWith('http://safe.example.com/page?q=1')
  })
})
