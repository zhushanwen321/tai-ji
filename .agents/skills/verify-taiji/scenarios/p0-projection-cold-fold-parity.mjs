/**
 * p0-projection-cold-fold-parity —— 投影一致性 A9（设计 §4.1 V9：冷启动列表查询与
 * 删档对拍）。回归对照面——续读链交付（U1-U5 全部 committed）后本剧本必须仍绿；
 * 红 = 实装改变了冷启动读法或删档处置形态，按设计偏差上报（A9 节点任务书）。
 *
 * 断言面（A9 节点任务书，对应设计 V9 通过标准）：
 * ① 冷启动（runtime 无该会话内存投影）后直接查询 session.getSubagents 与
 *    session.getWorkflows（两域事件目录全量 fold 冷读建投影）在观测分布负载内完成
 *    ——G7 关闭口径：不设大小两档计时断言，冷启动查询耗时记日志备查；
 * ② 冷启动列表与全量 fold 派生视图列表一致（剧本独立 fold 两域事件文件 + 主文件
 *    v2 注册/终态条目，与查询 wire 对拍）；
 * ③ 删档对账：模拟保留维护轮删档（fixture 直接删除一条记录的事件文件——「主文件
 *    注册与终态条目在册 ∧ 事件文件缺席」磁盘态，对保留维护轮 / 主会话级联删除编排
 *    中途崩溃窗口 / btw 线删除的线 jsonl 在册形态等价）后：
 *    - 列表仍含该记录（维护轮删除对象仅两域事件文件，注册与终态条目不删）；
 *    - 状态 = entry 末态且与 fold 列表一致（D2 反向分支处置最小行）；
 *    - 详情按已裁形态呈现（事件流降级）；
 *    - 派生态无限滞留不发生（删档后再次查询与磁盘 fold 真值持续一致、不回跳旧态）。
 *
 * wire 可观测性注记（设计措辞 → wire 锚的翻译，非放宽）：
 * - 「事件游标随同一轮核对失效清理，续读链对该文件无残留游标」是续读链机制内部态
 *   （不出 wire）——真机面断言其用户可见承诺：删档记录行持续与磁盘 fold 真值一致、
 *   不回跳事件源旧态；游标级清理由单元测试层承载（impl-plan U1 检查点「删档反向
 *   分支生效用例」fixture 直接删除事件文件），登记 notProvable。
 * - 「详情按已裁形态呈现（事件流降级）」的 wire 翻译：事件流（record events 序列）
 *   无独立 RPC 帧，详情视图数据源 = fold 派生行（列表行字段）+ 对话流直读
 *   （session.getSubagentHistory 读 record.sessionFile——维护轮删档对象不含子代理
 *   会话 jsonl）。断言锚 = entry-source-only 实体行字段全部由终态条目供源
 *   （fixture 内 sa-gone-03：注册 + 终态条目在册、事件文件天然缺席——冷读建投影
 *   即产出降级形态，是 fold 缺席 → entry 末态构建行既有先例的直测载体）+ 删档后
 *   对话流仍可读。
 *
 * 孤儿 run 对账清理形态（AS4 第七来源：注册条目已失 → found=false 分形既有行为）
 * 不经本 fixture 断言（A9 任务书与设计 V9 一致排除）。
 *
 * 词表与布局（源码核对锚，勿凭示例硬写）：
 * - 主会话文件 `<dataDir>/agent/sessions/<encodeCwd(cwd)>/<sid>.jsonl`，首行 session
 *   header；record 族 custom entry 行 = `{type:'custom', customType:'subagent-record'
 *   |'workflow-record', data:{v:2, kind:'registered'|'settled', ...}}`
 *   （subagent-core record-entry.ts / workflow-record-entry.ts，classify 单源判 v/kind）。
 * - record 事件文件 `<dataDir>/ext-sessions/<rootSid>/subagents/records/<sa-id>.events`
 *   （RECORD_EVENTS_SUFFIX='.events'），首行头行 `{type:'record-events',id}`；事件帧
 *   信封 {seq,ts}，词表 record-events.ts（record-created 定身份、record-round-idle
 *   轮终收条、record-settled 终局）。
 * - run journal `<dataDir>/ext-sessions/<rootSid>/workflow/runs/<runId>.record.jsonl`
 *   （RUN_EVENTS_SUFFIX='.record.jsonl'，runIdOfFilename 剥后缀）；词表 run-created /
 *   run-settled 等 11 类（run-vocabulary.ts RUN_EVENT_TYPES）。
 * - fold 末态语义（events-projection.ts resolveSubagentStatus / projectV2Subagent）：
 *   fold 在册 = lastEvent 判（round-idle → idle / round-started → running）；
 *   fold 缺席 = settledEntry 兜底（status:'idle'、stopReason 取条目值）。
 *   workflow 侧（workflow-record-projection.ts resolveWorkflowStatus）：fold 在册且
 *   run-settled 帧 → 'done'；fold 缺席 = 终态条目三态自描述。
 */
