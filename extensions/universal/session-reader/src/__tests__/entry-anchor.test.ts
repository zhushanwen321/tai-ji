// entry-anchor.test.ts —— session-reader C04 簇合并产物（round5-G）。
// 共同被测业务模块：`src/discovery/entry-anchor.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/__tests__/entry-anchor.test.ts（18 用例，skip 0）
//   - src/__tests__/zcode-manifest.test.ts（18 用例，skip 0）

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { SUBAGENT_RECORD_CUSTOM_TYPE, SUBAGENT_RECORD_ENTRY_VERSION } from '@zhushanwen/subagent-core'
import { findZcodeEntryAnchor, type ZcodeAnchor } from '../discovery/entry-anchor.js'
import { readZcodeManifest, listZcodeManifests } from '../discovery/zcode-manifest.js'

// ======== 来源：entry-anchor.test.ts ========
describe("entry-anchor", () => {
  // ============================================================
  // 变体 E（设计 §4 场景 1a）：manifest 缺席时 entry 兜底定位（F16 每轮覆写 → 取文件
  // 顺序末条，collectLastRecordEntries 同构）。
  //
  // 单元边界：本文件只测「定位」（sa-id → sessionRef 锚）；「读到 sess-B 行集内容」的
  // 库读取断言属 U9 集成测试（场景 1a 变体 E 全量断言），此处不引入 sqlite 依赖。
  // sess-A / sess-B 本身即两个可区分的锚值——取首条或合并的实现会直接失败。
  // ============================================================

  const DB_PATH = '/data/agent/engines/zcode/session-db/db.sqlite'

  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'entry-anchor-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** subagent-record custom entry 行（顶层 id = entry id；data.id = record id 即 sa-id）。 */
  function recordLine(
    entryId: string,
    saId: string,
    sessionRef: Record<string, string>,
    v = 2,
  ): string {
    // 登记 §3.3：v1 全量快照形态已删——锚源 = v2 终态条（settled 携带 engine/engineHandle）。
    return JSON.stringify({
      type: 'custom',
      customType: 'subagent-record',
      id: entryId,
      parentId: null,
      data: {
        v,
        kind: 'settled',
        id: saId,
        status: 'idle',
        stopReason: 'completed',
        endedAt: 2,
        turns: 1,
        totalTokens: 1,
        engine: 'zcode',
        engineHandle: { sessionRef, poolKey: 'shared' },
      },
    })
  }

  /** pi 形态 message 行（真实感填充）。 */
  function messageLine(entryId: string, text: string): string {
    return JSON.stringify({
      type: 'message',
      id: entryId,
      parentId: null,
      message: { role: 'user', content: text },
    })
  }

  /**
 * v2 终态条行（W1 D1：`{v:2, kind:"settled", id, engine?, engineHandle?, ...}`——
 * 载荷形态对齐 subagent-core SubagentRecordSettledEntryData，锚取 engineHandle.sessionRef）。
 */
  function v2SettledLine(
    entryId: string,
    saId: string,
    opts: {
      sessionRef?: Record<string, string>
      engine?: string
    } = {},
  ): string {
    const data: Record<string, unknown> = {
      v: 2,
      kind: 'settled',
      id: saId,
      status: 'idle',
      stopReason: 'end_turn',
      endedAt: 123,
      turns: 1,
      totalTokens: 10,
      model: undefined,
      thinkingLevel: undefined,
    }
    if (opts.engine !== undefined) data.engine = opts.engine
    if (opts.sessionRef !== undefined) {
      data.engineHandle = { sessionRef: opts.sessionRef, poolKey: 'shared' }
    }
    return JSON.stringify({
      type: 'custom',
      customType: 'subagent-record',
      id: entryId,
      parentId: null,
      data,
    })
  }

  /**
 * v2 注册条行（`{v:2, kind:"registered", id, agent, task, ...}`——身份域字段，不携带
 * engineHandle；设计 D1 裁决「sessionRef 双键取自终态条」，注册条目不是锚源）。
 */
  function v2RegisteredLine(entryId: string, saId: string): string {
    return JSON.stringify({
      type: 'custom',
      customType: 'subagent-record',
      id: entryId,
      parentId: null,
      data: {
        v: 2,
        kind: 'registered',
        id: saId,
        agent: 'dev',
        task: 't',
        slug: 's',
        origin: 'tool',
        rootSessionId: 'root-1',
        depth: 0,
        startedAt: 1,
      },
    })
  }

  /** 缺 dbPath 的 sessionRef（pi record 形态：只有 sessionId 单键）。 */
  const REF_NO_DBPATH = { sessionId: 'sess-pi-x' }

  /** 缺 sessionId 的 sessionRef（半键）。 */
  const REF_NO_SESSION_ID = { dbPath: DB_PATH }

  function writeMainSession(name: string, lines: string[]): string {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    return file
  }

  describe('变体 E：同 sa-id 多条 entry 取文件顺序末条（F16 覆写）', () => {
    it('首条 sess-A / 末条 sess-B → 命中 sess-B 且 ≠ sess-A（取首条/合并必失败）', async () => {
      const file = writeMainSession('main.jsonl', [
        JSON.stringify({ type: 'session', id: 'main-1', cwd: '/tmp/proj' }),
        messageLine('m1', 'dispatch subagent'),
        recordLine('e1', 'sa-1', { sessionId: 'sess-A', dbPath: DB_PATH }),
        messageLine('m2', 'round 1 done'),
        recordLine('e2', 'sa-1', { sessionId: 'sess-B', dbPath: DB_PATH }),
      ])

      const anchor = await findZcodeEntryAnchor([file], 'sa-1')

      // 非平凡断言：两个不同锚值使「末条 vs 首条」结果可区分
      expect(anchor).toBeDefined()
      expect(anchor?.sessionId).toBe('sess-B')
      expect(anchor?.sessionId).not.toBe('sess-A')
      expect(anchor?.dbPath).toBe(DB_PATH)
    })

    it('多条不同 sa-id 交错：只命中目标 id 的末条，不串锚', async () => {
      const file = writeMainSession('main.jsonl', [
        JSON.stringify({ type: 'session', id: 'main-1' }),
        recordLine('e1', 'sa-1', { sessionId: 'sa1-r1', dbPath: DB_PATH }),
        recordLine('e2', 'sa-2', { sessionId: 'sa2-r1', dbPath: DB_PATH }),
        recordLine('e3', 'sa-1', { sessionId: 'sa1-r2', dbPath: DB_PATH }),
        recordLine('e4', 'sa-2', { sessionId: 'sa2-r2', dbPath: DB_PATH }),
        recordLine('e5', 'sa-1', { sessionId: 'sa1-r3', dbPath: DB_PATH }),
      ])

      expect((await findZcodeEntryAnchor([file], 'sa-1'))?.sessionId).toBe('sa1-r3')
      expect((await findZcodeEntryAnchor([file], 'sa-2'))?.sessionId).toBe('sa2-r2')
    })
  })

  describe('行级容错（best-effort，不因一行坏 JSON 失败整文件）', () => {
    it('坏行穿插 + 末行半行：正常命中末条完整条目', async () => {
      const file = writeMainSession('main.jsonl', [
        JSON.stringify({ type: 'session', id: 'main-1' }),
        'not-json-at-all{{{',
        recordLine('e1', 'sa-1', { sessionId: 'sess-A', dbPath: DB_PATH }),
        '{"type":"custom","customType":"subagent-record","data":{"broken"',
      ])

      const anchor = await findZcodeEntryAnchor([file], 'sa-1')
      expect(anchor?.sessionId).toBe('sess-A')
    })
  })

  describe('形状校验窄而严：缺键条目不算命中，继续找更早条目', () => {
    it('末条 sessionRef 缺 dbPath → 命中更早的完整条目', async () => {
      const file = writeMainSession('main.jsonl', [
        JSON.stringify({ type: 'session', id: 'main-1' }),
        recordLine('e1', 'sa-1', { sessionId: 'sess-EARLY', dbPath: DB_PATH }),
        recordLine('e2', 'sa-1', REF_NO_DBPATH),
      ])

      const anchor = await findZcodeEntryAnchor([file], 'sa-1')
      expect(anchor?.sessionId).toBe('sess-EARLY')
    })

    it('全部条目缺双键 → not-found（undefined）', async () => {
      const file = writeMainSession('main.jsonl', [
        JSON.stringify({ type: 'session', id: 'main-1' }),
        recordLine('e1', 'sa-1', REF_NO_DBPATH),
        recordLine('e2', 'sa-1', REF_NO_SESSION_ID),
      ])

      expect(await findZcodeEntryAnchor([file], 'sa-1')).toBeUndefined()
    })

    it('sessionRef 键为空串 → 不算命中（非空 string 才算锚）', async () => {
      const file = writeMainSession('main.jsonl', [
        JSON.stringify({ type: 'session', id: 'main-1' }),
        recordLine('e1', 'sa-1', { sessionId: '', dbPath: DB_PATH }),
        recordLine('e2', 'sa-1', { sessionId: 'sess-A', dbPath: '' }),
      ])

      expect(await findZcodeEntryAnchor([file], 'sa-1')).toBeUndefined()
    })

    it('data.v 非当前版本（future-v，如 3）不算命中，更早 v=2 条目仍可命中', async () => {
      const file = writeMainSession('main.jsonl', [
        JSON.stringify({ type: 'session', id: 'main-1' }),
        recordLine('e1', 'sa-1', { sessionId: 'sess-A', dbPath: DB_PATH }),
        recordLine('e2', 'sa-1', { sessionId: 'sess-V3', dbPath: DB_PATH }, 3),
      ])

      const anchor = await findZcodeEntryAnchor([file], 'sa-1')
      expect(anchor?.sessionId).toBe('sess-A')
      expect(anchor?.sessionId).not.toBe('sess-V3')
    })
  })

  // ============================================================
  // v2 终态条锚定（W1 D1 版本门补齐：sessionRef 双键取自终态条）
  // ============================================================

  describe('v2 终态条锚定：kind="settled" + engineHandle.sessionRef 双键', () => {
    it('v2 终态条完整锚（sessionRef 双键齐）→ 命中', async () => {
      const file = writeMainSession('main.jsonl', [
        JSON.stringify({ type: 'session', id: 'main-1' }),
        messageLine('m1', 'dispatch'),
        v2SettledLine('e1', 'sa-1', {
          engine: 'zcode',
          sessionRef: { sessionId: 'sess-V2A', dbPath: DB_PATH },
        }),
      ])

      const anchor = await findZcodeEntryAnchor([file], 'sa-1')
      expect(anchor).toBeDefined()
      expect(anchor?.sessionId).toBe('sess-V2A')
      expect(anchor?.dbPath).toBe(DB_PATH)
    })

    it('v2 注册条（kind="registered"，不携带 engineHandle）→ 不命中（锚只取自终态条）', async () => {
      const file = writeMainSession('main.jsonl', [
        JSON.stringify({ type: 'session', id: 'main-1' }),
        v2RegisteredLine('e-reg', 'sa-1'),
      ])

      expect(await findZcodeEntryAnchor([file], 'sa-1')).toBeUndefined()
    })

    it('同 id 两条 v2 终态条（早/晚）→ 末条胜（末条锚定语义）', async () => {
      const file = writeMainSession('main.jsonl', [
        JSON.stringify({ type: 'session', id: 'main-1' }),
        recordLine('e1', 'sa-1', { sessionId: 'sess-OLD', dbPath: DB_PATH }),
        v2SettledLine('e2', 'sa-1', {
          engine: 'zcode',
          sessionRef: { sessionId: 'sess-NEW', dbPath: DB_PATH },
        }),
      ])

      const anchor = await findZcodeEntryAnchor([file], 'sa-1')
      expect(anchor?.sessionId).toBe('sess-NEW')
      expect(anchor?.sessionId).not.toBe('sess-OLD')
    })

    it('v2 终态条锚残缺（缺 engineHandle）→ 不命中，更早完整条目仍可命中（缺键不遮蔽）', async () => {
      const file = writeMainSession('main.jsonl', [
        JSON.stringify({ type: 'session', id: 'main-1' }),
        recordLine('e1', 'sa-1', { sessionId: 'sess-EARLY', dbPath: DB_PATH }),
        v2SettledLine('e2', 'sa-1', { engine: 'zcode' }), // 无 sessionRef
      ])

      const anchor = await findZcodeEntryAnchor([file], 'sa-1')
      expect(anchor?.sessionId).toBe('sess-EARLY')
    })

    it('v2 但 kind 不在词表（unknown-kind，非 registered/settled）→ 不命中', async () => {
      const badKind = JSON.stringify({
        type: 'custom',
        customType: 'subagent-record',
        id: 'e-bad',
        parentId: null,
        data: {
          v: 2,
          kind: 'migrated',
          id: 'sa-1',
          engineHandle: { sessionRef: { sessionId: 'sess-BAD', dbPath: DB_PATH }, poolKey: 'shared' },
        },
      })
      const file = writeMainSession('main.jsonl', [
        JSON.stringify({ type: 'session', id: 'main-1' }),
        badKind,
      ])

      expect(await findZcodeEntryAnchor([file], 'sa-1')).toBeUndefined()
    })
  })

  describe('无关条目不命中', () => {
    it('非 subagent-record 的 custom entry、id 不匹配的 record 均跳过', async () => {
      const todoLine = JSON.stringify({
        type: 'custom',
        customType: 'todo',
        id: 't1',
        parentId: null,
        data: { v: 1, id: 'sa-1', engineHandle: { sessionRef: { sessionId: 'sess-TODO', dbPath: DB_PATH } } },
      })
      const file = writeMainSession('main.jsonl', [
        JSON.stringify({ type: 'session', id: 'main-1' }),
        todoLine,
        recordLine('e1', 'sa-other', { sessionId: 'sess-OTHER', dbPath: DB_PATH }),
      ])

      expect(await findZcodeEntryAnchor([file], 'sa-1')).toBeUndefined()
      expect((await findZcodeEntryAnchor([file], 'sa-other'))?.sessionId).toBe('sess-OTHER')
    })
  })

  describe('候选文件列表：顺序回退 + 命中即止（越界语义由调用方承载）', () => {
    it('前一候选未命中 → 后一候选命中', async () => {
      const empty = writeMainSession('empty.jsonl', [JSON.stringify({ type: 'session', id: 's0' })])
      const withAnchor = writeMainSession('with-anchor.jsonl', [
        JSON.stringify({ type: 'session', id: 'main-2' }),
        recordLine('e1', 'sa-1', { sessionId: 'sess-B', dbPath: DB_PATH }),
      ])

      const anchor: ZcodeAnchor | undefined = await findZcodeEntryAnchor([empty, withAnchor], 'sa-1')
      expect(anchor?.sessionId).toBe('sess-B')
    })

    it('前一候选命中即止：不跨文件合并（后一候选的更新条目不覆盖）', async () => {
      const first = writeMainSession('first.jsonl', [
        JSON.stringify({ type: 'session', id: 'main-1' }),
        recordLine('e1', 'sa-1', { sessionId: 'sess-A', dbPath: DB_PATH }),
      ])
      const second = writeMainSession('second.jsonl', [
        JSON.stringify({ type: 'session', id: 'main-2' }),
        recordLine('e2', 'sa-1', { sessionId: 'sess-B', dbPath: DB_PATH }),
      ])

      const anchor = await findZcodeEntryAnchor([first, second], 'sa-1')
      expect(anchor?.sessionId).toBe('sess-A')
      expect(anchor?.sessionId).not.toBe('sess-B')
    })

    it('候选不可读（不存在）→ 跳过继续，全不可读 → not-found', async () => {
      const withAnchor = writeMainSession('with-anchor.jsonl', [
        JSON.stringify({ type: 'session', id: 'main-1' }),
        recordLine('e1', 'sa-1', { sessionId: 'sess-B', dbPath: DB_PATH }),
      ])

      expect((await findZcodeEntryAnchor([join(dir, 'missing.jsonl'), withAnchor], 'sa-1'))?.sessionId).toBe('sess-B')
      expect(await findZcodeEntryAnchor([join(dir, 'missing.jsonl')], 'sa-1')).toBeUndefined()
      expect(await findZcodeEntryAnchor([], 'sa-1')).toBeUndefined()
    })
  })

  describe('协议字面量漂移检查（跨包契约）', () => {
    it('entry-anchor 本地 customType 字面量 === subagent-core 写侧单源', () => {
      // 源码本地持有磁盘协议字符串（生产依赖范围不引 subagent-core），此处锚定两侧同值
      expect(SUBAGENT_RECORD_CUSTOM_TYPE).toBe('subagent-record')
    })

    it('entry-anchor 本地 v2 认识版本 === subagent-core 写侧单源（写侧再升版本本检查先红）', () => {
      expect(SUBAGENT_RECORD_ENTRY_VERSION).toBe(2)
    })
  })
});

