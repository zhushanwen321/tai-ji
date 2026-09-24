/**
 * readEntries 活跃路径过滤（消息撤回投影残留修复，U7）单元验收测试。
 *
 * 两块：
 * 1. filterEntriesToActivePath 纯函数（投影前裁剪）：有分支 fixture 被撤子树剔除 /
 *    leafId 缺失·null·悬空三态防御回退（不过滤，回归钉）/ parentId 环防环终止 /
 *    线性批（增量形态父链越批）不丢数据 / 无树信息 legacy 不过滤。
 * 2. handler 级集成（真实 PluginRpcServer.dispatch → readEntries handler）：过滤真实
 *    接入读链路 + 对外五字段投影契约零变更（parentId 仍不出 runtime）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/plugin-service/__tests__/session-api-active-path.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  filterEntriesToActivePath,
  registerSessionRpcHandlers,
  SessionEventDispatch,
  SESSION_READ_METHODS,
} from '../api/session-api.js'
import type { SessionHandlers } from '../api/session-api.js'
import { PluginRpcServer } from '../plugin-rpc-server.js'
import { EntryInvalidationDispatch } from '../plugin-entry-invalidation-dispatch.js'
import type { IPiEngine } from '../../ports/pi-engine.js'

const TS = '2026-01-01T00:00:00.000Z'

/** 带 tree 字段的 raw pi entry（get_entries 回包形态：id/parentId/timestamp + 域字段）。 */
function entry(id: string, parentId: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, parentId, timestamp: TS, ...extra }
}

/** 标准撤回后树：root → 被撤子树（含 task op）→ 撤回后活跃路径（label 锚 + 新消息）。 */
function branchedTree(): { entries: Record<string, unknown>[]; leafId: string } {
  return {
    entries: [
      entry('e1', null),
      entry('e2', 'e1', { type: 'message', message: { role: 'user', content: '被撤消息' } }),
      // 被撤子树：task op custom entry + assistant 回复（撤回后面板残留的缺陷源）
      entry('e3', 'e2', { type: 'custom', customType: 'pi-scheduler:task', data: { op: 'upsert' } }),
      entry('e4', 'e3', { type: 'message', message: { role: 'assistant', content: '被撤回复' } }),
      // 撤回后活跃路径：navigateTree 回 e1 后追加的新分支
      entry('e5', 'e1', { type: 'label', label: 'taiji:revoked' }),
      entry('e6', 'e5', { type: 'message', message: { role: 'user', content: '新消息' } }),
    ],
    leafId: 'e6',
  }
}

describe('filterEntriesToActivePath：活跃路径裁剪（投影前）', () => {
  it('有分支 fixture：被撤子树（含 task op）剔除，活跃路径条目全保留且保持文件序', () => {
    const t = branchedTree()
    const filtered = filterEntriesToActivePath(t.entries, t.leafId)
    expect(filtered.map((e) => (e as { id: string }).id)).toEqual(['e1', 'e5', 'e6'])
  })

  it('leafId 缺失（undefined）→ 不过滤（回退现行为，回归钉）', () => {
    const t = branchedTree()
    expect(filterEntriesToActivePath(t.entries, undefined)).toEqual(t.entries)
  })

  it('leafId null → 不过滤（空 session / 回归钉）', () => {
    const t = branchedTree()
    expect(filterEntriesToActivePath(t.entries, null)).toEqual(t.entries)
  })

  it('leafId 悬空（不在条目集）→ 不过滤（防御回退：不丢数据，与 scheduler 扩展回退语义同构）', () => {
    const t = branchedTree()
    expect(filterEntriesToActivePath(t.entries, 'nope')).toEqual(t.entries)
  })

  it('parentId 环 → 防环守卫终止（不死循环、不抛），回溯可达条目保留', () => {
    const entries = [
      entry('a', 'c'), // 环：a → c → b → a
      entry('b', 'a'),
      entry('c', 'b'),
      entry('d', 'a'),
    ]
    // 不挂 Timeout（死循环撑爆用例超时）即防环成立的构造性证明；环不可达的 d 被剔
    const filtered = filterEntriesToActivePath(entries, 'a')
    expect(filtered.map((e) => (e as { id: string }).id)).toEqual(['a', 'b', 'c'])
  })

  it('线性连续批（增量形态：首条 parent 在批外悬空）→ 全批保留不丢数据', () => {
    const entries = [
      entry('c1', 'cursor'), // cursor 在上次拉取范围（批外）
      entry('c2', 'c1'),
      entry('c3', 'c2'),
    ]
    expect(filterEntriesToActivePath(entries, 'c3')).toEqual(entries)
  })

  it('无树信息（全条目缺 string id）→ 不过滤（legacy 线性 fixture）', () => {
    const entries = [{ type: 'custom', customType: 'x', data: 1 }, { foo: 'bar' }]
    expect(filterEntriesToActivePath(entries, 'e1')).toEqual(entries)
  })

  it('空 entries → 原样返回', () => {
    expect(filterEntriesToActivePath([], 'e1')).toEqual([])
  })
})

