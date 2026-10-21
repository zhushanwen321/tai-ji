#!/usr/bin/env node
/**
 * 探针：**mock-http 通道**能否让 workflow 成员（`agent()` 派发的孙进程 pi）跑到 LLM？
 *
 * 与 `mock-llm-grandchild.mjs` 同源（同一条 spawn 链路、同一个 PI_CODING_AGENT_DIR），
 * 但覆盖 fan-out 形态：run 级 `model` 覆盖 → 两个成员各自 spawn 一个孙进程 pi →
 * 每个成员都要在终局调 `structured-output`（workflow 模式下它是单参数合成工具，
 * parameters 即权威 schema；不调 = `schema_deterministic` 失败）。
 *
 * 四条断言：
 *   ① 主轮完成（message.complete 且非 error）；
 *   ② `session.getWorkflows` 里 run 走到终态（done/partial/failed）；
 *   ③ run record 里两个成员 outcome=done，且 canary 摘要落盘；
 *   ④ `mockLlm.requests` 出现 ≥2 条 `model === 'mock-sub-a'` 的请求（铁证：成员真的打到 mock）。
 *
 * 用法：
 *   node scripts/probes/mock-llm-workflow.mjs [--repo <worktree>] [--keep] [--timeout-ms 180000]
 *
 * 结论值：mock-workflow-reachable | verified-unreachable | inconclusive
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createInstance, resolveRepo, readPiLogs, readRuntimeLogs } from '../lib/instance.mjs'
import { createEvidence } from '../lib/evidence.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..', '..')
const WORKFLOW_SCRIPT = path.join(SKILL_ROOT, 'fixtures', 'workflows', 'fanout-canary.workflow.js')

const argv = process.argv.slice(2)
const hasFlag = (n) => argv.includes(`--${n}`)
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) return fallback
  return v
}

const repo = resolveRepo(flag('repo', process.cwd()))
const worktree = path.basename(repo)
const timeoutMs = Number(flag('timeout-ms', '180000'))
const keep = hasFlag('keep')
const stamp = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
})()
const runId = `probe-${stamp}`
const runDir = path.join(os.homedir(), '.agents', 'skill-data', 'verify-taiji', worktree, runId, 'mock-llm-workflow')
const ev = createEvidence({ runDir, feature: 'mock-llm-workflow', meta: { runId, worktree, probe: 'mock-http workflow reachability' } })
const log = (m) => process.stderr.write(`[probe] ${m}\n`)

const MAIN_MODEL = 'mock-1'
const SUB_MODEL = 'mock-sub-a'
const CANARY_A = 'FANOUT_BRANCH_A_MOCK_CANARY'
const CANARY_B = 'FANOUT_BRANCH_B_MOCK_CANARY'

/** 成员演员两轮：先调 structured-output 交结果，再收尾文本。 */
const member = (summary) => [
  { toolCalls: [{ name: 'structured-output', args: { summary } }], stopReason: 'toolUse' },
  { text: `${summary}-done`, stopReason: 'stop' },
]

const llm = {
  responses: {
    [`mockllm/${MAIN_MODEL}`]: [
      {
        text: '跑一个两路 fan-out 的 workflow：',
        toolCalls: [
          {
            name: 'workflow_run',
            args: {
              name: WORKFLOW_SCRIPT,
              model: `mockllm/${SUB_MODEL}`,
              args: { tasks: ['第一路：报出你剧本里的 canary', '第二路：报出你剧本里的 canary'] },
            },
          },
        ],
        stopReason: 'toolUse',
      },
      { text: 'workflow-dispatched', stopReason: 'stop' },
      // 完成通知会触发主 agent 继续跑轮；备足脚本防「剧本耗尽 404」噪音（不影响结论）
      ...Array.from({ length: 6 }, (_, i) => ({ text: `parent-idle-${i}`, stopReason: 'stop' })),
    ],
    [`mockllm/${SUB_MODEL}`]: [...member(CANARY_A), ...member(CANARY_B), ...member('SPARE_1'), ...member('SPARE_2')],
  },
  mainModel: MAIN_MODEL,
  subModel: SUB_MODEL,
}

