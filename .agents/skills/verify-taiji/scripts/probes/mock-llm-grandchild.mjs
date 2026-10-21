#!/usr/bin/env node
/**
 * 探针：**mock-http 通道**能否让孙进程（subagent 派发的 pi）跑到 LLM？
 *
 * 背景（与 `faux-grandchild.mjs` 对照）：
 * - faux 通道不可达：孙进程 pi 由 `pi-subagent-cli` 恒带 `--no-extensions` spawn
 *   （`packages/pi-subagent-cli/src/spawn-args.ts`），扩展集只剩宿主白名单
 *   （`extensions/universal/subagent-workflow/src/host/pi-host.ts` 的
 *   `GRANDCHILD_EXTENSION_PKG_SEGMENTS` = structured-output），faux provider 注册
 *   进不去 → `Model "faux/..." not found`。
 * - mock-http 通道的假设：孙进程继承 `PI_CODING_AGENT_DIR`
 *   （`packages/runtime/src/infra/subagent-control/engine-launch-env.ts`），因此读到同一份
 *   `<agentDir>/models.json` 里的自定义 `openai-completions` provider（baseUrl 指本机
 *   mock 服务）——**全程零 token、零外网、零 extension**。
 *
 * 探针结构（三演员，model-keyed 剧本）：
 *   mockllm/mock-1     （主会话）：step0 = subagent_start(model: mockllm/mock-sub-a)
 *                                  step1 = 收尾文本（主轮完成）
 *                                  step2 = 完成通知触发的那一轮（可选消耗）
 *   mockllm/mock-sub-a （孙进程）：step0 = canary 文本
 *
 * 四条断言（缺一不成立）：
 *   ① 主轮完成（message.complete）；
 *   ② `session.getSubagents` 里该 record 走到终态（done/idle）；
 *   ③ canary 文本出现在 record / 子会话产物里（不是 task 文本的回声）；
 *   ④ `mockLlm.requests` 里出现 `model === 'mock-sub-a'` 的请求（铁证：孙进程真的打到 mock）。
 *
 * 用法：
 *   node scripts/probes/mock-llm-grandchild.mjs [--repo <worktree>] [--keep] [--timeout-ms 120000]
 *
 * 产出：控制台单行 JSON（结论）+ 证据落
 *   ~/.agents/skill-data/verify-taiji/<worktree>/<runId>/mock-llm-grandchild/
 * 结论值：mock-grandchild-reachable | verified-unreachable | inconclusive
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createInstance, resolveRepo, readPiLogs, readRuntimeLogs } from '../lib/instance.mjs'
import { createEvidence } from '../lib/evidence.mjs'

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
const runDir = path.join(os.homedir(), '.agents', 'skill-data', 'verify-taiji', worktree, runId, 'mock-llm-grandchild')
const ev = createEvidence({
  runDir,
  feature: 'mock-llm-grandchild',
  meta: { runId, worktree, probe: 'mock-http grandchild reachability' },
})
const log = (m) => process.stderr.write(`[probe] ${m}\n`)

const MAIN_MODEL = 'mock-1'
const SUB_MODEL = 'mock-sub-a'
// canary 不写进 task（task 只说「回声 canary」）：child 侧文本出现 = 孙进程真的产出了
// mock 回复，排除「task 文本被 JSON 化后误命中」的假阳性
const CHILD_TEXT = 'GRANDCHILD_MOCK_CANARY_9c1d'

const llm = {
  responses: {
    [`mockllm/${MAIN_MODEL}`]: [
      {
        text: '派一个子任务去核对：',
        toolCalls: [
          {
            name: 'subagent_start',
            args: {
              task: 'Echo the canary word your scripted response contains, nothing else.',
              slug: 'm0-probe',
              model: `mockllm/${SUB_MODEL}`,
              fork: false,
            },
          },
        ],
        stopReason: 'toolUse',
      },
      { text: 'main-dispatched', stopReason: 'stop' },
      // 完成通知会触发主 agent 再跑一轮（triggerTurn）；备一步防「剧本耗尽 404」噪音
      { text: 'parent-notified', stopReason: 'stop' },
    ],
    [`mockllm/${SUB_MODEL}`]: [{ text: CHILD_TEXT, stopReason: 'stop' }],
  },
  mainModel: MAIN_MODEL,
  subModel: SUB_MODEL,
}

const instance = createInstance({ repo, name: `probe-${runId}`, llm, background: true })
let proto = null
let conclusion = 'inconclusive'
let reason = ''
let dataDir = ''
/** 断言明细（落 evidence + 结论分级用） */
const facts = {
  parentTurn: null,
  parentText: '',
  subagentStatus: null,
  subagentStopReason: null,
  canaryInRecord: false,
  canaryInSessionFiles: false,
  childModelRequests: [],
  mainModelRequests: [],
}

