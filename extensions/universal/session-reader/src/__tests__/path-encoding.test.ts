// path-encoding.test.ts —— session-reader C06 簇合并产物（round5-G）。
// 共同被测业务模块：`core:@zhushanwen/subagent-core/execution/assembly/path-encoding.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/__tests__/cross-package-subagent-core.test.ts（2 用例，skip 0）
//   - src/__tests__/rebuild-manifest-dual-write.test.ts（2 用例，skip 0）

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleSessionRead } from '../tool-handler.js'
// barrel 符号走包根；ManifestStore / ModelRegistryLike / path-encoding 函数未进 barrel
// （D3 判定不进），按 subagent-workflow 测试同款包名 .ts 深路径消费，vitest alias 解析。
import { ModelConfigService, RecordStore, SUBAGENT_RECORD_CUSTOM_TYPE, SubagentService, type SubagentRecord } from '@zhushanwen/subagent-core'
import { ManifestStore } from '@zhushanwen/subagent-core/execution/persistence/manifest-store.ts'
import { type ModelRegistryLike } from '@zhushanwen/subagent-core/execution/assembly/model-resolver.ts'
import { getSubagentRecordsDir, getSubagentSessionDir } from '@zhushanwen/subagent-core/execution/assembly/path-encoding.ts'
// barrel 外符号按包名 .ts 深路径消费（vitest alias 重写，同 cross-package 先例）
import { createRecord } from '@zhushanwen/subagent-core/execution/persistence/execution-record.ts'
import { listRecordManifests, type RecordManifest } from '../discovery/subagents.js'

