/**
 * CommandPopover file 分支 + AddMenuPopover 去 @ 入口 单测（U27-U32）。
 *
 * 覆盖：
 * - U27 CommandPopover type='file' 渲染候选（DOM body 含文件名 button）
 * - U28 CommandPopover file 候选空 → PopoverContent 不渲染
 * - U29 file 候选含目录项 → 图标 folder（G16 映射验证）
 * - U33 sid A→B 切换无残留（ADR-0049 回归）
 * - LP 组 landing cwd 路（u5，landing-composer-session-file-symbols G1/D2 + adversarial-
 *   review-fixes §3.4 D7/#10）：无 sessionId + cwd 有值 → open-fetch 边沿拉取渲染候选；
 *   拉取失败回写**错误态**（浮层渲染「加载失败，点击重试」+ 行内重试重发拉取）；成功空结果
 *   → 空态「当前目录无匹配文件」（两因区分）；truncated → 底部「已截断」提示；open 边沿
 *   清陈旧候选 + cwd 快照守卫（迟到回执按发起时 cwd 归属裁决）；panel session 路用例全部保持
 * - U30 AddMenuPopover 有 session → 含「文件」「命令」，不含「引用」
 * - U31 AddMenuPopover 无 session（landing）→ 不含「文件」「引用」，含「命令」
 * - U32 Composer onAddSelect('file') → cmdType='file', cmdOpen=true
 *
 * mock 策略：
 * - CommandPopover：vi.mock useFileSearch 返回可控 nodes（绕过 file.search）
 * - AddMenuPopover：纯组件 mount + body DOM 断言（reka-ui teleport）
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/panel/composer-file-popover.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// mock useFileSearch：返回可控 FileNode[]，绕过真实 file.search
const mockLoad = vi.fn()
vi.mock('@/composables/features/search/useFileSearch', () => ({
  useFileSearch: () => ({ load: (...args: unknown[]) => mockLoad(...args) }),
}))

// open-fetch 直接 import composer domain（landing cwd 通道，u4）——mock 之隔离真实 WS 通路。
// u5 re-anchor（e79ba3647/8ca21226f）后实现 import 的是 core 子路径，mock 必须对齐同一
// specifier（旧 '@/api/domains/composer' bridge 已删，mock 指旧路径 = mock 失效）
const getFileCandidatesByCwdMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/composer')>()
  return {
    ...actual,
    getFileCandidatesByCwd: (...args: unknown[]) => getFileCandidatesByCwdMock(...args),
  }
})

import CommandPopover from '@/components/panel/CommandPopover.vue'
import AddMenuPopover from '@/components/panel/AddMenuPopover.vue'
import type { FileNode } from '@taiji/shared'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('CommandPopover file 分支', () => {
  it('U27 type=file 渲染候选：DOM body 含文件名 button', async () => {
    const nodes: FileNode[] = [{ path: 'a.ts', name: 'a.ts', type: 'file' }]
    mockLoad.mockResolvedValueOnce(nodes)

    const wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'file', sessionId: 's1' },
    })
    await flushPromises()
    await nextTick()

    const btns = Array.from(document.body.querySelectorAll('.cmd-row'))
    const fileBtn = btns.find((b) => b.textContent?.includes('a.ts'))
    expect(fileBtn).toBeDefined()
    wrapper.unmount()
  })

  it('U28 type=file 候选空 → PopoverContent 不渲染', async () => {
    mockLoad.mockResolvedValueOnce([])

    const wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'file', sessionId: 's1' },
    })
    await flushPromises()
    await nextTick()

    // PopoverContent v-if="items.length > 0"，空候选不渲染浮层（无 .cmd-row 行）
    const rows = Array.from(document.body.querySelectorAll('.cmd-row'))
    expect(rows.length).toBe(0)
    wrapper.unmount()
  })

  it('U29 候选含目录项 → 图标用 folder（G16 映射）', async () => {
    const nodes: FileNode[] = [
      { path: 'src', name: 'src', type: 'dir' },
      { path: 'a.ts', name: 'a.ts', type: 'file' },
    ]
    mockLoad.mockResolvedValueOnce(nodes)

    const wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'file', sessionId: 's1' },
    })
    await flushPromises()
    await nextTick()

    // 目录项 name 补斜杠（src/），验证 G16 映射后目录正确识别
    const dirBtn = Array.from(document.body.querySelectorAll('.cmd-row')).find((b) =>
      b.textContent?.includes('src/'),
    )
    expect(dirBtn).toBeDefined()
    wrapper.unmount()
  })
})

// ADR-0049 回归：同组件实例 sid A→B 切换后 B 的文件候选不显示 A 残留。
// 验证 watch(sessionId) 触发 loadCandidates 从 store 缓存重新填充，
// fileCandidates ref 被 B 的数据覆盖（而非保留 A 的旧值）。
it('U33 sid A→B 切换后 B 的候选不显示 A 残留（ADR-0049 回归）', async () => {
  // mock 按 sessionId 返回不同候选
  mockLoad.mockImplementation(async (sid: string) => {
    if (sid === 's-a') return [{ path: 'a.ts', name: 'a.ts', type: 'file' as const }]
    if (sid === 's-b') return [{ path: 'b.ts', name: 'b.ts', type: 'file' as const }]
    return []
  })

  const wrapper = mount(CommandPopover, {
    attachTo: document.body,
    props: { open: true, type: 'file', sessionId: 's-a' },
  })
  await flushPromises()
  await nextTick()

  // A 的候选可见
  const btnsA = Array.from(document.body.querySelectorAll('.cmd-row'))
  expect(btnsA.some((b) => b.textContent?.includes('a.ts'))).toBe(true)
  expect(btnsA.some((b) => b.textContent?.includes('b.ts'))).toBe(false)

  // 切到 B
  await wrapper.setProps({ sessionId: 's-b' })
  await flushPromises()
  await nextTick()

  // B 的候选可见，A 的残留不可见
  const btnsB = Array.from(document.body.querySelectorAll('.cmd-row'))
  expect(btnsB.some((b) => b.textContent?.includes('b.ts'))).toBe(true)
  expect(btnsB.some((b) => b.textContent?.includes('a.ts'))).toBe(false)

  // 切回 A（验证 store 缓存恢复）
  await wrapper.setProps({ sessionId: 's-a' })
  await flushPromises()
  await nextTick()

  const btnsA2 = Array.from(document.body.querySelectorAll('.cmd-row'))
  expect(btnsA2.some((b) => b.textContent?.includes('a.ts'))).toBe(true)
  expect(btnsA2.some((b) => b.textContent?.includes('b.ts'))).toBe(false)

  wrapper.unmount()
})

// ── landing cwd 路（u5：无 sessionId + cwd 有值，$ 候选边沿拉） ──────────────────────

describe('landing cwd 路（LP 组，u5 G1/D2）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  beforeEach(() => {
    // open-fetch 的 1s 节流是模块级真实时钟（跨用例共享）——只 fake Date（flushPromises
    // 依赖的 setImmediate/setTimeout 保持真实），用例间推进时钟跳出节流窗口
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('LP1 无 sessionId + cwd 有值 → open 边沿按 cwd 拉取，浮层渲染文件候选行', async () => {
    getFileCandidatesByCwdMock.mockResolvedValueOnce({
      files: [{ path: 'landing-main.ts', name: 'landing-main.ts', type: 'file' }],
      truncated: false,
    })
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'file', cwd: '/tmp/landing-proj' },
    })
    await nextTick()
    // 关闭态不预拉（open-fetch 仅 false→true 边沿触发）
    expect(getFileCandidatesByCwdMock).not.toHaveBeenCalled()
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getFileCandidatesByCwdMock).toHaveBeenCalledTimes(1)
    expect(getFileCandidatesByCwdMock).toHaveBeenCalledWith('/tmp/landing-proj')
    // 拉取结果渲染进浮层（用户可见 DOM）
    const btn = Array.from(document.body.querySelectorAll('.cmd-row')).find((b) =>
      b.textContent?.includes('landing-main.ts'),
    )
    expect(btn).toBeDefined()
  })

  it('LP2 拉取失败（D7）→ 错误态浮层「加载失败，点击重试」；点击行重试绕节流重发拉取，成功后恢复', async () => {
    // 跳出 LP1 拉取留下的 1s 节流窗口（模块级节流，不推进时钟则本用例边沿被节流命中）
    vi.advanceTimersByTime(1001)
    getFileCandidatesByCwdMock.mockRejectedValueOnce(
      Object.assign(new Error('cwd not found'), { code: 'not_found' }),
    )
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'file', cwd: '/deleted-dir' },
    })
    await nextTick()
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getFileCandidatesByCwdMock).toHaveBeenCalledTimes(1)
    // D7：失败回写错误态（被否的「降级空数组」不再适用）——浮层渲染错误行；
    // rejection 被 open-fetch catch，不冒泡 unhandled（vitest 对 unhandled 判失败，用例通过即无）
    const errRow = document.body.querySelector('[data-testid="cmd-file-error"]')
    expect(errRow).not.toBeNull()
    expect(document.body.querySelector('[data-testid="cmd-file-empty"]')).toBeNull()
    expect(document.body.querySelectorAll('.cmd-row')).toHaveLength(0)

    // 点击错误行 → 重试（force 绕过 1s 节流，仍在窗口内即重发）；成功后错误态消失、候选渲染
    getFileCandidatesByCwdMock.mockResolvedValueOnce({
      files: [{ path: 'recovered.ts', name: 'recovered.ts', type: 'file' }],
      truncated: false,
    })
    errRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    await nextTick()
    expect(getFileCandidatesByCwdMock).toHaveBeenCalledTimes(2)
    expect(document.body.querySelector('[data-testid="cmd-file-error"]')).toBeNull()
    expect(
      Array.from(document.body.querySelectorAll('.cmd-row')).some((b) => b.textContent?.includes('recovered.ts')),
    ).toBe(true)
  })

  it('LP3 成功且 truncated=true（D7）→ 候选列表底部渲染「已截断」提示行', async () => {
    vi.advanceTimersByTime(1001)
    getFileCandidatesByCwdMock.mockResolvedValueOnce({
      files: [{ path: 'big-repo-file.ts', name: 'big-repo-file.ts', type: 'file' }],
      truncated: true,
    })
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'file', cwd: '/tmp/huge-monorepo' },
    })
    await nextTick()
    await wrapper.setProps({ open: true })
    await flushPromises()
    await nextTick()

    expect(
      Array.from(document.body.querySelectorAll('.cmd-row')).some((b) => b.textContent?.includes('big-repo-file.ts')),
    ).toBe(true)
    expect(document.body.querySelector('[data-testid="cmd-file-truncated"]')).not.toBeNull()
  })

  it('LP4 成功但空结果（D7）→ 空态浮层「当前目录无匹配文件」（与加载失败错误态两因区分）', async () => {
    vi.advanceTimersByTime(1001)
    getFileCandidatesByCwdMock.mockResolvedValueOnce({ files: [], truncated: false })
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'file', cwd: '/tmp/empty-dir' },
    })
    await nextTick()
    await wrapper.setProps({ open: true })
    await flushPromises()
    await nextTick()

    expect(document.body.querySelector('[data-testid="cmd-file-empty"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="cmd-file-error"]')).toBeNull()
  })

  it('LP5 cwd 快照守卫（B5/#10）：open 边沿清上一 cwd 陈旧候选；在途回执按发起时 cwd 归属、失配丢弃', async () => {
    vi.advanceTimersByTime(1001)
    // 第一拍：cwd A 拉到候选 a.ts
    getFileCandidatesByCwdMock.mockResolvedValueOnce({
      files: [{ path: 'a.ts', name: 'a.ts', type: 'file' }],
      truncated: false,
    })
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'file', cwd: '/dir-a' },
    })
    await nextTick()
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(
      Array.from(document.body.querySelectorAll('.cmd-row')).some((b) => b.textContent?.includes('a.ts')),
    ).toBe(true)

    // 第二拍：切 cwd B 重开（推进时钟出节流）——B 拉取挂起期间，open 边沿已清 A 的陈旧候选
    vi.advanceTimersByTime(1001)
    let resolveB: (v: { files: FileNode[]; truncated: boolean }) => void = () => {}
    getFileCandidatesByCwdMock.mockImplementationOnce(
      () => new Promise<{ files: FileNode[]; truncated: boolean }>((res) => { resolveB = res }),
    )
    await wrapper.setProps({ open: false })
    await nextTick()
    await wrapper.setProps({ cwd: '/dir-b', open: true })
    await flushPromises()
    expect(
      Array.from(document.body.querySelectorAll('.cmd-row')).some((b) => b.textContent?.includes('a.ts')),
    ).toBe(false) // 陈旧候选已清（FileNode.path 相对旧 cwd，跨目录显示是事实错误）

    // 在途期间再切 cwd → C：B 的回执到达时快照失配（cwd ≠ 发起时 /dir-b）→ 丢弃
    await wrapper.setProps({ cwd: '/dir-c' })
    await nextTick()
    resolveB({ files: [{ path: 'b-only.ts', name: 'b-only.ts', type: 'file' }], truncated: false })
    await flushPromises()
    await nextTick()
    expect(document.body.querySelectorAll('.cmd-row')).toHaveLength(0)
  })
})

// ── AddMenuPopover ──────────────────────────────────────────────────

describe('AddMenuPopover 入口（# 文件改走 inline 触发，+菜单只剩 附件/命令）', () => {
  it('U30 +菜单含「附件」「命令」，不含「文件」「引用」', async () => {
    const wrapper = mount(AddMenuPopover, {
      attachTo: document.body,
    })
    // 触发 Popover 打开（click trigger）
    await wrapper.find('button').trigger('click')
    await nextTick()

    const texts = Array.from(document.body.querySelectorAll('button')).map((b) => b.textContent ?? '')
    expect(texts.some((t) => t.includes('附件'))).toBe(true)
    expect(texts.some((t) => t.includes('命令'))).toBe(true)
    // # 文件已移除入口（改走 inline 触发）；@ 引用早已废弃
    expect(texts.some((t) => t.includes('文件'))).toBe(false)
    expect(texts.some((t) => t.includes('引用'))).toBe(false)
    wrapper.unmount()
  })
})
