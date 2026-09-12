// 跨包集成（[U4c / G4-S5③] record 持久化收敛 P4c 验收锚点）：
// subagent-core 重建/终态写面产出的 manifest → session-reader identity 投影不降级。
//
// 断言链（设计 subagent-record-persistence-consolidation D5 前向兼容判定 + S5③）：
//   1. manifest 被人为删除（S5 缓存可丢场景）→ subagent-core RecordStore.rebuildIndexes
//      全量重建 → session-reader listRecordManifests 重新可见；
//   2. 重建窗口前后，session-reader identity 投影的输入字段集（rootSessionId/slug/
//      task/agentName/model/status/sessionFile/parentRecordId）逐字段一致——双写过渡
//      字段（executionStatus）在场且不被本包消费（旧 status 三态投影继续生效）；
//   3. 重建源 = `.state` 权威（closedReason 从终态位派生，旧三态 cancelled 形态
//      保真——buildRecord 分支 1 → derivedManifestRecord 派生）。
//
// 形态同 cross-package-subagent-core.test.ts：subagent-core 真实 tmpdir 产出磁盘
// 状态，本包零 mock 读同一 tmpdir；不触碰真实数据目录（红线）。

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RecordStore } from '@zhushanwen/subagent-core'
// barrel 外符号按包名 .ts 深路径消费（vitest alias 重写，同 cross-package 先例）
import { createRecord } from '@zhushanwen/subagent-core/execution/execution-record.ts'
import {
  getSubagentRecordsDir,
  getSubagentSessionDir,
} from '@zhushanwen/subagent-core/execution/path-encoding.ts'

import { listRecordManifests, type RecordManifest } from '../discovery/subagents.js'

const ROOT_SESSION = 'root-dual-write'

/** session-reader identity 投影（manifestIdentityData）消费的字段集——重建窗口
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
  let agentDir: string
  let sessionsDir: string
  let recordsDir: string
  let childFile: string

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-rebuild-dualwrite-'))
    sessionsDir = getSubagentSessionDir(agentDir, agentDir)
    recordsDir = getSubagentRecordsDir(agentDir, agentDir)
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
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('S5③: manifest 删除 → rebuildIndexes 重建 → identity 投影字段集前后一致（双写字段在场）', async () => {
    // ── 初始 manifest：subagent-core 终态写面（markFinalized）真实产出 ──
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
    const writer = new RecordStore(sessionsDir, undefined, undefined, recordsDir)
    expect(writer.markFinalized(record, 'gc')).toBe(true)
    writer.dispose()

    const before = (await listRecordManifests(agentDir)).find((m) => m.id === 'sa-dw')
    expect(before).toBeDefined()
    const viewBefore = identityView(before!)

    // 双写过渡字段在写面就位（本包不消费，但前向兼容锚要求其在场）
    const rawBefore = JSON.parse(fs.readFileSync(path.join(recordsDir, 'sa-dw.json'), 'utf-8')) as Record<string, unknown>
    expect(rawBefore.executionStatus).toBe('closed')
    expect(rawBefore.status).toBe('closed')

    // ── S5 场景：人为删除全部 manifest（缓存可丢）→ 全量重建 ──
    for (const f of fs.readdirSync(recordsDir)) fs.rmSync(path.join(recordsDir, f))
    expect((await listRecordManifests(agentDir)).filter((m) => m.id === 'sa-dw')).toHaveLength(0)

    const rebuilder = new RecordStore(sessionsDir, undefined, undefined, recordsDir)
    expect(rebuilder.rebuildIndexes()).toBe(1)
    rebuilder.dispose()

    // ── session-reader 视角：重建后 identity 投影不降级 ──
    const after = (await listRecordManifests(agentDir)).find((m) => m.id === 'sa-dw')
    expect(after).toBeDefined()
    expect(identityView(after!)).toEqual(viewBefore)

    // 重建源 = `.state` 权威：closedReason 从终态位派生回 manifest（旧三态 closed）
    const rawAfter = JSON.parse(fs.readFileSync(path.join(recordsDir, 'sa-dw.json'), 'utf-8')) as Record<string, unknown>
    expect(rawAfter.status).toBe('closed')
    expect(rawAfter.executionStatus).toBe('closed')
    expect(rawAfter.closedReason).toBe('gc')
  })

  it('惰性通道：查询面（collectRecords）补建的 manifest 同样可被本包读取投影', async () => {
    // 不经终态写面（无 manifest 初始形态）：磁盘 record 只有 identity + 无 sidecar
    // （running 形态）→ 查询触发惰性补建。
    const store = new RecordStore(sessionsDir, undefined, undefined, recordsDir)
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
    // 双写过渡字段在场（running 二态）
    const raw = JSON.parse(fs.readFileSync(path.join(recordsDir, 'sa-dw.json'), 'utf-8')) as Record<string, unknown>
    expect(raw.executionStatus).toBe('running')
    expect(raw.status).toBe('running')
  })
})
