/**
 * SessionHistoryReader btw 线离线尾读解析腿直测（btw-question 重载链缺陷修复）。
 *
 * 缺陷背景：重启后线进程不在场（pm.getClient(vid) null）→ 离线尾读走通用链
 * getHistoryTailFromFile → scanSessions 对 btw vid 构造性 miss（线目录在 G4 隔离面
 * `agent/btw/…`，不在 sessions/ 扫描面）→ 静默空 → 线视图空态（「持久化不改变可见性」
 * 裁决⑧被违背）。修复 = tailReadOffline 对 btw vid 先经 resolveBtwThreadFile（组合根接
 * BtwService 注册表）解析线文件，命中走同一 tailReadHistory 链；缺失/miss warn + 空页。
 *
 * 分层：不 mock session-history（尾读链对临时 jsonl 真跑——窗口/turn 边界/cursor 定位
 * 为被测行为的一部分）；fake 面 = pm（离线）+ sessionStore.convertHistory（entry→Message
 * 投影，转换链本体由 session-history 域自身测试覆盖）+ resolveBtwThreadFile（注册表缝）。
 * 非 btw vid 回归腿断言解析器零调用（分支收窄证明）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@taiji/shared'
import { btwVirtualId } from '@taiji/shared'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { ISessionStore } from '../../ports/session.js'
import { SessionHistoryReader } from '../history-rebuild-cache.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'btw-offline-tail-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** pi session message entry（jsonl 行）：type:'message' + message 体（turn 边界 = role:'user'）。 */
function messageEntry(id: string, role: 'user' | 'assistant', text: string): string {
  return JSON.stringify({
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-09-23T00:00:00.000Z',
    message: { role, content: [{ type: 'text', text }], timestamp: Date.now() },
  })
}

/**
 * fake convertHistory：entry.message 体 → Message（text parts 拼接为 content，供断言
 * 「文件里的内容被回放」）。透传 role，逐条编 id。
 */
function fakeConvertHistory(raw: unknown[]): Message[] {
  return raw.map((m, i) => {
    const body = m as { role?: string; content?: unknown }
    const text = Array.isArray(body.content)
      ? body.content
          .map((c) => (typeof c === 'object' && c !== null && (c as { text?: unknown }).text != null ? String((c as { text: unknown }).text) : ''))
          .join('')
      : String(body.content ?? '')
    return { id: `m-${i}`, role: body.role, content: text, status: 'complete', timestamp: 1 } as Message
  })
}

function makeOfflineReader(resolveBtwThreadFile?: (vid: string) => string | undefined) {
  const resolve = vi.fn(resolveBtwThreadFile)
  const sessionStore = {
    // 非 btw vid 回归腿走通用链 getHistoryTailFromFile → scanSessions（btw vid 不会走到）
    scanSessions: vi.fn(() => [] as Array<{ id: string; filePath: string }>),
    convertHistory: vi.fn((raw: unknown[]) => fakeConvertHistory(raw)),
  } as unknown as ISessionStore
  const reader = new SessionHistoryReader({
    pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager,
    sessionStore,
    resolveBtwThreadFile: resolve,
  })
  return { reader, resolve, sessionStore }
}

