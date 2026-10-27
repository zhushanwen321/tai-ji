import ImportSessionDialog from '@/components/sidebar/ImportSessionDialog.vue';
import RenameSessionDialog from '@/components/sidebar/RenameSessionDialog.vue';
import { IMPORT_SEARCH_DEBOUNCE_MS } from '@/composables/features/sidebar/useImportSession';
import zhCN from '@/i18n/locales/zh-CN/importSession';
import { DEFAULT_PROJECT_ID, useProjectStore } from '@/stores/project';
import { useSessionStore } from '@/stores/session';
import type { ImportCandidate, Project } from '@taiji/shared';
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← ImportSessionDialog.test.ts
// ======================================================================

// ── api mock：session 域两方法（默认实现模拟 runtime 匹配语义，用例可覆写）；project.save 供 store 持久化 watch ──
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

// ── toast mock：捕获 warning 通道（sidecar_failed 降级提示）──
const toastMocks = vi.hoisted(() => ({
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({ useToast: () => toastMocks }))

// ── ipc mock：pickDirectory 目录选择器（V8「选择其他目录」；默认取消，用例覆写选中）──
const ipcMocks = vi.hoisted(() => ({
  pickDirectory: vi.fn(),
}))
vi.mock('@/lib/ipc', () => ({ pickDirectory: ipcMocks.pickDirectory }))

/** 1 天毫秒数（fixture 相对时间分桶） */
const ONE_DAY = 86_400_000

const STOCK_DIR = '--Users-test-Stock--'
const TAIJI_DIR = '--Users-test-taiji--'

/** 候选工厂（字段契约 = shared ImportCandidate） */
function makeCandidate(overrides: Partial<ImportCandidate> = {}): ImportCandidate {
  return {
    sessionId: '01a04420-1111-2222-3333-444444444444',
    name: null,
    cwd: '/Users/test/Stock',
    sourcePath: `/Users/test/.pi/agent/sessions/${STOCK_DIR}/2026-08-27T09-11-00Z_01a04420-1111-2222-3333-444444444444.jsonl`,
    lastModified: Date.now(),
    size: 8_100_000,
    dirLabel: STOCK_DIR,
    alreadyImported: false,
    cwdExists: true,
    ...overrides,
  }
}

/**
 * fixture（时间以 beforeEach 冻结的 2026-09-02 周三午间为基准，保证日历周分桶稳定）：
 * now-1s/2s → 今天；now-1d（9-01 周二）→ 昨天；now-2d（8-31 周一）→ 本周；now-8d → 更早。
 */
function makeFixture(): ImportCandidate[] {
  return [
    makeCandidate({ name: 'clickhouse 日线迁移', lastModified: Date.now() - 1_000 }),
    makeCandidate({
      name: '已导入的调研',
      sessionId: 'aa11bb22-3333-4444-5555-666666666666',
      sourcePath: `/Users/test/.pi/agent/sessions/${STOCK_DIR}/2026-08-20T10-00-00Z_aa11bb22-3333-4444-5555-666666666666.jsonl`,
      lastModified: Date.now() - 2_000,
      alreadyImported: true,
    }),
    makeCandidate({
      name: null,
      sessionId: 'bb22cc33-4444-5555-6666-777777777777',
      sourcePath: `/Users/test/.pi/agent/sessions/${TAIJI_DIR}/2026-09-01T08-00-00Z_bb22cc33-4444-5555-6666-777777777777.jsonl`,
      cwd: '/Users/test/gone-dir',
      lastModified: Date.now() - ONE_DAY,
      dirLabel: TAIJI_DIR,
      cwdExists: false,
    }),
    makeCandidate({
      name: '本周的调优会话',
      sessionId: 'ee44ff55-6666-7777-8888-999999999999',
      sourcePath: `/Users/test/.pi/agent/sessions/${STOCK_DIR}/2026-08-31T09-00-00Z_ee44ff55-6666-7777-8888-999999999999.jsonl`,
      lastModified: Date.now() - ONE_DAY * 2,
    }),
    makeCandidate({
      name: '更早的 agent 会话',
      sessionId: 'cc33dd44-5555-6666-7777-888888888888',
      sourcePath: `/Users/test/.pi/agent/sessions/${TAIJI_DIR}/2026-08-01T08-00-00Z_cc33dd44-5555-6666-7777-888888888888.jsonl`,
      cwd: '/Users/test/taiji',
      lastModified: Date.now() - ONE_DAY * 8,
      dirLabel: TAIJI_DIR,
    }),
  ]
}

/**
 * runtime D5 S7 匹配语义模拟：字段集 = name ∪ 完整 sessionId ∪ uuid 前 6 位短 ID ∪
 * sourcePath ∪ dirLabel，全部 case-insensitive includes（过滤发生在 runtime，组件测试
 * 用 mock 复刻同一语义，断言 renderer 的「发 query + 展示过滤结果」协作）。
 */
function matchCandidates(items: ImportCandidate[], query: string): ImportCandidate[] {
  if (!query) return items
  const q = query.toLowerCase()
  return items.filter(
    (c) =>
      (c.name ?? '').toLowerCase().includes(q) ||
      c.sessionId.toLowerCase().includes(q) ||
      c.sessionId.slice(0, 6).toLowerCase().includes(q) ||
      c.sourcePath.toLowerCase().includes(q) ||
      c.dirLabel.toLowerCase().includes(q),
  )
}

/**
 * zcode 源候选 fixture（契约 §3.7：sessionId 保持原始 sess_ 前缀形态——源系统主键；
 * sourcePath = db 路径结构占位，zcode 导入定位走 sessionId 而非 sourcePath）。
 */
function makeZcodeFixture(): ImportCandidate[] {
  return [
    makeCandidate({
      sessionId: 'sess_9d5b3a1f-2e4c-4b8d-a6f0-7c1d9e2b4a88',
      name: '修复构建脚本',
      cwd: '/Users/test/zcode-alpha',
      sourcePath: '/Users/test/.zcode/cli/db/db.sqlite',
      dirLabel: 'zcode-alpha',
      lastModified: Date.now() - 1_000,
    }),
  ]
}

let fixture: ImportCandidate[]
let zcodeFixture: ImportCandidate[]
let wrapper: VueWrapper | null = null

function seedProjects(): void {
  const projectStore = useProjectStore()
  const projects: Project[] = [
    { id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 },
    { id: 'stock-id', name: 'Stock', lastUsedAt: 2 },
    { id: 'beta-id', name: 'Beta', lastUsedAt: 1 },
  ]
  projectStore.projects = projects
  projectStore.activeProjectId = 'stock-id'
}

/**
 * mount 对话框并推进到阶段二候选列表（open=true 触发 resetForOpen 停在来源选择，
 * 再点指定来源选项进入该源列表）。默认 'pi'——存量用例即 pi 缺省路径（V5 零回归测试）。
 */
async function mountDialogAtSource(kind: 'pi' | 'zcode' = 'pi'): Promise<void> {
  wrapper = mount(ImportSessionDialog, {
    props: { open: true },
    attachTo: document.body,
  })
  await flushPromises()
  const option = byTestId(`import-source-option-${kind}`)
  expect(option, `来源选项 ${kind} 应存在`).not.toBeNull()
  await option!.trigger('click')
  await flushPromises()
}

/** mount 后进入 pi 源候选列表（存量用例缺省路径） */
async function mountDialog(): Promise<void> {
  await mountDialogAtSource('pi')
}

/** Dialog 经 reka DialogPortal teleport 到 body：按 testid 从 body 取 DOMWrapper */
function byTestId(testid: string): DOMWrapper<Element> | null {
  const el = document.body.querySelector(`[data-testid="${testid}"]`)
  return el ? new DOMWrapper(el) : null
}

function allByTestId(testid: string): DOMWrapper<Element>[] {
  return Array.from(document.body.querySelectorAll(`[data-testid="${testid}"]`)).map(
    (el) => new DOMWrapper(el),
  )
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

/** DOM 分组结构：按渲染顺序取分组头与其后的条目行文本（分桶归属断言用） */
function groupBuckets(): Array<{ label: string; items: string[] }> {
  const els = Array.from(
    document.body.querySelectorAll('[data-testid="import-group"], [data-testid="import-item"]'),
  )
  const result: Array<{ label: string; items: string[] }> = []
  for (const el of els) {
    if (el.getAttribute('data-testid') === 'import-group') {
      result.push({ label: el.textContent?.trim() ?? '', items: [] })
    } else if (result.length > 0) {
      result[result.length - 1].items.push(el.textContent ?? '')
    }
  }
  return result
}

/** 搜索输入：setValue 触发 query watch → 推进 250ms debounce → 排空 RPC 微任务 */
async function typeSearch(text: string): Promise<void> {
  const input = byTestId('import-search-input')
  expect(input, '搜索框应存在').not.toBeNull()
  await input!.setValue(text)
  await vi.advanceTimersByTimeAsync(IMPORT_SEARCH_DEBOUNCE_MS)
  await flushPromises()
}

/** 点列表条目行（select 高亮） */
async function clickItemRow(index: number): Promise<void> {
  const items = allByTestId('import-item')
  expect(items[index], `import-item[${index}] 应存在`).toBeTruthy()
  await items[index].trigger('click')
  await flushPromises()
}

/** 通过行内按钮发起导入（不经底部确认，sourcePath 直接来自该行候选） */
async function importViaRowButton(index: number): Promise<void> {
  const items = allByTestId('import-item')
  const btn = items[index].find('[data-testid="import-item-import-btn"]')
  expect(btn.exists(), `import-item[${index}] 的导入按钮应存在`).toBe(true)
  await btn.trigger('click')
  await flushPromises()
}

function importErrorWithCode(code: string): Error {
  return Object.assign(new Error(`rpc failure: ${code}`), { code })
}

beforeEach(() => {
  vi.useFakeTimers()
  // 冻结时间基准：2026-09-02（周三）午间——日历周分桶对 fixture 相对偏移恒定
  // （本周 = 周一 8-31 起；离午夜 ±12h，秒级偏移不跨日历日）
  vi.setSystemTime(new Date('2026-09-02T12:00:00'))
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  vi.clearAllMocks()
  fixture = makeFixture()
  zcodeFixture = makeZcodeFixture()
  // 候选 mock 按 payload.source 分发（复刻多源路由：pi 回 pi fixture，zcode 回
  // sess_ 前缀形态候选——两源候选域不同是 selectSource 切源重新拉取断言的语义前提）
  apiMocks.importCandidates.mockImplementation(
    async (req?: { query?: string; source?: string }) => {
      const pool = req?.source === 'zcode' ? zcodeFixture : fixture
      const items = matchCandidates(pool, (req?.query ?? '').trim())
      return {
        total: pool.length,
        items,
        dirs: [
          { label: STOCK_DIR, count: pool.filter((c) => c.dirLabel === STOCK_DIR).length },
          { label: TAIJI_DIR, count: pool.filter((c) => c.dirLabel === TAIJI_DIR).length },
        ],
      }
    },
  )
  apiMocks.importSession.mockImplementation(async (req: { sourcePath: string }) => ({
    sessionId: 'imported-new-session-id',
    targetPath: `/Users/test/.taiji/agent/sessions/${STOCK_DIR}/copied.jsonl`,
    sourcePath: req.sourcePath,
  }))
  // 默认取消（对齐真实 pickDirectory 无 electronAPI 时的降级契约），选中场景用例内覆写
  ipcMocks.pickDirectory.mockResolvedValue({ canceled: true, path: null })
  seedProjects()
})



describe('ImportSessionDialog（U5 验收）', () => {
  it('首屏冒烟：对话框结构元素齐备（观察者视角，含 u7 demo 对齐细节）', async () => {
    await mountDialog()

    for (const testid of [
      'import-session-dialog',
      'import-search-input',
      'import-dir-chip',
      'import-choose-dir-btn',
      'import-item',
      'import-project-select',
      'import-cancel-btn',
      'import-confirm-btn',
    ]) {
      expect(byTestId(testid), `${testid} 应存在`).not.toBeNull()
    }
    // u7 demo 对齐：标题「导入 pi 会话」+ 副标题 + 搜索框 icon / Esc kbd（demo searchbox）
    expect(bodyText()).toContain(zhCN.dialogTitle)
    expect(bodyText()).toContain(zhCN.description)
    expect(byTestId('import-search-input')!.attributes('placeholder')).toBe(zhCN.searchPlaceholder)
    const inputEl = byTestId('import-search-input')!.element as HTMLElement
    expect(inputEl.previousElementSibling?.tagName.toLowerCase()).toBe('svg')
    const kbd = inputEl.parentElement?.querySelector('kbd')
    expect(kbd?.textContent).toBe('Esc')
    expect(bodyText()).toContain(zhCN.importTo)
  })

  describe('验收1：默认列表（选定 pi 来源即拉候选 + 目录分组渲染）', () => {
    it('选定 pi 来源即发候选 RPC（显式 source，无 query），日期四档分组 + 目录 chip + 计数可见', async () => {
      await mountDialog()

      // 构建者：选定来源即拉，payload 显式带 source，无 query（全量）
      expect(apiMocks.importCandidates).toHaveBeenCalledTimes(1)
      expect(apiMocks.importCandidates).toHaveBeenCalledWith({ source: 'pi' })
      // 使用者：5 条候选渲染；目录 chip = 单个「全部目录 ▾」（u7 下拉形态，选项见下一用例）
      expect(allByTestId('import-item')).toHaveLength(5)
      expect(allByTestId('import-dir-chip')).toHaveLength(1)
      expect(byTestId('import-dir-chip')!.text()).toContain(zhCN.allDirs)
      // 条目行可见原工作目录（目录名 dirLabel 已移入下拉菜单，见下一用例）
      expect(bodyText()).toContain('/Users/test/Stock')
      // 观察者：四档分组按序渲染且归属正确——9-01（周二）在本周内但归「昨天」（昨天优先）；
      // 8-31（周一）归「本周」；8-25 归「更早」
      const buckets = groupBuckets()
      expect(buckets.map((b) => b.label)).toEqual([
        zhCN.group.today,
        zhCN.group.yesterday,
        zhCN.group.thisWeek,
        zhCN.group.earlier,
      ])
      expect(buckets[0].items.join(' ')).toContain('clickhouse 日线迁移')
      expect(buckets[1].items.join(' ')).toContain(TAIJI_DIR)
      expect(buckets[2].items.join(' ')).toContain('本周的调优会话')
      expect(buckets[3].items.join(' ')).toContain('更早的 agent 会话')
      // 计数 = 可见 / 总数（全可见时两数相等）
      expect(byTestId('import-count')!.text()).toBe('可见 5 / 共 5')
    })

    it('目录下拉菜单（u7 对齐 demo dir-menu）：选项含全部+各子目录带计数；选子目录过滤列表，选全部恢复', async () => {
      await mountDialog()

      // 打开菜单（Popover 触发）
      await byTestId('import-dir-chip')!.trigger('click')
      await flushPromises()
      const options = allByTestId('import-dir-option')
      // 观察者：菜单项 = 全部目录 + 2 个子目录，每项带计数（全部 = total，子目录 = dirs.count）
      expect(options).toHaveLength(3)
      expect(options[0].text()).toContain(zhCN.allDirs)
      expect(options[0].text()).toContain('5')
      expect(options[1].text()).toContain(STOCK_DIR)
      expect(options[1].text()).toContain('3')
      expect(options[2].text()).toContain(TAIJI_DIR)
      expect(options[2].text()).toContain('2')

      // 使用者：选 taiji 子目录 → 菜单收起、chip 文案切换、列表客户端过滤（不发新 RPC）
      await options[2].trigger('click')
      await flushPromises()
      expect(byTestId('import-dir-menu')).toBeNull()
      expect(byTestId('import-dir-chip')!.text()).toContain(TAIJI_DIR)
      expect(allByTestId('import-item')).toHaveLength(2)
      expect(byTestId('import-count')!.text()).toBe('可见 2 / 共 5')
      expect(bodyText()).not.toContain('clickhouse 日线迁移')
      // 构建者：目录过滤纯客户端，不重复发 RPC
      expect(apiMocks.importCandidates).toHaveBeenCalledTimes(1)

      // 重开菜单选「全部目录」→ 恢复全量
      await byTestId('import-dir-chip')!.trigger('click')
      await flushPromises()
      await allByTestId('import-dir-option')[0].trigger('click')
      await flushPromises()
      expect(allByTestId('import-item')).toHaveLength(5)
      expect(byTestId('import-dir-chip')!.text()).toContain(zhCN.allDirs)
    })
  })

  describe('验收2：搜索过滤三通道（debounce 250ms 后发 query）', () => {
    it('通道一 名称关键词：列表过滤出目标条目', async () => {
      await mountDialog()
      await typeSearch('clickhouse')

      expect(apiMocks.importCandidates).toHaveBeenLastCalledWith({ source: 'pi', query: 'clickhouse' })
      expect(allByTestId('import-item')).toHaveLength(1)
      expect(bodyText()).toContain('clickhouse 日线迁移')
    })

    it('通道二 完整 Session ID / 短 ID（uuid 前 6 位）：各过滤出唯一条目', async () => {
      await mountDialog()

      // 完整 sessionId
      await typeSearch('bb22cc33-4444-5555-6666-777777777777')
      expect(apiMocks.importCandidates).toHaveBeenLastCalledWith({
        source: 'pi',
        query: 'bb22cc33-4444-5555-6666-777777777777',
      })
      expect(allByTestId('import-item')).toHaveLength(1)

      // 短 ID（uuid 前 6 位，pi TUI 式标识）；命中唯一条目，其原工作目录（行2）可见
      await typeSearch('01a044')
      expect(apiMocks.importCandidates).toHaveBeenLastCalledWith({ source: 'pi', query: '01a044' })
      const items = allByTestId('import-item')
      expect(items).toHaveLength(1)
      expect(items[0].text()).toContain('/Users/test/Stock')
    })

    it('通道三 .jsonl 绝对路径前缀：RPC 收到路径 query（形态切路径模式，见验收3）', async () => {
      await mountDialog()
      const pathPrefix = `/Users/test/.pi/agent/sessions/${STOCK_DIR}/2026-08-27`
      await typeSearch(pathPrefix)

      expect(apiMocks.importCandidates).toHaveBeenLastCalledWith({ source: 'pi', query: pathPrefix })
    })

    it('清空搜索立即回全量（不走 debounce）', async () => {
      await mountDialog()
      await typeSearch('clickhouse')
      expect(allByTestId('import-item')).toHaveLength(1)

      const input = byTestId('import-search-input')!
      await input.setValue('')
      await flushPromises()

      expect(allByTestId('import-item')).toHaveLength(5)
    })
  })

  describe('验收3：路径模式切换（query 以 / ~ 开头）', () => {
    it('输入绝对路径：分组列表隐藏，路径行展示命中元信息，「导入此文件」直达导入', async () => {
      await mountDialog()
      const fullPath = fixture[0].sourcePath
      await typeSearch(fullPath)

      // 观察者：形态切换——列表隐藏、路径行出现
      expect(byTestId('import-path-bar')).not.toBeNull()
      expect(allByTestId('import-item')).toHaveLength(0)
      // 使用者：路径行展示 query 与命中元信息（大小 · 相对时间）
      const bar = byTestId('import-path-bar')!
      expect(bar.text()).toContain(fullPath)
      expect(bar.find('[data-testid="import-path-meta"]').text()).toContain('7.7 MB')
      const btn = bar.find('[data-testid="import-path-import-btn"]')
      expect(btn.attributes('disabled')).toBeUndefined()

      // 构建者：路径行按钮直达导入，payload.sourcePath = 命中条目
      await btn.trigger('click')
      await flushPromises()
      expect(apiMocks.importSession).toHaveBeenCalledWith({
        source: 'pi',
        sourcePath: fullPath,
        projectId: 'stock-id',
      })
    })

    it('路径未命中任何候选：显示「未找到匹配」+ 按钮禁用', async () => {
      await mountDialog()
      await typeSearch('/nonexistent/path/other.jsonl')

      const bar = byTestId('import-path-bar')!
      expect(bar.find('[data-testid="import-path-meta"]').text()).toContain(zhCN.pathNoMatch)
      expect(bar.find('[data-testid="import-path-import-btn"]').attributes('disabled')).toBeDefined()
    })

    it('路径命中已导入候选：「导入此文件」禁用（不重复导入）', async () => {
      await mountDialog()
      await typeSearch(fixture[1].sourcePath)

      const bar = byTestId('import-path-bar')!
      expect(bar.text()).toContain(fixture[1].sourcePath)
      expect(bar.find('[data-testid="import-path-import-btn"]').attributes('disabled')).toBeDefined()
    })

    it('~ 开头同样进入路径模式；退出（清空 query）恢复分组列表', async () => {
      await mountDialog()
      const input = byTestId('import-search-input')!
      await input.setValue('~/sessions/some.jsonl')
      await flushPromises()

      expect(byTestId('import-path-bar')).not.toBeNull()
      expect(allByTestId('import-item')).toHaveLength(0)

      await input.setValue('')
      await flushPromises()
      expect(byTestId('import-path-bar')).toBeNull()
      expect(allByTestId('import-item')).toHaveLength(5)
    })
  })

  describe('验收4：已导入候选项禁用 / 不可重复导入', () => {
    it('已导入条目：徽标可见 + 行按钮禁用 + 点击不触发导入 RPC', async () => {
      await mountDialog()

      // fixture[1] = alreadyImported 条目
      const importedRow = allByTestId('import-item').find((r) => r.text().includes('已导入的调研'))
      expect(importedRow, '已导入条目应渲染').toBeTruthy()

      // 观察者：徽标 + 半透明降维
      expect(importedRow!.find('[data-testid="import-item-imported"]').exists()).toBe(true)
      expect(importedRow!.find('[data-testid="import-item-imported"]').text()).toBe(zhCN.importedBadge)
      expect(importedRow!.classes()).toContain('opacity-50')
      // 使用者：行内导入按钮禁用
      const rowBtn = importedRow!.find('[data-testid="import-item-import-btn"]')
      expect(rowBtn.attributes('disabled')).toBeDefined()
      await rowBtn.trigger('click')
      await flushPromises()
      // 构建者：composable alreadyImported 检查兜底（disabled 吞 click 或检查 return，均不得发 RPC）
      expect(apiMocks.importSession).not.toHaveBeenCalled()
    })

    it('选中已导入条目后底部「导入」仍禁用（canConfirm 含 alreadyImported）', async () => {
      await mountDialog()
      await clickItemRow(1)

      expect(byTestId('import-confirm-btn')!.attributes('disabled')).toBeDefined()
    })
  })

  describe('验收5：选目标 project（默认当前激活，可改）', () => {
    // reka Select 打开依赖其内部 setTimeout（open 状态推进），fake timers 会冻结在
    // closed——本组用例不涉 debounce，切真实 timers（describe 级 hook 晚于文件级执行）
    beforeEach(() => {
      vi.useRealTimers()
    })

    it('打开即默认当前激活 project（trigger 可见），下拉含全部 project', async () => {
      await mountDialog()

      // 使用者：trigger 常显当前激活 project（SelectValue 自算名，不依赖下拉打开）
      expect(byTestId('import-project-select')!.text()).toContain('Stock')

      // 打开下拉（reka SelectTrigger 在 pointerdown 打开，happy-dom 需显式 dispatch）
      const trigger = byTestId('import-project-select')!.element as HTMLElement
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      trigger.click()
      await flushPromises()

      const options = Array.from(document.body.querySelectorAll('[role="option"]')).map(
        (el) => el.textContent ?? '',
      )
      expect(options).toContain('Stock')
      expect(options).toContain('Beta')
      expect(options).toContain(zhCN.defaultProjectName)
    })

    it('下拉改选 Beta → 导入 payload.projectId 跟随新目标', async () => {
      await mountDialog()

      const trigger = byTestId('import-project-select')!.element as HTMLElement
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      trigger.click()
      await flushPromises()

      const beta = Array.from(document.body.querySelectorAll('[role="option"]')).find((el) =>
        (el.textContent ?? '').includes('Beta'),
      )
      expect(beta, 'Beta option 应存在').toBeTruthy()
      beta!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      beta!.click()
      await flushPromises()

      // 使用者：trigger 显示新目标
      expect(byTestId('import-project-select')!.text()).toContain('Beta')

      await importViaRowButton(0)
      expect(apiMocks.importSession).toHaveBeenCalledWith({
        source: 'pi',
        sourcePath: fixture[0].sourcePath,
        projectId: 'beta-id',
      })
    })

    it('不改动时导入走默认（当前激活 project）', async () => {
      await mountDialog()
      await importViaRowButton(0)

      expect(apiMocks.importSession).toHaveBeenCalledWith({
        source: 'pi',
        sourcePath: fixture[0].sourcePath,
        projectId: 'stock-id',
      })
    })
  })

  describe('验收6：导入成功 emit + 结果 toast（u7：info 成功 / warning 预警合并）', () => {
    it('无预警的成功：toast.info 展示「已导入「名」到 project · 可继续对话」，不走 warning/error', async () => {
      await mountDialog()

      await importViaRowButton(0)

      // 使用者：成功 toast 可见（info 命令回显通道）
      expect(toastMocks.info).toHaveBeenCalledTimes(1)
      expect(toastMocks.info).toHaveBeenCalledWith(
        zhCN.toastImported.replace('{name}', 'clickhouse 日线迁移').replace('{project}', 'Stock'),
      )
      expect(toastMocks.warning).not.toHaveBeenCalled()
      expect(toastMocks.error).not.toHaveBeenCalled()
      // 构建者：emit 单 payload 对象（项目规则：emit 只传单 payload）
      const imported = wrapper!.emitted('imported')
      expect(imported).toHaveLength(1)
      expect(imported![0][0]).toMatchObject({
        sessionId: 'imported-new-session-id',
        sessionName: 'clickhouse 日线迁移',
        projectName: 'Stock',
      })
      expect(imported![0][0]).not.toHaveProperty('warning', 'sidecar_failed')
    })

    it('无名称候选（cwd 正常）：toast 显示名回退短 ID（uuid 前 6 位，目录编码名不可读），走 info 通道', async () => {
      // 单条 name=null + cwdExists=true 候选：无预警 → info 通道 + 短 ID 回退
      apiMocks.importCandidates.mockImplementationOnce(async () => ({
        total: 1,
        items: [makeCandidate({ name: null, cwdExists: true })],
        dirs: [],
      }))
      await mountDialog()

      await importViaRowButton(0)

      expect(toastMocks.info).toHaveBeenCalledWith(
        zhCN.toastImported.replace('{name}', '01a044').replace('{project}', 'Stock'),
      )
      expect(toastMocks.warning).not.toHaveBeenCalled()
    })

    it('name/dirLabel 均空（根顶层文件）：emit sessionName 回退短 ID（uuid 前 6 位）', async () => {
      // 顶层文件 dirLabel=''：sessionName 三级回退（name || dirLabel || 短 ID）落到末级
      apiMocks.importCandidates.mockImplementationOnce(async () => ({
        total: 1,
        items: [makeCandidate({ name: null, dirLabel: '' })],
        dirs: [],
      }))
      await mountDialog()

      await importViaRowButton(0)

      const imported = wrapper!.emitted('imported')
      expect(imported).toHaveLength(1)
      expect(imported![0][0]).toMatchObject({
        sessionId: 'imported-new-session-id',
        sessionName: '01a044',
      })
    })

    it('sidecar_failed warning：成功文案 + 降级预警合并单条 warning toast（非 error），emit payload 携带 warning', async () => {
      await mountDialog()
      apiMocks.importSession.mockResolvedValueOnce({
        sessionId: 'sid-new',
        targetPath: '/target/copied.jsonl',
        warning: 'sidecar_failed',
      })

      await importViaRowButton(0)

      // 使用者：一条 warning toast 同时含成功文案与恢复指引（一次导入一个结果块）
      expect(toastMocks.warning).toHaveBeenCalledTimes(1)
      const warned = toastMocks.warning.mock.calls[0][0] as string
      expect(warned).toContain('clickhouse 日线迁移')
      expect(warned).toContain(zhCN.toastWarnSidecar)
      expect(warned.indexOf('可继续对话')).toBeLessThan(warned.indexOf(zhCN.toastWarnSidecar))
      expect(toastMocks.info).not.toHaveBeenCalled()
      expect(toastMocks.error).not.toHaveBeenCalled()
      // 构建者：emit 单 payload 对象
      const imported = wrapper!.emitted('imported')
      expect(imported).toHaveLength(1)
      expect(imported![0]).toEqual([
        {
          sessionId: 'sid-new',
          sessionName: 'clickhouse 日线迁移',
          projectName: 'Stock',
          targetPath: '/target/copied.jsonl',
          warning: 'sidecar_failed',
        },
      ])
      // 对话框请求父层关闭（v-model:open 收尾）
      const openEvents = wrapper!.emitted('update:open')
      expect(openEvents?.[openEvents.length - 1]).toEqual([false])
    })

    it('死 cwd（cwdExists=false，V9）：toast 追加「原目录不存在」预警（warning 通道）', async () => {
      await mountDialog()

      // fixture[2] cwdExists=false（原目录不存在的降级场景）
      await importViaRowButton(2)

      expect(toastMocks.warning).toHaveBeenCalledTimes(1)
      const warned = toastMocks.warning.mock.calls[0][0] as string
      expect(warned).toContain(zhCN.toastImported.replace('{name}', 'bb22cc').replace('{project}', 'Stock'))
      expect(warned).toContain(zhCN.cwdMissing)
      expect(toastMocks.info).not.toHaveBeenCalled()
    })

    it('死 cwd + sidecar_failed 双预警：合并同一条 warning（分号分隔，两条预警均可见）', async () => {
      await mountDialog()
      apiMocks.importSession.mockResolvedValueOnce({
        sessionId: 'sid-both',
        targetPath: '/target/both.jsonl',
        warning: 'sidecar_failed',
      })

      await importViaRowButton(2)

      expect(toastMocks.warning).toHaveBeenCalledTimes(1)
      const warned = toastMocks.warning.mock.calls[0][0] as string
      expect(warned).toContain(zhCN.cwdMissing)
      expect(warned).toContain(zhCN.toastWarnSidecar)
      expect(warned).toContain('bb22cc')
    })

    it('导入进行中：按钮呈导入中态并禁用；完成后关闭', async () => {
      await mountDialog()
      let resolveImport: (v: { sessionId: string; targetPath: string }) => void = () => {}
      apiMocks.importSession.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveImport = resolve
          }),
      )

      const rowBtn = allByTestId('import-item')[0].find('[data-testid="import-item-import-btn"]')
      await rowBtn.trigger('click')
      await flushPromises()

      // 使用者：进行中态（文案 + 禁用，防双击连点）
      const confirm = byTestId('import-confirm-btn')!
      expect(confirm.text()).toContain(zhCN.importing)
      expect(confirm.attributes('disabled')).toBeDefined()

      resolveImport({ sessionId: 'sid-p', targetPath: '/target/p.jsonl' })
      await flushPromises()
      const openEvents = wrapper!.emitted('update:open')
      expect(openEvents?.[openEvents.length - 1]).toEqual([false])
    })
  })

  describe('验收7：错误内联恢复指引（error envelope code → 文案）', () => {
    it.each([
      'import_source_missing',
      'import_invalid_session',
      'import_marker_filename',
      'import_dir_unreadable',
      'import_already_imported',
      'import_target_conflict',
      'import_copy_failed',
      'import_project_invalid',
      'timeout',
    ])('%s：内联展示对应恢复指引文案，对话框不关', async (code) => {
      await mountDialog()
      apiMocks.importSession.mockRejectedValueOnce(importErrorWithCode(code))

      await importViaRowButton(0)

      // 使用者：错误内联可见且等于 i18n 文案（每条文案都含「后重试/请」恢复动作）
      const errorEl = byTestId('import-error')
      expect(errorEl, 'import-error 元素应存在').not.toBeNull()
      expect(errorEl!.text()).toBe(zhCN.errors[code as keyof typeof zhCN.errors])
      // 失败不关闭对话框（可继续操作 / 重试）
      expect(wrapper!.emitted('update:open')).toBeUndefined()
    })

    it('未识别 code 归一化为 unknown 文案；无 code 同样兜底', async () => {
      await mountDialog()
      apiMocks.importSession.mockRejectedValueOnce(importErrorWithCode('weird_unlisted'))

      await importViaRowButton(0)
      expect(byTestId('import-error')!.text()).toBe(zhCN.errors.unknown)
    })

    it('import_already_imported 文案含「侧边栏可直接打开」引导（错误规格表恢复指引列）', () => {
      expect(zhCN.errors.import_already_imported).toContain('侧边栏可直接打开')
    })

    it('错误后可重试导入（按钮恢复可用）', async () => {
      await mountDialog()
      apiMocks.importSession.mockRejectedValueOnce(importErrorWithCode('import_copy_failed'))
      await importViaRowButton(0)
      expect(byTestId('import-error')).not.toBeNull()

      apiMocks.importSession.mockResolvedValueOnce({ sessionId: 'sid-ok', targetPath: '/t/ok.jsonl' })
      await importViaRowButton(0)
      expect(wrapper!.emitted('imported')).toHaveLength(1)
    })
  })

  describe('验收8：cwdExists=false 标注（原目录不存在的降级提示）', () => {
    it('原目录不存在的条目：「原目录不存在」标注可见；正常条目无标注', async () => {
      await mountDialog()

      const missingRow = allByTestId('import-item').find((r) => r.text().includes(TAIJI_DIR))
      expect(missingRow, 'cwdExists=false 条目应渲染').toBeTruthy()

      // 使用者：降级标注可见（用户知情，无静默语义漂移）
      const badge = missingRow!.find('[data-testid="import-item-cwd-missing"]')
      expect(badge.exists()).toBe(true)
      expect(badge.text()).toBe(zhCN.cwdMissing)

      // 观察者：cwdExists=true 条目不渲染标注
      const normalRow = allByTestId('import-item').find((r) => r.text().includes('clickhouse 日线迁移'))
      expect(normalRow!.find('[data-testid="import-item-cwd-missing"]').exists()).toBe(false)
    })
  })

  describe('验收9：目录切换（V8「选择其他目录」）', () => {
    const CUSTOM_ROOT = '/Users/test/custom-sessions'
    const CUSTOM_DIR = '--Users-test-custom-sessions--'

    /** 新根 fixture（V8 场景：只有少量 session 的目录） */
    function makeCustomFixture(): ImportCandidate[] {
      return [
        makeCandidate({
          name: '其他目录的会话',
          sessionId: 'ddee0011-1111-2222-3333-444444444444',
          sourcePath: `${CUSTOM_ROOT}/${CUSTOM_DIR}/2026-08-28T10-00-00Z_ddee0011-1111-2222-3333-444444444444.jsonl`,
          lastModified: Date.now(),
          dirLabel: CUSTOM_DIR,
        }),
      ]
    }

    /** 点「选择其他目录」按钮（触发 pickDirectory → 选中后切根重新拉取） */
    async function clickChooseDir(): Promise<void> {
      const btn = byTestId('import-choose-dir-btn')
      expect(btn, '「选择其他目录」按钮应存在').not.toBeNull()
      await btn!.trigger('click')
      await flushPromises()
    }

    it('选中目录：RPC 带新 rootDir 重载，当前根可见 + 列表/dirs/chip/计数更新', async () => {
      await mountDialog()
      const customFixture = makeCustomFixture()
      apiMocks.importCandidates.mockImplementationOnce(async () => ({
        total: customFixture.length,
        items: customFixture,
        dirs: [{ label: CUSTOM_DIR, count: customFixture.length }],
      }))
      ipcMocks.pickDirectory.mockResolvedValueOnce({ canceled: false, path: CUSTOM_ROOT })

      await clickChooseDir()

      // 构建者：目录选择器被调（标题文案）+ RPC 收到新 rootDir（缺省根时 payload 不含该字段）
      expect(ipcMocks.pickDirectory).toHaveBeenCalledTimes(1)
      expect(ipcMocks.pickDirectory).toHaveBeenCalledWith({ title: zhCN.chooseDirTitle })
      expect(apiMocks.importCandidates).toHaveBeenLastCalledWith({ source: 'pi', rootDir: CUSTOM_ROOT })
      // 使用者：当前扫描根可见（chip 区更新）+ 按钮仍在
      expect(byTestId('import-root-dir')!.text()).toBe(CUSTOM_ROOT)
      expect(bodyText()).toContain(zhCN.chooseDirBtn)
      // 列表重载为新根数据：1 条 + 目录菜单只含新子目录（u7：全部 + 1 项）+ 计数正确
      expect(allByTestId('import-item')).toHaveLength(1)
      expect(bodyText()).toContain('其他目录的会话')
      await byTestId('import-dir-chip')!.trigger('click')
      await flushPromises()
      const options = allByTestId('import-dir-option')
      expect(options).toHaveLength(2)
      expect(options[0].text()).toContain(zhCN.allDirs)
      expect(options[1].text()).toContain(CUSTOM_DIR)
      expect(options[1].text()).toContain('1')
      expect(byTestId('import-count')!.text()).toBe('可见 1 / 共 1')
    })

    it('取消选择：无重载（RPC 次数不变），扫描根保持默认', async () => {
      await mountDialog()
      const callsBefore = apiMocks.importCandidates.mock.calls.length
      ipcMocks.pickDirectory.mockResolvedValueOnce({ canceled: true, path: null })

      await clickChooseDir()

      expect(apiMocks.importCandidates).toHaveBeenCalledTimes(callsBefore)
      expect(byTestId('import-root-dir')).toBeNull()
    })

    it('切换根后搜索：payload 同时带 rootDir + query（搜索词跨根保留）', async () => {
      await mountDialog()
      ipcMocks.pickDirectory.mockResolvedValueOnce({ canceled: false, path: CUSTOM_ROOT })
      await clickChooseDir()

      await typeSearch('clickhouse')

      expect(apiMocks.importCandidates).toHaveBeenLastCalledWith({
        source: 'pi',
        rootDir: CUSTOM_ROOT,
        query: 'clickhouse',
      })
    })

    it('关闭重开：扫描根回到默认（重开停在来源选择，重进 pi 后 RPC 不带 rootDir）', async () => {
      await mountDialog()
      ipcMocks.pickDirectory.mockResolvedValueOnce({ canceled: false, path: CUSTOM_ROOT })
      await clickChooseDir()
      expect(byTestId('import-root-dir')).not.toBeNull()

      await wrapper!.setProps({ open: false })
      await flushPromises()
      await wrapper!.setProps({ open: true })
      await flushPromises()
      // 重开回到阶段一来源选择（视图态与扫描根同步重置）
      expect(byTestId('import-source-picker')).not.toBeNull()
      const option = byTestId('import-source-option-pi')!
      await option.trigger('click')
      await flushPromises()

      expect(byTestId('import-root-dir')).toBeNull()
      expect(apiMocks.importCandidates).toHaveBeenLastCalledWith({ source: 'pi' })
    })
  })

  describe('验收10：候选加载失败内联恢复指引（candidates RPC 错误码不再被吞）', () => {
    it('import_dir_unreadable：按码展示目录权限恢复指引 + 重试按钮（V6 场景可达内联指引）', async () => {
      apiMocks.importCandidates.mockImplementationOnce(() =>
        Promise.reject(importErrorWithCode('import_dir_unreadable')),
      )
      await mountDialog()

      // 使用者：失败态展示码专属恢复指引（含「选择其他目录」出路），非通用失败文案
      const errorEl = byTestId('import-load-error')
      expect(errorEl, 'import-load-error 元素应存在').not.toBeNull()
      expect(errorEl!.text()).toBe(zhCN.errors.import_dir_unreadable)
      expect(errorEl!.text()).not.toBe(zhCN.loadFailed)
      expect(byTestId('import-retry-btn')).not.toBeNull()
    })

    it('表外兜底码（import_failed）：default 分支走通用失败文案 + 重试', async () => {
      apiMocks.importCandidates.mockImplementationOnce(() =>
        Promise.reject(importErrorWithCode('import_failed')),
      )
      await mountDialog()

      expect(byTestId('import-load-error')!.text()).toBe(zhCN.loadFailed)
      expect(byTestId('import-retry-btn')).not.toBeNull()
    })

    it('加载失败后点重试：恢复列表展示（错误态可恢复）', async () => {
      apiMocks.importCandidates.mockImplementationOnce(() =>
        Promise.reject(importErrorWithCode('import_dir_unreadable')),
      )
      await mountDialog()
      expect(byTestId('import-load-error')).not.toBeNull()

      await byTestId('import-retry-btn')!.trigger('click')
      await flushPromises()

      expect(byTestId('import-load-error')).toBeNull()
      expect(allByTestId('import-item')).toHaveLength(5)
    })
  })

  describe('验收11：条目行2 显示原工作目录（cwd）', () => {
    it('行2 展示 cwd；sourcePath 降级为行 title tooltip（悬停可看全路径）', async () => {
      await mountDialog()

      const row = allByTestId('import-item').find((r) =>
        r.text().includes('clickhouse 日线迁移'),
      )!
      expect(row, '目标条目应渲染').toBeTruthy()
      // 使用者：行2 可见原工作目录
      expect(row.text()).toContain('/Users/test/Stock')
      // 观察者：源文件全路径不再占行2 文本位，转由 title 提供
      expect(row.text()).not.toContain('.pi/agent/sessions')
      expect(row.attributes('title')).toBe(fixture[0].sourcePath)
    })
  })

  describe('验收12：计数「可见 N / 共 total」（截断提示）', () => {
    it('items 被截断（可见 < total）：计数自然呈现截断事实', async () => {
      apiMocks.importCandidates.mockImplementationOnce(async () => ({
        total: 4615,
        items: fixture.slice(0, 3),
        dirs: [],
      }))
      await mountDialog()

      expect(allByTestId('import-item')).toHaveLength(3)
      expect(byTestId('import-count')!.text()).toBe('可见 3 / 共 4615')
    })
  })

  describe('验收14：u7 demo 对齐走查（骨架屏 + 空态两条出路）', () => {
    it('加载态：骨架屏占位（demo §4「不用转圈」）——三行三段 animate-pulse 块，无加载文本', async () => {
      // pending 中的 RPC：loading 常驻直到 resolve（flushPromises 不推进未决 promise）
      apiMocks.importCandidates.mockImplementationOnce(() => new Promise(() => {}))
      await mountDialog()

      const skeleton = byTestId('import-loading')
      expect(skeleton, '骨架屏容器应存在').not.toBeNull()
      expect(skeleton!.attributes('aria-busy')).toBe('true')
      // 观察者：3 行 × 3 段占位块（icon 块 / 标题行 / 尾部元信息块），shimmer 动画
      const bars = skeleton!.findAll('.animate-pulse')
      expect(bars).toHaveLength(9)
      expect(document.body.textContent).not.toContain('加载中')
    })

    it('空结果：两条出路可见——换关键词 / 粘贴 .jsonl 绝对路径（demo empty 形态）', async () => {
      await mountDialog()
      await typeSearch('zzz-不存在的关键词')

      expect(allByTestId('import-item')).toHaveLength(0)
      const empty = byTestId('import-empty')
      expect(empty, '空态容器应存在').not.toBeNull()
      // 使用者：主文案 + 出路提示（引导到路径粘贴通道）
      expect(empty!.text()).toContain(zhCN.emptyTitle)
      expect(empty!.text()).toContain(zhCN.emptyHint)
    })
  })

  describe('验收15：两阶段视图（来源选择 → 候选列表 → 返回重选）', () => {
    /** 裸 mount（停在阶段一，不点来源）——阶段一专用断言用 */
    async function mountAtSourcePhase(): Promise<void> {
      wrapper = mount(ImportSessionDialog, {
        props: { open: true },
        attachTo: document.body,
      })
      await flushPromises()
    }

    it('打开停在阶段一：两来源选项 + 各自说明可见，列表/搜索/导入按钮不可见，未发候选 RPC', async () => {
      await mountAtSourcePhase()

      // 观察者：阶段一标题 + 两选项（标题 + 来源说明一句）
      expect(byTestId('import-source-picker')).not.toBeNull()
      expect(bodyText()).toContain(zhCN.pickSourceTitle)
      expect(bodyText()).toContain(zhCN.pickSourceDescription)
      const piOption = byTestId('import-source-option-pi')!
      const zcodeOption = byTestId('import-source-option-zcode')!
      expect(piOption.text()).toContain(zhCN.sourcePiTitle)
      expect(piOption.text()).toContain(zhCN.sourcePiDesc)
      expect(zcodeOption.text()).toContain(zhCN.sourceZcodeTitle)
      expect(zcodeOption.text()).toContain(zhCN.sourceZcodeDesc)
      // 阶段二专属元素不可见（搜索框 / 候选列表 / 底部导入确认）
      expect(byTestId('import-search-input')).toBeNull()
      expect(allByTestId('import-item')).toHaveLength(0)
      expect(byTestId('import-confirm-btn')).toBeNull()
      // 构建者：选定来源前零 RPC（resetForOpen 不首次拉取，阶段一是纯选择视图）
      expect(apiMocks.importCandidates).not.toHaveBeenCalled()
    })

    it('选 pi → 阶段二：返回按钮可见，RPC 带 source=pi（缺省路径行为不变）', async () => {
      await mountAtSourcePhase()
      await byTestId('import-source-option-pi')!.trigger('click')
      await flushPromises()

      // 观察者：阶段一隐藏、阶段二元素可见（返回入口 + 列表 + pi 标题）
      expect(byTestId('import-source-picker')).toBeNull()
      expect(byTestId('import-back-btn')!.text()).toContain(zhCN.backToSource)
      expect(bodyText()).toContain(zhCN.dialogTitle)
      expect(allByTestId('import-item')).toHaveLength(5)
      // 构建者：payload 显式 source=pi，无 rootDir/query
      expect(apiMocks.importCandidates).toHaveBeenCalledTimes(1)
      expect(apiMocks.importCandidates).toHaveBeenCalledWith({ source: 'pi' })
    })

    it('选 zcode → 阶段二：RPC 带 source=zcode，zcode 标题可见，「选择其他目录」不显示（换根 out-of-scope）', async () => {
      await mountDialogAtSource('zcode')

      // 观察者：zcode 专属标题 + 候选可见 + 无换根按钮（pi 阶段该按钮存在，见验收9）
      expect(bodyText()).toContain(zhCN.zcodeDialogTitle)
      expect(allByTestId('import-item')).toHaveLength(1)
      expect(allByTestId('import-item')[0].text()).toContain('修复构建脚本')
      expect(byTestId('import-choose-dir-btn')).toBeNull()
      // 构建者：候选 RPC 显式 source=zcode
      expect(apiMocks.importCandidates).toHaveBeenCalledWith({ source: 'zcode' })
    })

    it('zcode 候选导入：payload 带 source+sessionId（原始 sess_ 形态，非 sourcePath 定位语义）', async () => {
      await mountDialogAtSource('zcode')
      await importViaRowButton(0)

      // 构建者：zcode 导入按契约带 sessionId（源系统主键原始形态）+ source；
      // sourcePath 仅契约必填占位（runtime zcode 分支不消费）
      expect(apiMocks.importSession).toHaveBeenCalledWith({
        source: 'zcode',
        sessionId: 'sess_9d5b3a1f-2e4c-4b8d-a6f0-7c1d9e2b4a88',
        sourcePath: zcodeFixture[0].sourcePath,
        projectId: 'stock-id',
      })
      // 使用者：成功 toast（zcode 候选名可见）+ imported emit
      expect(toastMocks.info).toHaveBeenCalledTimes(1)
      expect(wrapper!.emitted('imported')).toHaveLength(1)
    })

    it('返回重选：回到阶段一列表隐藏；重进同源不重新拉取（RPC 次数不变），切源重新拉取 source 跟随', async () => {
      await mountDialog() // pi 阶段二（RPC #1）
      expect(apiMocks.importCandidates).toHaveBeenCalledTimes(1)

      await byTestId('import-back-btn')!.trigger('click')
      await flushPromises()
      // 观察者：阶段一可见、候选列表隐藏
      expect(byTestId('import-source-picker')).not.toBeNull()
      expect(allByTestId('import-item')).toHaveLength(0)

      // 重进同源：候选保留（数据不闪）——不重发 RPC
      await byTestId('import-source-option-pi')!.trigger('click')
      await flushPromises()
      expect(apiMocks.importCandidates).toHaveBeenCalledTimes(1)
      expect(allByTestId('import-item')).toHaveLength(5)

      // 切源：重新拉取 + source=zcode
      await byTestId('import-back-btn')!.trigger('click')
      await byTestId('import-source-option-zcode')!.trigger('click')
      await flushPromises()
      expect(apiMocks.importCandidates).toHaveBeenCalledTimes(2)
      expect(apiMocks.importCandidates).toHaveBeenLastCalledWith({ source: 'zcode' })
      expect(allByTestId('import-item')).toHaveLength(1)
    })

    it('zcode 错误文案：import_source_missing 显示 zcode 特化恢复指引（未装库场景，§3.6）', async () => {
      apiMocks.importSession.mockRejectedValueOnce(importErrorWithCode('import_source_missing'))
      await mountDialogAtSource('zcode')

      await importViaRowButton(0)

      // 使用者：同码不同义——zcode 文案指向「确认已安装 zcode」（pi 文案的「选择其他
      // 目录」对 zcode 是死路指引）
      const errorEl = byTestId('import-error')!
      expect(errorEl.text()).toBe(zhCN.errorsZcode.import_source_missing)
      expect(errorEl.text()).not.toBe(zhCN.errors.import_source_missing)
      // 失败不关闭对话框（可重试）
      expect(wrapper!.emitted('update:open')).toBeUndefined()
    })

    it('zcode 错误文案：import_target_conflict 显示 zcode 特化恢复指引（§3.6——库内会话无「原始文件名」可选）', async () => {
      apiMocks.importSession.mockRejectedValueOnce(importErrorWithCode('import_target_conflict'))
      await mountDialogAtSource('zcode')

      await importViaRowButton(0)

      // 使用者：同码不同义——pi 文案引导「改用原始文件名」对 sqlite 库内会话不可执行，
      // zcode 指引联系反馈（罕见场景，换目标 project 不影响本错误）
      const errorEl = byTestId('import-error')!
      expect(errorEl.text()).toBe(zhCN.errorsZcode.import_target_conflict)
      expect(errorEl.text()).not.toBe(zhCN.errors.import_target_conflict)
      // 失败不关闭对话框（可重试）
      expect(wrapper!.emitted('update:open')).toBeUndefined()
    })

    it('conversion_degraded warning：成功 toast 追加 droppedCount 计数汇总「已跳过 N 条」（单条 warning）', async () => {
      apiMocks.importSession.mockResolvedValueOnce({
        sessionId: '9d5b3a1f-2e4c-4b8d-a6f0-7c1d9e2b4a88',
        targetPath: '/mock/taiji/sessions/zcode-demo/9d5b3a1f.jsonl',
        warning: 'conversion_degraded',
        degradationSummary: { droppedCount: 36, unclassified: null },
      })
      await mountDialogAtSource('zcode')

      await importViaRowButton(0)

      // 使用者：一条 warning toast 同时含成功文案与 L1/L2 计数汇总行
      expect(toastMocks.warning).toHaveBeenCalledTimes(1)
      const warned = toastMocks.warning.mock.calls[0][0] as string
      expect(warned).toContain('修复构建脚本')
      expect(warned).toContain(zhCN.toastWarnDropped.replace('{count}', '36'))
      expect(toastMocks.info).not.toHaveBeenCalled()
      expect(toastMocks.error).not.toHaveBeenCalled()
      // 构建者：emit payload 携带 warning + degradationSummary（消费方可选消费）
      const imported = wrapper!.emitted('imported')!
      expect(imported[0][0]).toMatchObject({
        warning: 'conversion_degraded',
        degradationSummary: { droppedCount: 36, unclassified: null },
      })
    })

    it('conversion_unclassified warning：成功 toast 追加「N 条无法分类」计数 + 首条 sample（messageId + preview），单条 warning', async () => {
      apiMocks.importSession.mockResolvedValueOnce({
        sessionId: '9d5b3a1f-2e4c-4b8d-a6f0-7c1d9e2b4a88',
        targetPath: '/mock/taiji/sessions/zcode-demo/9d5b3a1f.jsonl',
        warning: 'conversion_unclassified',
        degradationSummary: {
          droppedCount: 0,
          unclassified: {
            count: 2,
            firstSample: {
              messageId: 'msg_unclassified_01',
              preview: '未来版本引入的未知 kind 消息原文截断示例',
            },
          },
        },
      })
      await mountDialogAtSource('zcode')

      await importViaRowButton(0)

      // 使用者：一条 warning toast 同时含成功文案、L4 计数行与首条定位样本（A3 数据源 =
      // degradationSummary.unclassified——计数 + sample messageId 均可见，供升级重导/反馈）
      expect(toastMocks.warning).toHaveBeenCalledTimes(1)
      const warned = toastMocks.warning.mock.calls[0][0] as string
      expect(warned).toContain('修复构建脚本')
      expect(warned).toContain(zhCN.toastWarnUnclassified.replace('{count}', '2'))
      expect(warned).toContain(
        zhCN.toastUnclassifiedSample
          .replace('{messageId}', 'msg_unclassified_01')
          .replace('{preview}', '未来版本引入的未知 kind 消息原文截断示例'),
      )
      expect(warned.indexOf('可继续对话')).toBeLessThan(warned.indexOf('msg_unclassified_01'))
      expect(toastMocks.info).not.toHaveBeenCalled()
      expect(toastMocks.error).not.toHaveBeenCalled()
      // 构建者：emit payload 携带 warning + degradationSummary
      const imported = wrapper!.emitted('imported')!
      expect(imported[0][0]).toMatchObject({
        warning: 'conversion_unclassified',
        degradationSummary: {
          droppedCount: 0,
          unclassified: {
            count: 2,
            firstSample: {
              messageId: 'msg_unclassified_01',
              preview: '未来版本引入的未知 kind 消息原文截断示例',
            },
          },
        },
      })
    })
  })

  it('取消按钮：emit update:open false（父层收尾关闭）', async () => {
    await mountDialog()
    await byTestId('import-cancel-btn')!.trigger('click')

    const openEvents = wrapper!.emitted('update:open')
    expect(openEvents?.[openEvents.length - 1]).toEqual([false])
  })
})

