// @vitest-environment node

/**
 * file-type 判定纯函数单测（合并文件，波次 2a 簇 3-13）：
 * file-type.test.ts（本文件）+ background-task-bucket.test.ts +
 * partitioned-session-records.test.ts——三源同为 node 环境纯函数直测，
 * 零 mock 零 hook 零定时器，合并为纯搬运。
 *
 * 覆盖：
 * - 各 FileKind 的扩展名映射（markdown/image/code）
 * - 未知扩展名 → text 兜底
 * - 无扩展名 → text
 * - dotfile（.eslintrc）处理
 * - 路径含目录前缀（src/a/b.ts）
 * - 大小写不敏感（.MD/.TS）
 * - extToLang 映射 + fallback 'typescript'
 * - background-task-bucket 分桶 / 筛选 / 计数 / statusIcon SSOT
 * - partitioned-session-records 共享分区工厂行为直测
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/lib/file-type.test.ts
 */
import { describe, it, expect } from 'vitest'
import { detectFileKind, extToLang } from '@/composables/logic/file-type'
import {
  isActiveBackgroundTaskState,
  isTerminalBackgroundTaskState,
} from '@zhushanwen/extension-protocol'
import {
  backgroundTaskBucket,
  filterBackgroundTasks,
  backgroundTaskStatusIcon,
  type BackgroundTaskEntry,
} from '@/lib/background-task-bucket'
import { createPartitionedLoadState, createPartitionedRecords } from '@/lib/partitioned-session-records'

describe('detectFileKind', () => {
  describe('markdown', () => {
    const cases = ['README.md', 'doc.markdown', 'page.mdx']
    for (const p of cases) {
      it(`${p} → markdown`, () => {
        expect(detectFileKind(p)).toBe('markdown')
      })
    }
  })

  describe('image', () => {
    const cases = ['logo.png', 'photo.jpg', 'icon.jpeg', 'anim.gif', 'vec.svg', 'pic.webp', 'old.bmp', 'fav.ico']
    for (const p of cases) {
      it(`${p} → image`, () => {
        expect(detectFileKind(p)).toBe('image')
      })
    }
  })

  describe('code', () => {
    const cases = ['a.ts', 'b.tsx', 'c.js', 'd.jsx', 'Comp.vue', 'cfg.json', 'app.py', 'srv.go', 'lib.rs', 'Main.java']
    for (const p of cases) {
      it(`${p} → code`, () => {
        expect(detectFileKind(p)).toBe('code')
      })
    }
  })

  it('未知扩展名 → text', () => {
    expect(detectFileKind('notes.unknownext')).toBe('text')
    expect(detectFileKind('data.csv')).toBe('text')
  })

  it('无扩展名 → text', () => {
    expect(detectFileKind('Makefile')).toBe('text')
    expect(detectFileKind('LICENSE')).toBe('text')
  })

  it('路径含目录前缀', () => {
    expect(detectFileKind('src/components/Panel.vue')).toBe('code')
    expect(detectFileKind('docs/architecture/readme.md')).toBe('markdown')
  })

  it('大小写不敏感', () => {
    expect(detectFileKind('README.MD')).toBe('markdown')
    expect(detectFileKind('App.TS')).toBe('code')
    expect(detectFileKind('IMG.PNG')).toBe('image')
  })

  it('dotfile 扩展名处理', () => {
    expect(detectFileKind('.eslintrc')).toBe('text')
    expect(detectFileKind('.gitignore')).toBe('text')
  })
})