function walk(root, depth = 0, maxDepth = 5, out = []) {
  if (depth > maxDepth) return out
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(root, e.name)
    const rel = path.relative(dataDir, full)
    if (e.isDirectory()) {
      out.push(`${rel}/`)
      walk(full, depth + 1, maxDepth, out)
    } else {
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        /* race */
      }
      out.push(`${rel} (${size}B)`)
    }
  }
  return out
}

/** 递归读目录下所有文本文件（子会话 JSONL / record 事件文件）。体积上限保护。 */
function readTreeText(root, maxBytes = 4_000_000) {
  let total = 0
  const parts = []
  const walkFiles = (dir, depth = 0) => {
    if (depth > 6 || total > maxBytes) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (total > maxBytes) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        walkFiles(full, depth + 1)
        continue
      }
      try {
        const st = fs.statSync(full)
        if (st.size > 2_000_000) continue
        const text = fs.readFileSync(full, 'utf8')
        total += text.length
        parts.push(`# ${path.relative(dataDir, full)}\n${text}`)
      } catch {
        /* 二进制/不可读：跳过 */
      }
    }
  }
  if (fs.existsSync(root)) walkFiles(root)
  return parts.join('\n')
}

try {
  const info = await instance.launch()
  dataDir = info.dataDir
  const topo = instance.llm
  log(`launched pid=${info.pid} vite=${info.vitePort} cdp=${info.cdpPort} dataDir=${dataDir}`)
  log(`mock-http: ${topo.baseUrl}（main=${topo.mainRef} sub=${topo.subRef}）`)
  ev.step({
    step: 'env.launch',
    channel: 'C',
    exitCode: 0,
    stats: { pid: info.pid, vitePort: info.vitePort, cdpPort: info.cdpPort, mockBaseUrl: topo.baseUrl },
  })

  const ready = await instance.waitReady({ timeoutMs: 180_000 })
  log(`ready in ${ready.elapsedMs}ms extensions=${ready.extensions} runtime=${ready.runtimePort}`)
  const doctor = await instance.doctor()
  ev.step({ step: 'env.ready', channel: 'C', exitCode: 0, stats: { elapsedMs: ready.elapsedMs, extensions: ready.extensions } })
  ev.step({ step: 'env.doctor', channel: 'C', exitCode: doctor.exitCode, stats: { verdict: doctor.raw?.verdict } })

  // 装配自检：mock 服务在盘且 models.json 指向它（否则后续不可达与通道无关）
  const modelsJson = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent', 'models.json'), 'utf8'))
  const provider = modelsJson.providers?.[topo.providerId]
  const wired = provider?.baseUrl === topo.baseUrl && provider?.api === 'openai-completions'
  ev.assert('装配：models.json 里的 mock provider 指向本机 mock 服务', wired === true, {
    channel: 'C',
    expected: `baseUrl=${topo.baseUrl} api=openai-completions`,
    actual: `baseUrl=${provider?.baseUrl ?? '<缺>'} api=${provider?.api ?? '<缺>'}`,
  })
  ev.attach('models-json', JSON.stringify(modelsJson, null, 2).slice(0, 20_000))
  ev.attach(
    'settings-json',
    fs.readFileSync(path.join(dataDir, 'agent', 'settings.json'), 'utf8').slice(0, 20_000),
  )
  try {
    ev.attach(
      'subagents-config-json',
      fs.readFileSync(path.join(dataDir, 'agent', 'subagents', 'config.json'), 'utf8').slice(0, 10_000),
    )
  } catch {
    /* 无该文件（engineDefaults 未写）不影响探针 */
  }

  proto = await instance.protocol()

  // 控制组：主会话必须吃到 mock（否则探针不成立）
  const created = await proto.call('session.create', { cwd: repo, label: 'probe-parent' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  log(`parent session=${sid} model=${created.session?.modelId}`)
  ev.step({
    step: 'session.create',
    channel: 'B',
    exitCode: 0,
    stats: { sessionId: sid, modelId: created.session?.modelId },
  })
  await proto.subscribe(sid)
  const sinceSend = proto.events.length
  await proto.send(sid, 'dispatch one subagent (mock-http probe)')
  const end = await proto.waitTurnEnd(sid, { since: sinceSend, timeoutMs: 180_000 })
  facts.parentTurn = { type: end.type, stopReason: end.payload?.stopReason ?? '' }
  log(`parent turn end: ${end.type} stop=${end.payload?.stopReason ?? ''}`)
  ev.assert('① 主轮完成（message.complete 且非 error）', end.ok === true, {
    channel: 'B',
    expected: 'message.complete + stopReason != error',
    actual: `${end.type} stop=${end.payload?.stopReason ?? ''} msg=${String(end.payload?.message ?? '').slice(0, 300)}`,
  })

  const parentHistory = await proto.history(sid, { limitTurns: 10 })
  const parentText = (parentHistory.messages ?? [])
    .filter((m) => m.role === 'assistant')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('|')
  facts.parentText = parentText
  ev.assert('控制组：主会话 assistant 文本来自 mock 剧本', parentText.includes('main-dispatched'), {
    channel: 'B',
    expected: '含 main-dispatched',
    actual: parentText.slice(0, 300),
  })

  // ② 等 subagent 进入终态（条件轮询，不 sleep 定长）
  const deadline = Date.now() + timeoutMs
  let records = []
  let record = null
  while (Date.now() < deadline) {
    const reply = await proto.call('session.getSubagents', { sessionId: sid }, { timeoutMs: 60_000 })
    records = reply.subagents ?? []
    record = records.find((r) => r.slug === 'm0-probe') ?? records[0] ?? null
    if (record && ['done', 'idle', 'cancelled', 'error', 'failed'].includes(String(record.status))) break
    if (record && (record.stopReason || record.outcome)) break
    await new Promise((r) => setTimeout(r, 500))
  }
  facts.subagentStatus = record?.status ?? null
  facts.subagentStopReason = record?.stopReason ?? null
  log(`subagent record: ${JSON.stringify(record ?? null).slice(0, 600)}`)
  ev.attach('subagents', JSON.stringify(records, null, 2).slice(0, 40_000))
  ev.step({
    step: 'subagent.observe',
    channel: 'B',
    exitCode: 0,
    stats: {
      count: records.length,
      status: record?.status,
      stopReason: record?.stopReason,
      outcome: record?.outcome,
      model: record?.model,
    },
  })
  ev.assert('② 孙进程 record 走到终态', ['done', 'idle'].includes(String(record?.status)), {
    channel: 'B',
    expected: 'status ∈ {done, idle}',
    actual: `status=${record?.status} stopReason=${record?.stopReason} error=${String(record?.error ?? '').slice(0, 200)}`,
  })

  // 事件证据（subagent.stream_* / notify / error）
  const interesting = proto.events.filter(
    (e) => /^subagent\./.test(e.type) || e.type === 'extension:notify' || e.type === 'message.error' || e.type === 'session.subagents',
  )
  ev.attach(
    'events',
    interesting
      .map((e) => `${new Date(e.receivedAt).toISOString()} ${e.type} ${JSON.stringify(e.payload).slice(0, 600)}`)
      .join('\n'),
  )
  ev.step({ step: 'events.collect', channel: 'B', exitCode: 0, stats: { interesting: interesting.length } })

  // ③ 磁盘证据：孙进程产物里找 canary
  const storeRoot = path.join(dataDir, 'ext-sessions')
  ev.attach('tree', (fs.existsSync(storeRoot) ? walk(storeRoot) : ['(ext-sessions 不存在)']).join('\n'))

  // 孙进程 stderr tee：<dataDir>/logs/pi-task-stderr-<pid>.log
  const logsDir = path.join(dataDir, 'logs')
  const stderrFiles = fs.existsSync(logsDir) ? fs.readdirSync(logsDir).filter((f) => f.startsWith('pi-task-stderr-')) : []
  const stderrText = stderrFiles
    .map((f) => `# ${f}\n${fs.readFileSync(path.join(logsDir, f), 'utf8')}`)
    .join('\n')
  ev.attach('grandchild-stderr', stderrText || '(无 pi-task-stderr-*.log)')

  const recordsDir = path.join(dataDir, 'ext-sessions', String(sid), 'subagents', 'records')
  const recordFiles = fs.existsSync(recordsDir)
    ? fs.readdirSync(recordsDir).map((f) => `# ${f}\n${fs.readFileSync(path.join(recordsDir, f), 'utf8')}`).join('\n')
    : '(无 records 目录)'
  ev.attach('subagent-record-files', recordFiles.slice(0, 200_000))

  const subagentsTree = path.join(dataDir, 'ext-sessions', String(sid), 'subagents')
  const subagentDiskText = readTreeText(subagentsTree)
  // 孙进程自己的 pi session JSONL（子代理 session 池）
  const childSessionText = subagentDiskText
  facts.canaryInRecord = recordFiles.includes(CHILD_TEXT)
  facts.canaryInSessionFiles = childSessionText.includes(CHILD_TEXT)
  ev.assert('③ canary 出现在 record / 子会话产物里', facts.canaryInRecord || facts.canaryInSessionFiles, {
    channel: 'C',
    expected: `含 ${CHILD_TEXT}`,
    actual: `record=${facts.canaryInRecord} subagents树=${facts.canaryInSessionFiles}`,
  })

  const haystack = [readRuntimeLogs(dataDir), readPiLogs(dataDir), stderrText, recordFiles, subagentDiskText].join('\n')
  const hits = haystack
    .split('\n')
    .filter((l) => /Model .* not found|No API provider|not found|Failed to load extension|mock_llm_/i.test(l))
    .slice(-160)
  ev.attach('model-error-hits', hits.join('\n') || '(no hits)')
  ev.step({ step: 'disk.grep', channel: 'C', exitCode: 0, stats: { hits: hits.length, stderrFiles: stderrFiles.length } })

  // ④ 铁证：mock 服务端收到的请求里，有没有子演员模型的请求
  const mock = instance.mockLlm
  const allRequests = mock?.requests ?? []
  facts.mainModelRequests = allRequests.filter((r) => r.model === MAIN_MODEL).map((r) => ({ stepIndex: r.stepIndex, status: r.status }))
  facts.childModelRequests = allRequests
    .filter((r) => r.model === SUB_MODEL)
    .map((r) => ({ stepIndex: r.stepIndex, status: r.status, messageCount: r.messageCount }))
  ev.attach(
    'mock-requests',
    JSON.stringify(
      allRequests.map((r) => ({
        model: r.model,
        status: r.status,
        queueKey: r.queueKey,
        stepIndex: r.stepIndex,
        messageCount: r.messageCount,
        summary: r.summary,
        error: r.error,
      })),
      null,
      2,
    ).slice(0, 120_000),
  )
  ev.step({
    step: 'mock.requests',
    channel: 'C',
    exitCode: 0,
    stats: {
      total: allRequests.length,
      main: facts.mainModelRequests.length,
      child: facts.childModelRequests.length,
      models: [...new Set(allRequests.map((r) => r.model))].join(','),
      pending: JSON.stringify(mock?.pending() ?? {}),
    },
  })
  ev.assert('④ mock 服务收到子演员模型（mock-sub-a）的请求', facts.childModelRequests.length > 0, {
    channel: 'C',
    expected: `requests 含 model=${SUB_MODEL}`,
    actual: `models=${[...new Set(allRequests.map((r) => r.model))].join(',') || '(空)'}`,
  })

  // ── 结论三态 ──
  const childHit = facts.childModelRequests.length > 0
  const canaryHit = facts.canaryInRecord || facts.canaryInSessionFiles
  const terminalOk = ['done', 'idle'].includes(String(record?.status))
  const modelMissing =
    /Model ["'][^"']*not found|No API provider registered|Failed to load extension/i.test(haystack) ||
    /exited with code 1/i.test(`${record?.error ?? ''} ${record?.result ?? ''}`)

  if (childHit && canaryHit && terminalOk) {
    conclusion = 'mock-grandchild-reachable'
    reason = '孙进程 pi 打到本机 mock 服务（model=mock-sub-a 请求被记录），canary 文本出现在子会话产物，record 终态收敛'
  } else if (childHit && terminalOk) {    conclusion = 'mock-grandchild-reachable'
    reason = '孙进程打到 mock 且 record 终态收敛，但未在磁盘产物里找到 canary 文本（canary 断言失败，看 subagents 树附件）'
  } else if (modelMissing && !childHit) {
    conclusion = 'verified-unreachable'
    reason = `孙进程 pi 未打到 mock（模型/扩展装配失败）：${String(record?.error ?? '').trim() || '见 grandchild-stderr'}`
  } else {
    conclusion = 'inconclusive'
    reason = `未同时满足四条断言（childHit=${childHit} canaryHit=${canaryHit} terminalOk=${terminalOk} status=${record?.status}）`
  }
  ev.assert('探针结论可分类', conclusion !== 'inconclusive', {
    channel: 'B',
    expected: 'mock-grandchild-reachable 或 verified-unreachable',
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
    title: 'mock-http 孙进程可达性探针',
    uncovered:
      conclusion === 'inconclusive' ? ['结论未定：见 probe-error / model-error-hits / mock-requests'] : [],
    gotchas: [
      'mock-http 通道只依赖 <agentDir>/models.json（孙进程继承 PI_CODING_AGENT_DIR），不需要任何 extension',
      'models.json 的 apiKey 必须是字面量：pi 把 $VAR 当 env 模板、!cmd 当命令',
      'mock-http 与 faux 是两条互斥通道（createInstance 同时给会抛错）',
    ],
    summary: [
      `- 结论：**${conclusion}**`,
      `- 依据：${reason}`,
      `- 主演员模型：mockllm/${MAIN_MODEL}；子演员模型：mockllm/${SUB_MODEL}`,
      `- mock 收到的模型：${facts.mainModelRequests.length} × ${MAIN_MODEL} / ${facts.childModelRequests.length} × ${SUB_MODEL}`,
      `- record 终态：status=${facts.subagentStatus} stopReason=${facts.subagentStopReason}`,
      `- canary（${CHILD_TEXT}）：record=${facts.canaryInRecord} 子会话树=${facts.canaryInSessionFiles}`,
    ].join('\n'),
  })
  ev.verdict({
    verdict: conclusion === 'inconclusive' ? 'degraded' : 'pass',
    deviations: conclusion === 'inconclusive' ? [reason] : [],
    blockers: [],
    notProvable: [
      'mock 回复没有真实 model 语义（模型行为/工具选择质量不可断言）',
      'workflow 成员的 fan-out 分支本探针未覆盖（同一 spawn 链路，需另写 fanout 剧本）',
    ],
  })
  process.stderr.write(`[probe] evidence: ${runDir}\n`)
  fs.writeSync(
    1,
    `${JSON.stringify({
      probe: 'mock-llm-grandchild',
      conclusion,
      reason,
      mainModel: `mockllm/${MAIN_MODEL}`,
      childModel: `mockllm/${SUB_MODEL}`,
      expectedText: CHILD_TEXT,
      facts,
      evidenceDir: runDir,
      runId,
    })}\n`,
  )
  process.exit(conclusion === 'verified-unreachable' || conclusion === 'mock-grandchild-reachable' ? 0 : 1)
}
