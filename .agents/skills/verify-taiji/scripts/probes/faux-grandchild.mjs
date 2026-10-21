#!/usr/bin/env node
/**
 * 探针：faux LLM 演员在孙进程（subagent 派发的 pi）里能否生效？
 *
 * 背景：主会话 pi 由 runtime 以 `--extension <faux-provider-ext>` 显式注入 faux provider；
 * 孙进程 pi 由 pi-subagent-cli spawn，argv 恒带 `--no-extensions`（自动发现全关），
 * 扩展集只来自宿主下发的白名单（structured-output）+ e2e 专用放行门
 * （subagent-workflow/src/host/pi-host.ts 的 resolveE2eFauxExtensionPath 要求
 * `TAIJI_E2E === '1'`，dev 装配不设该 env）。本探针用真实 dev 实例验证这个推论。
 *
 * 用法：
 *   node scripts/probes/faux-grandchild.mjs [--repo <worktree>] [--keep] [--timeout-ms 120000]
 *
 * 产出：控制台单行 JSON（结论）+ 证据落
 *   ~/.agents/skill-data/verify-taiji/<worktree>/<runId>/faux-grandchild-probe/
 * 结论值：faux-grandchild-reachable | verified-unreachable | inconclusive
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
const timeoutMs = Number(flag('timeout-ms', '150000'))
const keep = hasFlag('keep')
const stamp = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
})()
const runId = `probe-${stamp}`
const runDir = path.join(os.homedir(), '.agents', 'skill-data', 'verify-taiji', worktree, runId, 'faux-grandchild')
const ev = createEvidence({ runDir, feature: 'faux-grandchild', meta: { runId, worktree, probe: 'faux grandchild reachability' } })
const log = (m) => process.stderr.write(`[probe] ${m}\n`)

const GRANDCHILD_MODEL = 'faux/faux-1-c'
// canary 不写进 task（task 只说「回声 canary」）：child 侧文本出现 = 孙进程真的产出了 faux 回复，
// 排除「task 文本被 JSON 化后误命中」的假阳性
const CHILD_TEXT = 'GRANDCHILD_CANARY_7f3a'

const faux = {
  responses: {
    'faux/faux-1': [
      {
        toolCalls: [
          {
            name: 'subagent_start',
            args: {
              task: 'Echo the canary word your scripted response contains, nothing else.',
              slug: 'b0-probe',
              model: GRANDCHILD_MODEL,
            },
          },
        ],
        stopReason: 'toolUse',
      },
      { text: 'main-dispatched', stopReason: 'stop' },
    ],
    [GRANDCHILD_MODEL]: [{ text: CHILD_TEXT, stopReason: 'stop' }],
  },
}

const instance = createInstance({ repo, name: `probe-${runId}`, faux, background: true })
let proto = null
let conclusion = 'inconclusive'
let reason = ''

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
    const rel = path.relative(runRootOfProbe, full)
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
let runRootOfProbe = ''

try {
  const info = await instance.launch()
  log(`launched pid=${info.pid} vite=${info.vitePort} cdp=${info.cdpPort} dataDir=${info.dataDir}`)
  const ready = await instance.waitReady({ timeoutMs: 180_000 })
  log(`ready in ${ready.elapsedMs}ms extensions=${ready.extensions} runtime=${ready.runtimePort}`)
  const doctor = await instance.doctor()
  ev.step({ step: 'env.ready', channel: 'C', exitCode: 0, stats: { elapsedMs: ready.elapsedMs, extensions: ready.extensions } })
  ev.step({ step: 'env.doctor', channel: 'C', exitCode: doctor.exitCode, stats: { verdict: doctor.raw?.verdict } })

  proto = await instance.protocol()
  const dataDir = info.dataDir
  runRootOfProbe = dataDir

  // 控制组：主会话必须吃到 faux（否则探针不成立）
  const created = await proto.call('session.create', { cwd: repo, label: 'probe-parent' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  log(`parent session=${sid} model=${created.session?.modelId}`)
  await proto.subscribe(sid)
  const sinceSend = proto.events.length
  await proto.send(sid, 'dispatch one subagent (probe)')
  const end = await proto.waitTurnEnd(sid, { since: sinceSend, timeoutMs: 120_000 })
  log(`parent turn end: ${end.type} stop=${end.payload?.stopReason ?? ''}`)
  ev.assert('控制组：主会话 faux 生效（parent turn 完成）', end.type === 'message.complete', {
    channel: 'B',
    expected: 'message.complete',
    actual: `${end.type} stop=${end.payload?.stopReason ?? ''} err=${end.payload?.message ?? ''}`,
  })
  const parentHistory = await proto.history(sid, { limitTurns: 10 })
  const parentText = (parentHistory.messages ?? [])
    .filter((m) => m.role === 'assistant')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('|')
  ev.assert('控制组：主会话 assistant 文本来自 faux 脚本', parentText.includes('main-dispatched'), {
    channel: 'B',
    expected: '含 main-dispatched',
    actual: parentText.slice(0, 300),
  })

  // 等 subagent 进入终态（条件轮询）
  const deadline = Date.now() + timeoutMs
  let records = []
  let record = null
  while (Date.now() < deadline) {
    const reply = await proto.call('session.getSubagents', { sessionId: sid }, { timeoutMs: 60_000 })
    records = reply.subagents ?? []
    record = records.find((r) => r.slug === 'b0-probe') ?? records[0] ?? null
    if (record && ['done', 'idle', 'cancelled', 'error', 'failed'].includes(String(record.status))) break
    if (record && (record.stopReason || record.outcome)) break
    await new Promise((r) => setTimeout(r, 500))
  }
  log(`subagent record: ${JSON.stringify(record ?? null).slice(0, 500)}`)
  ev.attach('subagents', JSON.stringify(records, null, 2).slice(0, 40_000))
  ev.step({
    step: 'subagent.observe',
    channel: 'B',
    exitCode: 0,
    stats: { count: records.length, status: record?.status, stopReason: record?.stopReason, outcome: record?.outcome },
  })

  // 事件证据（subagent.stream_* / notify / error）
  const interesting = proto.events.filter(
    (e) => /^subagent\./.test(e.type) || e.type === 'extension:notify' || e.type === 'message.error' || e.type === 'session.subagents',
  )
  ev.attach('events', interestedText(interesting))
  ev.step({ step: 'events.collect', channel: 'B', exitCode: 0, stats: { interesting: interesting.length } })

  // 磁盘证据：会话树 + 全量 grep 模型/扩展错误
  const storeRoot = path.join(dataDir, 'ext-sessions')
  const tree = fs.existsSync(storeRoot) ? walk(storeRoot) : ['(ext-sessions 不存在)']
  ev.attach('tree', tree.join('\n'))
  // 孙进程 stderr tee：<dataDir>/logs/pi-task-stderr-<pid>.log（pi-subagent-cli stderr-rotation）
  const logsDir = path.join(dataDir, 'logs')
  const stderrFiles = fs.existsSync(logsDir)
    ? fs.readdirSync(logsDir).filter((f) => f.startsWith('pi-task-stderr-'))
    : []
  const stderrText = stderrFiles
    .map((f) => `# ${f}\n${fs.readFileSync(path.join(logsDir, f), 'utf8')}`)
    .join('\n')
  ev.attach('grandchild-stderr', stderrText || '(无 pi-task-stderr-*.log)')
  const recordsDir = path.join(dataDir, 'ext-sessions', String(sid), 'subagents', 'records')
  const recordFiles = fs.existsSync(recordsDir)
    ? fs.readdirSync(recordsDir).map((f) => `# ${f}\n${fs.readFileSync(path.join(recordsDir, f), 'utf8')}`).join('\n')
    : '(无 records 目录)'
  ev.attach('subagent-record-files', recordFiles)

  const haystack = [readRuntimeLogs(dataDir), readPiLogs(dataDir), stderrText, recordFiles].join('\n')
  const hits = haystack
    .split('\n')
    .filter((l) => /Model .* not found|No API provider|faux|not found|Failed to load extension/i.test(l))
    .slice(-120)
  ev.attach('model-error-hits', hits.join('\n') || '(no hits)')
  ev.step({ step: 'disk.grep', channel: 'C', exitCode: 0, stats: { hits: hits.length, stderrFiles: stderrFiles.length } })

  // 结论分类（只看孙进程产物，不看 task 文本）
  const childError = `${record?.error ?? ''} ${record?.result ?? ''}`
  const childProducedText = recordFiles.includes(CHILD_TEXT) || stderrText.includes(CHILD_TEXT)
  const modelMissing =
    /Model ["'][^"']*faux[^"']*["'] not found|No API provider registered|faux[\w/-]* not found/i.test(haystack) ||
    /exited with code 1/i.test(childError)
  if (childProducedText) {
    conclusion = 'faux-grandchild-reachable'
    reason = '孙进程产出 faux 脚本文本（model-keyed 队列被消费）'
  } else if (modelMissing) {
    conclusion = 'verified-unreachable'
    reason = `孙进程 pi 失败退出（faux 扩展未装载到孙进程）：${childError.trim() || '见 grandchild-stderr'}`
  } else {
    conclusion = 'inconclusive'
    reason = '未观察到 faux 文本，也未捕获模型缺失错误；看 evidence 附件'
  }
  ev.assert('探针结论可分类', conclusion !== 'inconclusive', {
    channel: 'B',
    expected: 'reachable 或 verified-unreachable',
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
    log(`--keep：实例保留 pid=${instance.pid} dataDir=${instance.dataDir}`)
    await proto?.close().catch(() => {})
  }
  ev.report({
    title: 'faux 孙进程可达性探针',
    uncovered: conclusion === 'inconclusive' ? ['结论未定：见 error-evidence / model-error-hits'] : [],
    gotchas: [
      '孙进程 pi 恒 `--no-extensions`（自动发现关闭），扩展只来自宿主白名单',
      'e2e 专用放行门 resolveE2eFauxExtensionPath 要求 TAIJI_E2E=1；dev 装配不设该 env',
    ],
    summary: `- 结论：**${conclusion}**\n- 依据：${reason}\n- 孙进程模型：${GRANDCHILD_MODEL}\n- 期望文本：${CHILD_TEXT}`,
  })
  ev.verdict({
    verdict: conclusion === 'inconclusive' ? 'degraded' : 'pass',
    deviations: conclusion === 'inconclusive' ? [reason] : [],
    blockers: [],
    notProvable: ['结论依赖 dev 装配（TAIJI_E2E 未设）；e2e harness 形态另有 TAIJI_E2E=1 分支'],
  })
  process.stderr.write(`[probe] evidence: ${runDir}\n`)
  fs.writeSync(
    1,
    `${JSON.stringify({ probe: 'faux-grandchild', conclusion, reason, model: GRANDCHILD_MODEL, expectedText: CHILD_TEXT, evidenceDir: runDir, runId })}\n`,
  )
  process.exit(conclusion === 'verified-unreachable' || conclusion === 'faux-grandchild-reachable' ? 0 : 1)
}

function interestedText(list) {
  return list
    .map((e) => `${new Date(e.receivedAt).toISOString()} ${e.type} ${JSON.stringify(e.payload).slice(0, 600)}`)
    .join('\n')
}