const instance = createInstance({ repo, name: `probe-${runId}`, llm, background: true })
let proto = null
let conclusion = 'inconclusive'
let reason = ''
let dataDir = ''
const facts = {
  parentTurn: null,
  runStatus: null,
  runId: null,
  memberOutcomes: [],
  canaryInRecord: false,
  childRequests: 0,
  childStepIndexes: [],
  mainRequests: 0,
}

try {
  const info = await instance.launch()
  dataDir = info.dataDir
  const topo = instance.llm
  log(`launched pid=${info.pid} vite=${info.vitePort} cdp=${info.cdpPort} dataDir=${dataDir}`)
  log(`mock-http: ${topo.baseUrl}（main=${topo.mainRef} sub=${topo.subRef}）workflow=${WORKFLOW_SCRIPT}`)
  ev.step({
    step: 'env.launch',
    channel: 'C',
    exitCode: 0,
    stats: { pid: info.pid, vitePort: info.vitePort, cdpPort: info.cdpPort, mockBaseUrl: topo.baseUrl, workflowScript: WORKFLOW_SCRIPT },
  })
  if (!fs.existsSync(WORKFLOW_SCRIPT)) {
    throw new Error(`workflow 探针脚本缺失：${WORKFLOW_SCRIPT}`)
  }
  ev.attach('workflow-script', fs.readFileSync(WORKFLOW_SCRIPT, 'utf8'))

  const ready = await instance.waitReady({ timeoutMs: 180_000 })
  log(`ready in ${ready.elapsedMs}ms extensions=${ready.extensions} runtime=${ready.runtimePort}`)
  const doctor = await instance.doctor()
  ev.step({ step: 'env.ready', channel: 'C', exitCode: 0, stats: { elapsedMs: ready.elapsedMs, extensions: ready.extensions } })
  ev.step({ step: 'env.doctor', channel: 'C', exitCode: doctor.exitCode, stats: { verdict: doctor.raw?.verdict } })

  proto = await instance.protocol()
  const created = await proto.call('session.create', { cwd: repo, label: 'probe-wf' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  log(`parent session=${sid} model=${created.session?.modelId}`)
  await proto.subscribe(sid)
  const sinceSend = proto.events.length
  await proto.send(sid, 'run the canary workflow')
  const end = await proto.waitTurnEnd(sid, { since: sinceSend, timeoutMs: 180_000 })
  facts.parentTurn = { type: end.type, stopReason: end.payload?.stopReason ?? '' }
  log(`parent turn end: ${end.type} stop=${end.payload?.stopReason ?? ''}`)
  ev.assert('① 主轮完成（message.complete 且非 error）', end.ok === true, {
    channel: 'B',
    expected: 'message.complete + stopReason != error',
    actual: `${end.type} stop=${end.payload?.stopReason ?? ''} msg=${String(end.payload?.message ?? '').slice(0, 300)}`,
  })

  // ② run 终态（条件轮询）
  const deadline = Date.now() + timeoutMs
  let runs = []
  while (Date.now() < deadline) {
    const reply = await proto.call('session.getWorkflows', { sessionId: sid }, { timeoutMs: 60_000 })
    runs = reply.workflows ?? []
    if (runs.length > 0 && runs.every((r) => !['running', 'pending'].includes(String(r.status)))) break
    await new Promise((r) => setTimeout(r, 1_000))
  }
  const run = runs.find((r) => String(r.workflowName ?? '').includes('fanout-canary')) ?? runs[0] ?? null
  facts.runStatus = run?.status ?? null
  facts.runId = run?.runId ?? null
  log(`workflow run: ${facts.runId} status=${facts.runStatus}`)
  ev.attach('workflow-runs', JSON.stringify(runs, null, 2).slice(0, 60_000))
  ev.assert('② run 走到终态', ['done', 'partial', 'failed'].includes(String(run?.status)), {
    channel: 'B',
    expected: 'status ∈ {done, partial, failed}',
    actual: `status=${run?.status} runId=${run?.runId}`,
  })

  // ③ record 磁盘证据（成员 outcome + canary）
  const recDir = path.join(dataDir, 'ext-sessions', String(sid), 'workflow', 'runs')
  const recFiles = fs.existsSync(recDir) ? fs.readdirSync(recDir).filter((f) => f.endsWith('.record.jsonl')) : []
  let recordText = ''
  for (const f of recFiles) {
    try {
      recordText += `# ${f}\n${fs.readFileSync(path.join(recDir, f), 'utf8')}\n`
    } catch {
      /* race */
    }
  }
  ev.attach('workflow-records', recordText.slice(0, 200_000))
  facts.canaryInRecord = recordText.includes(CANARY_A) && recordText.includes(CANARY_B)
  facts.memberOutcomes = recordText
    .split('\n')
    .map((l) => {
      try {
        const o = JSON.parse(l)
        return o?.type === 'agent-settled' ? { taskIndex: o.taskIndex, outcome: o.outcome, failureKind: o.result?.failureKind } : null
      } catch {
        return null
      }
    })
    .filter(Boolean)
  ev.step({
    step: 'workflow.record',
    channel: 'C',
    exitCode: 0,
    stats: { recordFiles: recFiles.length, memberOutcomes: JSON.stringify(facts.memberOutcomes), canary: facts.canaryInRecord },
  })
  ev.assert('③ 两个成员 outcome=done（canary 摘要落盘）', facts.memberOutcomes.length >= 2 && facts.memberOutcomes.every((m) => m.outcome === 'done'), {
    channel: 'C',
    expected: '2 × agent-settled outcome=done',
    actual: JSON.stringify(facts.memberOutcomes),
  })

  const stderrFiles = (() => {
    const logsDir = path.join(dataDir, 'logs')
    return fs.existsSync(logsDir) ? fs.readdirSync(logsDir).filter((f) => f.startsWith('pi-task-stderr-')) : []
  })()
  const stderrText = stderrFiles
    .map((f) => `# ${f}\n${fs.readFileSync(path.join(dataDir, 'logs', f), 'utf8')}`)
    .join('\n')
  ev.attach('grandchild-stderr', stderrText || '(无 pi-task-stderr-*.log)')

  // ④ 铁证：mock 服务端请求记录
  const mock = instance.mockLlm
  const allRequests = mock?.requests ?? []
  const childRequests = allRequests.filter((r) => r.model === SUB_MODEL)
  facts.childRequests = childRequests.length
  facts.childStepIndexes = childRequests.map((r) => r.stepIndex)
  facts.mainRequests = allRequests.filter((r) => r.model === MAIN_MODEL).length
  ev.attach(
    'mock-requests',
    JSON.stringify(
      allRequests.map((r) => ({ model: r.model, status: r.status, queueKey: r.queueKey, stepIndex: r.stepIndex, messageCount: r.messageCount, error: r.error })),
      null,
      2,
    ).slice(0, 120_000),
  )
  ev.step({
    step: 'mock.requests',
    channel: 'C',
    exitCode: 0,
    stats: { total: allRequests.length, main: facts.mainRequests, child: facts.childRequests, models: [...new Set(allRequests.map((r) => r.model))].join(',') },
  })
  ev.assert('④ mock 收到 ≥2 条成员模型（mock-sub-a）请求', facts.childRequests >= 2, {
    channel: 'C',
    expected: '≥2 × model=mock-sub-a',
    actual: `${facts.childRequests} 条（steps=${facts.childStepIndexes.join(',')}）`,
  })

  const haystack = [readRuntimeLogs(dataDir), readPiLogs(dataDir), stderrText, recordText].join('\n')
  const hits = haystack
    .split('\n')
    .filter((l) => /Model .* not found|No API provider|not found|Failed to load extension|mock_llm_/i.test(l))
    .slice(-120)
  ev.attach('model-error-hits', hits.join('\n') || '(no hits)')

  const memberOk = facts.memberOutcomes.length >= 2 && facts.memberOutcomes.every((m) => m.outcome === 'done')
  if (facts.childRequests >= 2 && memberOk && facts.canaryInRecord) {
    conclusion = 'mock-workflow-reachable'
    reason = `${facts.childRequests} 条成员模型请求命中本机 mock；run status=${facts.runStatus}，两成员 outcome=done，canary 摘要落 record`
  } else if (facts.childRequests >= 1) {
    conclusion = 'inconclusive'
    reason = `成员打到 mock（${facts.childRequests} 条）但未全绿：run=${facts.runStatus} members=${JSON.stringify(facts.memberOutcomes)} canary=${facts.canaryInRecord}`
  } else if (/Model .* not found|Failed to load extension/i.test(haystack)) {
    conclusion = 'verified-unreachable'
    reason = '成员未打到 mock，且日志出现模型/扩展装配错误（见 model-error-hits）'
  } else {
    conclusion = 'inconclusive'
    reason = `成员零请求且无明确模型错误：run=${facts.runStatus} status=${String(run?.status)}`
  }
  ev.assert('探针结论可分类', conclusion !== 'inconclusive', {
    channel: 'B',
    expected: 'mock-workflow-reachable 或 verified-unreachable',
    actual: `${conclusion}（${reason}）`,
  })
} catch (e) {
  conclusion = 'inconclusive'
  reason = e instanceof Error ? e.message : String(e)
  ev.assert('探针执行无异常', false, { channel: 'C', expected: '无异常', actual: reason })
  ev.attach('probe-error', `${e?.stack ?? reason}\n\n${JSON.stringify(e?.evidence ?? {}, null, 2)}`)
  log(`探针异常：${reason}`)
} finally {
  if (!keep) {
    try {
      await instance.dispose()
    } catch (e) {
      log(`dispose 失败：${e instanceof Error ? e.message : String(e)}`)
    }
  } else {
    log(`--keep：实例保留 pid=${instance.pid} dataDir=${instance.dataDir} mock=${instance.llm?.baseUrl ?? '(none)'}`)
    await proto?.close().catch(() => {})
  }
  ev.report({
    title: 'mock-http workflow 孙进程可达性探针',
    uncovered: conclusion === 'inconclusive' ? ['见 probe-error / mock-requests / workflow-records'] : [],
    gotchas: [
      'workflow 模式下 structured-output 是单参数合成工具（parameters 即权威 schema），成员必须在终局调用它，否则 schema_deterministic 失败',
      'run 级 model 覆盖（workflow_run.model）才能让成员落到「成员演员」队列；不传则成员继承主 agent 模型，与主队共享游标',
      '成员 spawn 走同一条 pi-subagent-cli 链路，因此 mock-http 通道结论对 subagent / workflow 通用',
    ],
    summary: [
      `- 结论：**${conclusion}**`,
      `- 依据：${reason}`,
      `- run：${facts.runId} status=${facts.runStatus}`,
      `- 成员 outcome：${JSON.stringify(facts.memberOutcomes)}`,
      `- mock 请求：main=${facts.mainRequests} × ${MAIN_MODEL} / child=${facts.childRequests} × ${SUB_MODEL}（steps=${facts.childStepIndexes.join(',')}）`,
      `- canary 落盘：${facts.canaryInRecord}`,
    ].join('\n'),
  })
  ev.verdict({
    verdict: conclusion === 'inconclusive' ? 'degraded' : 'pass',
    deviations: conclusion === 'inconclusive' ? [reason] : [],
    blockers: [],
    notProvable: ['mock 回复没有真实模型语义（编排质量/耗时/成本不可断言）', 'workflow 的 abort / reconnect 面本探针未覆盖'],
  })
  process.stderr.write(`[probe] evidence: ${runDir}\n`)
  fs.writeSync(
    1,
    `${JSON.stringify({
      probe: 'mock-llm-workflow',
      conclusion,
      reason,
      workflowScript: WORKFLOW_SCRIPT,
      facts,
      evidenceDir: runDir,
      runId,
    })}\n`,
  )
  process.exit(conclusion === 'verified-unreachable' || conclusion === 'mock-workflow-reachable' ? 0 : 1)
}