describe('readEntries handler 集成：过滤接入读链 + 对外契约零变更', () => {
  it('被撤子树的 task op 不在回包；活跃路径 task op 仍为精确五字段投影（parentId 不出 runtime）', async () => {
    const t = branchedTree()
    const fakeClient = {
      exited: false,
      getEntries: async () => ({ data: { entries: t.entries, leafId: t.leafId } }),
    }
    const server = new PluginRpcServer()
    const sent: Array<{ type: string; response?: { result?: unknown } }> = []
    server.registerWorker('w1', { postMessage: (m: unknown) => sent.push(m as (typeof sent)[number]) })
    const deps: SessionHandlers = {
      listSessions: () => [],
      getSession: () => undefined,
      getActiveSession: () => undefined,
      sendMessage: async () => ({ blocked: false }),
      sessionEvents: new SessionEventDispatch(server),
      sessionRead: {
        pm: { getClient: () => fakeClient as unknown as IPiEngine },
        getSessionSummary: () => ({ sessionFile: '/sessions/s1.jsonl' }),
        entryInvalidation: new EntryInvalidationDispatch({ sessionExists: () => true }),
      },
    }
    registerSessionRpcHandlers(server, deps)
    const read = (id: number): Promise<void> =>
      server.dispatch('w1', {
        jsonrpc: '2.0',
        id,
        method: SESSION_READ_METHODS.readEntries,
        params: { pluginId: 'p1', sessionId: 's1', customType: 'pi-scheduler:task' },
      })

    // 第一轮：撤回后树——被撤子树的 task op（e3）被裁剪，其余条目非 task 域被投影过滤，
    // 两道收窄叠加后回包 = 空集；游标照常透出（下次 sinceEntryId 语义不变）
    await read(1)
    const result1 = (sent[0]?.response?.result ?? {}) as {
      entries: Array<Record<string, unknown>>
      leafEntryId?: string
      sessionFile?: string
    }
    expect(result1.entries).toEqual([])
    expect(result1.leafEntryId).toBe('e6')
    expect(result1.sessionFile).toBe('/sessions/s1.jsonl')

    // 第二轮：task op 落在活跃路径——投影契约回归（精确五字段、无 parentId）
    fakeClient.getEntries = async () => ({
      data: {
        entries: [
          entry('e1', null),
          entry('ok1', 'e1', { type: 'custom', customType: 'pi-scheduler:task', data: { op: 'upsert' } }),
        ],
        leafId: 'ok1',
      },
    })
    await read(2)
    const result2 = (sent[1]?.response?.result ?? {}) as typeof result1
    expect(result2.entries).toEqual([
      { id: 'ok1', timestamp: TS, type: 'custom', customType: 'pi-scheduler:task', data: { op: 'upsert' } },
    ])
    expect(result2.entries[0]).not.toHaveProperty('parentId')
  })
})
