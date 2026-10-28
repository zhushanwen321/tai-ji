/**
 * BtwService 合并测试（线进程生命周期 / 契约注入 / fork 分支 / fork cli / no-abort /
 * pi 原生 fork / 注册表重建 / surface 双写）。
 *
 * 来源（分节注释见内；各来源节以基名 describe 包裹，节内顶层 hook/helper 随节下沉）：
 * - btw-lifecycle（原主文件）
 * - btw-contract-inject / btw-create-branches / btw-fork-cli / btw-no-abort
 * - btw-pi-fork-semantics / btw-registry / btw-surface-dual-write
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/btw-lifecycle.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from '../../../../../../test-guard/integration-gate.ts'
import { getBtwThreadDir } from '../../../infra/pi/pi-paths.js'
import { trashDirectory as realTrashDirectory } from '../../../infra/system/trash.js'
import { BtwError, BtwService, BTW_BEHAVIOR_CONTRACT, forkViaCliPi, inspectSourceState } from '../btw-service.js'
import { cleanupDir, makeHarness, makeTmpDir, useTmpDataDir, writeSessionFile, BtwHarness, cleanEntries, danglingEntries, makeFakeClient } from './helpers/btw-harness.js'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { getSessionBtwDir, getSessionStoreDir } from '@taiji/shared/paths'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, appendFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 线进程生命周期（btw-question D1）：惰性 spawn / 闲置 30min destroy /
 * 有待处理交互豁免计闲置 / 回收前提醒挂点 / reattach 自建附着编排（V5）/ 关线原语。
 * timer 走 fake timers（测试红线：禁真实等待）。
 */

// closeLine 线树软删走 trashDirectory：platform 钉 linux（任何宿主机都走非 mac 降级
// rmSync 分支，断言落盘效果）；child_process 整模块 mock 兜底锁定零子进程（不触真实
// 废纸篓）。tmpdir 保持真实（fs-guard 白名单 = os.tmpdir()）。trashDirectory 包装成
// 可控 spy：默认经闭包转调真实现，失败语义用例 mockRejectedValueOnce 注入。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn() }
})
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, platform: () => 'linux' }
})
// trashDirectory 改 deps 注入（C-comm-03：services 不得 value import infra——BtwServiceDeps
// 字段）。spy 默认闭包转调真实现；失败用例用 mockRejectedValueOnce（一次性，消费后自动
// 回到此默认形态），无需手动恢复。