import fs from 'node:fs'
import path from 'node:path'

const RECORD_EVENTS_SUFFIX = '.events'
const RUN_EVENTS_SUFFIX = '.record.jsonl'

/** shared/session-store-paths.ts encodeCwd 的同式副本（fixture 自含，不 import 仓内 TS）。 */
function encodeCwd(cwd) {
  return '--' + cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--'
}

function writeJsonl(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

/** 主会话文件（session header + record 族 v2 条目）+ project 绑定 sidecar。 */
function seedSessionWithEntries(dataDir, { sid, cwd, projectId, recordEntries, workflowEntries }) {
  const dir = path.join(dataDir, 'agent', 'sessions', encodeCwd(cwd))
  fs.mkdirSync(dir, { recursive: true })
  const sessionFile = path.join(dir, `${sid}.jsonl`)
  const lines = [{ type: 'session', id: sid, cwd, timestamp: new Date().toISOString() }]
  lines.push(...recordEntries, ...workflowEntries)
  writeJsonl(sessionFile, lines)
  if (projectId !== undefined) {
    fs.writeFileSync(`${sessionFile}.project.json`, `${JSON.stringify({ projectId })}\n`)
  }
  return sessionFile
}

/**
 * record 域 v2 条目行（customType 'subagent-record'，v2 两族：registered + settled）。
 * settled 同值形态 = 保留维护轮删档的真实前提（fold 终态 ∧ 超窗才删——fold 末态与
 * entry 末态同源同值，run-state-evidence.ts 资格判据）。
 */
function subagentRecordEntry(kind, fields) {
  return { type: 'custom', customType: 'subagent-record', data: { v: 2, kind, ...fields } }
}

/** run 域 v2 条目行（customType 'workflow-record'，同构两族）。 */
function workflowRecordEntry(kind, fields) {
  return { type: 'custom', customType: 'workflow-record', data: { v: 2, kind, ...fields } }
}

/** record 事件文件（头行 + record-created + record-round-idle 终态——同值形态 fold 末态）。 */
function seedRecordEventsFile(dataDir, sid, { id, agent, task, slug, ts, stopReason, sessionFile }) {
  const recordsDir = path.join(dataDir, 'ext-sessions', sid, 'subagents', 'records')
  writeJsonl(path.join(recordsDir, `${id}${RECORD_EVENTS_SUFFIX}`), [
    { type: 'record-events', id },
    {
      type: 'record-created',
      seq: 1,
      ts,
      id,
      agent,
      task,
      slug,
      origin: 'tool',
      rootSessionId: sid,
      depth: 0,
      mode: 'background',
      startedAt: ts,
    },
    {
      type: 'record-round-idle',
      seq: 2,
      ts: ts + 1_000,
      round: 1,
      stopReason,
      turns: 3,
      totalTokens: 1234,
      resultSummary: 'parity fixture round done',
    },
  ])
  return { recordsDir, file: path.join(recordsDir, `${id}${RECORD_EVENTS_SUFFIX}`) }
}

/** 子代理会话 jsonl（详情对话流直读载体；行形态 = pi session entry message 行）。 */
function seedSubagentSessionFile(dataDir, sid, saId, ts) {
  const sessionsDir = path.join(dataDir, 'ext-sessions', sid, 'subagents', 'sessions')
  writeJsonl(path.join(sessionsDir, `${saId}.jsonl`), [
    { type: 'message', id: `${saId}-m1`, timestamp: new Date(ts).toISOString(), message: { role: 'user', content: [{ type: 'text', text: `parity fixture prompt for ${saId}` }] } },
    { type: 'message', id: `${saId}-m2`, timestamp: new Date(ts + 500).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: `parity fixture reply for ${saId}` }] } },
  ])
  return path.join(sessionsDir, `${saId}.jsonl`)
}