// ======================================================================
// ← RenameSessionDialog.test.ts
// ======================================================================

/** 辅助：构造最小 SessionSummary（cast 补齐可选字段，测试代码可接受） */
function mkSession(id: string, label: string): SessionSummary {
  return { id, label, cwd: '/x', status: 'idle' } as SessionSummary
}

/** i18n 文案（zh-CN locale 断言，vitest-i18n-setup mock 取值） */
const MSG_REQUIRED = '请输入名称'
const MSG_MAX_LENGTH = '名称不能超过 60 个字符'
const MSG_PATTERN = '不允许换行符，最大 60 个字符'
const MAX_LABEL_LENGTH = 60

let wrapper_m2: VueWrapper | null = null

/** mount 对话框（open=true 触发 resetState 聚焦），目标 session 名 = '旧名称' */
async function mountDialog_m2(): Promise<void> {
  const sessionStore = useSessionStore()
  sessionStore.appendSession(mkSession('s1', '旧名称'))
  wrapper_m2 = mount(RenameSessionDialog, {
    props: { open: true, sessionId: 's1' },
    attachTo: document.body,
  })
  await flushPromises()
}

/** Dialog 经 reka DialogPortal teleport 到 body：按 id 从 body 取输入框 */
function inputEl(): HTMLInputElement {
  const el = document.body.querySelector('#rename-session-label')
  expect(el, '重命名输入框应存在').not.toBeNull()
  return el as HTMLInputElement
}