describe('btw-lifecycle', () => {
  const trashDirectoryMock = vi.fn((dirPath: string) => realTrashDirectory(dirPath))

  const execFileSyncMock = vi.mocked(execFileSync)

  const MAIN_SID = 'main-sid-001'
  const CWD = '/Users/x/proj'

  let restoreDataDir: () => void
  let fx: string
  let h: BtwHarness
  let svc: BtwService

  /** 分支② 形态建线（无 fork；state 给定 sid + 真实存在的线文件路径）。 */
  async function createNoForkLine(fileSid = 'sid-b2'): Promise<{ sessionId: string; file: string }> {
    h.deps.resolveMainSessionFile = vi.fn(() => undefined)
    const file = writeSessionFile(join(fx, 'thread'), `${fileSid}.jsonl`, {
      type: 'session', version: 3, id: fileSid, timestamp: 't', cwd: CWD,
    }, [])
    h.state = { sessionId: fileSid, sessionFile: file }
    const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })
    return { sessionId: res.sessionId, file: res.sessionFilePath }
  }

  beforeEach(() => {
    // 显式 toFake 含 Date：闲置钟 = Date.now，须随 advanceTimersByTime 前进
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    restoreDataDir = useTmpDataDir()
    fx = makeTmpDir()
    h = makeHarness()
    h.deps.trashDirectory = trashDirectoryMock
    svc = new BtwService(h.deps)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    svc.dispose()
    cleanupDir(fx)
    restoreDataDir()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('reattach spawn 形态（自建附着编排；restore 离线腿不通用——V5）', () => {
    it('进程存活 → 短路复用（不重复 spawn）', async () => {
      const { sessionId } = await createNoForkLine()
      const c1 = await svc.ensureProcess(sessionId)
      const c2 = await svc.ensureProcess(sessionId)
      expect(c1).toBe(c2)
      expect(h.spawned).toHaveLength(1)
    })

    it('重附着后续问：spawn → switch_session(线文件) → 一致性守卫 → rekey → surface:btw 注册', async () => {
      const { sessionId, file } = await createNoForkLine('sid-r1')
      // 进程引用摘除（原「闲置回收后」形态；回收机制已随 ADR-0122 退役，重附着由
      // 进程死亡/重启场景触发）——直接置 rec.client = undefined 造重附着入口。
      svc.getLine(sessionId)!.client = undefined

      const client = await svc.ensureProcess(sessionId)

      expect(client).toBeDefined()
      expect(h.spawned).toHaveLength(2)
      expect(h.spawned[1].key).toBe(sessionId) // rekey 后 pm 键 ≡ 注册 id（harness rekey 会同步改 key）
      expect(h.spawned[1].client.switchSession).toHaveBeenCalledWith(file)
      expect(h.rekeyed[1]).toEqual([expect.stringMatching(/^btw-attach-/), sessionId]) // tempKey → 线 pi 真实 id（W4a）
      expect(h.registered).toHaveLength(2)
      expect(h.registered[1]).toMatchObject({ id: sessionId, surface: 'btw', file })
      expect(svc.getLine(sessionId)!.contractRounds).toBe(2) // 每轮会话建立重注入契约
      expect(h.traces.map(t => t.round)).toEqual([1, 2])
    })

    it('线文件不存在（首 flush 前即回收）→ thread_file_missing（不代造文件，策略归调用方）', async () => {
      h.deps.resolveMainSessionFile = vi.fn(() => undefined)
      h.state = { sessionId: 'sid-gone', sessionFile: join(fx, 'never-flushed.jsonl') } // 文件不落盘
      const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })
      svc.getLine(res.sessionId)!.client = undefined

      await expect(svc.ensureProcess(res.sessionId)).rejects.toMatchObject({ code: 'thread_file_missing' })
    })

    it('[D1] 重附着 = 旧轮挂起请求失效终态：pendingInteraction 结构解除（tick 未走到也不残留豁免）', async () => {
      const { sessionId } = await createNoForkLine('sid-r9')
      svc.setPendingInteraction(sessionId, true)
      h.spawned[0].client.exited = true // 进程亡（挂起请求随之失效），tick 尚未走到

      await svc.ensureProcess(sessionId) // 用户续问 → 重附着

      expect(svc.getLine(sessionId)!.pendingInteraction).toBe(false)
    })

    it('未知线 → line_not_found', async () => {
      await expect(svc.ensureProcess('nosuch-line')).rejects.toMatchObject({ code: 'line_not_found' })
    })

    it('附着落错会话 → state_mismatch 收尸', async () => {
      const { sessionId, file } = await createNoForkLine('sid-ok')
      svc.getLine(sessionId)!.client = undefined
      h.state = { sessionId: 'sid-WRONG', sessionFile: file } // reattach 读回与注册表不符

      await expect(svc.ensureProcess(sessionId)).rejects.toMatchObject({ code: 'state_mismatch' })
      expect(h.destroyed).toContain(h.spawned[1].key) // tempKey 收尸
    })
  })

  describe('关线原语（btw.remove；级联归 M4-a）', () => {
    it('closeLine：杀进程 + 注册表移除 + 文件删除限定本线目录内', async () => {
      // 线文件写在本线目录内（session-store-layout-inversion 布局：<root>/<mainSid>/btw/）
      const inside = writeSessionFile(
        getBtwThreadDir(MAIN_SID), 'inside.jsonl',
        { type: 'session', version: 3, id: 'sid-inside', timestamp: 't', cwd: CWD }, [],
      )
      h.deps.resolveMainSessionFile = vi.fn(() => undefined)
      h.state = { sessionId: 'sid-inside', sessionFile: inside }
      const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

      expect(await svc.closeLine(res.sessionId, { deleteSessionFile: true })).toBe(true)
      expect(h.destroyed).toContain(res.sessionId)
      expect(svc.getLine(res.sessionId)).toBeUndefined()
      expect(existsSync(inside)).toBe(false)
      expect(await svc.closeLine(res.sessionId)).toBe(false) // 幂等
    })

    it('closeLine 不删本线目录外文件（防误删面）', async () => {
      const outside = writeSessionFile(join(fx, 'elsewhere'), 'out.jsonl', {
        type: 'session', version: 3, id: 'sid-out', timestamp: 't', cwd: CWD,
      }, [])
      h.deps.resolveMainSessionFile = vi.fn(() => undefined)
      h.state = { sessionId: 'sid-out', sessionFile: outside }
      const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

      expect(await svc.closeLine(res.sessionId, { deleteSessionFile: true })).toBe(true)
      expect(existsSync(outside)).toBe(true) // 线目录外文件保留（守卫拦截 rm）
    })
  })

  describe('closeLine 线树软删（D5 对称挂树：<root>/<线sid>/ 整树 trashDirectory）', () => {
    /** 建线并在真实线树位置预置派生数据形态（线派生 subagent 记录等）。 */
    async function createLineWithTree(fileSid: string): Promise<{ sessionId: string; lineTree: string }> {
      h.deps.resolveMainSessionFile = vi.fn(() => undefined)
      const inside = writeSessionFile(
        getBtwThreadDir(MAIN_SID), `${fileSid}.jsonl`,
        { type: 'session', version: 3, id: fileSid, timestamp: 't', cwd: CWD }, [],
      )
      h.state = { sessionId: fileSid, sessionFile: inside }
      const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })
      const lineTree = join(getSessionStoreDir(), fileSid)
      mkdirSync(join(lineTree, 'subagents'), { recursive: true })
      writeFileSync(join(lineTree, 'subagents', 'rec.json'), '{}')
      return { sessionId: res.sessionId, lineTree }
    }

    it('删线软删线树整树（含派生数据；非 mac 降级递归删真跑 + 零子进程不触废纸篓）', async () => {
      const { sessionId, lineTree } = await createLineWithTree('sid-tree-1')
      expect(existsSync(lineTree)).toBe(true) // 前提自证：线树与派生数据在盘

      expect(await svc.closeLine(sessionId, { deleteSessionFile: true })).toBe(true)

      expect(existsSync(lineTree)).toBe(false) // 整树消失（<root>/<线sid>/ 递归删净）
      expect(execFileSyncMock).not.toHaveBeenCalled() // 降级通道零子进程
    })

    it('线树不存在（线从未派生数据——常态）→ 存在性守卫零动作，关线不炸', async () => {
      trashDirectoryMock.mockClear() // mock 调用记录跨用例累积，清零后断言本用例零调用
      h.deps.resolveMainSessionFile = vi.fn(() => undefined)
      const inside = writeSessionFile(
        getBtwThreadDir(MAIN_SID), 'sid-no-tree.jsonl',
        { type: 'session', version: 3, id: 'sid-no-tree', timestamp: 't', cwd: CWD }, [],
      )
      h.state = { sessionId: 'sid-no-tree', sessionFile: inside }
      const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })
      const lineTree = join(getSessionStoreDir(), 'sid-no-tree')
      expect(existsSync(lineTree)).toBe(false) // 前提自证：树从未创建

      expect(await svc.closeLine(res.sessionId, { deleteSessionFile: true })).toBe(true)
      expect(trashDirectoryMock).not.toHaveBeenCalled() // 零动作（不空跑 trash 通道）
    })

    it('线树软删失败 → 结构化错误上抛不静默（补账兜底已退役，残留必须出声）', async () => {
      const { sessionId, lineTree } = await createLineWithTree('sid-tree-fail')
      trashDirectoryMock.mockRejectedValueOnce(new Error('移入废纸篓失败（Finder 未在 5s 内响应）'))

      await expect(svc.closeLine(sessionId, { deleteSessionFile: true })).rejects.toThrow(/移入废纸篓失败/)
      expect(existsSync(lineTree)).toBe(true) // 失败保留原地（可撤销语义：不静默变不可逆）
    })
  })

  describe('BtwError code 面（M2-b 恢复指引映射）', () => {
    it('code 字段可判别', () => {
      const e = new BtwError('line_not_found', 'x')
      expect(e).toBeInstanceOf(Error)
      expect(e.code).toBe('line_not_found')
      expect(e.name).toBe('BtwError')
    })
  })
})

// ════════════════ 来源: btw-contract-inject.test.ts ════════════════