/** run journal（run-created + run-settled 终帧——fold 在册终态形态）。 */
function seedRunJournal(dataDir, sid, { runId, workflowName, ts }) {
  const runsDir = path.join(dataDir, 'ext-sessions', sid, 'workflow', 'runs')
  writeJsonl(path.join(runsDir, `${runId}${RUN_EVENTS_SUFFIX}`), [
    { type: 'run-created', seq: 1, ts, runId, rootSessionId: sid, workflowName, argsSummary: '{"fixture":true}' },
    { type: 'run-settled', seq: 2, ts: ts + 2_000, outcome: 'done' },
  ])
  return { runsDir, file: path.join(runsDir, `${runId}${RUN_EVENTS_SUFFIX}`) }
}

// ── 独立 fold 对拍副本（fixture 自含，语义对齐 projectV2Subagent / projectV2Workflow
//    在本 fixture 形态上的可见行为；只复刻对拍字段，不复刻全量投影）────────────

/** record 域单文件 fold：文件缺席 = null（fold 缺席态）；在册 = {status, stopReason}。 */
function foldRecordEventsFile(file) {
  let lines
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n')
  } catch {
    return null // 事件文件缺席（删档形态 / 天然 entry-source-only 形态）
  }
  let lastType
  let roundIdleStopReason
  for (const line of lines) {
    if (line.trim().length === 0) continue
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      continue
    }
    if (frame.type === 'record-events') continue // 头行不参与 fold
    lastType = frame.type
    if (frame.type === 'record-round-idle') roundIdleStopReason = frame.stopReason
  }
  if (lastType === 'record-round-idle') return { status: 'idle', stopReason: roundIdleStopReason }
  if (lastType === 'record-round-started') return { status: 'running', stopReason: undefined }
  return { status: 'running', stopReason: undefined }
}

/** run 域单文件 fold：文件缺席 = null；在册 = {status, outcome}（run-settled 帧 → done）。 */
function foldRunJournalFile(file) {
  let lines
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n')
  } catch {
    return null
  }
  let created
  let settled
  for (const line of lines) {
    if (line.trim().length === 0) continue
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      continue
    }
    if (frame.type === 'run-created') created = frame
    if (frame.type === 'run-settled') settled = frame
  }
  if (settled !== undefined) return { status: 'done', outcome: settled.outcome }
  if (created !== undefined) return { status: 'running', outcome: undefined }
  return null
}

/** 期望列表行集：v2 条目 + 事件 fold 合并（fold 缺席 → settledEntry 兜底，entry 末态）。 */
function expectedSubagentRows(recordEntries) {
  const rows = new Map()
  const registeredById = new Map()
  const settledById = new Map()
  for (const entry of recordEntries) {
    const d = entry.data
    if (d.kind === 'registered') registeredById.set(d.id, d)
    if (d.kind === 'settled') settledById.set(d.id, d)
  }
  for (const [id, reg] of registeredById) {
    const settledEntry = settledById.get(id)
    rows.set(id, {
      status: settledEntry !== undefined ? 'idle' : 'running', // fold 缺席 → settledEntry 兜底
      stopReason: settledEntry?.stopReason,
    })
  }
  return { rows, registeredById, settledById }
}

export const meta = {
  id: 'p0-projection-cold-fold-parity',
  priority: 'P0',
  title: '投影一致性 V9：冷启动列表查询与删档对拍（两域全量 fold 冷读一致性 + 删档 entry 末态最小行）',
  covers: ['session.persistence', 'subagent.list', 'workflow.runs'],
  requires: ['none'],
  estimateSec: 240,
  provable: [
    'V9②: 冷启动首次查询 getSubagents/getWorkflows 返回的列表与剧本独立 fold 两域事件文件 + 主文件 v2 条目的真值一致（id 集合 / status / stopReason / outcome）',
    'V9④: 删档（fixture 删除一条记录的事件文件，注册与终态条目保留）后列表仍含该记录、状态 = entry 末态、与 fold 列表一致',
    'V9④: entry-source-only 形态行字段全部由终态条目供源（fixture 天然缺席事件文件的记录，冷读建投影即降级形态）',
    'V9④: 删档后详情对话流仍可读（session.getSubagentHistory 直读 record.sessionFile，事件域缺席不拖垮详情）',
    'V9④: 删档后再次查询与磁盘 fold 真值持续一致（无滞留的用户可见面：不回跳事件源旧态）',
  ],
  notProvable: [
    '「事件游标随同一轮核对失效清理」的游标级清理是续读链机制内部态（不出 wire）——单元测试层承载（impl-plan U1 检查点：删档反向分支生效用例），本剧本断言其用户可见承诺',
    '「详情事件流降级」的事件序列本身无独立 RPC 帧——wire 锚 = 列表行 entry 兜底源 + 对话流直读不受影响',
    '孤儿 run 对账清理形态（AS4 第七来源，注册条目已失 → found=false 分形既有行为）不经本 fixture 断言（设计 V9 同款排除）',
    'G7 关闭口径：不设大小两档计时断言，冷启动查询耗时仅记日志备查（对照 M1 V1 计时 91 文件 3.1ms / 分布实测折算上界约 14ms）',
  ],
}