/** 写线会话文件并返回解析器 fake（按 vid 查注册表 → 文件路径）。 */
function seedThreadFile(name: string, lines: string[]): { registry: (vid: string) => string | undefined } {
  const file = join(dir, name)
  writeFileSync(file, lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf-8')
  return { registry: (vid) => (vid === vidFor(name) ? file : undefined) }
}

/** 测试约定：文件名 <name>.jsonl ↔ 线 pi sid = <name>（vid 第二段）。 */
function vidFor(name: string): string {
  return btwVirtualId(name)
}

describe('btw vid 离线尾读（btw 面解析腿）', () => {
  it('注册表命中 + 文件在场：entries 经同一尾读链回放（2 turns）', async () => {
    const { registry } = seedThreadFile('line-a', [
      messageEntry('e1', 'user', 'turn 1 q'),
      messageEntry('e2', 'assistant', 'turn 1 a'),
      messageEntry('e3', 'user', 'turn 2 q'),
      messageEntry('e4', 'assistant', 'turn 2 a'),
    ])
    const { reader, resolve } = makeOfflineReader(registry)
    const result = await reader.getHistory(vidFor('line-a'))
    expect(resolve).toHaveBeenCalledWith(vidFor('line-a'))
    expect(result.messages.map((m) => m.content)).toEqual(['turn 1 q', 'turn 1 a', 'turn 2 q', 'turn 2 a'])
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(result.truncated).toBe(false)
    expect(result.loadedTurns).toBe(2)
    expect(result.totalTurnsEstimate).toBe(2)
  })

  it('注册表命中但文件缺失：空页 + warn（含 vid 与期望路径）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const missing = join(dir, 'never-flushed.jsonl') // 故意不写盘
      const { reader } = makeOfflineReader(() => missing)
      const result = await reader.getHistory(vidFor('never-flushed'))
      expect(result).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
      const btwWarns = warnSpy.mock.calls.map((args) => args.join(' ')).filter((s) => s.includes('btw line session file missing'))
      expect(btwWarns).toHaveLength(1)
      expect(btwWarns[0]).toContain(vidFor('never-flushed'))
      expect(btwWarns[0]).toContain(missing)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('注册表 miss（未注入解析 / 无条目）：空页 + warn，不炸', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { reader, resolve } = makeOfflineReader(undefined)
      const result = await reader.getHistory(vidFor('unknown-line'))
      expect(result.messages).toEqual([])
      expect(resolve).toHaveBeenCalled()
      const btwWarns = warnSpy.mock.calls.map((args) => args.join(' ')).filter((s) => s.includes('no registry entry'))
      expect(btwWarns).toHaveLength(1)
      expect(btwWarns[0]).toContain(vidFor('unknown-line'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('合法空线（文件在场 0 字节）：空页且不触发 btw 文件缺失 warn（与异常态区分）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { registry } = seedThreadFile('empty-line', [])
      const { reader } = makeOfflineReader(registry)
      const result = await reader.getHistory(vidFor('empty-line'))
      expect(result).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
      expect(warnSpy.mock.calls.map((args) => args.join(' ')).some((s) => s.includes('btw line session file missing'))).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('cursor 游标翻页（离线 btw 线）：同一解析腿，返回锚点前最近窗口', async () => {
    const { registry } = seedThreadFile('line-cursor', [
      messageEntry('e1', 'user', 'turn 1'),
      messageEntry('e2', 'assistant', 'reply 1'),
      messageEntry('e3', 'user', 'turn 2'),
      messageEntry('e4', 'assistant', 'reply 2'),
    ])
    const { reader } = makeOfflineReader(registry)
    const page = await reader.getHistory(vidFor('line-cursor'), { cursor: 'e3', limitTurns: 2 })
    // e3 是最新 turn 起点：锚前窗口 = 第 1 个 turn（e1+e2），锚所在 turn 不返回
    expect(page.messages.map((m) => m.content)).toEqual(['turn 1', 'reply 1'])
    expect(page.loadedTurns).toBe(1)
    expect(page.truncated).toBe(false)
  })
})

describe('非 btw vid 回归腿（原行为不变）', () => {
  it('普通 sid 离线尾读：不触碰 btw 解析器，走通用链（scanSessions miss → 静默空）', async () => {
    const { reader, resolve, sessionStore } = makeOfflineReader(() => join(dir, 'should-not-matter.jsonl'))
    const result = await reader.getHistory('plain-session-id')
    expect(resolve).not.toHaveBeenCalled()
    expect(sessionStore.scanSessions).toHaveBeenCalledWith({ force: true })
    expect(result).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
  })

  it('subagent 三段式 vid 同样不走 btw 解析腿（分支收窄在 isBtwVirtualId）', async () => {
    const { reader, resolve } = makeOfflineReader(() => join(dir, 'should-not-matter.jsonl'))
    await reader.getHistory('subagent:main-1:sub-1')
    expect(resolve).not.toHaveBeenCalled()
  })
})