describe('btw-contract-inject', () => {
  const MAIN_SID = 'main-sid-001'
  const CWD = '/Users/x/proj'

  let restoreDataDir: () => void
  let fx: string
  let h: BtwHarness
  let svc: BtwService

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    restoreDataDir = useTmpDataDir()
    fx = makeTmpDir()
    h = makeHarness()
    svc = new BtwService(h.deps)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    svc.dispose()
    cleanupDir(fx)
    restoreDataDir()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function createLine(): Promise<{ sessionId: string; file: string }> {
    h.deps.resolveMainSessionFile = vi.fn(() => undefined)
    const file = writeSessionFile(join(fx, 'thread'), 'sid-c1.jsonl', {
      type: 'session', version: 3, id: 'sid-c1', timestamp: 't', cwd: CWD,
    }, [])
    h.state = { sessionId: 'sid-c1', sessionFile: file }
    const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })
    return { sessionId: res.sessionId, file: res.sessionFilePath }
  }

  describe('P-contract-inject：线会话建立时注入一次', () => {
    it('载体组合：appendSystemPrompt = 模式 append 段 ⊕ 契约（不覆盖、恰一次）', async () => {
      h.baseOptions = { appendSystemPrompt: 'MODE-APPEND-SEGMENT' }
      await createLine()

      const append = h.spawned[0].options.appendSystemPrompt!
      expect(append).toContain('MODE-APPEND-SEGMENT')
      expect(append).toContain(BTW_BEHAVIOR_CONTRACT)
      expect(append.split(BTW_BEHAVIOR_CONTRACT)).toHaveLength(2) // 恰一次
    })

    it('无模式 append 段 → 纯契约', async () => {
      await createLine()
      expect(h.spawned[0].options.appendSystemPrompt).toBe(BTW_BEHAVIOR_CONTRACT)
    })

    it('trace 断言：create 轮 round=1 恰一条（carrier + 契约文本可断言）', async () => {
      const { sessionId } = await createLine()
      expect(h.traces).toEqual([
        { sessionId, round: 1, carrier: 'append-system-prompt', contract: BTW_BEHAVIOR_CONTRACT },
      ])
    })

    it('重附着轮再注入一次（每会话建立一次，含重附着轮——D9⑤）', async () => {
      const { sessionId } = await createLine()
      // 进程引用摘除（闲置回收已随 ADR-0122 退役；重附着由进程死亡/重启场景触发）
      const rec = svc.getLine(sessionId)!
      rec.client = undefined

      await svc.ensureProcess(sessionId)

      expect(h.traces.map(t => [t.sessionId, t.round])).toEqual([[sessionId, 1], [sessionId, 2]])
      // 新一轮 spawn options 同样携带契约（进程重建 ⇒ prompt 期载体随之重建）
      expect(h.spawned[1].options.appendSystemPrompt).toBe(BTW_BEHAVIOR_CONTRACT)
    })

    it('契约不进注册表字段 / 不经 registerSession 参数（model-only，UI 面不可见的结构侧）', async () => {
      const { sessionId } = await createLine()
      const rec = svc.getLine(sessionId)!
      // 摘除 client（fake 自引用循环）后序列化——断言注册表数据字段不含契约文本
      expect(JSON.stringify({ ...rec, client: undefined })).not.toContain(BTW_BEHAVIOR_CONTRACT)
      // registerSession 收 6 参（id/client/cwd/label/file/surface——W5 hidden 形参已删，
      // btw 显式传 'btw'）——契约无传输通道（surface 是展示归属非契约载体）
      expect(h.registered[0].argc).toBe(6)
      expect(h.registered[0].surface).toBe('btw')
      expect(JSON.stringify(h.registered[0])).not.toContain(BTW_BEHAVIOR_CONTRACT)
    })

    it('契约文本与设计 D9⑤ 一句话版逐字一致（防漂移锚）', () => {
      expect(BTW_BEHAVIOR_CONTRACT).toBe(
        '父任务快照仅供背景；只回答本线新问题、不自动续主任务；仅本线明确要求时才改工作区',
      )
    })
  })
})

// ════════════════ 来源: btw-create-branches.test.ts ════════════════

