/**
 * LRU 驱逐不删盘文件（crash-resilience §3.3 D6-⑨ 纯缓存语义验收项）。
 *
 * 设计裁决：驱逐 ≠ session 死亡——驱逐只释放 renderer 内存分区（messages Map 条目 +
 * LRU 时序记录），被逐出 session 重进是设计内流程（cache 命中或幂等重建，用户无感）。
 * 本测试把「node:fs 整模块替换为全 spy」，驱动 evictIfNeeded / evictSessionWithVirtual
 * 全路径后断言 fs 上任何函数都未被调用——删除类 API（rmSync/unlinkSync/rmdirSync 等）
 * 与写类 API 一样零命中，结构上排除「驱逐路径偷偷碰盘」的回归。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** 覆盖删除/写/改三类能力的 fs 函数名单（驱逐路径若碰盘必然命中其中之一）。 */
const FS_FN_NAMES = [
  'existsSync', 'statSync', 'lstatSync', 'readdirSync', 'readFileSync',
  'mkdirSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'unlink',
  'writeFileSync', 'appendFileSync', 'copyFileSync', 'renameSync', 'truncateSync',
]

function makeFsMock(): Record<string, ReturnType<typeof vi.fn>> {
  const fns: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const name of FS_FN_NAMES) fns[name] = vi.fn()
  return fns
}

const fsFns = makeFsMock()

vi.mock('node:fs', () => ({
  ...fsFns,
  default: { ...fsFns },
}))

import { evictIfNeeded, evictSessionWithVirtual, touchLru, _resetLruForTest, LRU_MAX_SESSIONS, type LruEvictDeps } from '../lru'

function makeDeps(sids: string[]): { deps: LruEvictDeps; deleted: string[] } {
  const deleted: string[] = []
  const store = new Map(sids.map((sid) => [sid, { value: [] }]))
  return {
    deleted,
    deps: {
      messagesValue: () => store,
      hydratedValue: () => new Set(sids),
      isExempt: () => false,
      deleteMessageKey: (sid) => {
        store.delete(sid)
        deleted.push(sid)
      },
      deleteHydrated: () => undefined,
      // [B9] 未装配联动回调（core 无 renderer 装配环境）：默认不联动，驱逐面不变
      agentCallEvictionsOf: () => [],
    },
  }
}

beforeEach(() => {
  _resetLruForTest()
})

afterEach(() => {
  vi.clearAllMocks()
})

function expectNoFsCalls(): void {
  for (const [name, fn] of Object.entries(fsFns)) {
    expect(fn.mock.calls, `fs.${name} 被意外调用`).toHaveLength(0)
  }
}

describe('LRU 驱逐不删盘（D6-⑨ 纯缓存语义）', () => {
  it('阈值触发驱逐：仅内存 delete，fs 全模块零调用', () => {
    const sids = Array.from({ length: LRU_MAX_SESSIONS + 2 }, (_, i) => `s${i}`)
    const { deps, deleted } = makeDeps(sids)
    sids.forEach(touchLru)
    evictIfNeeded(deps)
    // 驱逐发生了（最旧 2 个被逐出内存）
    expect(deleted).toEqual(['s0', 's1'])
    expectNoFsCalls()
  })

  it('显式驱逐（带虚拟 key 联动）：同样零 fs 调用', () => {
    const { deps, deleted } = makeDeps(['main-1', 'subagent:main-1:x'])
    touchLru('main-1')
    touchLru('subagent:main-1:x')
    evictSessionWithVirtual('main-1', deps)
    expect(deleted).toEqual(['main-1', 'subagent:main-1:x'])
    expectNoFsCalls()
  })

  it('未超阈值：不驱逐、零 fs 调用', () => {
    const { deps, deleted } = makeDeps(['a', 'b'])
    touchLru('a')
    touchLru('b')
    evictIfNeeded(deps)
    expect(deleted).toEqual([])
    expectNoFsCalls()
  })
})
