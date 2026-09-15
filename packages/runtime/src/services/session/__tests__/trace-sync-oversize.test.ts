/**
 * D5④ trace-sync oversize 降级态测试（u4c-read-paths，crash-resilience §3.3 D5④ +
 * 错误规格表「历史文件超 32MB」行）。
 *
 * 必测断言（impl-plan u4c 验收）：
 * - buildTraceSnapshotFromFile 遇 oversize 标记 → source='oversize' 降级快照：
 *   oversizeMessage 文案含体积（MB）与源文件**绝对路径**，entries/malformed 恒空，
 *   与 source='empty'（文件缺失空态）显式区分（设计明令不混淆）
 * - getTraceEntries RPC 路径遇 oversize：权威 entries 照常返回（RPC 通路不受文件预算
 *   影响），malformed 补齐降级为空数组（不为增强项绕过读取预算）
 * - 既有契约回归：文本 null → 'empty'、正常文本 → 'file'
 *
 * store 用窄 stub（本文件只消费 readSessionJsonlText / readSessionEndMeta /
 * readSessionHeaderLine / scanSessions 四读，oversize 形态的真文件行为由
 * session-store-oversize.test.ts 覆盖）。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/trace-sync-oversize.test.ts
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { buildTraceSnapshotFromFile, TraceSync } from '../trace-sync.js'
import type { ISessionStore } from '../../ports/session.js'
import type { IManagedSessionView } from '../types.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import { READ_PRECHECK_MAX_BYTES } from '@taiji/shared'

/** 窄 store stub：三读可注入（未注入的方法返回空值，本文件不消费）。 */
function makeStore(overrides: Partial<Pick<ISessionStore, 'readSessionJsonlText' | 'readSessionEndMeta' | 'readSessionHeaderLine' | 'scanSessions'>>): ISessionStore {
  return {
    scanSessions: () => [],
    invalidateScanCache: () => {},
    refreshAll: () => {},
    persistSessionEnd: () => {},
    persistPresetBinding: () => {},
    persistProjectBinding: () => {},
    persistAgentBinding: () => {},
    extractSessionOutcome: () => null,
    invalidateMetaCache: () => {},
    convertHistory: () => [],
    rebuildHistoryFromEntries: () => ({ messages: [], clientUuidMap: new Map(), orphanToolResults: [] }),
    parseSessionHeader: () => null,
    readSessionHeaderLine: () => null,
    readSessionJsonlText: () => null,
    readSessionEndMeta: () => null,
    // u4c（D5⑤）：ISessionStore 新增流式归一化成员（本文件不触达，no-op 满足类型）
    normalizeSessionFileStreaming: () => {},
    persistHandoffSidecar: () => {},
    trash: () => Promise.resolve(),
    ...overrides,
  }
}

describe('D5④ buildTraceSnapshotFromFile oversize 降级态', () => {
  it('oversize 标记 → source=oversize + 文案含体积与绝对路径 + entries 恒空（非空态混淆）', () => {
    const filePath = join('/tmp', 'trace-oversize-fixture', '20260909_abc_session.jsonl')
    const bytes = READ_PRECHECK_MAX_BYTES + 4096
    const store = makeStore({ readSessionJsonlText: () => ({ oversize: true, bytes, maxBytes: READ_PRECHECK_MAX_BYTES }) })

    const snap = buildTraceSnapshotFromFile('sid-1', filePath, store)

    expect(snap.source).toBe('oversize')
    expect(snap.entries).toEqual([])
    expect(snap.malformed).toEqual([])
    expect(snap.filePath).toBe(filePath)
    expect(snap.oversizeMessage).toBeDefined()
    // 文案规格（crash-resilience D5④ 定版）：体积 MB + 源文件绝对路径
    expect(snap.oversizeMessage).toContain(`${(bytes / (1024 * 1024)).toFixed(1)} MB`)
    expect(snap.oversizeMessage).toContain(filePath)
  })

  it('文本 null → source=empty（既有空态契约回归；与 oversize 显式区分）', () => {
    const store = makeStore({ readSessionJsonlText: () => null })

    const snap = buildTraceSnapshotFromFile('sid-1', join('/tmp', 'x.jsonl'), store)

    expect(snap.source).toBe('empty')
    expect('oversizeMessage' in snap).toBe(false)
  })

  it('正常文本 → source=file（既有契约回归）', () => {
    const store = makeStore({
      readSessionJsonlText: () => '{"type":"session","id":"s1"}\n{"type":"assistant","id":"e1"}\n',
    })

    const snap = buildTraceSnapshotFromFile('sid-1', join('/tmp', 'ok.jsonl'), store)

    expect(snap.source).toBe('file')
    expect(snap.entries).toHaveLength(1)
    expect('oversizeMessage' in snap).toBe(false)
  })
})

describe('D5④ getTraceEntries RPC 路径遇 oversize 文件', () => {
  it('权威 entries 照常返回，malformed 补齐降级空数组（不绕过读取预算）', async () => {
    const filePath = '/tmp/rpc-oversize/big.jsonl'
    const entries = [{ type: 'assistant', id: 'e1' }]
    const client = { getEntries: async () => ({ data: { entries, leafId: 'e1' } }) }
    const pm = { getClient: () => client, destroySession: async () => {} } as unknown as IProcessManager
    const store = makeStore({
      scanSessions: () => [{ id: 'sid-1', filePath, cwd: '/tmp', timestamp: '', name: null, lastModified: 0, size: 0, outcome: null }],
      readSessionHeaderLine: () => '{"type":"session","id":"s1"}',
      readSessionJsonlText: () => ({ oversize: true, bytes: READ_PRECHECK_MAX_BYTES + 1, maxBytes: READ_PRECHECK_MAX_BYTES }),
    })
    const sync = new TraceSync({
      pm,
      sessionStore: store,
      getSession: (): IManagedSessionView | undefined => undefined,
      getMessageBus: () => null,
    })

    const snap = await sync.getTraceEntries('sid-1')

    expect(snap.source).toBe('rpc')
    expect(snap.entries).toEqual(entries) // RPC 权威通路不受文件预算影响
    expect(snap.malformed).toEqual([]) // oversize 下 malformed 补齐降级
  })
})