describe('btw-create-branches', () => {
  const MAIN_SID = 'main-sid-001'
  const CWD = '/Users/x/proj'

  let restoreDataDir: () => void
  let fx: string
  let h: BtwHarness
  let svc: BtwService

  beforeEach(() => {
    restoreDataDir = useTmpDataDir()
    fx = makeTmpDir()
    h = makeHarness()
    svc = new BtwService(h.deps)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    svc.dispose()
    cleanupDir(fx)
    restoreDataDir()
    vi.restoreAllMocks()
  })

  /** 源 fixture（干净可 fork）。 */
  function stubCleanSource(): { src: string; forkFile: string } {
    const src = writeSessionFile(join(fx, 'src'), 'main.jsonl', {
      type: 'session', version: 3, id: MAIN_SID, timestamp: 't', cwd: CWD,
    }, cleanEntries())
    h.deps.resolveMainSessionFile = vi.fn(() => src)
    const forkFile = writeSessionFile(join(fx, 'fork'), 'fork.jsonl', {
      type: 'session', version: 3, id: 'sid-f1', timestamp: 't', cwd: CWD, parentSession: src,
    }, cleanEntries())
    h.deps.forkSession = vi.fn(async () => forkFile)
    return { src, forkFile }
  }

  describe('分支①：源已落盘 → 正常 fork（pi 原生 --fork 链路）', () => {
    it('fork → switch_session 附着 → registerSession(surface:btw) → 注册表登记', async () => {
      const { forkFile } = stubCleanSource()
      h.state = { sessionId: 'sid-f1', sessionFile: forkFile }

      const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

      expect(res).toEqual({ sessionId: 'sid-f1', mainSid: MAIN_SID, snapshotKind: 'forked', sessionFilePath: forkFile })
      // spawn 键 = tempKey → rekey 到线 pi 真实 id（W4a：pm 键 ≡ 注册 id ≡ lifecycle 键）
      expect(h.spawned).toHaveLength(1)
      expect(h.rekeyed[0][0]).toMatch(/^btw-create-/)
      expect(h.spawned[0].key).toBe('sid-f1') // rekey 后 pm 键 ≡ 注册 id
      expect(h.rekeyed).toEqual([[expect.stringMatching(/^btw-create-/), 'sid-f1']])
      // 附着编排：switchSession(forkFile)
      expect(h.spawned[0].client.switchSession).toHaveBeenCalledWith(forkFile)
      // surface:'btw' 注册（6 参 = 尾部 surface，W5 hidden 形参已删；仍不含 parentSession
      // 血缘——关联不进展示链，D4 结构性成立）
      expect(h.registered).toHaveLength(1)
      expect(h.registered[0]).toMatchObject({ id: 'sid-f1', file: forkFile, surface: 'btw', cwd: CWD, label: 'proj' })
      expect(h.registered[0].argc).toBe(6)
      // 落点不变量（V2②③）：env session-dir 强制覆写为线目录
      expect(h.spawned[0].options.env?.PI_CODING_AGENT_SESSION_DIR).toBe(getBtwThreadDir(MAIN_SID))
      // 注册表
      const rec = svc.getLine('sid-f1')!
      expect(rec).toMatchObject({ mainSid: MAIN_SID, piSessionId: 'sid-f1', surface: 'btw', snapshotKind: 'forked', contractRounds: 1 })
      expect(svc.listLines(MAIN_SID).map(l => l.piSessionId)).toEqual(['sid-f1'])
    })

    it('label 覆写透传 registerSession', async () => {
      const { forkFile } = stubCleanSource()
      h.state = { sessionId: 'sid-f1', sessionFile: forkFile }
      await svc.createLine({ mainSid: MAIN_SID, cwd: CWD, label: '提问-自定义' })
      expect(h.registered[0].label).toBe('提问-自定义')
    })
  })

  describe('分支②：源不存在/为空 → 回落无 fork 新建（落点 = 线目录 + 无快照标记）', () => {
    it('源 unresolved（resolveMainSessionFile 返回 undefined）→ 不调 fork、不 switch、kind=no-source', async () => {
      h.deps.resolveMainSessionFile = vi.fn(() => undefined)
      h.state = { sessionId: 'sid-b2', sessionFile: join(fx, 'threadB', 'x.jsonl') }

      const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

      expect(res.snapshotKind).toBe('no-source')
      expect(h.deps.forkSession).not.toHaveBeenCalled()
      expect(h.spawned[0].client.switchSession).not.toHaveBeenCalled()
      expect(h.registered[0]).toMatchObject({ id: 'sid-b2', surface: 'btw', file: join(fx, 'threadB', 'x.jsonl') })
      // 回落 spawn 落点继承：env session-dir = 线目录（V2② 实测同款通道）
      expect(h.spawned[0].options.env?.PI_CODING_AGENT_SESSION_DIR).toBe(getBtwThreadDir(MAIN_SID))
      expect(svc.getLine('sid-b2')?.snapshotKind).toBe('no-source')
      // 不静默：warn 登记不可用原因
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('fork source unavailable'))
    })

    it('源 missing（文件不存在）→ 回落 + forkSession 未被调用', async () => {
      const missing = join(fx, 'gone.jsonl')
      h.deps.resolveMainSessionFile = vi.fn(() => missing)
      h.state = { sessionId: 'sid-b3', sessionFile: join(fx, 't', 'y.jsonl') }

      const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

      expect(res.snapshotKind).toBe('no-source')
      expect(h.deps.forkSession).not.toHaveBeenCalled()
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('missing'))
    })

    it('header-only 源（零 entry）→ 宿主前置判空回落，不产空上下文线', async () => {
      const headerOnly = writeSessionFile(join(fx, 'src'), 'hdr.jsonl', {
        type: 'session', version: 3, id: MAIN_SID, timestamp: 't', cwd: CWD,
      }, [])
      h.deps.resolveMainSessionFile = vi.fn(() => headerOnly)
      h.state = { sessionId: 'sid-b4', sessionFile: join(fx, 't', 'z.jsonl') }

      const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

      expect(res.snapshotKind).toBe('no-source')
      expect(h.deps.forkSession).not.toHaveBeenCalled()
    })

    it('源 ok 但 fork bootstrap 失败 → catch 回落 no-source（warn 不静默，D3 编排）', async () => {
      const src = writeSessionFile(join(fx, 'src'), 'main.jsonl', {
        type: 'session', version: 3, id: MAIN_SID, timestamp: 't', cwd: CWD,
      }, cleanEntries())
      h.deps.resolveMainSessionFile = vi.fn(() => src)
      h.deps.forkSession = vi.fn(async () => { throw new BtwError('fork_failed', 'bootstrap exited (code 1)') })
      h.state = { sessionId: 'sid-b5', sessionFile: join(fx, 't', 'w.jsonl') }

      const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

      expect(res.snapshotKind).toBe('no-source')
      expect(h.deps.forkSession).toHaveBeenCalledTimes(1)
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('falling back to no-snapshot line'))
    })
  })

  describe('分支③：源含进行中 turn → 截断快照标记', () => {
    it('源含悬空 tool-call → kind=truncated（fixture 文件驱动）', async () => {
      const src = writeSessionFile(join(fx, 'src'), 'main.jsonl', {
        type: 'session', version: 3, id: MAIN_SID, timestamp: 't', cwd: CWD,
      }, danglingEntries())
      h.deps.resolveMainSessionFile = vi.fn(() => src)
      const forkFile = writeSessionFile(join(fx, 'fork'), 'fork.jsonl', {
        type: 'session', version: 3, id: 'sid-f3', timestamp: 't', cwd: CWD, parentSession: src,
      }, danglingEntries())
      h.deps.forkSession = vi.fn(async () => forkFile)
      h.state = { sessionId: 'sid-f3', sessionFile: forkFile }

      const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })
      expect(res.snapshotKind).toBe('truncated')
      // fork 文件本身逐字节保留（截断 = 落盘即止，不改写）
      expect(existsSync(forkFile)).toBe(true)
    })

    it('干净源 + 调用方 mainTurnActive 信号 → kind=truncated（纯文本流式增强通道）', async () => {
      const { forkFile } = stubCleanSource()
      h.state = { sessionId: 'sid-f1', sessionFile: forkFile }
      const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD, mainTurnActive: true })
      expect(res.snapshotKind).toBe('truncated')
    })
  })

  describe('失败路径（fail-fast + 收尸）', () => {
    it('get_state 缺 sessionId/sessionFile → spawn_state_invalid + 进程收尸', async () => {
      h.deps.resolveMainSessionFile = vi.fn(() => undefined)
      h.state = {}
      await expect(svc.createLine({ mainSid: MAIN_SID, cwd: CWD })).rejects.toMatchObject({ code: 'spawn_state_invalid' })
      expect(h.destroyed).toEqual([h.spawned[0].key])
      expect(svc.listLines(MAIN_SID)).toEqual([])
    })

    it('附着会话 id ≠ fork header id → state_mismatch + 收尸（进程绑错 = 实现 bug 拦截）', async () => {
      const { forkFile } = stubCleanSource()
      h.state = { sessionId: 'sid-OTHER', sessionFile: forkFile }
      await expect(svc.createLine({ mainSid: MAIN_SID, cwd: CWD })).rejects.toMatchObject({ code: 'state_mismatch' })
      expect(h.destroyed).toContain(h.spawned[0].key)
      expect(svc.listLines(MAIN_SID)).toEqual([])
    })
  })
})