/** 错误消息元素（不可见时为 null） */
function errorMsgEl(): Element | null {
  return document.body.querySelector('#rename-session-label-message')
}

/** 输入并等 DOM 更新（v-model 同步，错误 computed 随 input 事件即时刷新）；Portal 内容不在 wrapper_m2 子树，走 body DOMWrapper */
async function type(value: string): Promise<void> {
  await new DOMWrapper<HTMLInputElement>(inputEl()).setValue(value)
  await nextTick()
}

/**
 * 含换行值注入：input type=text 的 value sanitization（HTML 规范）会剥离换行，
 * happy-dom 与真实浏览器一致，故换行分支无法经常规 setter 触达——覆写 value 后
 * dispatch input 事件，仍走真实 v-model → 校验 → DOM 错误展示生产链路。
 */
async function typeWithNewline(value: string): Promise<void> {
  const input = inputEl()
  Object.defineProperty(input, 'value', { value, writable: true, configurable: true })
  input.dispatchEvent(new Event('input'))
  await nextTick()
  delete (input as unknown as Record<string, unknown>).value
}

/** 点确认按钮（文本定位，Dialog 内容在 body 下） */
async function clickConfirm(): Promise<void> {
  const btn = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === '确认',
  )
  expect(btn, '确认按钮应存在').not.toBeNull()
  ;(btn as HTMLButtonElement).click()
  await flushPromises()
}