describe('extToLang', () => {
  it('ts → typescript', () => {
    expect(extToLang('a.ts')).toBe('typescript')
    expect(extToLang('a.tsx')).toBe('typescript')
  })

  it('js → javascript', () => {
    expect(extToLang('a.js')).toBe('javascript')
  })

  it('vue → vue', () => {
    expect(extToLang('Comp.vue')).toBe('vue')
  })

  it('py → python', () => {
    expect(extToLang('app.py')).toBe('python')
  })

  it('sh → bash', () => {
    expect(extToLang('run.sh')).toBe('bash')
  })

  it('未知扩展名 fallback typescript', () => {
    expect(extToLang('notes.unknownext')).toBe('typescript')
    expect(extToLang('Makefile')).toBe('typescript')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 源: background-task-bucket.test.ts —— 分桶 / 筛选 / 计数 / statusIcon SSOT
//（u-renderer-store 验收条款：分桶判据谓词复用 isActive/isTerminal；statusIcon 判定顺序
// killed null 优先 dim / exitCode!==0 吸 null → danger / orphaned→info，D10①⑤）。
//
// 「谓词复用」的可测口径：四 state 全枚举的 bucket 结果与契约谓词
// isActiveBackgroundTaskState / isTerminalBackgroundTaskState 逐一对账（实现若改为
// 本地重写枚举判定，对账仍绿但 filter/count 的同源一致性断言会锁死两处不可漂移；
// 谓词身份由行为等价 + 全枚举覆盖锁定）。
// ═══════════════════════════════════════════════════════════════════

/** 构造 registry 条目（协议镜像形状；未给出的字段取合法默认）。 */
function entry(overrides: Partial<BackgroundTaskEntry> & { state: BackgroundTaskEntry['state'] }): BackgroundTaskEntry {
  return {
    taskId: 'bt-test-a1b2c3',
    pid: 53241,
    command: 'pnpm test',
    outputFile: '/tmp/bt.log',
    startedAt: 1_000,
    ownerPiPid: 100,
    sessionId: 'sess-x',
    ...overrides,
  }
}

const RUNNING = entry({ state: 'running' })
const KILLING = entry({ state: 'killing' })
const EXITED_OK = entry({ state: 'exited', exitCode: 0, reason: 'natural', endedAt: 5_000, durationMs: 4_000 })
const EXITED_FAIL = entry({ state: 'exited', exitCode: 1, reason: 'natural', endedAt: 6_000, durationMs: 5_000 })
const EXITED_KILLED = entry({ state: 'exited', exitCode: null, reason: 'killed', endedAt: 7_000, durationMs: 6_000 })
const EXITED_TIMEOUT = entry({ state: 'exited', exitCode: null, reason: 'timeout', endedAt: 8_000, durationMs: 7_000 })
const ORPHANED = entry({ state: 'orphaned', endedAt: 9_000 })

describe('backgroundTaskBucket 分桶判据（谓词复用 isActive/isTerminal）', () => {
  it('四 state 全枚举：bucket 结果与契约谓词逐一对账', () => {
    const states: BackgroundTaskEntry['state'][] = ['running', 'killing', 'exited', 'orphaned']
    for (const state of states) {
      const e = entry({ state })
      const active = backgroundTaskBucket(e) === 'active'
      // 对账契约谓词：active 桶 ⇔ isActiveBackgroundTaskState；ended 桶 ⇔ isTerminal
      expect(active).toBe(isActiveBackgroundTaskState(e.state))
      expect(!active).toBe(isTerminalBackgroundTaskState(e.state))
    }
  })

  it('运行中桶 = running + killing（killing 是活跃瞬态，不落入已结束）', () => {
    expect(backgroundTaskBucket(RUNNING)).toBe('active')
    expect(backgroundTaskBucket(KILLING)).toBe('active')
  })

  it('已结束桶 = exited（含 killed/timeout）+ orphaned', () => {
    expect(backgroundTaskBucket(EXITED_OK)).toBe('ended')
    expect(backgroundTaskBucket(EXITED_KILLED)).toBe('ended')
    expect(backgroundTaskBucket(EXITED_TIMEOUT)).toBe('ended')
    expect(backgroundTaskBucket(ORPHANED)).toBe('ended')
  })
})

describe('filterBackgroundTasks 过滤与排序（S1 验收口径同源）', () => {
  // 乱序输入：ended 按 endedAt 倒序应翻转；active 按 startedAt 升序
  const tasks = [EXITED_TIMEOUT, RUNNING, EXITED_OK, KILLING, ORPHANED, EXITED_FAIL, EXITED_KILLED]

  it("filter='active' 只留运行中（含 killing），startedAt 升序", () => {
    const out = filterBackgroundTasks(tasks, 'active')
    expect(out.map((t) => t.taskId)).toEqual([RUNNING.taskId, KILLING.taskId])
  })

  it("filter='ended' 只留终态（exited+orphaned），endedAt 倒序（最近结束在前）", () => {
    const out = filterBackgroundTasks(tasks, 'ended')
    expect(out.map((t) => t.state)).toEqual(['orphaned', 'exited', 'exited', 'exited', 'exited'])
    const endedAts = out.map((t) => t.endedAt as number)
    expect([...endedAts].sort((a, b) => b - a)).toEqual(endedAts)
  })

  it("filter='all' 运行中置顶（startedAt 升序）+ 已结束段倒序——全量保持分组有序", () => {
    const out = filterBackgroundTasks(tasks, 'all')
    expect(out).toHaveLength(tasks.length)
    expect(out.map((t) => backgroundTaskBucket(t))).toEqual([
      'active', 'active',
      'ended', 'ended', 'ended', 'ended', 'ended',
    ])
    const firstEndedIdx = out.findIndex((t) => backgroundTaskBucket(t) === 'ended')
    const activeSegment = out.slice(0, firstEndedIdx)
    const endedSegment = out.slice(firstEndedIdx)
    expect(activeSegment.map((t) => t.startedAt)).toEqual(
      [...activeSegment].map((t) => t.startedAt).sort((a, b) => a - b),
    )
    const endedAts = endedSegment.map((t) => t.endedAt as number)
    expect([...endedAts].sort((a, b) => b - a)).toEqual(endedAts)
  })

  it('空列表三值过滤均返回空数组', () => {
    for (const f of ['active', 'ended', 'all'] as const) {
      expect(filterBackgroundTasks([], f)).toEqual([])
    }
  })
})

describe('backgroundTaskStatusIcon 判定顺序（D10⑤，顺序即语义）', () => {
  it('state 先分流：running → accent 旋转环；killing → warn 点；orphaned → info 点', () => {
    expect(backgroundTaskStatusIcon(RUNNING)).toEqual({
      shape: 'spinner', tone: 'accent', statusKey: 'running',
    })
    expect(backgroundTaskStatusIcon(KILLING)).toEqual({
      shape: 'dot', tone: 'warn', statusKey: 'killing',
    })
    expect(backgroundTaskStatusIcon(ORPHANED)).toEqual({
      shape: 'dot', tone: 'info', statusKey: 'orphaned',
    })
  })

  it('killed 优先 dim：reason=killed + exitCode=null 不误入 danger（判定顺序锚——先判 exitCode 会红）', () => {
    expect(backgroundTaskStatusIcon(EXITED_KILLED)).toEqual({
      shape: 'dot', tone: 'dim', statusKey: 'killed',
    })
  })

  it('exitCode!==0 吸收 null：timeout（exitCode=null）与显式失败（exitCode=1）同为 danger，色档不区分 reason', () => {
    expect(backgroundTaskStatusIcon(EXITED_TIMEOUT)).toEqual({
      shape: 'dot', tone: 'danger', statusKey: 'failed',
    })
    expect(backgroundTaskStatusIcon(EXITED_FAIL)).toEqual({
      shape: 'dot', tone: 'danger', statusKey: 'failed',
    })
  })

  it('exitCode===0 → success 点', () => {
    expect(backgroundTaskStatusIcon(EXITED_OK)).toEqual({
      shape: 'dot', tone: 'success', statusKey: 'succeeded',
    })
  })
})

// ═══════════════════════════════════════════════════════════════════
// 源: partitioned-session-records.test.ts —— 共享分区工厂行为直测
//（不 import 任何 store，无环）。
//
// - createPartitionedRecords：record 表四件套（state ref + 响应式视图 + 非响应式读 +
//   不可变写/清）——apply 触发响应性 / 空数组兜底 / clear 幂等 / 多 sid 独立。
// - createPartitionedLoadState：加载态三件套（loading / loadError / oversize，待裁决项 1
//   收敛 2026-10-04）——缺省读取 / beginLoad 清错误 / endLoad 删条目不重生 / facet 独立 /
//   clear 精确释放 / clearAll 整表替换。
//
// 两 store（subagent / workflow）的 facet 领域语义与工厂接线由各自 store 测试锁定；
// 本节锁工厂自身的分区范式（与 createPartitionedRecords 同风格的行为范围）。
// ═══════════════════════════════════════════════════════════════════

describe('createPartitionedRecords — record 表四件套', () => {
  it('get / recordsOf 缺省空数组（无条目不写 Map）', () => {
    const p = createPartitionedRecords<{ id: string }>()
    expect(p.get('s1')).toEqual([])
    expect(p.recordsOf('s1').value).toEqual([])
  })

  it('apply 写入分区并触发响应式视图重算（不可变替换整 Map）', () => {
    const p = createPartitionedRecords<{ id: string }>()
    const view = p.recordsOf('s1')
    expect(view.value).toEqual([])
    p.apply('s1', [{ id: 'a' }])
    expect(view.value).toEqual([{ id: 'a' }])
    expect(p.get('s1')).toEqual([{ id: 'a' }])
  })

  it('clear 精确释放指定 sid，其他 sid 不受影响；对缺失 sid 幂等', () => {
    const p = createPartitionedRecords<{ id: string }>()
    p.apply('s1', [{ id: 'a' }])
    p.apply('s2', [{ id: 'b' }])
    p.clear('s1')
    expect(p.get('s1')).toEqual([])
    expect(p.get('s2')).toEqual([{ id: 'b' }])
    expect(() => p.clear('never')).not.toThrow()
  })

  it('apply 空数组是合法写入（真实删空语义，分区存在但为空）', () => {
    const p = createPartitionedRecords<{ id: string }>()
    p.apply('s1', [{ id: 'a' }])
    p.apply('s1', [])
    expect(p.get('s1')).toEqual([])
  })
})

describe('createPartitionedLoadState — 加载态三件套（待裁决项 1 收敛）', () => {
  it('读取缺省：无条目 = loading false / error null / oversize false', () => {
    const load = createPartitionedLoadState()
    expect(load.isLoadingOf('s1')).toBe(false)
    expect(load.loadErrorOf('s1')).toBeNull()
    expect(load.oversizeOf('s1')).toBe(false)
  })

  it('beginLoad：loading 置位 + 该 sid 错误清除（loadXxx 入口语义单点）', () => {
    const load = createPartitionedLoadState()
    load.setLoadError('s1', 'stale error')
    load.beginLoad('s1')
    expect(load.isLoadingOf('s1')).toBe(true)
    expect(load.loadErrorOf('s1')).toBeNull()
  })

  it('endLoad：loading 条目删除（无条目残留 = 不在途语义，非 set false）', () => {
    const load = createPartitionedLoadState()
    load.beginLoad('s1')
    load.endLoad('s1')
    expect(load.isLoadingOf('s1')).toBe(false)
    // 未 begin 的 sid endLoad 是 no-op（不重生条目）
    load.endLoad('never')
    expect(load.isLoadingOf('never')).toBe(false)
  })

  it('setLoadError / oversize 置清：facet 各自独立，互不串扰', () => {
    const load = createPartitionedLoadState()
    load.beginLoad('s1')
    load.setLoadError('s1', 'rpc down')
    load.setOversize('s1')
    expect(load.loadErrorOf('s1')).toBe('rpc down')
    expect(load.oversizeOf('s1')).toBe(true)
    expect(load.isLoadingOf('s1')).toBe(true)

    load.clearOversize('s1')
    expect(load.oversizeOf('s1')).toBe(false)
    expect(load.loadErrorOf('s1')).toBe('rpc down')
  })

  it('clear：三分区精确释放（deleteSession 路径），其他 sid 不受影响', () => {
    const load = createPartitionedLoadState()
    load.beginLoad('s1')
    load.setLoadError('s1', 'e1')
    load.setOversize('s1')
    load.beginLoad('s2')
    load.setOversize('s2')

    load.clear('s1')

    expect(load.isLoadingOf('s1')).toBe(false)
    expect(load.loadErrorOf('s1')).toBeNull()
    expect(load.oversizeOf('s1')).toBe(false)
    expect(load.isLoadingOf('s2')).toBe(true)
    expect(load.oversizeOf('s2')).toBe(true)
  })

  it('clearAll：整表替换（clearSubagents / clearWorkflows 全局重置语义）', () => {
    const load = createPartitionedLoadState()
    load.beginLoad('s1')
    load.setLoadError('s2', 'e2')
    load.setOversize('s3')

    load.clearAll()

    expect(load.isLoadingOf('s1')).toBe(false)
    expect(load.loadErrorOf('s2')).toBeNull()
    expect(load.oversizeOf('s3')).toBe(false)
  })

  it('多 sid 分区独立（ADR-0049：split 双面板并行拉取互不遮蔽）', () => {
    const load = createPartitionedLoadState()
    load.beginLoad('a')
    expect(load.isLoadingOf('a')).toBe(true)
    expect(load.isLoadingOf('b')).toBe(false)
    load.setLoadError('b', 'pane-b down')
    expect(load.loadErrorOf('a')).toBeNull()
    expect(load.loadErrorOf('b')).toBe('pane-b down')
  })
})
