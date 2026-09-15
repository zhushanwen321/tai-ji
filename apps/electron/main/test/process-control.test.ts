/**
 * getDescendantPids 特征测试（complexity-debt U03 补覆盖缺口）。
 *
 * 背景：process-control.ts 的既有测试（runtime-supervisor-crash-restart /
 * supervisor-health-liveness）把整个模块 vi.mock 掉，getDescendantPids 既有覆盖为零。
 * 本文件锚定其可观测行为面（stop() 时序 T0 依赖，[HISTORICAL] 必须在 SIGTERM 前调用）：
 *   - 平台/入参守卫：win32 / pid=0 / NaN → []（不触 pgrep）
 *   - BFS 遍历：广度优先按代收集（子→孙），后代不含根
 *   - pgrep 输出解析：按行 split + Number 过滤（非数字/负数/0 剔除）
 *   - 失败分类：exit 1（无子进程）与 ENOENT 静默；其他真实错误 warn（文案锚定）
 *
 * Mock 策略：mock node:child_process 的 execFileSync（getDescendantPids 唯一 IO 依赖）
 * + electron（模块顶层 import）。不 spawn 真实进程。
 *
 * 运行：cd apps/electron/main && npx vitest run test/process-control.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// electron mock：process-control 顶层 import { app }（仅 spawnRuntimeProcess/getStderrSink
// 路径触达，本测试不调用，但模块加载需要可解析的 electron）
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/fake/app-path',
    getVersion: () => '0.0.0-test',
  },
}))

// execFileSync mock（vi.hoisted：vi.mock 工厂内引用）
const execFileSyncMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFileSync: execFileSyncMock,
}))

// 动态 import：确保 mock 先于模块加载生效
async function loadModule() {
  return await import('../supervisor/process-control.js')
}

/** pgrep 抛错形态构造（execFileSync 失败：错误对象带 status=exit code / code=spawn 错误）。 */
function pgrepError(props: { status?: number; code?: string }): Error {
  return Object.assign(new Error('pgrep failed'), props)
}

describe('getDescendantPids', () => {
  let originalPlatform: PropertyDescriptor | undefined
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    // 本测试用例集按 pgrep 可用平台（macOS/Linux）设计；CI 若在 win32 跑，
    // 需要非 win 用例的守卫分支显式桩 darwin（下方用例各自桩）。
    execFileSyncMock.mockReset()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    warnSpy.mockRestore()
  })

  /** 桩为 pgrep 可用平台（macOS/Linux 同路径，依赖项一致）。 */
  function stubPgrepPlatform(): void {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  }

  it('win32 平台 → 返回 [] 且不触 pgrep（taskkill 树终止由独立路径负责）', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const { getDescendantPids } = await loadModule()

    expect(getDescendantPids(1234)).toEqual([])
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('parentPid 为 0 / NaN → 返回 []（ falsy 守卫，不触 pgrep）', async () => {
    stubPgrepPlatform()
    const { getDescendantPids } = await loadModule()

    expect(getDescendantPids(0)).toEqual([])
    expect(getDescendantPids(NaN)).toEqual([])
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('BFS 按代收集：root → [111,222]，111 → [333]，孙辈不再有子 → [111,222,333]（不含 root）', async () => {
    stubPgrepPlatform()
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      const pid = args[1]
      if (pid === '100') return '111\n222'
      if (pid === '111') return '333\n'
      if (pid === '222') return ''
      if (pid === '333') throw pgrepError({ status: 1 }) // 孙辈无子进程：exit 1
      throw new Error(`unexpected pgrep query: ${pid}`)
    })
    const { getDescendantPids } = await loadModule()

    expect(getDescendantPids(100)).toEqual([111, 222, 333])
    // 全程无真实错误（exit 1 静默）
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('pgrep 输出按行解析并过滤无效项（非数字 / 负数 / 0）', async () => {
    stubPgrepPlatform()
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      const pid = args[1]
      if (pid === '100') return '111\nnot-a-pid\n-5\n0\n 222 '
      if (pid === '111' || pid === '222') throw pgrepError({ status: 1 })
      throw new Error(`unexpected pgrep query: ${pid}`)
    })
    const { getDescendantPids } = await loadModule()

    expect(getDescendantPids(100)).toEqual([111, 222])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('pgrep exit 1（无子进程）→ 静默跳过该分支，队列其余分支继续处理', async () => {
    stubPgrepPlatform()
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      const pid = args[1]
      if (pid === '100') throw pgrepError({ status: 1 })
      if (pid === '200') return '300'
      if (pid === '300') throw pgrepError({ status: 1 })
      throw new Error(`unexpected pgrep query: ${pid}`)
    })
    const { getDescendantPids } = await loadModule()

    // root 即无子进程：结果为空但不抛、不 warn
    expect(getDescendantPids(100)).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
    // 混合队列：exit 1 的分支被跳过，健康分支（200→300）仍被收集
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      const pid = args[1]
      if (pid === '100') return '200'
      if (pid === '200') return '300'
      if (pid === '300') throw pgrepError({ status: 1 })
      throw new Error(`unexpected pgrep query: ${pid}`)
    })
    expect(getDescendantPids(100)).toEqual([200, 300])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('pgrep ENOENT（命令不存在）→ 静默返回 []，不阻断 stop 流程', async () => {
    stubPgrepPlatform()
    execFileSyncMock.mockImplementation(() => {
      throw pgrepError({ code: 'ENOENT' })
    })
    const { getDescendantPids } = await loadModule()

    expect(getDescendantPids(100)).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('pgrep 其他真实错误（exit 2）→ console.warn 文案锚定（getDescendantPids failed for PID）', async () => {
    stubPgrepPlatform()
    execFileSyncMock.mockImplementation(() => {
      throw pgrepError({ status: 2 })
    })
    const { getDescendantPids } = await loadModule()

    expect(getDescendantPids(100)).toEqual([])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toBe('[runtime] getDescendantPids failed for PID 100:')
  })

  it('每次查询经 pgrep -P <pid>（不经 shell）', async () => {
    stubPgrepPlatform()
    execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
      const pid = args[1]
      if (pid === '100') throw pgrepError({ status: 1 })
      throw new Error(`unexpected pgrep query: ${pid}`)
    })
    const { getDescendantPids } = await loadModule()

    getDescendantPids(100)
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    expect(execFileSyncMock.mock.calls[0]?.[0]).toBe('pgrep')
    expect(execFileSyncMock.mock.calls[0]?.[1]).toEqual(['-P', '100'])
  })
})