// ======== 来源：cross-package-subagent-core.test.ts ========
describe("cross-package-subagent-core", () => {
  /**
 * W4 跨包集成测试（[collect 退役] 改造保留：原「E1 落标出口产出 manifest」驱动侧
 * 随 sync 批机制删除，现行真实派生视图出口 = store 重建通道 rebuildIndexes——manifest
 * 是可丢缓存，boot 全量路径按磁盘子文件锚幂等补缺）。「subagent-core 真实 tmpdir
 * 产出磁盘状态 → session-reader result action sa- id 反查，不 mock manifest 写入」
 * 的跨包契约保持不变。
 *
 * 与 result.test.ts 的分工：result.test.ts 的 fixture **手工预写** manifest；本文件
 * manifest 内容必须来自派生视图代码路径——subagent-core 侧真实驱动（真实 RecordStore
 * 落盘 register/轮终 entry → initSession 内 orphan 覆写真实跑 → rebuildIndexes
 * derivedManifestRecord 派生视图真写 records/<sa-id>.json），session-reader 侧零 mock
 * 读同一 tmpdir 断言反查闭环。
 *
 * 构造形态取自 subagent-core sync-collect-recovery.test.ts 的 kill -9 同构主用例
 * （形态同构是 v1 教训「种子绕过真实链路 = 假绿」的执行）：子 session 文件在其
 * 基础上补 message entries（result action 的正文提取源）。
 *
 * mock 面最小：仅构造 SubagentService 所需的最小 pi 形状（appendEntry 真写主文件，
 * 其余 no-op stub）——零 vi.mock、notifier/store/config 全真实实现，agentDir 全部
 * mkdtemp(tmpdir) 自建自删（红线：零真实数据目录触碰）。
 */

  /** 剥身份 env（subagent-core 测试纪律同款）：身份 env 会让 service 误判自己是
 *  子进程跳过恢复扫描。 */
  const ENV_KEYS_TO_STRIP = [
    'PI_SUBAGENT_ROOT_SESSION_ID',
    'PI_SUBAGENT_SELF_RECORD_ID',
    'PI_SUBAGENT_DEPTH',
    'PI_SUBAGENT_ROOT_CWD',
    'PI_SUBAGENT_FORK_DEPTH',
  ] as const

  const ROOT_SESSION = 'root-cross-pkg'

  /** 驱动 SubagentService 的最小 pi 形状：appendEntry 真写主 session JSONL（pi 落盘
 *  形态同构），其余面 no-op（本链路 E1 全终态直达补发，settled 重扫不注册）。 */
  function makeWritingPi(mainFile: string) {
    return {
      appendEntry(customType: string, data: unknown): void {
        fs.appendFileSync(
          mainFile,
          `${JSON.stringify({
          type: 'custom',
          id: `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          parentId: null,
          timestamp: new Date().toISOString(),
          customType,
          data,
        })}\n`,
        'utf-8',
      )
    },
    events: { emit(): void {} },
    sendMessage(): void {},
    on(): void {},
  }
}

/** 种子成员 record（真实 RecordStore.reportSubagentRecord 入参——序列化/落盘/扫描
 *  三层真实；字段形状同 subagent-core sync-collect-recovery.test.ts memberRecord）。 */
function memberRecord(overrides: Partial<SubagentRecord> & { id: string }): SubagentRecord {
  return {
    agent: '/agents/worker.md',
    task: 'cross-package task',
    slug: 'cross',
    status: 'running',
    mode: 'background',
    startedAt: 1000,
    rootSessionId: ROOT_SESSION,
    parentRecordId: undefined,
    depth: 0,
    endedAt: undefined,
    turns: 0,
    totalTokens: 0,
    model: 'prov/m1',
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    result: undefined,
    error: undefined,
    sessionFile: undefined,
    ...overrides,
  }
}

interface MemberSeed {
  id: string
  /** 子 session 最终 assistant 正文（跨 message 以 "\n\n" join 后的整体——record.result
   *  与 result action 提取的同源基线，逐字节一致断言锚点）。 */
  resultText: string
  /** 子文件 assistant message 正文分段（跨 message join "\n\n"）。 */
  assistantParts: string[]
  model: string
}

describe('跨包集成：subagent-core 重建 manifest → session-reader result 反查（W4）', () => {
  let dataDir: string
  let agentDir: string
  let mainFile: string
  let services: SubagentService[]

  beforeEach(() => {
    for (const k of ENV_KEYS_TO_STRIP) delete process.env[k]
    // 生产拓扑复刻（[session-store-layout-inversion 域 9]）：agentDir = <dataDir>/agent
    //（session-reader 的 agentDir 语义），subagent-core 写侧经新公式落存储树
    // <dataDir>/ext-sessions/<rootSid>/subagents/——listRecordManifests 双根扫描的新根
    //（dirname(agentDir)/ext-sessions）与写侧落点相遇
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-pkg-subagent-core-'))
    agentDir = path.join(dataDir, 'agent')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.mkdirSync(getSubagentSessionDir(ROOT_SESSION, dataDir), { recursive: true })
    // 恢复 service 的内部 store 经 getSubagentRecordsDir(resolveStoreRootSessionId())
    //（env dataDir 兜底）解析——钉 env 把写删目标收进本 mkdtemp 树（自建自删红线，
    // subagent-core 同族测试先例 subagent-service-model-switch.test.ts）
    process.env['TAIJI_AGENT_DATA_DIR'] = dataDir
    mainFile = path.join(agentDir, 'main-session.jsonl')
    services = []
  })

  afterEach(() => {
    for (const s of services) s.dispose()
    delete process.env['TAIJI_AGENT_DATA_DIR']
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 真实 RecordStore（写文件 pi：种子经真实 register 通路 + v2 条目构造器
   *  （toRegisteredEntryData，[v1 兼容层删除] v1 快照写点 toSubagentRecordEntry 已删）
   *  落主文件）。[u-subagent dir 晚绑定] store/manifest 构造 = 目录取值函数。 */
  function makeSeedStore(): RecordStore {
    return new RecordStore(
      () => getSubagentSessionDir(ROOT_SESSION, dataDir),
      new ManifestStore(() => getSubagentRecordsDir(ROOT_SESSION, dataDir)),
      makeWritingPi(mainFile),
    )
  }

  /** 恢复侧真实 SubagentService：initSession 内 orphan 覆写真实跑（覆写 entry 落盘
   *  保留批标记/result），返回 service 供显式驱动 E1。 */
  function makeRecoveryService(): SubagentService {
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir })
    const modelRegistry: ModelRegistryLike = {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    }
    modelService.initModel({
      sessionId: ROOT_SESSION,
      ctxModel: { id: 'm', name: 'M', provider: 'p', reasoning: false },
      modelRegistry,
    })
    const service = new SubagentService({ cwd: agentDir, modelService })
    service.initSession({ pi: makeWritingPi(mainFile), sessionId: ROOT_SESSION, mainSessionFile: mainFile })
    services.push(service)
    return service
  }

  /** 子 session 文件：header + user 任务 + assistant 正文（message entries 是
   *  result action 的提取源）+ identity/record entry（orphan 覆写重建的数据锚，
   *  形态同 subagent-core W1 用例）——**不写**三 sidecar，保证恢复走
   *  finalizeOrphanRecord 真实路径。 */
  function writeChildSessionFile(m: MemberSeed): string {
    const childFile = path.join(getSubagentSessionDir(ROOT_SESSION, dataDir), `${m.id}.jsonl`)
    const ts = new Date(1000).toISOString()
    const lines: string[] = [
      JSON.stringify({ type: 'session', version: 3, id: `sess-${m.id}`, timestamp: ts, cwd: agentDir }),
      JSON.stringify({
        type: 'message', id: `${m.id}-u1`, parentId: `sess-${m.id}`, timestamp: ts,
        message: { role: 'user', content: [{ type: 'text', text: 'do the cross-package task' }] },
      }),
    ]
    m.assistantParts.forEach((text, i) => {
      lines.push(
        JSON.stringify({
          type: 'message', id: `${m.id}-a${i + 1}`, parentId: `${m.id}-u1`, timestamp: ts,
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'internal reasoning must be excluded' },
              { type: 'text', text },
            ],
          },
        }),
      )
    })
    lines.push(
      JSON.stringify({
        type: 'custom', id: `cid-${m.id}-1`, parentId: null, timestamp: ts,
        customType: 'subagent-identity',
        data: { id: m.id, agent: '/agents/worker.md', mode: 'background', task: 'cross-package task', startedAt: 1000, rootSessionId: ROOT_SESSION, depth: 0 },
      }),
      JSON.stringify({
        // 登记 §3.3：主/子文件条目范围 = v2 注册条（身份域；运行态事实源在 record 事件文件）。
        type: 'custom', id: `cid-${m.id}-2`, parentId: `cid-${m.id}-1`, timestamp: ts,
        customType: 'subagent-record',
        data: {
          v: 2, kind: 'registered', id: m.id, agent: '/agents/worker.md', task: 'cross-package task',
          slug: 'cross', origin: 'tool', rootSessionId: ROOT_SESSION, depth: 0, startedAt: 1000,
        },
      }),
    )
    fs.writeFileSync(childFile, lines.join('\n') + '\n', 'utf-8')
    return childFile
  }

  /** 种「崩溃前主文件末条序列」：register（running+sync）→ 轮终（idle + result
   *  全文 + sessionFile）——[U4/D4] 翻边后成功成员崩溃时的真实末条形态（U5 前的
   *  running+resumable 桥接形态已随字段退役消亡）。 */
  function seedRoundTerminalEntries(m: MemberSeed, childFile: string): void {
    // 登记 §3.3：v1 快照写点已删——经写入型 pi 落 v2 条目族（注册 + 终态）。
    const pi = makeWritingPi(mainFile)
    const seed = (record: SubagentRecord): void => {
      for (const entry of v2Entries(record)) pi.appendEntry(SUBAGENT_RECORD_CUSTOM_TYPE, entry)
    }
    seed(memberRecord({ id: m.id, sessionFile: childFile, model: m.model }))
    seed(memberRecord({ id: m.id, sessionFile: childFile, model: m.model, status: 'idle', result: m.resultText }))
  }

  /** record → v2 条目族（注册恒在场；非 running 再补终态条）。 */
  function v2Entries(record: SubagentRecord): Array<Record<string, unknown>> {
    const registered = {
      v: 2, kind: 'registered', id: record.id, agent: record.agent, task: record.task, slug: record.slug,
      origin: record.origin ?? 'tool', rootSessionId: record.rootSessionId, depth: record.depth,
      startedAt: record.startedAt,
    }
    if (record.status === 'running') return [registered]
    return [registered, {
      v: 2, kind: 'settled', id: record.id, status: 'idle',
      stopReason: record.stopReason ?? 'end_turn', endedAt: record.endedAt ?? record.startedAt,
      turns: record.turns, totalTokens: record.totalTokens, model: record.model,
      thinkingLevel: record.thinkingLevel,
      ...(record.sessionFile !== undefined ? { sessionFile: record.sessionFile } : {}),
      ...(record.result !== undefined ? { result: record.result } : {}),
    }]
  }

  /** 全链路驱动：种子 → 恢复 service（orphan 覆写）→ rebuildIndexes（现行 boot
   *  全量重建通道——derivedManifestRecord 派生视图真写 manifest）。返回子 session 文件
   *  路径表。[collect 退役] 原 E1 落标出口（recoverSyncCollectBatch →
   *  appendBatchFinalizedEntry）随 sync 批机制删除。 */
  async function driveManifestRebuild(members: MemberSeed[]): Promise<Map<string, string>> {
    const childFiles = new Map<string, string>()
    for (const m of members) {
      const childFile = writeChildSessionFile(m)
      childFiles.set(m.id, childFile)
      seedRoundTerminalEntries(m, childFile)
    }
    const service = makeRecoveryService()
    service.rebuildIndexes()
    // derivedManifestRecord 派生视图为同步落盘——全成员 manifest 即刻可见（W3 派生视图
    // 代码路径的产物，非手工预写）。
    for (const m of members) {
      expect(
        fs.existsSync(path.join(getSubagentRecordsDir(ROOT_SESSION, dataDir), `${m.id}.json`)),
        `manifest of ${m.id}`,
      ).toBe(true)
    }
    return childFiles
  }

  it('1. 单 sa- id：E1 落标 manifest 真实产出 → result 反查命中，正文与 record.result 逐字节一致', async () => {
    const resultText = 'part one\n\npart two'
    const m: MemberSeed = {
      id: 'sa-cross-1',
      resultText,
      assistantParts: ['part one', 'part two'],
      model: 'prov/round-m',
    }
    const childFiles = await driveManifestRebuild([m])

    // manifest 内容断言（rebuildIndexes → derivedManifestRecord 派生视图路径的产物，
    // 非手工预写）：sessionFile 来自 W1 派生视图扩展。[U2/U3 两态桥接] 恢复链覆写后成员
    // 处于 idle（重建单规则）、无旧终态遗留位 → legacy status 如实派生 "running"
    //（legacyManifestStatusFields 单点派生，session-reader 视角的活跃成员）。
    const manifest = JSON.parse(
      fs.readFileSync(path.join(getSubagentRecordsDir(ROOT_SESSION, dataDir), 'sa-cross-1.json'), 'utf-8'),
    ) as Record<string, unknown>
    expect(manifest).toMatchObject({
      id: 'sa-cross-1',
      rootSessionId: ROOT_SESSION,
      agentName: '/agents/worker.md',
      status: 'running',
      sessionFile: childFiles.get('sa-cross-1'),
    })

    // session-reader 侧：sa- id 反查（v1 此处报「无匹配 record」——manifest 惰性不落盘）
    const r = await handleSessionRead({ action: 'result', session: 'sa-cross-1' }, { agentDir })
    // 同源语义：跨 assistant message "\n\n" join、thinking 块排除——与 record.result 逐字节一致
    expect(r.content[0]?.text).toBe(resultText)
    const d = r.details as {
      session: string
      sessionId: string
      sessionFile: string
      totalChars: number
      truncated: boolean
    }
    expect(d.session).toBe('sa-cross-1')
    expect(d.sessionId).toBe('sess-sa-cross-1') // header 真实 id，非 sa- 占位
    expect(d.sessionFile).toBe(childFiles.get('sa-cross-1'))
    expect(d.totalChars).toBe(resultText.length)
    expect(d.truncated).toBe(false)
  })

  it('2. 双成员批（逗号串批量）：全部 sa- id 反查命中，头行/分隔/顺序与正文一致', async () => {
    const members: MemberSeed[] = [
      { id: 'sa-cross-a', resultText: 'alpha final answer', assistantParts: ['alpha final answer'], model: 'prov/ma' },
      { id: 'sa-cross-b', resultText: 'beta final answer', assistantParts: ['beta final answer'], model: 'prov/mb' },
    ]
    await driveManifestRebuild(members)

    const r = await handleSessionRead({ action: 'result', session: 'sa-cross-a,sa-cross-b' }, { agentDir })
    const text = r.content[0]?.text ?? ''
    expect(text).toContain('[1/2] sa-cross-a')
    expect(text).toContain('[2/2] sa-cross-b')
    expect(text.indexOf('[1/2]')).toBeLessThan(text.indexOf('[2/2]'))
    expect(text).toContain('\n\n---\n\n')
    // 每成员正文与 record.result 一致（批量形态下同样逐字节）
    expect(text).toContain('alpha final answer')
    expect(text).toContain('beta final answer')
    const d = r.details as { count: number; items: Array<{ session: string; text: string; truncated: boolean }> }
    expect(d.count).toBe(2)
    expect(d.items.map((i) => i.session)).toEqual(['sa-cross-a', 'sa-cross-b'])
    expect(d.items[0]?.text).toBe('alpha final answer')
    expect(d.items[1]?.text).toBe('beta final answer')
    expect(d.items.every((i) => !i.truncated)).toBe(true)
  })
})
});

// ======== 来源：rebuild-manifest-dual-write.test.ts ========
describe("rebuild-manifest-dual-write", () => {
  const ROOT_SESSION = 'root-dual-write'

  /** session-reader identity 派生视图（manifestIdentityData）消费的字段集——重建窗口
 *  前后必须逐字段一致（降级 = 任一字段缺失/漂移）。 */
  function identityView(m: RecordManifest) {
    return {
      id: m.id,
      rootSessionId: m.rootSessionId,
      agentName: m.agentName,
      task: m.task,
      slug: m.slug,
      model: m.model,
      status: m.status,
      sessionFile: m.sessionFile,
      parentRecordId: m.parentRecordId,
    }
  }

  describe('跨包集成：subagent-core rebuildIndexes 重建 manifest → session-reader 投影不降级', () => {
    let dataDir: string
    let agentDir: string
    let sessionsDir: string
    let recordsDir: string
    let childFile: string

    beforeEach(() => {
      // 生产拓扑复刻（[session-store-layout-inversion 域 9]）：agentDir = <dataDir>/agent
      //（session-reader 的 agentDir 语义），subagent-core 写侧经新公式落存储树
      // <dataDir>/ext-sessions/<rootSid>/subagents/——listRecordManifests 双根扫描的新根
      //（dirname(agentDir)/ext-sessions）与写侧落点相遇
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-rebuild-dualwrite-'))
      agentDir = path.join(dataDir, 'agent')
      sessionsDir = getSubagentSessionDir(ROOT_SESSION, dataDir)
      recordsDir = getSubagentRecordsDir(ROOT_SESSION, dataDir)
      fs.mkdirSync(sessionsDir, { recursive: true })
      fs.mkdirSync(recordsDir, { recursive: true })

      // 子 session 文件：session header + model_change（light 重建的 model 源——
      // identity 前途经 entry best-effort 提取）+ identity entry（session-reader
      // 步骤 2 首行 header 探测 + manifest 主路径的数据锚）
      childFile = path.join(sessionsDir, '20260912T000000_sa-dw.jsonl')
      const ts = new Date(1000).toISOString()
      fs.writeFileSync(
        childFile,
        [
          JSON.stringify({ type: 'session', version: 3, id: 'sess-sa-dw', timestamp: ts, cwd: agentDir }),
          JSON.stringify({ type: 'model_change', id: 'mc-1', parentId: null, timestamp: ts, provider: 'prov', modelId: 'm1' }),
          JSON.stringify({
            type: 'custom',
            id: 'id-1',
            parentId: null,
            timestamp: ts,
            customType: 'subagent-identity',
            data: {
              id: 'sa-dw',
              agent: 'worker',
              mode: 'background',
              task: 'dual write task',
              slug: 'dual',
              startedAt: 1000,
              rootSessionId: ROOT_SESSION,
              parentRecordId: 'sa-parent',
              depth: 1,
            },
          }),
        ].join('\n') + '\n',
        'utf-8',
      )
    })

    afterEach(() => {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('S5③: manifest 删除 → rebuildIndexes 重建 → identity 派生视图字段集前后一致（双写字段在场）', async () => {
      // ── 初始 manifest：subagent-core 终态写侧（markFinalized）真实产出 ──
      const record = createRecord('sa-dw', {
        agent: 'worker',
        model: 'prov/m1',
        mode: 'background',
        task: 'dual write task',
        slug: 'dual',
        startedAt: 1000,
        rootSessionId: ROOT_SESSION,
        parentRecordId: 'sa-parent',
        depth: 1,
        chatMode: false,
        controller: new AbortController(),
      })
      Object.assign(record, {
        sessionFile: childFile,
        status: 'closed' as const,
        closedReason: 'gc' as const,
        endedAt: 2000,
      })
      // [u-subagent dir 晚绑定] RecordStore 构造 = 目录取值函数（非目录字符串）
      const writer = new RecordStore(() => sessionsDir, undefined, undefined, () => recordsDir)
      expect(writer.markFinalized(record, 'gc')).toBe(true)
      writer.dispose()

      const before = (await listRecordManifests(agentDir)).find((m) => m.id === 'sa-dw')
      expect(before).toBeDefined()
      const viewBefore = identityView(before!)

      // 双写过渡字段在写侧就位（本包不消费，但前向兼容锚要求其在场）。
      // [U2 两态] executionStatus 是内部权威词汇（running|idle 两态，终态概念删除）
      // → 终态化后恒 'idle'；status 旧三态是 session-reader 直读派生视图（永久保留）→ 'closed'。
      const rawBefore = JSON.parse(fs.readFileSync(path.join(recordsDir, 'sa-dw.json'), 'utf-8')) as Record<string, unknown>
      expect(rawBefore.executionStatus).toBe('idle')
      expect(rawBefore.status).toBe('closed')

      // ── S5 场景：人为删除全部 manifest（缓存可丢）→ 全量重建 ──
      for (const f of fs.readdirSync(recordsDir)) fs.rmSync(path.join(recordsDir, f))
      expect((await listRecordManifests(agentDir)).filter((m) => m.id === 'sa-dw')).toHaveLength(0)

      const rebuilder = new RecordStore(() => sessionsDir, undefined, undefined, () => recordsDir)
      expect(rebuilder.rebuildIndexes()).toBe(1)
      rebuilder.dispose()

      // ── session-reader 视角：重建后 identity 派生视图不降级 ──
      const after = (await listRecordManifests(agentDir)).find((m) => m.id === 'sa-dw')
      expect(after).toBeDefined()
      // 字段集保真（身份/富字段逐字段一致）；仅 legacy status 按 ③ 后重建语义如实
      // 派生 running（终态权威 = 事件流 record-settled 帧，磁盘重建无 closedReason 载体）。
      expect(identityView(after!)).toEqual({ ...viewBefore, status: 'running' })

      const rawAfter = JSON.parse(fs.readFileSync(path.join(recordsDir, 'sa-dw.json'), 'utf-8')) as Record<string, unknown>
      expect(rawAfter.status).toBe('running')
      expect(rawAfter.executionStatus).toBe('idle')
      // closedReason 无重建载体（`.state` 退场）→ 如实缺席。
      expect(rawAfter.closedReason).toBeUndefined()
    })

    it('惰性通道：查询结果（collectRecords）补建的 manifest 同样可被本包读取派生视图', async () => {
      // 不经终态写侧（无 manifest 初始形态）：磁盘 record 只有 identity + 无 sidecar
      // → 查询触发惰性补建。
      const store = new RecordStore(() => sessionsDir, undefined, undefined, () => recordsDir)
      expect(store.collectRecords(10).map((r) => r.id)).toContain('sa-dw')
      store.dispose()

      const manifests = await listRecordManifests(agentDir)
      const found = manifests.find((m) => m.id === 'sa-dw')
      expect(found).toBeDefined()
      expect(found!.status).toBe('running')
      expect(found!.task).toBe('dual write task')
      expect(found!.agentName).toBe('worker')
      expect(found!.sessionFile).toBe(childFile)
      expect(found!.parentRecordId).toBe('sa-parent')
      // 双写过渡字段（[U3 重建单规则] 无 sidecar 重建一律 idle：executionStatus 如实
      // 派生两态词汇；legacy status 经桥接判据派生——无 closedReason 遗留位的 idle
      // 派生 "running"（session-reader 视角的活跃成员，§3.2.8 下行映射）。
      const raw = JSON.parse(fs.readFileSync(path.join(recordsDir, 'sa-dw.json'), 'utf-8')) as Record<string, unknown>
      expect(raw.executionStatus).toBe('idle')
      expect(raw.status).toBe('running')
    })
  })
});
