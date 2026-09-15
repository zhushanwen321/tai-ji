import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, it, expect } from 'vitest'
import {
  parseRegistryContent,
  corruptPathFor,
  readRegistry,
  atomicWriteRegistry,
  serializeRegistryFile,
  trimTerminalEntries,
  type RegistryFileLogFn,
} from './background-task-registry-file'
import {
  BACKGROUND_TASK_REGISTRY_VERSION,
  type BackgroundTaskRegistryEntry,
} from './background-task'

let tmpDir: string

function freshDir(): string {
  tmpDir = mkdtempSync(join('/tmp', 'ext-protocol-registry-test-'))
  return tmpDir
}

afterEach(() => {
  if (tmpDir !== undefined) {
    try {
      chmodSync(tmpDir, 0o755)
    } catch {
      /* 已清理 */
    }
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    tmpDir = undefined as unknown as string
  }
})

const entry = (taskId: string, overrides: Record<string, unknown> = {}): BackgroundTaskRegistryEntry => ({
  taskId,
  pid: 100 + Number(taskId.replace(/\D/g, '') || 0),
  command: 'sleep 30',
  outputFile: '/tmp/out.log',
  startedAt: 1_000,
  state: 'running',
  ownerPiPid: 1,
  sessionId: 's1',
  ...overrides,
})

