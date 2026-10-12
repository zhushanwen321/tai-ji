/**
 * session-export-ipc 单测（ui-replica-demo-fidelity 待立项通道 1，2026-10-12 立项）。
 *
 * 覆盖（验收标准 1）：
 * - 正常复制成功：handler 返回 status='exported' + 产物路径 + 字节数（文件真实落盘，
 *   内容与源一致）
 * - 路径越界（三树之外）拒绝：EPATH + 不落任何文件（不 fallback）
 * - sessionFile 缺失：EINVALID 可消费错误（renderer 禁用入口外的纵深防御）
 * - 源文件不存在（树内路径）：具体 errno（ENOENT）可消费
 * - canceled 不产生文件
 * - 三树放行面：sessions / subagents / btw 三棵树内的路径都放行
 * - 默认文件名清洗：suggestedName 剥目录成分 + 非法字符清洗 + .jsonl 后缀保证
 * - 注册幂等：重复注册不重复 handle（防 Electron「second handler」炸启动）
 *
 * electron mock 捕获 ipcMain.handle（对齐 diagnostics-export-ipc.test.ts 形态）；main-logger
 * mock 掉（镜像日志会污染夹具目录）。复制走真实实现（fs-guard 生效中，夹具全部 mkdtemp
 * tmpdir 自建自删）。piAgentDir 经 TAIJI_AGENT_DATA_DIR env 注入（getPiAgentDir 缺省推导
 * = <dataDir>/agent，与生产同一条 SSOT 通道）。
 * 运行：cd apps/electron/main && npx vitest run sessions/__tests__/session-export-ipc.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 捕获注册的 handler（key=channel, value=handler fn），由 ipcMain.handle 桩写入
const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
  dialog: {},
  BrowserWindow: {},
}))

// main-logger mock：镜像日志落盘会写夹具目录，stub 掉保持内容确定性
vi.mock('../../logs/main-logger.js', () => ({
  mainLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { registerSessionExportHandler, buildDefaultFileName } from '../session-export-ipc.js'
import { SESSION_EXPORT_JSONL } from '@taiji/shared'
import type { SessionJsonlExportResult } from '@taiji/shared'

describe('session-export-ipc（session:export-jsonl）', () => {
  let tmpDir: string
  let savedDataDir: string | undefined
  let saveResult: { canceled: boolean; filePath?: string }
  let dialogShouldThrow = false
  /** 保存对话框收到的 defaultPath（默认文件名清洗断言读点） */
  let capturedDefaultPath: string | undefined

  beforeAll(() => {
    // 模块级 registered 标志：全文件单次注册；对话框行为经外层可变桩切换（对齐
    // diagnostics-export-ipc.test.ts 文件头说明）
    registerSessionExportHandler({
      showSaveDialog: async (options) => {
        capturedDefaultPath = options.defaultPath
        if (dialogShouldThrow) throw new Error('dialog crashed')
        return saveResult
      },
    })
  })

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'session-export-ipc-test-'))
    savedDataDir = process.env.TAIJI_AGENT_DATA_DIR
    // piAgentDir 权威推导链（生产同源）：getPiAgentDir() = <TAIJI_AGENT_DATA_DIR>/agent
    process.env.TAIJI_AGENT_DATA_DIR = tmpDir
    saveResult = { canceled: true }
    dialogShouldThrow = false
    capturedDefaultPath = undefined
  })

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = savedDataDir
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function invoke(payload?: unknown): Promise<SessionJsonlExportResult> {
    const handler = handlers.get(SESSION_EXPORT_JSONL)
    expect(handler, 'handler 应已注册到 session:export-jsonl 通道').toBeDefined()
    return handler!(undefined, payload) as Promise<SessionJsonlExportResult>
  }

  /** 在指定会话树（sessions/subagents/btw）下播种一个 JSONL 夹具，返回其绝对路径 */
  function seedSessionFile(tree: 'sessions' | 'subagents' | 'btw', relParts: string[], content = '{"type":"message"}\n'): string {
    const dir = join(tmpDir, 'agent', tree, ...relParts.slice(0, -1))
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, relParts[relParts.length - 1])
    writeFileSync(filePath, content)
    return filePath
  }

  it('正常复制成功：exported + 产物路径 + 字节数，文件真实落盘且内容一致', async () => {
    const src = seedSessionFile('sessions', ['c-proj-a', '2026-01-01T00-00-00_sid-1.jsonl'], '{"line":1}\n{"line":2}\n')
    const dest = join(tmpDir, 'exported.jsonl')
    saveResult = { canceled: false, filePath: dest }

    const result = await invoke({ sessionId: 'sid-1', sessionFile: src, suggestedName: '我的会话.jsonl' })

    expect(result.status).toBe('exported')
    if (result.status !== 'exported') return
    expect(result.path).toBe(dest)
    expect(result.bytes).toBe(statSync(src).size)
    expect(readFileSync(dest, 'utf8')).toBe('{"line":1}\n{"line":2}\n')
    // 对话框预填名 = suggestedName 原样透传（合法名不清洗改写）
    expect(capturedDefaultPath).toBe('我的会话.jsonl')
  })

  it('三树放行面：subagents / btw 两棵树内的路径同样放行导出', async () => {
    const subSrc = seedSessionFile('subagents', ['c-proj-b', 'sub-sid-1.jsonl'])
    saveResult = { canceled: false, filePath: join(tmpDir, 'out-sub.jsonl') }
    const subResult = await invoke({ sessionId: 'sub-sid-1', sessionFile: subSrc })
    expect(subResult.status).toBe('exported')

    const btwSrc = seedSessionFile('btw', ['c-proj-b', 'main-sid-1', 'btw-sid-1.jsonl'])
    saveResult = { canceled: false, filePath: join(tmpDir, 'out-btw.jsonl') }
    const btwResult = await invoke({ sessionId: 'btw-sid-1', sessionFile: btwSrc })
    expect(btwResult.status).toBe('exported')
  })

  it('路径越界（三树之外）拒绝：EPATH + 不落任何文件（不 fallback）', async () => {
    // 数据目录内但树外（logs/）——目录形似合法、树外即拒
    const outsideDir = join(tmpDir, 'logs')
    mkdirSync(outsideDir, { recursive: true })
    const outside = join(outsideDir, 'runtime.jsonl')
    writeFileSync(outside, 'secret')
    const dest = join(tmpDir, 'stolen.jsonl')
    saveResult = { canceled: false, filePath: dest }

    const result = await invoke({ sessionId: 'sid-1', sessionFile: outside })

    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.error.code).toBe('EPATH')
    expect(existsSync(dest)).toBe(false)
  })

  it('路径越界（相对路径）拒绝：非绝对路径不经对话框直接拒绝', async () => {
    const result = await invoke({ sessionId: 'sid-1', sessionFile: 'agent/sessions/rel.jsonl' })
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.error.code).toBe('EPATH')
    expect(capturedDefaultPath).toBeUndefined()
  })

  it('sessionFile 缺失：EINVALID 可消费错误（零 rejection 面纵深，不触对话框）', async () => {
    const result = await invoke({ sessionId: 'sid-1' })
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.error.code).toBe('EINVALID')
    expect(capturedDefaultPath).toBeUndefined()
  })

  it('源文件不存在（树内路径）：具体 errno（ENOENT）可消费', async () => {
    const missing = join(tmpDir, 'agent', 'sessions', 'c-x', 'ghost.jsonl')
    saveResult = { canceled: false, filePath: join(tmpDir, 'out.jsonl') }

    const result = await invoke({ sessionId: 'ghost', sessionFile: missing })

    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.error.code).toBe('ENOENT')
  })

  it('canceled 不产生文件：返回 canceled 三态，对话框未被绕过', async () => {
    const src = seedSessionFile('sessions', ['c-proj-a', 'sid-2.jsonl'])
    saveResult = { canceled: true }

    const result = await invoke({ sessionId: 'sid-2', sessionFile: src })

    expect(result).toEqual({ status: 'canceled' })
    expect(existsSync(join(tmpDir, 'sid-2.jsonl'))).toBe(false)
  })

  it('默认文件名清洗：剥目录成分 + 非法字符换下划线 + .jsonl 后缀保证 + 空值回退链', () => {
    // 目录成分剥除（对话框预填名不带路径逃逸面）
    expect(buildDefaultFileName('sid-1', '../../etc/passwd.jsonl')).toBe('passwd.jsonl')
    // 非法字符清洗（Windows 保留字符 + 控制字符域）
    expect(buildDefaultFileName('sid-1', 'a:b*c?.jsonl')).toBe('a_b_c_.jsonl')
    // 后缀保证：无后缀补 .jsonl
    expect(buildDefaultFileName('sid-1', '我的会话')).toBe('我的会话.jsonl')
    // 空清洗后回退 sessionId
    expect(buildDefaultFileName('sid-9', '///')).toBe('sid-9.jsonl')
    // 双空回退 'session'
    expect(buildDefaultFileName('', undefined)).toBe('session.jsonl')
  })

  it('对话框桩抛错：归一 EDIALOG 错误三态（零 rejection 面）', async () => {
    const src = seedSessionFile('sessions', ['c-proj-a', 'sid-3.jsonl'])
    dialogShouldThrow = true

    const result = await invoke({ sessionId: 'sid-3', sessionFile: src })

    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.error.code).toBe('EDIALOG')
  })

  it('注册幂等：重复调用 registerSessionExportHandler 不重复 handle', () => {
    registerSessionExportHandler()
    registerSessionExportHandler()
    expect([...handlers.keys()].filter((c) => c === SESSION_EXPORT_JSONL)).toHaveLength(1)
  })
})