// 注：RenameSessionDialog 节不自建 pinia——ImportSessionDialog 节的顶层 beforeEach（注册更早、
// 先执行）已 setActivePinia + 种子 project；此处再 createPinia 会清掉种子（合并首跑 9 例红）。



describe('RenameSessionDialog 校验（V5：空/超60/换行拒绝，合法通过）', () => {
  it('TC1: 允许 emoji、标点、多语言等可打印字符（合法名通过：无错误消息）', async () => {
    await mountDialog_m2()
    const validCases = [
      'hello🎉', // emoji
      'test.name', // 点号
      '用户(1)', // 括号
      'task@home', // @符号
      '100% 完成', // 百分号
      'bug #123', // 井号
      '价格 $99', // 美元符号
      '路径/a/b', // 斜杠
      'C:\\Users', // 反斜杠
      '<html>', // 尖括号
      'a+b=c', // 加号等号
      '问号?感叹号!', // 问号感叹号
      '引号"单引号\'', // 引号
      '波浪号~', // 波浪号
      '管道|符', // 管道符
      '👨‍👩‍👧 家庭', // emoji 组合字符
      '中文测试', // 中文
      '日本語テスト', // 日文
      '한국어 테스트', // 韩文
      'Ñoño', // 西班牙文
    ]
    for (const value of validCases) {
      await type(value)
      expect(errorMsgEl(), `合法名 "${value}" 不应显示错误`).toBeNull()
    }
  })

  it('TC2: 拒绝 \\r\\n 控制字符（用户可见错误：换行文案）', async () => {
    await mountDialog_m2()
    const invalidCases = ['hello\nworld', 'hello\rworld', 'hello\r\nworld', 'hello\n\rworld', '\n开头', '结尾\n', '\r开头', '结尾\r']
    for (const value of invalidCases) {
      await typeWithNewline(value)
      expect(errorMsgEl(), `含换行 "${value}" 应显示错误`).not.toBeNull()
      expect(errorMsgEl()!.textContent).toBe(MSG_PATTERN)
    }
  })

  it('TC3: 长度边界（60 通过 / 61 拒绝）与空名拒绝', async () => {
    await mountDialog_m2()
    await type('a'.repeat(MAX_LABEL_LENGTH))
    expect(errorMsgEl(), '60 字符不应显示错误').toBeNull()

    await type('a'.repeat(MAX_LABEL_LENGTH + 1))
    expect(errorMsgEl(), '61 字符应显示错误').not.toBeNull()
    expect(errorMsgEl()!.textContent).toBe(MSG_MAX_LENGTH)

    await type('')
    expect(errorMsgEl(), '空名应显示错误').not.toBeNull()
    expect(errorMsgEl()!.textContent).toBe(MSG_REQUIRED)
  })

  it('交互: 合法名点确认 → emit confirm（label trim）+ update:open false', async () => {
    await mountDialog_m2()
    await type('  新名称  ')
    expect(errorMsgEl()).toBeNull()
    await clickConfirm()
    expect(wrapper_m2!.emitted('confirm')).toEqual([[{ sessionId: 's1', label: '新名称' }]])
    expect(wrapper_m2!.emitted('update:open')).toEqual([[false]])
  })

  it('交互: 非法名点确认 → 错误可见且不 emit（确认按钮不禁用、submit 被拦截，与改写前等价）', async () => {
    await mountDialog_m2()
    await type('')
    await clickConfirm()
    expect(errorMsgEl(), '提交后错误应可见').not.toBeNull()
    expect(errorMsgEl()!.textContent).toBe(MSG_REQUIRED)
    expect(wrapper_m2!.emitted('confirm')).toBeUndefined()
  })

  it('交互: 打开即聚焦并全选输入框', async () => {
    await mountDialog_m2()
    expect(document.activeElement).toBe(inputEl())
    expect((inputEl() as HTMLInputElement).value).toBe('旧名称')
  })

  it('交互: 初值未动时无错误展示（新实现：label 偏离初值或提交尝试后即显示错误；旧 vee-validate 为 blur/submit 后才显示，差异登记 D7），动过再改回原值错误消失', async () => {
    await mountDialog_m2()
    expect(errorMsgEl(), '打开初值合法不应显示错误').toBeNull()
    await type('')
    expect(errorMsgEl()).not.toBeNull()
    await type('旧名称')
    expect(errorMsgEl(), '改回合法初值后错误应消失').toBeNull()
  })
})

// 合并产物专用：两节各自 afterEach（顺序：先卸载再清 body）合并后，先执行者清 body 会让
// 后执行者 unmount 已脱离 DOM 的节点抛 nextSibling null。收为单一 afterEach：两槽都卸载后清一次。
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  wrapper_m2?.unmount()
  wrapper_m2 = null
  vi.useRealTimers()
  document.body.innerHTML = ''
})
