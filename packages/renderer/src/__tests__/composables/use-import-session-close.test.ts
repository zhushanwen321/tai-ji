/**
 * useImportSession close() 清扫描结果测试（[G4/u10] 2026-09-14 内存审计杂项组）。
 *
 * 锁定（docs/design/memory-leak-remediation.md §3.4 G4「ImportSessionDialog close() 清扫描结果」）：
 *  - C1 关闭即清：items/dirs/total（候选全量快照，可达数百条对象）随 close 置空——
 *    对话框是全局单例 UI，无 session 生命周期兜底，不清则驻留到下次打开
 *  - C2 在途失效：close 后迟到的候选响应不回填（requestSeq++ 使 stale 写回守卫拦截）
 *  - C3 debounce 取消：close 清 pending debounce（组件侧 watch(open) 注释承诺的
 *    「取消 pending debounce」在 composable 落实）——关窗后不再发出新查询
 *
 * 观察者视角（TEST-STRATEGY §3）：经 computed 渲染 items/dirs/total 计数文本，断言用户可见归零。
 * composable 实例经 setup 闭包捕获直读（绕开 vm 代理的 ref 解包歧义）。
 *
 * mock 策略对齐 ImportSessionDialog.test.ts：vi.mock('@/api')（session.importCandidates
 * 可控）+ vi.mock('@/composables/useToast') + vi.mock('@/lib/ipc')（pickDirectory 不触达）。
 * vue-i18n 由 vitest-i18n-setup.ts 全局 mock。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-import-session-close.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, defineComponent, nextTick } from 'vue'

const apiMocks = vi.hoisted(() => ({
  importCandidates: vi.fn(),
  importSession: vi.fn(),
}))
vi.mock('@/api', () => ({
  session: {
    importCandidates: apiMocks.importCandidates,
    importSession: apiMocks.importSession,
  },
  project: {
    load: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
  },
}))

const toastMocks = vi.hoisted(() => ({
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({ useToast: () => toastMocks }))

vi.mock('@/lib/ipc', () => ({ pickDirectory: vi.fn() }))

import { useImportSession, IMPORT_SEARCH_DEBOUNCE_MS } from '@/composables/features/sidebar/useImportSession'
import type { ImportCandidate, ImportCandidateDir } from '@xyz-agent/shared'

/** 候选/目录 fixture（字段契约 = shared 类型） */
function makeCandidate(sessionId: string): ImportCandidate {
  return {
    sessionId,
    name: null,
    cwd: '/Users/test/Stock',
    sourcePath: `/Users/test/.pi/agent/sessions/x/${sessionId}.jsonl`,
    lastModified: Date.now(),
    size: 1000,
    dirLabel: 'x',
    alreadyImported: false,
    cwdExists: true,
  }
}
function makeDir(label: string): ImportCandidateDir {
  return { label, count: 1 }
}

/**
 * 挂载消费 useImportSession 的哑组件（pinia + i18n 全局 setup 生效要求）。
 * composable 实例经闭包捕获；模板渲染三计数字符串「items/dirs/total」——用户可见形态断言锚点。
 */
function mountComposable() {
  const pinia = createPinia()
  setActivePinia(pinia)
  let instance: ReturnType<typeof useImportSession> | undefined
  const Comp = defineComponent({
    setup() {
      const s = useImportSession()
      instance = s
      const counts = computed(() => `${s.items.value.length}/${s.dirs.value.length}/${s.total.value}`)
      return { counts }
    },
    template: '<div data-testid="counts">{{ counts }}</div>',
  })
  const wrapper = mount(Comp, { global: { plugins: [pinia] } })
  return {
    wrapper,
    s: instance!,
    counts: () => wrapper.get('[data-testid="counts"]').text(),
  }
}

describe('useImportSession close() 清扫描结果（G4/u10）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.importCandidates.mockResolvedValue({
      items: [makeCandidate('id-1'), makeCandidate('id-2')],
      dirs: [makeDir('x'), makeDir('y')],
      total: 2,
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('C1: 打开写入候选 → close() 清 items/dirs/total + open 收口', async () => {
    const t = mountComposable()
    t.s.resetForOpen()
    await flushPromises()
    expect(t.s.open.value).toBe(true)
    expect(t.counts()).toBe('2/2/2')

    t.s.close()
    await nextTick()
    expect(t.s.open.value).toBe(false)
    expect(t.s.items.value).toEqual([])
    expect(t.s.dirs.value).toEqual([])
    expect(t.s.total.value).toBe(0)
    // 用户可见形态：计数归零
    expect(t.counts()).toBe('0/0/0')
    t.wrapper.unmount()
  })

  it('C2: close 后在途迟到的候选响应不回填（requestSeq 失效 stale 写回）', async () => {
    let resolveFetch: ((v: unknown) => void) | undefined
    apiMocks.importCandidates.mockReturnValue(
      new Promise((r) => {
        resolveFetch = r
      }),
    )
    const t = mountComposable()
    t.s.resetForOpen() // 发起首拉（在途）
    t.s.close() // 关闭（清结果 + 失效在途写回）
    resolveFetch?.({
      items: [makeCandidate('late-1')],
      dirs: [makeDir('late')],
      total: 1,
    })
    await flushPromises()
    expect(t.counts()).toBe('0/0/0')
    t.wrapper.unmount()
  })

  it('C3: close 取消 pending debounce——关窗后不发出新候选查询', async () => {
    vi.useFakeTimers()
    const t = mountComposable()
    t.s.resetForOpen() // 空查询立即首拉（调用 #1）
    await vi.advanceTimersByTimeAsync(0)
    expect(apiMocks.importCandidates).toHaveBeenCalledTimes(1)

    t.s.query.value = 'stock' // 非空输入 → 排 250ms debounce
    await vi.advanceTimersByTimeAsync(10)
    t.s.close() // 关闭 → debounce 取消
    await vi.advanceTimersByTimeAsync(IMPORT_SEARCH_DEBOUNCE_MS + 50)

    expect(apiMocks.importCandidates).toHaveBeenCalledTimes(1) // 无第二次查询
    expect(t.counts()).toBe('0/0/0')
    t.wrapper.unmount()
  })
})