// ════════════════ 来源: btw-fork-cli.test.ts ════════════════

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `btw-fork-cli${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}`,
  () => {
  const MAIN_SID = 'main-sid-001'
  const CWD = '/Users/x/proj'

  let restoreDataDir: () => void
  let fx: string
  let scriptDir: string

  beforeEach(() => {
    restoreDataDir = useTmpDataDir()
    fx = makeTmpDir()
    scriptDir = mkdtempSync(join(tmpdir(), 'taiji-btw-fakepi-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanupDir(fx)
    rmSync(scriptDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    restoreDataDir()
    vi.restoreAllMocks()
  })

  /** 写 fake pi 脚本（node shebang；把 argv 落盘供断言；行为由 mode 决定）。 */
  function writeFakePi(name: string, body: string): string {
    const file = join(scriptDir, name)
    writeFileSync(file, `#!/usr/bin/env node\nconst fs = require('node:fs')\nconst args = process.argv.slice(2)\nfs.writeFileSync(${JSON.stringify(join(scriptDir, name + '.argv'))}, JSON.stringify(args))\n${body}\n`)
    chmodSync(file, 0o755)
    return file
  }

  const sleepCode = (ms: number) => `setTimeout(() => {}, ${ms})`

  describe('forkViaCliPi：一次性 fork bootstrap 机制', () => {
    it('探测到线目录内新增 .jsonl 即返回（pre-existing 文件不误认）+ argv 双旗标原样传递', async () => {
      const threadDir = join(fx, 'threadA')
      mkdirSync(threadDir, { recursive: true })
      writeFileSync(join(threadDir, 'pre-existing.jsonl'), '{}\n') // 已有文件
      const src = join(fx, 'src.jsonl')
      writeFileSync(src, '{"type":"session"}\n')
      const script = writeFakePi('ok.js', `
        const dir = args[args.indexOf('--session-dir') + 1]
        fs.mkdirSync(dir, { recursive: true })
        setTimeout(() => {
          fs.writeFileSync(dir + '/2026T_fresh.jsonl', '{"type":"session","id":"fresh"}\\n')
        }, 30)
        ${sleepCode(5000)}
      `)

      const got = await forkViaCliPi({ piCommand: script, sourceFile: src, threadDir, cwd: fx, timeoutMs: 5000 })

      expect(got).toBe(join(threadDir, '2026T_fresh.jsonl')) // 新文件，不是 pre-existing
      const argv = JSON.parse(readFileSync(join(scriptDir, 'ok.js.argv'), 'utf8')) as string[]
      expect(argv).toEqual(['--mode', 'rpc', '--fork', src, '--session-dir', threadDir])
    })

    it('bootstrap 异常退出（无文件）→ BtwError fork_failed 携带 stderr（调用方回落分支②）', async () => {
      const script = writeFakePi('fail.js', `process.stderr.write('Cannot fork: source session file is empty or invalid\\n')\nprocess.exit(1)`)

      await expect(
        forkViaCliPi({ piCommand: script, sourceFile: '/nope.jsonl', threadDir: join(fx, 't2'), cwd: fx }),
      ).rejects.toMatchObject({ code: 'fork_failed', message: expect.stringContaining('exited (code 1)') })
      expect(readFileSync(join(scriptDir, 'fail.js.argv'), 'utf8')).toContain('--fork')
    })

    it('piCommand 不存在（spawn ENOENT）→ 快速 BtwError fork_failed（不 uncaught、不空等到超时）', async () => {
      await expect(
        forkViaCliPi({ piCommand: join(fx, 'no-such-pi-binary'), sourceFile: '/x.jsonl', threadDir: join(fx, 't5'), cwd: fx }),
      ).rejects.toMatchObject({ code: 'fork_failed', message: expect.stringContaining('spawn failed') })
    })

    it('超时 → BtwError fork_failed timed out（控制范围秒级有界，规则 #19）', async () => {
      const script = writeFakePi('hang.js', sleepCode(30000))

      const t0 = Date.now()
      await expect(
        forkViaCliPi({ piCommand: script, sourceFile: '/any.jsonl', threadDir: join(fx, 't3'), cwd: fx, timeoutMs: 400 }),
      ).rejects.toMatchObject({ code: 'fork_failed', message: expect.stringContaining('timed out after 400ms') })
      expect(Date.now() - t0).toBeLessThan(5000)
    })

    it('SIGTERM 被目标 handler 吞掉不退 → 宽限后升级 SIGKILL 仍返回（成功分支不挂死）', async () => {
      const threadDir = join(fx, 'threadStubborn')
      const src = join(fx, 'src.jsonl')
      writeFileSync(src, '{"type":"session"}\n')
      const sigLog = join(scriptDir, 'sigterm-received')
      // fake pi 注册 SIGTERM handler 吞信号（极端形态：默认 node 收 SIGTERM 即退，此处构造不退）
      const script = writeFakePi('stubborn.js', `
        process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(sigLog)}, 'term') })
        const dir = args[args.indexOf('--session-dir') + 1]
        fs.mkdirSync(dir, { recursive: true })
        setTimeout(() => {
          fs.writeFileSync(dir + '/2026T_stubborn.jsonl', '{"type":"session","id":"sb"}\\n')
        }, 20)
        ${sleepCode(30000)}
      `)

      const t0 = Date.now()
      const got = await forkViaCliPi({ piCommand: script, sourceFile: src, threadDir, cwd: fx, timeoutMs: 5000, killGraceMs: 300 })

      expect(got).toBe(join(threadDir, '2026T_stubborn.jsonl'))
      expect(readFileSync(sigLog, 'utf8')).toBe('term') // SIGTERM 确已送达且被吞
      expect(Date.now() - t0).toBeLessThan(5000) // SIGKILL 升级后返回，不无限 pending
    })
  })

  describe('createLine 默认 fork 装配链（resolvePiCommand → forkViaCliPi → 附着）', () => {
    it('deps 未注入 forkSession 时走 CLI bootstrap 全链', async () => {
      const h: BtwHarness = makeHarness()
      const svc = new BtwService(h.deps)
      try {
        // forkViaCliPi 的 spawn cwd = 线 cwd——必须是真实存在的目录（不存在 → spawn ENOENT）
        const cwd = join(fx, 'proj')
        mkdirSync(cwd, { recursive: true })
        const src = join(fx, 'src.jsonl')
        writeFileSync(src, '{"type":"session","id":"main"}\n{"type":"message","id":"e1"}\n')
        h.deps.resolveMainSessionFile = vi.fn(() => src)
        const threadDir = getBtwThreadDir(MAIN_SID)
        const forkFile = join(threadDir, '2026T_cli.jsonl')
        // fake pi：双旗标启动后往线目录写带 header 的 fork 文件（id=cli），随后保活待收
        const chainBody = `
          const dir = args[args.indexOf('--session-dir') + 1]
          fs.mkdirSync(dir, { recursive: true })
          setTimeout(() => {
            fs.writeFileSync(dir + '/2026T_cli.jsonl', JSON.stringify({type:'session',id:'cli',cwd:${JSON.stringify(cwd)}}) + '\\n')
          }, 20)
          ${sleepCode(5000)}
        `
        h.deps.resolvePiCommand = () => writeFakePi('chain.js', chainBody)
        // get_state 读回须与 fork header id 一致（附着一致性检查）
        h.state = { sessionId: 'cli', sessionFile: forkFile }
        h.deps.forkSession = undefined // 强制走默认 CLI 链

        const res = await svc.createLine({ mainSid: MAIN_SID, cwd })

        expect(res).toMatchObject({ sessionId: 'cli', snapshotKind: 'forked', sessionFilePath: forkFile })
        expect(existsSync(forkFile)).toBe(true)
        expect(h.spawned[0].client.switchSession).toHaveBeenCalledWith(forkFile)
        expect(h.registered[0]).toMatchObject({ id: 'cli', surface: 'btw' })
        // argv 双旗标原样传递（V2① 同款组合）
        const argv = JSON.parse(readFileSync(join(scriptDir, 'chain.js.argv'), 'utf8')) as string[]
        expect(argv).toEqual(['--mode', 'rpc', '--fork', src, '--session-dir', threadDir])
      } finally {
        svc.dispose()
      }
    })
  })
})

// ════════════════ 来源: btw-no-abort.test.ts ════════════════

describe('btw-no-abort', () => {
  const MAIN_SID = 'main-sid-001'
  const CWD = '/Users/x/proj'

  let restoreDataDir: () => void
  let fx: string
  let h: BtwHarness
  let svc: BtwService

  beforeEach(() => {
    restoreDataDir = useTmpDataDir()
    fx = makeTmpDir()
    h = makeHarness()
    svc = new BtwService(h.deps)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    svc.dispose()
    cleanupDir(fx)
    restoreDataDir()
    vi.restoreAllMocks()
  })

  describe('P-no-abort 结构侧：建线路径与主会话零耦合', () => {
    it('deps 无主进程通道时 createLine 照常完成 + 主会话文件字节级不变', async () => {
      // 主会话 fixture（模拟主 turn 落盘中：含分支 + 悬空 tool-call）
      const mainFile = writeSessionFile(join(fx, 'main'), 'main.jsonl', {
        type: 'session', version: 3, id: MAIN_SID, timestamp: 't', cwd: CWD,
      }, cleanEntries())
      const before = readFileSync(mainFile)
      h.deps.resolveMainSessionFile = vi.fn(() => mainFile)
      const forkFile = writeSessionFile(join(fx, 'fork'), 'fork.jsonl', {
        type: 'session', version: 3, id: 'sid-n1', timestamp: 't', cwd: CWD, parentSession: mainFile,
      }, cleanEntries())
      h.deps.forkSession = vi.fn(async () => forkFile)
      h.state = { sessionId: 'sid-n1', sessionFile: forkFile }

      // deps 全集只含进程/注册/解析/追踪面——不存在任何「向主进程发命令」的通道（构造性证明）
      expect(Object.keys(h.deps).sort()).toEqual([
        'buildLineSpawnOptions', 'forkSession', 'processes',
        'registerSession', 'resolveMainSessionFile', 'resolvePiCommand', 'traceContractInjection',
        'trashDirectory', // D5 线树软删通道（C-comm-03 deps 注入形态；仍非主进程命令通道）
        // W5：onWillReclaim 挂点随闲置回收机制残留删除（ADR-0122 清查收尾）已不在 deps 面
      ])

      const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

      // 主会话文件字节级不变（宿主零直写；pi fork 只读源）
      expect(readFileSync(mainFile)).toEqual(before)
      // fork 交接是只读 handoff：源路径原样传递
      expect(h.deps.forkSession).toHaveBeenCalledWith({ sourceFile: mainFile, threadDir: expect.any(String), cwd: CWD })
      // 进程键从不使用主会话 id（不 touch 主进程的 ProcessManager 条目）
      for (const key of [...h.spawned.map(s => s.key), ...h.rekeyed.map(([, to]) => to)]) {
        expect(key).not.toBe(MAIN_SID)
      }
      expect(res.sessionId).toBe('sid-n1')
    })

    it('建线只产生 btw 自己的进程条目（spawn 键 = btw 临时键，rekey 到线 pi 真实 id）', async () => {
      h.deps.resolveMainSessionFile = vi.fn(() => undefined)
      h.state = { sessionId: 'sid-n2', sessionFile: join(fx, 't', 'x.jsonl') }

      await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

      expect(h.spawned).toHaveLength(1)
      expect(h.rekeyed[0][0]).toMatch(/^btw-create-/)
      expect(h.rekeyed[0][1]).toBe('sid-n2') // rekey 目标 = 线 pi 真实 id（W4a：pm 键 ≡ 注册 id）
      // 主进程 destroy 面零触达：destroyed 只可能含 btw 自己的键（临时键或线 pi 真实 id）
      expect(h.destroyed.every(k => k.startsWith('btw-create-') || k === 'sid-n2')).toBe(true)
    })
  })
})

// ════════════════ 来源: btw-pi-fork-semantics.test.ts ════════════════

describe('btw-pi-fork-semantics', () => {
  const dirs: string[] = []
  function tmp(): string { const d = makeTmpDir('taiji-btw-pifork-'); dirs.push(d); return d }
  afterEach(() => { while (dirs.length) cleanupDir(dirs.pop()!) })

  function readJsonl(file: string): Record<string, unknown>[] {
    return readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
  }

  describe('pi 原生 forkFrom（实装 0.84.4）—— P-fork-equivalence / P-fork-source', () => {
    it('全树复制：含分支 fixture 逐字节等价 + parentSession=源 + 新 id（P-fork-equivalence）', () => {
      const root = tmp()
      const proj = join(root, 'proj')
      mkdirSync(proj, { recursive: true })
      const srcEntries = danglingEntries() // 含分支 e1→[e2|e3] + 悬空 tool-call
      const src = writeSessionFile(root, 'src.jsonl', {
        type: 'session', version: 3, id: 'main-src-001', timestamp: '2026-09-22T00:00:00.000Z', cwd: proj,
      }, srcEntries)
      const threadDir = join(root, 'threadA')

      const mgr = SessionManager.forkFrom(src, proj, threadDir)
      const forkedFile = mgr.getSessionFile()!
      expect(forkedFile.startsWith(threadDir)).toBe(true)
      expect(existsSync(forkedFile)).toBe(true)

      const lines = readJsonl(forkedFile)
      const header = lines[0] as { type: string; id: string; parentSession: string }
      expect(header.type).toBe('session')
      expect(header.id).not.toBe('main-src-001')
      expect(header.parentSession).toBe(src)
      // 逐字节等价：非 header entry 集 = 源全集（含分支 e3、悬空 tool-call e2）
      expect(lines.slice(1)).toEqual(srcEntries)
      expect(lines.some(l => l.id === 'e3')).toBe(true)
    })

    it('源缺失 / 空文件 → pi 显式 throw，不产目标文件（P-fork-source 分支② 依据）', () => {
      const root = tmp()
      const missing = join(root, 'missing.jsonl')
      expect(() => SessionManager.forkFrom(missing, root, join(root, 't1'))).toThrow(/empty or invalid/)

      const empty = join(root, 'empty.jsonl')
      writeFileSync(empty, '')
      expect(() => SessionManager.forkFrom(empty, root, join(root, 't2'))).toThrow(/empty or invalid/)

      expect(existsSync(join(root, 't1'))).toBe(false)
      expect(existsSync(join(root, 't2'))).toBe(false)
    })

    it('header-only 源：pi 产出零 entry 快照（边界），宿主前置判 unavailable 更严（G2 防线）', () => {
      const root = tmp()
      const headerOnly = writeSessionFile(root, 'header-only.jsonl', {
        type: 'session', version: 3, id: 'main-hdr-001', timestamp: 't', cwd: root,
      }, [])
      // pi 边界行为（实证）：零非 header entry 不 throw → 产出仅 header 的 fork 文件
      const mgr = SessionManager.forkFrom(headerOnly, root, join(root, 't3'))
      const lines = readJsonl(mgr.getSessionFile()!)
      expect(lines.length).toBe(1)
      // 宿主侧 inspectSourceState 判 empty → createLine 回落无 fork 分支（不产空上下文线）
      expect(inspectSourceState(headerOnly)).toEqual({ state: 'unavailable', reason: 'empty' })
    })

    it('inspectSourceState：ok 态含分支 + 悬空判定；缺失/未解析/尾部半行容忍', () => {
      const root = tmp()
      const src = writeSessionFile(root, 'src.jsonl', {
        type: 'session', version: 3, id: 'm-1', timestamp: 't', cwd: root,
      }, danglingEntries())
      expect(inspectSourceState(src)).toEqual({ state: 'ok', hasDanglingToolCall: true })

      const clean = writeSessionFile(root, 'clean.jsonl', {
        type: 'session', version: 3, id: 'm-2', timestamp: 't', cwd: root,
      }, cleanEntries())
      expect(inspectSourceState(clean)).toEqual({ state: 'ok', hasDanglingToolCall: false })

      expect(inspectSourceState(undefined)).toEqual({ state: 'unavailable', reason: 'unresolved' })
      expect(inspectSourceState(join(root, 'nope.jsonl'))).toEqual({ state: 'unavailable', reason: 'missing' })

      appendFileSync(clean, '{"type":"message","id":"partial')
      expect(inspectSourceState(clean)).toEqual({ state: 'ok', hasDanglingToolCall: false })
    })
  })
})

// ════════════════ 来源: btw-registry.test.ts ════════════════

describe('btw-registry', () => {
  const PROJ_A = '/Users/x/proj-a'
  const PROJ_B = '/Users/x/proj-b'

  let restoreDataDir: () => void
  let fx: string
  let h: BtwHarness
  let svc: BtwService

  beforeEach(() => {
    restoreDataDir = useTmpDataDir()
    fx = makeTmpDir()
    h = makeHarness()
    svc = new BtwService(h.deps)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    svc.dispose()
    cleanupDir(fx)
    restoreDataDir()
    vi.restoreAllMocks()
  })

  function seedThread(mainSid: string, lineSid: string, cwd: string, entries = cleanEntries()): string {
    // cwd 不再参与布局（mainSid 即分区键），仅作为 header 字段被重建读回
    const dir = getSessionBtwDir(mainSid)
    mkdirSync(dir, { recursive: true })
    return writeSessionFile(dir, `2026-09-22T00-00-00-000Z_${lineSid}.jsonl`, {
      type: 'session', version: 3, id: lineSid, timestamp: 't', cwd,
    }, entries)
  }

  describe('rebuildFromDisk：启动目录扫描重建', () => {
    it('按 <root>/<mainSid>/btw/*.jsonl 重建：session id（= header id）/header cwd/mainSid 目录 + surface 复原', () => {
      seedThread('main-a', 'line-1', PROJ_A)
      seedThread('main-b', 'line-2', PROJ_B)

      const rebuilt = svc.rebuildFromDisk()

      expect(rebuilt).toHaveLength(2)
      const byId = new Map(rebuilt.map(r => [r.piSessionId, r]))
      expect(byId.get('line-1')).toMatchObject({
        piSessionId: 'line-1', mainSid: 'main-a', cwd: PROJ_A, surface: 'btw',
        snapshotKind: 'unknown', contractRounds: 0,
        threadDir: getBtwThreadDir('main-a'),
      })
      expect(byId.get('line-1')!.client).toBeUndefined() // 重建不 spawn（惰性）
      expect(byId.get('line-2')).toMatchObject({ mainSid: 'main-b', cwd: PROJ_B, surface: 'btw' })
      // sessionFilePath 指向真实文件
      expect(byId.get('line-1')!.sessionFilePath).toContain('main-a')
    })

    it('listLines(mainSid) 按归属过滤 + createdAt 升序', () => {
      seedThread('main-a', 'line-1', PROJ_A)
      seedThread('main-a', 'line-2', PROJ_A)
      seedThread('main-b', 'line-9', PROJ_B)
      svc.rebuildFromDisk()

      expect(svc.listLines('main-a').map(l => l.piSessionId)).toEqual(['line-1', 'line-2'])
      expect(svc.listLines('main-b').map(l => l.piSessionId)).toEqual(['line-9'])
      expect(svc.listAllLines()).toHaveLength(3)
    })

    it('幂等：重复扫描不产重复条目（活跃条目优先不覆盖）', () => {
      seedThread('main-a', 'line-1', PROJ_A)
      expect(svc.rebuildFromDisk()).toHaveLength(1)
      expect(svc.rebuildFromDisk()).toHaveLength(0) // 已登记 → 不重复产出
      expect(svc.listAllLines()).toHaveLength(1)
    })

    it('坏文件 / 无 cwd header / 非法 sid / 非 sid 目录名 → warn 跳过（登记不静默）', () => {
      seedThread('main-a', 'line-1', PROJ_A)
      const root = getSessionStoreDir()
      const btwDir = getSessionBtwDir('main-a')
      // 无法解析的 jsonl
      writeFileSync(join(btwDir, 'broken.jsonl'), 'not-json\n')
      // header 无 cwd
      writeSessionFile(btwDir, 'nocwd.jsonl', { type: 'session', version: 3, id: 'line-x' }, cleanEntries())
      // 非 sid 目录名（新布局一级即 sessionId 分区；树内遍历规约：非合法形态跳过不代删）
      mkdirSync(join(root, 'not a sid!'), { recursive: true })
      // 非法 header id（含冒号 → isPiSessionId 拒，W4a 后注册键 = header id 原样）
      writeSessionFile(btwDir, 'badid.jsonl', { type: 'session', version: 3, id: 'btw:evil', cwd: PROJ_A }, cleanEntries())

      const rebuilt = svc.rebuildFromDisk()

      expect(rebuilt.map(r => r.piSessionId)).toEqual(['line-1'])
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('skip unparsable'))
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('without cwd'))
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('non-session dir name'))
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('invalid session id'))
    })

    it('空存储树（首启无树）→ []', () => {
      expect(svc.rebuildFromDisk()).toEqual([])
      expect(existsSync(getSessionStoreDir())).toBe(false)
    })

    it('无 btw 域目录的会话分区跳过（常态：主会话树无线）', () => {
      const root = getSessionStoreDir()
      mkdirSync(join(root, 'main-plain', 'attachments'), { recursive: true }) // 只有其他域
      expect(svc.rebuildFromDisk()).toEqual([])
    })

    it('重建条目 reattach 轮 surface:btw 注册（surface 复原经既有 registerSession）', async () => {
      const file = seedThread('main-a', 'line-1', PROJ_A)
      svc.rebuildFromDisk()
      h.state = { sessionId: 'line-1', sessionFile: file }

      const client = await svc.ensureProcess('line-1')

      expect(client).toBeDefined()
      expect(h.spawned[0].client.switchSession).toHaveBeenCalledWith(file)
      expect(h.registered[0]).toMatchObject({ id: 'line-1', surface: 'btw', file, cwd: PROJ_A })
      expect(h.spawned[0].options.env?.PI_CODING_AGENT_SESSION_DIR).toBe(getBtwThreadDir('main-a'))
      expect(svc.getLine('line-1')!.contractRounds).toBe(1)
    })
  })
})

