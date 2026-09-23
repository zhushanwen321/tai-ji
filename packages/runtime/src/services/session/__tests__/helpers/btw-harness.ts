/**
 * btw-service 测试基建（M1-b）：依赖 fake 装配 + tmp 数据目录隔离 + fixture 写入。
 *
 * 防线遵循（AGENTS.md 测试红线）：写删目标全部 `mkdtempSync(join(tmpdir(), ...))`
 * 自建自删；`TAIJI_AGENT_DATA_DIR` 在测试内改指 tmp 子目录（fs-guard 白名单 =
 * tmpdir() 动态跟随，getDataDir 每次读 env 无缓存），afterEach restore。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { IPiEngine, PiSessionOptions } from '../../../ports/pi-engine.js'
import type {
  BtwContractInjectionTrace,
  BtwLineSpawnContext,
  BtwServiceDeps,
} from '../../btw-service.js'

/** 把 `TAIJI_AGENT_DATA_DIR` 改指全新 tmp 目录；返回 restore（含目录自删）。 */
export function useTmpDataDir(): () => void {
  const prev = process.env.TAIJI_AGENT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'taiji-btw-data-'))
  process.env.TAIJI_AGENT_DATA_DIR = dir
  return () => {
    if (prev === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = prev
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

/** 新建独立 tmp 工作目录（fixture 会话文件等）。调用方负责清理（cleanupDir）。 */
export function makeTmpDir(prefix = 'taiji-btw-fx-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}

/** session JSONL fixture：header 行 + entry 行。 */
export function writeSessionFile(
  dir: string,
  name: string,
  header: Record<string, unknown>,
  entries: Record<string, unknown>[] = [],
): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  const lines = [JSON.stringify(header), ...entries.map(e => JSON.stringify(e))]
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

/** 干净源 fixture（无悬空 tool-call）。 */
export function cleanEntries(): Record<string, unknown>[] {
  return [
    { type: 'message', id: 'e1', parentId: 'h', message: { role: 'user', content: [{ type: 'text', text: 'q' }] } },
    { type: 'message', id: 'e2', parentId: 'e1', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } },
  ]
}

/** 含分支 + 悬空 tool-call 的源 fixture（分支③ 判定输入）。 */
export function danglingEntries(): Record<string, unknown>[] {
  return [
    { type: 'message', id: 'e1', parentId: 'h', message: { role: 'user', content: [{ type: 'text', text: 'q' }] } },
    { type: 'message', id: 'e2', parentId: 'e1', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: '{}' }] } },
    // 分支：e1 → [e2(未回工具结果) | e3] —— e3 证明全树分支，tc1 无结果证明半截 turn
    { type: 'message', id: 'e3', parentId: 'e1', message: { role: 'user', content: [{ type: 'text', text: 'branch-q' }] } },
  ]
}

/** fake pi 客户端（IPiEngine 子集；未列成员访问不到——服务只用 exited/lastActivityAt/getState/switchSession）。 */
export interface FakePiClient {
  raw: IPiEngine
  exited: boolean
  lastActivityAt: number
  getState: ReturnType<typeof vi.fn>
  switchSession: ReturnType<typeof vi.fn>
}

export function makeFakeClient(init?: { state?: Record<string, unknown>; lastActivityAt?: number }): FakePiClient {
  // 同一对象：服务持有的 raw 与测试侧 wrapper 必须是同一引用——否则改
  // wrapper.exited 影响不到服务读到的 client（spread 拷贝值字段会造出双状态）。
  const fake = {
    exited: false,
    lastActivityAt: init?.lastActivityAt ?? Date.now(),
    getState: vi.fn(async () => init?.state ?? {}),
    switchSession: vi.fn(async (_path: string) => {}),
  }
  return Object.assign(fake, { raw: fake as unknown as IPiEngine })
}

export interface SpawnRecord {
  key: string
  cwd: string
  options: PiSessionOptions
  client: FakePiClient
}

export interface RegisterRecord {
  id: string
  cwd: string
  label: string
  file: string | undefined
  hidden: boolean | undefined
  argc: number
}

export interface BtwHarness {
  deps: BtwServiceDeps
  spawned: SpawnRecord[]
  destroyed: string[]
  rekeyed: [string, string][]
  registered: RegisterRecord[]
  traces: BtwContractInjectionTrace[]
  reclaimed: string[]
  /** createSession 时读取的 get_state 返回值（每次 spawn 现读，可中途改）。 */
  state: Record<string, unknown>
  /** buildLineSpawnOptions 的基础返回值（可中途改）。 */
  baseOptions: PiSessionOptions
}

/**
 * 组装 BtwServiceDeps fake（全 vi.fn 可断言；overrides 覆盖单键）。
 * processes.createSession 每次产出新 fake client，其 getState 返回 harness.state。
 * [同一对象] deps 闭包捕获与返回值必须是同一对象——测试中途改 h.state / h.baseOptions
 * 才能被 spawn 读到（禁止 spread 拷贝：会造出 state 改了但闭包读旧壳的陷阱）。
 */
export function makeHarness(overrides?: Partial<BtwServiceDeps>): BtwHarness {
  const h: BtwHarness = {
    deps: undefined as unknown as BtwServiceDeps,
    spawned: [],
    destroyed: [],
    rekeyed: [],
    registered: [],
    traces: [],
    reclaimed: [],
    state: {},
    baseOptions: {},
  }
  h.deps = {
    processes: {
      createSession: vi.fn(async (key: string, cwd: string, options: PiSessionOptions) => {
        const client = makeFakeClient({ state: h.state })
        h.spawned.push({ key, cwd, options, client })
        return client.raw
      }),
      destroySession: vi.fn(async (key: string) => {
        h.destroyed.push(key)
        const rec = h.spawned.find(s => s.key === key)
        if (rec) rec.client.exited = true
      }),
      rekey: vi.fn((oldKey: string, newKey: string) => {
        h.rekeyed.push([oldKey, newKey])
        const rec = h.spawned.find(s => s.key === oldKey)
        if (rec) rec.key = newKey
      }),
      getClient: vi.fn(() => undefined),
    },
    buildLineSpawnOptions: vi.fn(async (_ctx: BtwLineSpawnContext) => ({ ...h.baseOptions })),
    registerSession: vi.fn(async (...args: unknown[]) => {
      const [id, , cwd, label, file, hidden] = args as [string, IPiEngine, string, string, string | undefined, boolean | undefined]
      h.registered.push({ id, cwd, label, file, hidden, argc: args.length })
      return {}
    }),
    resolveMainSessionFile: vi.fn(() => undefined),
    resolvePiCommand: () => 'pi-not-used-in-fake',
    forkSession: vi.fn(async () => { throw new Error('forkSession not stubbed by test') }),
    traceContractInjection: vi.fn((t: BtwContractInjectionTrace) => { h.traces.push(t) }),
    onWillReclaim: vi.fn((vid: string) => { h.reclaimed.push(vid) }),
    ...overrides,
  }
  return h
}