function writeRegistryFile(path: string, content: string): void {
  mkdirSync(tmpDir, { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function collectLogs(): { events: Array<{ level: string; event: string; detail?: unknown }>; logger: RegistryFileLogFn } {
  const events: Array<{ level: string; event: string; detail?: unknown }> = []
  return { events, logger: (level, event, detail) => events.push({ level, event, detail }) }
}

describe('parseRegistryContent（解析防御）', () => {
  it('合法文件 → 归一化条目数组', () => {
    const raw = JSON.stringify({ version: BACKGROUND_TASK_REGISTRY_VERSION, entries: [entry('bt-1')] })
    expect(parseRegistryContent(raw)).toEqual([entry('bt-1')])
  })

  it.each([
    ['JSON 语法错误', '{not-json'],
    ['JSON 非对象', '"just-a-string"'],
    ['version 不匹配', JSON.stringify({ version: 99, entries: [] })],
    ['entries 非数组', JSON.stringify({ version: BACKGROUND_TASK_REGISTRY_VERSION, entries: {} })],
  ])('%s → undefined（走 corrupt 隔离路径）', (_label, raw) => {
    expect(parseRegistryContent(raw)).toBeUndefined()
  })

  it('单条脏数据丢弃、不报废全表（8 必填字段缺一即丢）', () => {
    const dirty = { ...entry('bt-2') }
    delete (dirty as Record<string, unknown>).ownerPiPid
    const raw = JSON.stringify({
      version: BACKGROUND_TASK_REGISTRY_VERSION,
      entries: [dirty, entry('bt-1')],
    })
    expect(parseRegistryContent(raw)).toEqual([entry('bt-1')])
  })
})

describe('corruptPathFor（.corrupt 落点不覆盖前一份现场）', () => {
  it('固定名 .corrupt 不存在时优先', () => {
    const dir = freshDir()
    expect(corruptPathFor(join(dir, 'registry.json'))).toBe(join(dir, 'registry.json.corrupt'))
  })

  it('.corrupt 已存在时带时间戳后缀', () => {
    const dir = freshDir()
    const registryPath = join(dir, 'registry.json')
    writeFileSync(`${registryPath}.corrupt`, 'previous scene', 'utf8')
    const path = corruptPathFor(registryPath)
    expect(path.startsWith(`${registryPath}.corrupt-`)).toBe(true)
    expect(Number(path.split('-').pop())).toBeGreaterThan(0)
  })
})

describe('readRegistry（超集形态 + corrupt 隔离 + onLog 注入）', () => {
  it('文件不存在 → 空表 + corrupted:false，无日志', () => {
    const dir = freshDir()
    const { events, logger } = collectLogs()
    expect(readRegistry(join(dir, 'registry.json'), logger)).toEqual({ entries: [], corrupted: false })
    expect(events).toEqual([])
  })

  it('合法文件 → 条目 + corrupted:false', () => {
    const dir = freshDir()
    const path = join(dir, 'registry.json')
    writeRegistryFile(path, JSON.stringify({ version: BACKGROUND_TASK_REGISTRY_VERSION, entries: [entry('bt-1')] }))
    const { events, logger } = collectLogs()
    const result = readRegistry(path, logger)
    expect(result.entries).toEqual([entry('bt-1')])
    expect(result.corrupted).toBe(false)
    expect(events).toEqual([])
  })

  it('损坏文件 → 隔离改名保留现场 + 空表 + corrupted:true + onLog warn（排障生命线）', () => {
    const dir = freshDir()
    const path = join(dir, 'registry.json')
    const broken = '{corrupted content'
    writeRegistryFile(path, broken)
    const { events, logger } = collectLogs()
    const result = readRegistry(path, logger)
    expect(result).toEqual({ entries: [], corrupted: true })
    expect(existsSync(path)).toBe(false)
    const corruptPath = `${path}.corrupt`
    expect(existsSync(corruptPath)).toBe(true)
    expect(readFileSync(corruptPath, 'utf8')).toBe(broken)
    expect(events).toHaveLength(1)
    expect(events[0].level).toBe('warn')
    expect(events[0].event).toContain('registry corrupted')
    expect(events[0].detail).toEqual({ path, corruptPath })
  })

  it('corrupt 固定名被占用时改名到时间戳落点，不覆盖前一份现场', () => {
    const dir = freshDir()
    const path = join(dir, 'registry.json')
    writeFileSync(`${path}.corrupt`, 'previous scene', 'utf8')
    writeRegistryFile(path, '{broken again')
    const { logger } = collectLogs()
    expect(readRegistry(path, logger).corrupted).toBe(true)
    expect(readFileSync(`${path}.corrupt`, 'utf8')).toBe('previous scene')
    const siblings = readdirSync(dir).filter((n) => n.startsWith('registry.json.corrupt-'))
    expect(siblings).toHaveLength(1)
    expect(readFileSync(join(dir, siblings[0]), 'utf8')).toBe('{broken again')
  })

  it('读失败（权限）→ 空表 + corrupted:false + onLog warn（降级非损坏）', () => {
    const dir = freshDir()
    const path = join(dir, 'registry.json')
    writeRegistryFile(path, 'unreadable')
    chmodSync(path, 0o000)
    try {
      const { events, logger } = collectLogs()
      const result = readRegistry(path, logger)
      expect(result).toEqual({ entries: [], corrupted: false })
      expect(events).toHaveLength(1)
      expect(events[0].event).toContain('registry read failed')
    } finally {
      chmodSync(path, 0o644)
    }
  })
})

describe('serializeRegistryFile（字节契约单点）', () => {
  it('version 锁定 + JSON indent 2 + 尾部换行（与两侧既有写侧字节形态逐字节一致）', () => {
    const serialized = serializeRegistryFile([entry('bt-1')])
    expect(serialized).toBe(
      `${JSON.stringify({ version: BACKGROUND_TASK_REGISTRY_VERSION, entries: [entry('bt-1')] }, null, 2)}\n`,
    )
    expect(serialized.endsWith('\n')).toBe(true)
    expect(serialized).toContain('\n  "version": 1')
  })
})

describe('atomicWriteRegistry（原子写协议）', () => {
  it('写入内容与传入 content 逐字节一致，无 tmp 残留', () => {
    const dir = freshDir()
    const path = join(dir, 'nested', 'registry.json')
    const content = serializeRegistryFile([entry('bt-1')])
    atomicWriteRegistry(path, content)
    expect(readFileSync(path, 'utf8')).toBe(content)
    expect(readdirSync(join(dir, 'nested')).filter((n) => n.includes('.tmp_'))).toEqual([])
  })

  it('rename 失败 → tmp 清理后向上抛原错误（降级决策留给锁壳层）', () => {
    const dir = freshDir()
    // registryPath 指向已存在非空目录 → rename 必失败（EISDIR/ENOTEMPTY）
    const target = join(dir, 'occupied')
    mkdirSync(target)
    writeFileSync(join(target, 'blocker'), 'x', 'utf8')
    const { logger } = collectLogs()
    expect(() => atomicWriteRegistry(target, '{}', logger)).toThrow()
    expect(readdirSync(target).filter((n) => n.includes('.tmp_'))).toEqual([])
  })
})

describe('trimTerminalEntries（终态 LRU 纯函数）', () => {
  it('超上限按 endedAt ?? startedAt 升序淘汰最老终态', () => {
    const entries = [
      entry('bt-old', { state: 'exited', startedAt: 100, endedAt: 200 }),
      entry('bt-mid', { state: 'exited', startedAt: 300, endedAt: 400 }),
      entry('bt-new', { state: 'orphaned', startedAt: 500, endedAt: 600 }),
    ]
    const kept = trimTerminalEntries(entries, 2)
    expect(kept.map((e) => e.taskId)).toEqual(['bt-mid', 'bt-new'])
  })

  it('endedAt 缺省回退 startedAt 参与排序', () => {
    const entries = [
      entry('bt-a', { state: 'exited', startedAt: 100 }),
      entry('bt-b', { state: 'exited', startedAt: 50 }),
    ]
    expect(trimTerminalEntries(entries, 1).map((e) => e.taskId)).toEqual(['bt-a'])
  })

  it('活跃条目（running/killing）永不淘汰', () => {
    const entries = [
      entry('bt-active', { state: 'running', startedAt: 1 }),
      entry('bt-t1', { state: 'exited', startedAt: 2, endedAt: 3 }),
      entry('bt-t2', { state: 'exited', startedAt: 4, endedAt: 5 }),
    ]
    const kept = trimTerminalEntries(entries, 1)
    expect(kept.map((e) => e.taskId)).toEqual(['bt-active', 'bt-t2'])
  })

  it('未超上限原样保留；入参数组不被修改', () => {
    const entries = [
      entry('bt-1', { state: 'exited', startedAt: 2, endedAt: 3 }),
      entry('bt-2', { state: 'exited', startedAt: 1 }),
    ]
    const snapshot = JSON.parse(JSON.stringify(entries))
    expect(trimTerminalEntries(entries, 50)).toEqual(entries)
    expect(entries).toEqual(snapshot)
  })

  it('同为终态时 max=0 全淘汰', () => {
    const entries = [entry('bt-1', { state: 'exited', startedAt: 1 })]
    expect(trimTerminalEntries(entries, 0)).toEqual([])
  })
})
