import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { handleSessionRead } from '../tool-handler.js'
// barrel 符号走包根；ManifestStore / ModelRegistryLike / path-encoding 函数未进 barrel
// （D3 判定不进），按 subagent-workflow 测试同款包名 .ts 深路径消费，vitest alias 解析。
import {
  ModelConfigService,
  RecordStore,
  SubagentService,
  type SubagentRecord,
} from '@zhushanwen/subagent-core'
import { ManifestStore } from '@zhushanwen/subagent-core/execution/manifest-store.ts'
import type { ModelRegistryLike } from '@zhushanwen/subagent-core/execution/model-resolver.ts'
import {
  getSubagentRecordsDir,
  getSubagentSessionDir,
} from '@zhushanwen/subagent-core/execution/path-encoding.ts'

/**
 * W4 跨包集成测试（subagent-sync-collect v2 impl-plan W4 验收条款①，设计 §5 W4：
 * 「subagent-core 真实 tmpdir 产出磁盘状态 → session-reader result action sa- id 反查，
 * 不 mock manifest 写入」）。
 *
 * 与 result.test.ts 的分工：result.test.ts 的 fixture **手工预写** manifest（U6 时期
 * W3 投影代码尚不存在）；本文件 manifest 内容必须来自 v2 W3 的投影代码路径——
 * subagent-core 侧真实驱动 E1 崩溃恢复（kill -9 同构链路：真实 RecordStore 落盘
 * register/轮终 entry → initSession 内 orphan 覆写真实跑 → recoverSyncCollectBatch
 * 落标出口 appendBatchFinalizedEntry fire-and-forget 真写 records/<sa-id>.json），
 * session-reader 侧零 mock 读同一 tmpdir 断言反查闭环。
 *
 * 构造形态取自 subagent-core sync-collect-recovery.test.ts 的 kill -9 同构主用例
 * （W1 领地，形态同构是 v1 教训「种子绕过真实链路 = 假绿」的执行）：子 session 文件
 * 在其基础上补 message entries（result action 的正文提取源）。
 *
 * mock 面最小：仅构造 SubagentService 所需的最小 pi 形状（appendEntry 真写主文件，
 * 其余 no-op stub）——零 vi.mock、notifier/store/config 全真实实现，agentDir 全部
 * mkdtemp(tmpdir) 自建自删（红线：零真实数据目录触碰）。
 */

/** 剥身份/relay env（subagent-core 测试纪律同款）：身份 env 会让 service 误判自己是
 *  子进程跳过恢复扫描，relay env 改道 pi-invocation 的 relay 分支。 */