// ════════════════ 来源: btw-surface-dual-write.test.ts ════════════════

describe('btw-surface-dual-write', () => {
  const MAIN_SID = 'main-sid-w3'
  const CWD = '/Users/x/proj-w3'

  let restoreDataDir: () => void
  let fx: string
  let h: BtwHarness
  let svc: BtwService

  beforeEach(() => {
    restoreDataDir = useTmpDataDir()
    fx = makeTmpDir()
    h = makeHarness()
    svc = new BtwService(h.deps)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    svc.dispose()
    cleanupDir(fx)
    restoreDataDir()
    vi.restoreAllMocks()
  })

  /** 分支② 形态建线（无 fork；state 给定 sid + 真实存在的线文件路径）。
   *  W4a 键统一：返回线 session id（= pi 真实 id）。 */
  async function createNoForkLine(fileSid: string): Promise<{ sessionId: string; file: string }> {
    h.deps.resolveMainSessionFile = vi.fn(() => undefined)
    const file = writeSessionFile(join(fx, 'thread'), `${fileSid}.jsonl`, {
      type: 'session', version: 3, id: fileSid, timestamp: 't', cwd: CWD,
    }, [])
    h.state = { sessionId: fileSid, sessionFile: file }
    const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })
    return { sessionId: res.sessionId, file: res.sessionFilePath }
  }

  /** surface 断言（三条路径共用）：注册表记录 surface==='btw'。 */
  function expectBtwSurface(rec: { surface?: string } | undefined): void {
    expect(rec).toBeDefined()
    expect(rec!.surface).toBe('btw')
  }

  describe('W3 surface 落地：btw 线注册表记录 surface（验收项 10③，W5 hidden 退场后收敛为单字段）', () => {
    it('写路径①createLine：注册表记录 surface=btw + registerSession 第 6 参显式传 btw', async () => {
      const { sessionId } = await createNoForkLine('sid-create')

      // 注册表记录回读（btwService.getLine，runtime 层直取不经协议）
      expectBtwSurface(svc.getLine(sessionId))
      // btw 直注册链：deps.registerSession 调用带 surface='btw'（6 参形态）
      expect(h.registered).toHaveLength(1)
      expect(h.registered[0]).toMatchObject({ id: sessionId, surface: 'btw' })
      expect(h.registered[0].argc).toBe(6)
    })

    it('写路径②ensureProcess（reattach）：重附着后 surface 仍成立', async () => {
      const { sessionId } = await createNoForkLine('sid-reattach')
      svc.getLine(sessionId)!.client = undefined // 摘进程引用造重附着入口

      await svc.ensureProcess(sessionId)

      // 记录对象幂等重写 + registerSession 第 6 参再次显式传 btw
      expectBtwSurface(svc.getLine(sessionId))
      expect(h.registered).toHaveLength(2)
      expect(h.registered[1]).toMatchObject({ id: sessionId, surface: 'btw' })
    })

    it('写路径③rebuildFromDisk（重启重建）：重建条目 surface=btw', async () => {
      // 直接往磁盘树 <root>/<mainSid>/btw/*.jsonl 落一条线文件（root = tmp 数据目录下的
      // ext-sessions 存储树）——rebuildFromDisk 的扫描源；新 BtwService 实例 = 重启后的
      // 空注册表，rebuild 从磁盘树重建。
      const lineSid = 'sid-rebuild'
      const dir = getSessionBtwDir(MAIN_SID)
      writeSessionFile(dir, `2026-09-22T00-00-00-000Z_${lineSid}.jsonl`, {
        type: 'session', version: 3, id: lineSid, timestamp: 't', cwd: CWD,
      }, [])
      const svc2 = new BtwService(h.deps)

      const rebuilt = svc2.rebuildFromDisk()

      // W4a 键统一：注册键 = 线 session id（= header id 原样）
      expect(rebuilt.map(r => r.piSessionId)).toContain(lineSid)
      expectBtwSurface(svc2.getLine(lineSid))
      expect(svc2.getLine(lineSid)!.piSessionId).toBe(lineSid)
      svc2.dispose()
    })

    it('三路径合流：create → reattach → rebuild 后同一线的 surface 恒为 btw（终身不可变）', async () => {
      const { sessionId } = await createNoForkLine('sid-immutable')
      expectBtwSurface(svc.getLine(sessionId))

      svc.getLine(sessionId)!.client = undefined
      await svc.ensureProcess(sessionId)
      expectBtwSurface(svc.getLine(sessionId))

      // 重启形态：把该线的磁盘条目落进 btw 目录后以新实例重建（createNoForkLine 的线文件
      // 在 fx 下、不在扫描范围，重建前显式播种）
      const lineSid = sessionId // W4a：线 id 即 pi 真实 id（旧 vid 去前缀翻译层已删）
      writeSessionFile(getSessionBtwDir(MAIN_SID), `2026-09-22T00-00-00-000Z_${lineSid}.jsonl`, {
        type: 'session', version: 3, id: lineSid, timestamp: 't', cwd: CWD,
      }, [])
      const svc2 = new BtwService(h.deps)
      svc2.rebuildFromDisk()
      expectBtwSurface(svc2.getLine(sessionId))
      svc2.dispose()
    })
  })
})