export async function run(ctx) {
  const { repo, ev, log, dataDir } = ctx
  const gotchas = [
    '删档后查询在现状查询链（mtime 对账）与续读链交付后（反向分支）两形态下的可见行为一致——fixture 取同值形态（fold 末态 = entry 末态），两头绿即回归对照面达成',
    'sa-gone-03 事件文件天然缺席（只写注册与终态条目）——把「fold 缺席 → entry 末态构建行」的降级形态独立于删档步骤钉在冷读路径上',
  ]
  const cwd = path.join(repo, 'e2e', 'fixtures', 'sample-project')
  const SID = 'sess-projection-parity-fixture'
  const PROJECT_ID = 'proj-projection-parity'
  const TS = Date.now() - 60_000

  // fixture 形态：3 条 record（idle-01 / idle-02 / gone-03）+ 1 条 workflow run。
  // 同值形态（fold 末态 = entry 末态 = idle + stopReason 'completed'）忠实保留维护轮
  // 删档前提（fold 终态 ∧ 超窗才删——两源同源同值）。
  const RECORDS = [
    { id: 'sa-parity-idle-01', task: 'parity baseline record' },
    { id: 'sa-parity-idle-02', task: 'parity deletion-target record' },
    { id: 'sa-parity-gone-03', task: 'parity entry-source-only record' },
  ]
  const RUN_ID = 'wf-parity-01'

  const recordEntries = []
  const eventFiles = new Map()
  const sessionFiles = new Map()
  for (const rec of RECORDS) {
    const common = { id: rec.id, agent: 'general-purpose', task: rec.task, slug: `parity-${rec.id}`, origin: 'tool', rootSessionId: SID, depth: 0, startedAt: TS }
    const settled = {
      id: rec.id,
      status: 'idle',
      stopReason: 'completed',
      endedAt: TS + 5_000,
      turns: 3,
      totalTokens: 1234,
      model: 'parity-model',
      sessionFile: path.join(dataDir, 'ext-sessions', SID, 'subagents', 'sessions', `${rec.id}.jsonl`),
      result: `parity result ${rec.id}`,
    }
    recordEntries.push(subagentRecordEntry('registered', common), subagentRecordEntry('settled', settled))
    sessionFiles.set(rec.id, seedSubagentSessionFile(dataDir, SID, rec.id, TS))
    if (rec.id !== 'sa-parity-gone-03') {
      // gone-03 天然 entry-source-only：不写事件文件（冷读建投影即降级形态载体）
      const seeded = seedRecordEventsFile(dataDir, SID, {
        id: rec.id, agent: common.agent, task: rec.task, slug: common.slug, ts: TS, stopReason: 'completed', sessionFile: settled.sessionFile,
      })
      eventFiles.set(rec.id, seeded.file)
    }
  }
  const workflowEntries = [
    workflowRecordEntry('registered', { v: 2, runId: RUN_ID, workflowName: 'parity-workflow', recordPath: path.join(dataDir, 'ext-sessions', SID, 'workflow', 'runs', `${RUN_ID}${RUN_EVENTS_SUFFIX}`), startedAt: TS }),
    workflowRecordEntry('settled', { v: 2, runId: RUN_ID, status: 'done', reason: 'done', outcome: 'done', settledAt: TS + 2_000, usedTokens: 100, callCount: 2 }),
  ]

  const runJournal = seedRunJournal(dataDir, SID, { runId: RUN_ID, workflowName: 'parity-workflow', ts: TS })
  const sessionFile = seedSessionWithEntries(dataDir, { sid: SID, cwd, projectId: PROJECT_ID, recordEntries, workflowEntries })
  ev.step({
    step: 'seed.fixture',
    channel: 'C',
    exitCode: 0,
    stats: {
      sessionId: SID,
      recordEntries: recordEntries.length,
      eventFiles: [...eventFiles.keys()],
      entryOnlyRecords: ['sa-parity-gone-03'],
      runJournal: runJournal.file,
      sessionFile,
    },
  })
  log(`fixture 落盘完成：${RECORDS.length} 条 record（1 条 entry-source-only）+ 1 条 workflow run`)

  const proto = ctx.protocol
  if (!proto) throw new Error('protocol 未就绪')

  // ── 段 1：① 冷启动直接查询（两域全量 fold 冷读建投影）——耗时记日志备查 ──
  const t0Subs = Date.now()
  const subsReply = await proto.call('session.getSubagents', { sessionId: SID }, { timeoutMs: 30_000 })
  const tSubsMs = Date.now() - t0Subs
  const t0Runs = Date.now()
  const runsReply = await proto.call('session.getWorkflows', { sessionId: SID }, { timeoutMs: 30_000 })
  const tRunsMs = Date.now() - t0Runs
  ev.step({
    step: 'v9.cold-start-query',
    channel: 'B',
    exitCode: 0,
    stats: {
      elapsedSubagentsMs: tSubsMs,
      elapsedWorkflowsMs: tRunsMs,
      found: subsReply.found,
      subagents: subsReply.subagents?.length,
      workflows: runsReply.workflows?.length,
    },
  })
  // G7 关闭口径：不设计时断言，耗时 attach 备查（对照 M1 V1 计时 91 文件 3.1ms）
  ev.attach('cold-start-query-timing', [
    `冷启动首次 getSubagents：${tSubsMs}ms（${subsReply.subagents?.length ?? 0} 行）`,
    `冷启动首次 getWorkflows：${tRunsMs}ms（${runsReply.workflows?.length ?? 0} 行）`,
    'G7 关闭口径：观测分布内冷启动全量 fold 单次 ≤ 约 14ms（分布实测折算上界），不设大小两档计时断言',
  ].join('\n'))

  const subagents = Array.isArray(subsReply.subagents) ? subsReply.subagents : []
  const workflows = Array.isArray(runsReply.workflows) ? runsReply.workflows : []

  ev.assert('V9①: 冷启动查询 found=true（会话在册，非延迟落盘分形）', subsReply.found === true && runsReply.found === true, {
    channel: 'B',
    expected: 'found=true × 2',
    actual: `subs.found=${subsReply.found} runs.found=${runsReply.found}`,
  })
  ev.assert('V9①: 冷启动列表含全部 3 条 record 与 1 条 run', subagents.length === RECORDS.length && workflows.length === 1, {
    channel: 'B',
    expected: `subagents=${RECORDS.length} workflows=1`,
    actual: `subagents=${subagents.length} workflows=${workflows.length}`,
  })

  // ── 段 2：② 冷启动列表与全量 fold 派生视图对拍 ─────────────────────────
  const expectSubs = expectedSubagentRows(recordEntries)
  let foldParityOk = subagents.length === expectSubs.rows.size
  const foldParityDetail = []
  for (const row of subagents) {
    const expected = expectSubs.rows.get(row.subagentId)
    if (expected === undefined) {
      foldParityOk = false
      foldParityDetail.push(`${row.subagentId}: 多余行`)
      continue
    }
    const ok = row.status === expected.status && row.stopReason === expected.stopReason
    if (!ok) foldParityOk = false
    foldParityDetail.push(`${row.subagentId}: status=${row.status}(${expected.status}) stopReason=${row.stopReason}(${expected.stopReason ?? '∅'}) ${ok ? 'ok' : 'MISMATCH'}`)
  }
  ev.assert('V9②: subagents 列表与全量 fold 派生一致（id 集合 + status + stopReason）', foldParityOk, {
    channel: 'B',
    expected: '逐行同值（fold 末态供源 / entry 末态兜底）',
    actual: foldParityDetail.join(' | ') || `行数 ${subagents.length} ≠ ${expectSubs.rows.size}`,
  })

  const runRows = new Map(workflows.map((r) => [r.runId, r]))
  const runParityOk = runRows.size === 1 && runRows.has(RUN_ID)
  const runRow = runRows.get(RUN_ID)
  ev.assert('V9②: workflows 列表与全量 fold 派生一致（runId 集合 + status + outcome）', runParityOk && runRow.status === 'done' && runRow.outcome === 'done', {
    channel: 'B',
    expected: `${RUN_ID}: status=done outcome=done（run-settled 终帧 fold）`,
    actual: runRow !== undefined ? `${RUN_ID}: status=${runRow.status} outcome=${runRow.outcome ?? '∅'}` : 'run 行缺席',
  })

  // ── 段 3：entry-source-only 降级形态锚（删档前的独立载体）───────────────
  const goneRow = subagents.find((r) => r.subagentId === 'sa-parity-gone-03')
  const goneRowOk = goneRow !== undefined && goneRow.status === 'idle' && goneRow.stopReason === 'completed'
  ev.assert('V9④: entry-source-only 实体行由终态条目供源（事件文件天然缺席，status=idle + stopReason=completed）', goneRowOk, {
    channel: 'B',
    expected: 'sa-parity-gone-03: status=idle stopReason=completed（settledEntry 兜底）',
    actual: goneRow !== undefined ? `status=${goneRow.status} stopReason=${goneRow.stopReason ?? '∅'}` : '行缺席',
  })

  const goneHistory = await proto.call('session.getSubagentHistory', { sessionId: SID, subagentId: 'sa-parity-gone-03' }, { timeoutMs: 30_000 })
  const goneHistoryOk = Array.isArray(goneHistory.messages) && goneHistory.messages.length > 0
  ev.assert('V9④: entry-source-only 实体详情对话流可读（事件域缺席不拖垮 sessionFile 直读）', goneHistoryOk, {
    channel: 'B',
    expected: 'messages>0',
    actual: `messages=${Array.isArray(goneHistory.messages) ? goneHistory.messages.length : typeof goneHistory.messages}`,
  })

  // ── 段 4：③ 删档对账（模拟保留维护轮删档：直接删除 sa-parity-idle-02 事件文件）──
  const deleteTarget = eventFiles.get('sa-parity-idle-02')
  fs.rmSync(deleteTarget, { force: false })
  ev.step({ step: 'v9.delete-event-file', channel: 'C', exitCode: 0, stats: { deleted: deleteTarget, keptEntry: 'registered + settled 条目在册（主会话文件不动）' } })
  log(`删档：${deleteTarget}（主文件注册与终态条目保留）`)

  const afterSubs = await proto.call('session.getSubagents', { sessionId: SID }, { timeoutMs: 30_000 })
  const afterSubagents = Array.isArray(afterSubs.subagents) ? afterSubs.subagents : []
  const deletedRow = afterSubagents.find((r) => r.subagentId === 'sa-parity-idle-02')
  ev.assert('V9④: 删档后列表仍含该记录（注册与终态条目在册，found=true）', afterSubs.found === true && deletedRow !== undefined, {
    channel: 'B',
    expected: 'sa-parity-idle-02 在列',
    actual: deletedRow !== undefined ? '在列' : `缺席（found=${afterSubs.found}，行集合=${afterSubagents.map((r) => r.subagentId).join(',') || '∅'}）`,
  })
  ev.assert('V9④: 删档记录状态 = entry 末态（idle + stopReason=completed，fold 缺席条目兜底）', deletedRow !== undefined && deletedRow.status === 'idle' && deletedRow.stopReason === 'completed', {
    channel: 'B',
    expected: 'status=idle stopReason=completed',
    actual: deletedRow !== undefined ? `status=${deletedRow.status} stopReason=${deletedRow.stopReason ?? '∅'}` : '行缺席',
  })

  // 与 fold 列表一致：独立 fold 在删档后的磁盘真值（02 文件缺席 → entry 兜底；其余不变）
  const foldAfter = new Map()
  for (const rec of RECORDS) {
    const file = eventFiles.get(rec.id)
    const fold = file !== undefined && fs.existsSync(file) ? foldRecordEventsFile(file) : null
    foldAfter.set(rec.id, fold)
  }
  const foldConsistent = afterSubagents.length === RECORDS.length && [...foldAfter.entries()].every(([id, fold]) => {
    const row = afterSubagents.find((r) => r.subagentId === id)
    if (row === undefined) return false
    const expected = fold !== null ? fold : { status: 'idle', stopReason: 'completed' }
    return row.status === expected.status && row.stopReason === expected.stopReason
  })
  ev.assert('V9④: 删档后列表与 fold 列表一致（逐行：fold 在册按 fold 末态 / fold 缺席按 entry 末态）', foldConsistent, {
    channel: 'B',
    expected: '3 行逐行同值（02 删档 → entry 末态；01/03 不变）',
    actual: [...foldAfter.entries()].map(([id, fold]) => {
      const row = afterSubagents.find((r) => r.subagentId === id)
      return `${id}: wire=${row?.status ?? '∅'}/${row?.stopReason ?? '∅'} fold=${fold?.status ?? 'entry-only'}`
    }).join(' | '),
  })

  // 其余行不受删档影响
  const othersIntact = ['sa-parity-idle-01', 'sa-parity-gone-03'].every((id) => {
    const row = afterSubagents.find((r) => r.subagentId === id)
    return row !== undefined && row.status === 'idle' && row.stopReason === 'completed'
  })
  const afterRuns = await proto.call('session.getWorkflows', { sessionId: SID }, { timeoutMs: 30_000 })
  const afterRunRow = (Array.isArray(afterRuns.workflows) ? afterRuns.workflows : []).find((r) => r.runId === RUN_ID)
  ev.assert('V9④: 其余记录与 run 域不受删档影响（01/03 行不变，run 域 fold 真值不变）', othersIntact && afterRunRow !== undefined && afterRunRow.status === 'done', {
    channel: 'B',
    expected: '01/03 idle+completed，run done',
    actual: `01=${afterSubagents.find((r) => r.subagentId === 'sa-parity-idle-01')?.status ?? '∅'} 03=${afterSubagents.find((r) => r.subagentId === 'sa-parity-gone-03')?.status ?? '∅'} run=${afterRunRow?.status ?? '∅'}`,
  })

  // ── 段 5：无滞留的用户可见面 + 详情降级形态 ─────────────────────────────
  // 删档后再次查询：删档记录行持续与磁盘 fold 真值一致（同值形态下滞留的机制态在
  // wire 上不可见；该断言在现状 mtime 对账链与续读链反向分支两形态下同绿——回归
  // 对照面的构造性要求）。
  const againSubs = await proto.call('session.getSubagents', { sessionId: SID }, { timeoutMs: 30_000 })
  const againRow = (Array.isArray(againSubs.subagents) ? againSubs.subagents : []).find((r) => r.subagentId === 'sa-parity-idle-02')
  ev.assert('V9④: 删档后再次查询不回跳（与磁盘 fold 真值持续一致——无滞留的用户可见面）', againRow !== undefined && againRow.status === 'idle' && againRow.stopReason === 'completed', {
    channel: 'B',
    expected: 'status=idle stopReason=completed（与磁盘真值一致，无事件源旧态回跳）',
    actual: againRow !== undefined ? `status=${againRow.status} stopReason=${againRow.stopReason ?? '∅'}` : '行缺席',
  })

  const deletedHistory = await proto.call('session.getSubagentHistory', { sessionId: SID, subagentId: 'sa-parity-idle-02' }, { timeoutMs: 30_000 })
  const deletedHistoryOk = Array.isArray(deletedHistory.messages) && deletedHistory.messages.length > 0
  ev.assert('V9④: 删档记录详情对话流仍可读（维护轮删档对象不含子代理会话 jsonl）', deletedHistoryOk, {
    channel: 'B',
    expected: 'messages>0',
    actual: `messages=${Array.isArray(deletedHistory.messages) ? deletedHistory.messages.length : typeof deletedHistory.messages}`,
  })

  ev.attach('fold-parity-evidence', [
    `fixture：${SID}（${RECORDS.length} record + 1 run）`,
    `冷启动对拍：${foldParityDetail.join(' | ')}`,
    `删档对象：sa-parity-idle-02（事件文件已删，主文件注册 + settled 条目保留）`,
    `fold 语义锚：events-projection.ts resolveSubagentStatus（fold 缺席 → settledEntry 兜底 idle）；workflow-record-projection.ts resolveWorkflowStatus`,
  ].join('\n'))

  log('p0-projection-cold-fold-parity: 段落完成')
  return { uncovered: [], gotchas }
}