const ENV_KEYS_TO_STRIP = [
  'PI_SUBAGENT_ROOT_SESSION_ID',
  'PI_SUBAGENT_SELF_RECORD_ID',
  'PI_SUBAGENT_DEPTH',
  'PI_SUBAGENT_ROOT_CWD',
  'PI_SUBAGENT_FORK_DEPTH',
  'XYZ_SUBAGENT_RELAY_SOCKET',
  'XYZ_SUBAGENT_RELAY_NODE',
  'XYZ_SUBAGENT_RELAY_SCRIPT',
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
    chatMode: false,
    collectMode: 'sync',
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

describe('跨包集成：subagent-core E1 落标 manifest → session-reader result 反查（W4）', () => {
  let agentDir: string
  let mainFile: string
  let services: SubagentService[]

  beforeEach(() => {
    for (const k of ENV_KEYS_TO_STRIP) delete process.env[k]
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-pkg-subagent-core-'))
    fs.mkdirSync(getSubagentSessionDir(agentDir, agentDir), { recursive: true })
    mainFile = path.join(agentDir, 'main-session.jsonl')
    services = []
  })

  afterEach(() => {
    for (const s of services) s.dispose()
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 真实 RecordStore（写文件 pi：种子经真实 toSubagentRecordEntry 序列化落主文件）。 */
  function makeSeedStore(): RecordStore {
    return new RecordStore(
      getSubagentSessionDir(agentDir, agentDir),
      new ManifestStore(getSubagentRecordsDir(agentDir, agentDir)),
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
    const childFile = path.join(getSubagentSessionDir(agentDir, agentDir), `${m.id}.jsonl`)
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
        type: 'custom', id: `cid-${m.id}-2`, parentId: `cid-${m.id}-1`, timestamp: ts,
        customType: 'subagent-record',
        data: {
          v: 1, id: m.id, agent: '/agents/worker.md', task: 'cross-package task', slug: 'cross',
          status: 'running', mode: 'background', startedAt: 1000, rootSessionId: ROOT_SESSION,
          depth: 0, turns: 1, totalTokens: 10, model: m.model, eventLog: [], displayItems: [],
        },
      }),
    )
    fs.writeFileSync(childFile, lines.join('\n') + '\n', 'utf-8')
    return childFile
  }

  /** 种「崩溃前主文件末条序列」：register（running+sync）→ 轮终（running+resumable+
   *  result 全文 + sessionFile）——成功成员崩溃时的真实末条形态。 */
  function seedRoundTerminalEntries(m: MemberSeed, childFile: string): void {
    const store = makeSeedStore()
    store.reportSubagentRecord(memberRecord({ id: m.id, sessionFile: childFile, model: m.model }))
    store.reportSubagentRecord(
      memberRecord({ id: m.id, sessionFile: childFile, model: m.model, resumable: true, result: m.resultText }),
    )
  }

  /** 手写短轮询（真实 timers，vitest 4.1.8 vi.waitFor 对 falsy callback 不轮询——
   *  subagent-core 同款纪律）：manifest 为 fire-and-forget 异步写，需轮询等落盘。 */
  async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now()
    while (!cond()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`cross-pkg: condition not met within ${timeoutMs}ms`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  /** 全链路驱动：种子 → 恢复 service（orphan 覆写）→ E1（落标出口真写 manifest）。
   *  返回子 session 文件路径表。 */
  async function driveSyncBatchRecovery(members: MemberSeed[]): Promise<Map<string, string>> {
    const childFiles = new Map<string, string>()
    for (const m of members) {
      const childFile = writeChildSessionFile(m)
      childFiles.set(m.id, childFile)
      seedRoundTerminalEntries(m, childFile)
    }
    const service = makeRecoveryService()
    service.recoverSyncCollectBatch()
    // E1 落标出口 appendBatchFinalizedEntry 的 manifest 是 fire-and-forget best-effort
    // 写——轮询等全部成员 manifest 真实落盘（W3 投影代码路径的产物）。
    await until(() =>
      members.every((m) => fs.existsSync(path.join(getSubagentRecordsDir(agentDir, agentDir), `${m.id}.json`))),
    )
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
    const childFiles = await driveSyncBatchRecovery([m])

    // manifest 内容断言（W3 appendBatchFinalizedEntry 投影路径的产物，非手工预写）：
    // sessionFile 来自 W1 投影扩展。[U2/U3 两态桥接] E1 落标成员经恢复链覆写后处于
    // idle（重建单规则）/running 形态、无旧终态遗留位 → legacy status 如实投影
    // "running"（batchManifestRecord 单点派生，session-reader 视角的活跃成员）。
    const manifest = JSON.parse(
      fs.readFileSync(path.join(getSubagentRecordsDir(agentDir, agentDir), 'sa-cross-1.json'), 'utf-8'),
    ) as Record<string, unknown>
    expect(manifest).toMatchObject({
      id: 'sa-cross-1',
      rootSessionId: ROOT_SESSION,
      agentName: '/agents/worker.md',
      status: 'running',
      sessionFile: childFiles.get('sa-cross-1'),
    })

    // session-reader 侧：sa- id 反查（v1 此处报「无匹配 record」——manifest 惰性不落盘）
    const r = await handleSessionRead({ action: 'result', session: 'sa-cross-1' }, agentDir)
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
    await driveSyncBatchRecovery(members)

    const r = await handleSessionRead({ action: 'result', session: 'sa-cross-a,sa-cross-b' }, agentDir)
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
