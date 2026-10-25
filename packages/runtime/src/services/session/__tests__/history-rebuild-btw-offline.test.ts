/**
 * SessionHistoryReader btw 线离线尾读解析路径直测（btw-question 重载链缺陷修复）。
 *
 * 缺陷背景：重启后线进程不在场（pm.getClient(sessionId) null）→ 离线尾读走通用链
 * getHistoryTailFromFile → scanSessions 对 btw 线构造性 miss（线目录在 session 存储树侧
 * `<dataDir>/ext-sessions/<mainSid>/btw/`，公式 = getSessionBtwDir，不在 sessions/ 扫描
 * 范围）→ 静默空 → 线视图空态（「持久化不改变可见性」
 * 裁决⑧被违背）。修复 = tailReadOffline 对 btw 线先经 resolveBtwThreadFile（组合根接
 * BtwService 注册表成员查询）解析线文件，命中走同一 tailReadHistory 链；文件缺失 warn + 空页。
 *
 * W4a 键统一：判别器 = 解析器注入本身（resolveBtwThreadFile(sessionId) 命中即 btw 线分支，
 * 键 = 线 pi 真实会话 id；旧 isBtwVirtualId 前缀判别对 piId 形态恒 false，随键切换同批
 * 替换，设计 §3.3.6 迁移表）。未命中（主会话 / 未知 id）走通用链——「线不在注册表」与
 * 「主会话」在键统一后不可区分，统一按通用链处理（空页；renderer 侧另有空历史 warn）。
 *
 * 分层：不 mock session-history（尾读链对临时 jsonl 真跑——窗口/turn 边界/cursor 定位
 * 为被测行为的一部分）；fake 面 = pm（离线）+ sessionStore.convertHistory（entry→Message
 * 派生视图，转换链本体由 session-history 域自身测试覆盖）+ resolveBtwThreadFile（注册表缝）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@taiji/shared'
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

function makeOfflineReader(resolveBtwThreadFile?: (sessionId: string) => string | undefined) {
  const resolve = vi.fn(resolveBtwThreadFile)
  const sessionStore = {
    // 非 btw 线（主会话）回归路径走通用链 getHistoryTailFromFile → scanSessions
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

/** 写线会话文件并返回解析器 fake（按线 session id 查注册表 → 文件路径）。 */
function seedThreadFile(name: string, lines: string[]): { registry: (sessionId: string) => string | undefined } {
  const file = join(dir, name)
  writeFileSync(file, lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf-8')
  return { registry: (sessionId) => (sessionId === name ? file : undefined) }
}

describe('btw 线离线尾读（btw 面解析路径；W4a 判别器 = 注册表成员查询）', () => {
  it('注册表命中 + 文件在场：entries 经同一尾读链回放（2 turns）', async () => {
    const { registry } = seedThreadFile('line-a', [
      messageEntry('e1', 'user', 'turn 1 q'),
      messageEntry('e2', 'assistant', 'turn 1 a'),
      messageEntry('e3', 'user', 'turn 2 q'),
      messageEntry('e4', 'assistant', 'turn 2 a'),
    ])
    const { reader, resolve } = makeOfflineReader(registry)
    const result = await reader.getHistory('line-a')
    expect(resolve).toHaveBeenCalledWith('line-a') // 判别器即成员查询（W4a）
    expect(result.messages.map((m) => m.content)).toEqual(['turn 1 q', 'turn 1 a', 'turn 2 q', 'turn 2 a'])
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(result.truncated).toBe(false)
    expect(result.loadedTurns).toBe(2)
    expect(result.totalTurnsEstimate).toBe(2)
  })

  it('注册表命中但文件缺失：空页 + warn（含线 session id 与期望路径）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const missing = join(dir, 'never-flushed.jsonl') // 故意不写盘
      const { reader } = makeOfflineReader(() => missing)
      const result = await reader.getHistory('never-flushed')
      expect(result).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
      const btwWarns = warnSpy.mock.calls.map((args) => args.join(' ')).filter((s) => s.includes('btw line session file missing'))
      expect(btwWarns).toHaveLength(1)
      expect(btwWarns[0]).toContain('never-flushed')
      expect(btwWarns[0]).toContain(missing)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('判别器未命中（未注入解析 / 无条目）：走通用链空页，不炸（W4a 后与主会话不可区分）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { reader, resolve, sessionStore } = makeOfflineReader(undefined)
      const result = await reader.getHistory('unknown-line')
      expect(result.messages).toEqual([])
      expect(resolve).toHaveBeenCalledTimes(1) // 判别器即成员查询——调用一次、返 undefined
      expect(sessionStore.scanSessions).toHaveBeenCalledWith({ force: true }) // 落通用链
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('合法空线（文件在场 0 字节）：空页且不触发 btw 文件缺失 warn（与异常态区分）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { registry } = seedThreadFile('empty-line', [])
      const { reader } = makeOfflineReader(registry)
      const result = await reader.getHistory('empty-line')
      expect(result).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
      expect(warnSpy.mock.calls.map((args) => args.join(' ')).some((s) => s.includes('btw line session file missing'))).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('cursor 游标翻页（离线 btw 线）：同一解析路径，返回锚点前最近窗口', async () => {
    const { registry } = seedThreadFile('line-cursor', [
      messageEntry('e1', 'user', 'turn 1'),
      messageEntry('e2', 'assistant', 'reply 1'),
      messageEntry('e3', 'user', 'turn 2'),
      messageEntry('e4', 'assistant', 'reply 2'),
    ])
    const { reader } = makeOfflineReader(registry)
    const page = await reader.getHistory('line-cursor', { cursor: 'e3', limitTurns: 2 })
    // e3 是最新 turn 起点：锚前窗口 = 第 1 个 turn（e1+e2），锚所在 turn 不返回
    expect(page.messages.map((m) => m.content)).toEqual(['turn 1', 'reply 1'])
    expect(page.loadedTurns).toBe(1)
    expect(page.truncated).toBe(false)
  })
})

describe('附着 btw 线 RPC 失败降级的中断判定门禁（U8 tailReadOffline 剥除门禁）', () => {
  /** 附着态 reader：pm.getClient(线 id) 返回 getEntries 恒抛错的 fake client（活跃线 RPC 失败 → getLatestWindow catch → tailReadOffline 缺省关闭判定） */
  function makeAttachedReader(registry: (sessionId: string) => string | undefined) {
    const resolve = vi.fn(registry)
    const sessionStore = {
      scanSessions: vi.fn(() => [] as Array<{ id: string; filePath: string }>),
      convertHistory: vi.fn((raw: unknown[]) => fakeConvertHistory(raw)),
    } as unknown as ISessionStore
    const client = {
      getEntries: vi.fn(() => Promise.reject(new Error('rpc down'))),
    }
    const reader = new SessionHistoryReader({
      pm: { getClient: vi.fn(() => client) } as unknown as IProcessManager,
      sessionStore,
      resolveBtwThreadFile: resolve,
    })
    return { reader, client }
  }

  it('附着 btw 线 RPC 失败降级尾读：interrupted 不出场（判定前提「会话未附着」不成立——线尾 user entry 不得误标活线）', async () => {
    // 线文件尾 = user entry（中断形态）：若降级路径透传 interrupted，附着中的活线被误标
    const { registry } = seedThreadFile('attached-line', [
      messageEntry('e1', 'assistant', 'reply'),
      messageEntry('e2', 'user', 'generating'),
    ])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { reader, client } = makeAttachedReader(registry)
      const result = await reader.getHistory('attached-line')
      expect(client.getEntries).toHaveBeenCalled() // 确认走的是附着 RPC 降级链，非离线分支
      expect(result.messages.map((m) => m.content)).toEqual(['reply', 'generating'])
      // 剥除语义 = 值 undefined（消费方按 !== undefined 判「无判定」），非键删除
      expect(result.interrupted).toBeUndefined()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('对照：未附着（离线）同形态线文件中断判定照常出场（门禁只拦附着降级，不废 btw 判定链）', async () => {
    const { registry } = seedThreadFile('offline-line', [
      messageEntry('e1', 'assistant', 'reply'),
      messageEntry('e2', 'user', 'interrupted tail'),
    ])
    const { reader } = makeOfflineReader(registry)
    const result = await reader.getHistory('offline-line')
    expect(result.interrupted).toBe(true)
  })
})

describe('非 btw 线回归路径（原行为不变）', () => {
  it('普通 sid 离线尾读：判别器未命中即走通用链（scanSessions miss → 静默空）', async () => {
    // 生产注入语义：非线 id 查注册表 miss → undefined → 通用链（判别器调用一次）
    const { reader, resolve, sessionStore } = makeOfflineReader(() => undefined)
    const result = await reader.getHistory('plain-session-id')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(sessionStore.scanSessions).toHaveBeenCalledWith({ force: true })
    expect(result).toEqual({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
  })

  it('subagent 三段式虚拟 id 同样不走 btw 解析路径（判别器 miss → 通用链）', async () => {
    const { reader, sessionStore } = makeOfflineReader(() => undefined)
    await reader.getHistory('subagent:main-1:sub-1')
    expect(sessionStore.scanSessions).toHaveBeenCalledWith({ force: true })
  })
})