// ======== 来源：zcode-manifest.test.ts ========
describe("zcode-manifest", () => {
  // ============================================================
  // 变体 M（设计 §4 场景 1a）：zcode manifest 直读（§3.1 第①步主路径）+ 枚举（family 用）。
  //
  // fixture 对齐 F21 磁盘真实形态：zcode manifest **无 sessionFile 键**
  // （派生视图函数照写 sessionFile: undefined，JSON.stringify 丢键）、engine:'zcode'、
  // engineHandle.sessionRef 双键齐。
  //
  // 单元边界：只测「认出 zcode manifest + 提取锚」；白名单门禁 / 错误码映射（U9）、
  // entry 兜底定位语义（U7 已交付）不在本文件展开。
  // ============================================================

  const DB_PATH = '/data/agent/engines/zcode/session-db/db.sqlite'

  let agentDir: string

  /**
 * 在存储树分区 <root>/<sid>/subagents/records/ 下写一个 manifest 文件（手写 JSON 字符串，
 * 忠实控制键）。[session-store-layout-inversion D6/单新根] 新布局无 cwd-slug 层，
 * slug 参数消亡（保留签名兼容既有调用点，弃用改名 _slug）；分区名固定合法 sid。
 */
  function writeManifest(_slug: string, name: string, content: string): string {
    const recordsDir = join(dirname(agentDir), 'ext-sessions', 'root-session-test', 'subagents', 'records')
    mkdirSync(recordsDir, { recursive: true })
    const file = join(recordsDir, name)
    writeFileSync(file, content, 'utf8')
    return file
  }

  /** 磁盘真实形态的 zcode manifest（无 sessionFile 键——F21） */
  function zcodeManifestJson(opts: {
    id: string
    sessionId?: string
    dbPath?: string
    withEngineHandle?: boolean
    engine?: string
    rich?: Record<string, unknown>
  }): string {
    const m: Record<string, unknown> = {
      id: opts.id,
      rootSessionId: 'root-1',
      agentName: 'worker',
      status: 'running',
      ...opts.rich,
    }
    // 缺省 zcode（F21 磁盘真实形态）；显式传 'pi' 可覆盖
    m.engine = opts.engine ?? 'zcode'
    if (opts.withEngineHandle !== false) {
      m.engineHandle = {
        sessionRef: { sessionId: opts.sessionId ?? 'sess-1', dbPath: opts.dbPath ?? DB_PATH },
        poolKey: 'shared',
      }
    }
    // 刻意不写 sessionFile 键（F21：JSON.stringify 丢 undefined 键的产物形态）
    return JSON.stringify(m)
  }

  /** 变体 M instrument 用：主 session 文件里的 subagent-record entry 行（U7 recordLine 同款） */
  function recordLine(saId: string, sessionRef: Record<string, string>): string {
    return JSON.stringify({
      type: 'custom',
      customType: 'subagent-record',
      id: `e-${saId}`,
      parentId: null,
      data: {
        v: 2, kind: 'settled', id: saId, status: 'idle', stopReason: 'completed', endedAt: 2,
        turns: 1, totalTokens: 10, engine: 'zcode', engineHandle: { sessionRef, poolKey: 'shared' },
      },
    })
  }

  beforeEach(() => {
    // agentDir 两层化（<mkdtemp>/agent）：存储树推导 = dirname(agentDir)/ext-sessions，
    // 单层直接当 agentDir 会把扫描根泄到 tmpdir 公共层（跨测试污染——先例 reaper/family-zcode 同修）
    agentDir = join(mkdtempSync(join(tmpdir(), 'zcode-manifest-test-')), 'agent')
    mkdirSync(agentDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  describe('readZcodeManifest 直读：有锚 manifest → 取到 sessionRef', () => {
    it('engine zcode + sessionRef 双键齐 → kind=zcode，锚字段正确', async () => {
      writeManifest(
        'proj-a',
        'sa-abc.json',
        zcodeManifestJson({ id: 'sa-abc', sessionId: 'sess_5f3c', dbPath: DB_PATH }),
      )

      const lookup = await readZcodeManifest(agentDir, 'sa-abc')

      expect(lookup.kind).toBe('zcode')
      if (lookup.kind !== 'zcode') return
      expect(lookup.anchor.sessionId).toBe('sess_5f3c')
      expect(lookup.anchor.dbPath).toBe(DB_PATH)
    })

    it('多 cwd 目录窄 walk：目标不在第一个目录 → 后续目录命中（命中即止）', async () => {
      writeManifest('proj-empty', 'sa-other.json', zcodeManifestJson({ id: 'sa-other' }))
      writeManifest(
        'proj-deep',
        'sa-target.json',
        zcodeManifestJson({ id: 'sa-target', sessionId: 'sess-deep', dbPath: DB_PATH }),
      )

      const lookup = await readZcodeManifest(agentDir, 'sa-target')

      expect(lookup.kind).toBe('zcode')
      if (lookup.kind === 'zcode') expect(lookup.anchor.sessionId).toBe('sess-deep')
    })

    it('同目录存在坏 JSON manifest 不影响直读（不解析其他 manifest）', async () => {
      writeManifest('proj-a', 'sa-broken.json', '{"id":"sa-broken", truncated')
      writeManifest(
        'proj-a',
        'sa-good.json',
        zcodeManifestJson({ id: 'sa-good', sessionId: 'sess-good', dbPath: DB_PATH }),
      )

      const lookup = await readZcodeManifest(agentDir, 'sa-good')

      expect(lookup.kind).toBe('zcode')
      if (lookup.kind === 'zcode') expect(lookup.anchor.sessionId).toBe('sess-good')
    })
  })

  describe('readZcodeManifest 直读：失败信号（U9 错误码映射的归因输入）', () => {
    it('文件不存在（未知 sa-id）→ not-zcode', async () => {
      writeManifest('proj-a', 'sa-abc.json', zcodeManifestJson({ id: 'sa-abc' }))

      expect((await readZcodeManifest(agentDir, 'sa-missing')).kind).toBe('not-zcode')
    })

    it('坏 JSON → not-zcode（残缺 manifest 与今天的 tryReadManifest 丢弃行为等价）', async () => {
      writeManifest('proj-a', 'sa-abc.json', 'not-json-at-all{{{')

      expect((await readZcodeManifest(agentDir, 'sa-abc')).kind).toBe('not-zcode')
    })

    it('engine 缺省（pi 存量形态：有 sessionFile 无 engine）→ not-zcode', async () => {
      writeManifest(
        'proj-a',
        'sa-abc.json',
        JSON.stringify({
          id: 'sa-abc',
          rootSessionId: 'root-1',
          sessionFile: '/sessions/sub.jsonl',
        }),
      )

      expect((await readZcodeManifest(agentDir, 'sa-abc')).kind).toBe('not-zcode')
    })

    it("engine 显式 'pi' → not-zcode", async () => {
      writeManifest(
        'proj-a',
        'sa-abc.json',
        zcodeManifestJson({
          id: 'sa-abc',
          engine: 'pi',
          rich: { sessionFile: '/sessions/sub.jsonl' },
        }),
      )

      expect((await readZcodeManifest(agentDir, 'sa-abc')).kind).toBe('not-zcode')
    })

    it('engineHandle 整体缺席 → anchor-missing + reason=missing-engineHandle（旧版本产物 / 孤儿 manifest）', async () => {
      writeManifest(
        'proj-a',
        'sa-abc.json',
        zcodeManifestJson({ id: 'sa-abc', engine: 'zcode', withEngineHandle: false }),
      )

      const lookup = await readZcodeManifest(agentDir, 'sa-abc')
      expect(lookup.kind).toBe('anchor-missing')
      if (lookup.kind === 'anchor-missing') expect(lookup.reason).toBe('missing-engineHandle')
    })

    it('sessionRef 整体缺席 → anchor-missing + reason=missing-sessionRef', async () => {
      writeManifest(
        'proj-a',
        'sa-abc.json',
        JSON.stringify({ id: 'sa-abc', rootSessionId: 'root-1', engine: 'zcode', engineHandle: { poolKey: 'shared' } }),
      )

      const lookup = await readZcodeManifest(agentDir, 'sa-abc')
      expect(lookup.kind).toBe('anchor-missing')
      if (lookup.kind === 'anchor-missing') expect(lookup.reason).toBe('missing-sessionRef')
    })

    it('sessionRef 缺 dbPath 键 → anchor-missing + reason=missing-dbPath（部分回填的残余形态）', async () => {
      // 手写 JSON：sessionRef 只有 sessionId 单键（zcodeManifestJson 的 ?? 兜底不适用此形态）
      writeManifest(
        'proj-a',
        'sa-abc.json',
        JSON.stringify({
          id: 'sa-abc',
          rootSessionId: 'root-1',
          engine: 'zcode',
          engineHandle: { sessionRef: { sessionId: 'sess-1' }, poolKey: 'shared' },
        }),
      )

      const lookup = await readZcodeManifest(agentDir, 'sa-abc')
      expect(lookup.kind).toBe('anchor-missing')
      if (lookup.kind === 'anchor-missing') expect(lookup.reason).toBe('missing-dbPath')
    })

    it('sessionRef 键为空串 → anchor-missing + reason=missing-sessionId（非空 string 才算锚）', async () => {
      writeManifest(
        'proj-a',
        'sa-abc.json',
        zcodeManifestJson({ id: 'sa-abc', sessionId: '', dbPath: DB_PATH }),
      )

      const lookup = await readZcodeManifest(agentDir, 'sa-abc')
      expect(lookup.kind).toBe('anchor-missing')
      if (lookup.kind === 'anchor-missing') expect(lookup.reason).toBe('missing-sessionId')
    })

    it('subagents 根目录不存在 → not-zcode（不抛异常）', async () => {
      const bareDir = mkdtempSync(join(tmpdir(), 'zcode-manifest-bare-'))
      try {
        expect((await readZcodeManifest(bareDir, 'sa-abc')).kind).toBe('not-zcode')
      } finally {
        rmSync(bareDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })
  })

  describe('变体 M 定位分支 instrument：manifest 主路径命中（结果来源标记）', () => {
    it('manifest 与 entry 同 sa-id 各持不同锚 → 直读返回 manifest 的锚（entry 兜底来源未被采信）', async () => {
      // 结果来源标记：两来源锚值刻意不同——若实现（未来的路由编排）错误地跳过主路径
      // 落到 entry 兜底，将得到 'sess-from-entry'，本断言即失败（走对路而非碰巧对）。
      writeManifest(
        'proj-a',
        'sa-inst.json',
        zcodeManifestJson({ id: 'sa-inst', sessionId: 'sess-from-manifest', dbPath: DB_PATH }),
      )
      const mainFile = join(agentDir, 'main.jsonl')
      writeFileSync(
        mainFile,
        [
          JSON.stringify({ type: 'session', id: 'main-1', cwd: '/proj' }),
          recordLine('sa-inst', { sessionId: 'sess-from-entry', dbPath: DB_PATH }),
        ].join('\n') + '\n',
        'utf8',
      )

      // 主路径命中：锚来自 manifest
      const lookup = await readZcodeManifest(agentDir, 'sa-inst')
      expect(lookup.kind).toBe('zcode')
      if (lookup.kind === 'zcode') {
        expect(lookup.anchor.sessionId).toBe('sess-from-manifest')
        expect(lookup.anchor.sessionId).not.toBe('sess-from-entry')
      }

      // 标记有效性自证：entry 兜底（U7 函数）在同 fixture 上返回的是 entry 来源的锚——
      // 两来源可区分，主路径断言非平凡
      const entryAnchor = await findZcodeEntryAnchor([mainFile], 'sa-inst')
      expect(entryAnchor?.sessionId).toBe('sess-from-entry')
    })

    it('manifest 缺位 → not-zcode（此情形才需要 entry 兜底介入——定位链分支边界）', async () => {
      expect((await readZcodeManifest(agentDir, 'sa-none')).kind).toBe('not-zcode')
    })
  })

  describe('listZcodeManifests 枚举（family 节点列表来源）', () => {
    it('混排目录只返回 zcode 形态：pi manifest / 坏 JSON / 无锚 zcode 全部跳过', async () => {
      writeManifest(
        'proj-a',
        'sa-z1.json',
        zcodeManifestJson({ id: 'sa-z1', sessionId: 'sess-z1', dbPath: DB_PATH }),
      )
      // pi 存量形态（无 engine、有 sessionFile）——枚举不吸入（isRecordManifest 链零改动）
      writeManifest(
        'proj-a',
        'sa-pi.json',
        JSON.stringify({
          id: 'sa-pi',
          rootSessionId: 'root-1',
          sessionFile: '/sessions/pi-sub.jsonl',
          agentName: 'explorer',
        }),
      )
      // engine:'pi' 显式
      writeManifest(
        'proj-a',
        'sa-pi2.json',
        zcodeManifestJson({ id: 'sa-pi2', engine: 'pi', rich: { sessionFile: '/s.jsonl' } }),
      )
      // zcode 但无锚 → 不产出（直读侧归 anchor-missing，枚举侧无节点可建）
      writeManifest(
        'proj-a',
        'sa-noanchor.json',
        zcodeManifestJson({ id: 'sa-noanchor', engine: 'zcode', withEngineHandle: false }),
      )
      // 坏 JSON → 跳过不中断
      writeManifest('proj-a', 'sa-bad.json', '{{{broken')
      // 第二目录的 zcode manifest → 跨目录枚举
      writeManifest(
        'proj-b',
        'sa-z2.json',
        zcodeManifestJson({ id: 'sa-z2', sessionId: 'sess-z2', dbPath: DB_PATH }),
      )

      const manifests = await listZcodeManifests(agentDir)

      expect(manifests.map((m) => m.id).sort()).toEqual(['sa-z1', 'sa-z2'])
      const z1 = manifests.find((m) => m.id === 'sa-z1')
      expect(z1?.engine).toBe('zcode')
      expect(z1?.dbPath).toBe(DB_PATH)
      expect(z1?.rootSessionId).toBe('root-1')
    })

    it('dbFileExists 预计算：dbPath 指向真实文件 → true；不存在路径 → false（stat 不开库）', async () => {
      const realDb = join(agentDir, 'real-db.sqlite')
      writeFileSync(realDb, 'SQLite format 3 stub', 'utf8')
      writeManifest(
        'proj-a',
        'sa-alive.json',
        zcodeManifestJson({ id: 'sa-alive', sessionId: 'sess-a', dbPath: realDb }),
      )
      writeManifest(
        'proj-a',
        'sa-gone.json',
        zcodeManifestJson({ id: 'sa-gone', sessionId: 'sess-g', dbPath: join(agentDir, 'missing-db.sqlite') }),
      )

      const manifests = await listZcodeManifests(agentDir)

      expect(manifests.find((m) => m.id === 'sa-alive')?.dbFileExists).toBe(true)
      expect(manifests.find((m) => m.id === 'sa-gone')?.dbFileExists).toBe(false)
    })

    it('slug 兜底 m.slug ?? m.agentName ?? ""（与 pi 孤儿链同款）', async () => {
      writeManifest(
        'proj-a',
        'sa-s1.json',
        zcodeManifestJson({ id: 'sa-s1', sessionId: 'sess-1', rich: { slug: 'explicit-slug' } }),
      )
      writeManifest(
        'proj-a',
        'sa-s2.json',
        zcodeManifestJson({ id: 'sa-s2', sessionId: 'sess-2' }), // 无 slug → 回退 agentName
      )

      const manifests = await listZcodeManifests(agentDir)

      expect(manifests.find((m) => m.id === 'sa-s1')?.slug).toBe('explicit-slug')
      expect(manifests.find((m) => m.id === 'sa-s2')?.slug).toBe('worker') // agentName 兜底
    })

    it('存储树根不存在 → 空数组（不报错；单节点不可达不炸整屏）', async () => {
      // agentDir 两层化：扫描根 = dirname(agentDir)/ext-sessions（mkdtemp 私有层内，防公共层污染）
      const bareDir = join(mkdtempSync(join(tmpdir(), 'zcode-manifest-bare-')), 'agent')
      try {
        expect(await listZcodeManifests(bareDir)).toEqual([])
      } finally {
        rmSync(dirname(bareDir), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    })
  })
});
