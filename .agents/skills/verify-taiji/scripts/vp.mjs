#!/usr/bin/env node
/**
 * vp（verify primitive）——能力原语单步 CLI。
 *
 * 契约：capabilities/API-CONTRACT.md §2（冻结）。
 * - 单步：一次进程只做一个动作（stateless，不跨步持状态）；
 * - 输出：单行 JSON 到 stdout；
 * - 失败：exit 1 + {ok:false, capability, reason, hint, evidence}；
 * - 无副作用（除 capability 自身声明的动作）；不杀进程、不建/删数据目录。
 *
 * 用法：node vp.mjs <capability> [--repo <repo>] [--data-dir <dir> | --name <实例名>] [flags...] [--json]
 *   --json 兼容占位（本 CLI 恒输出单行 JSON）。
 *
 * v1 capability：env.doctor env.ports session.create session.list session.switch session.history
 *   session.delete chat.send chat.wait chat.abort model.list model.switch subagent.list
 *   workflow.list plugin.list extension.list evidence.tree evidence.logs shell.grep
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { printInstance, resolveRepo, readRuntimeLogs, readPiLogs, resolvedExtensionCount, portOwners } from './lib/instance.mjs'
import { createProtocol } from './lib/protocol.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

const CAPABILITY = process.argv[2]
const argv = process.argv.slice(3)

function hasFlag(name) {
  return argv.includes(`--${name}`)
}

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) return fallback
  return v
}

function requiredFlag(name, capability) {
  const v = flag(name)
  if (v === undefined || v === '') {
    throw makeError(`${capability} 需要 --${name}`, {
      hint: `node vp.mjs ${capability} --${name} <value> [--repo <repo>] [--data-dir <dir>]`,
    })
  }
  return v
}

function makeError(reason, { hint, evidence } = {}) {
  const e = new Error(reason)
  e.reason = reason
  e.hint = hint
  e.evidence = evidence
  return e
}

function resolveContext() {
  const repo = resolveRepo(flag('repo', process.cwd()))
  const explicit = flag('data-dir')
  if (explicit && !fs.existsSync(explicit)) {
    throw makeError(`数据目录不存在：${explicit}`, {
      hint: 'vp 不创建数据目录（无副作用）：核对路径，或先启动实例/运行 scenario',
    })
  }
  let name = flag('name')
  if (!explicit && !name) {
    throw makeError('缺 --data-dir（或 --name 派生）', {
      hint: 'vp 不猜数据目录：给 --data-dir <~/.taiji-dev 树下目录>，或给 --name <实例名> 让它经 dev-instance --print 派生',
    })
  }
  // 只给 --data-dir 时从实例元数据还原实例名（run.mjs/instance.launch 写入），
  // 否则端口会按 worktree 默认名派生 → doctor 误判「实例未启动」。
  if (explicit && !name) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(explicit, 'verify-instance.json'), 'utf8'))
      if (typeof meta.instanceName === 'string' && meta.instanceName.length > 0) name = meta.instanceName
    } catch {
      /* 无元数据：按默认名派生（人工实例可能没有） */
    }
  }
  const printed = printInstance({ repo, name, dataDir: explicit })
  return { repo, name, dataDir: printed.dataDir, printed }
}

function readRuntimePort(dataDir) {
  try {
    const n = Number.parseInt(fs.readFileSync(path.join(dataDir, 'runtime.port'), 'utf8').trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

async function withProtocol(ctx, fn) {
  const runtimePort = readRuntimePort(ctx.dataDir)
  if (!runtimePort) {
    throw makeError(`runtime.port 不存在或非法：${path.join(ctx.dataDir, 'runtime.port')}`, {
      hint: '实例未启动（先 env.doctor 核对）/ 数据目录不对；vp 只连已有实例',
      evidence: { dataDir: ctx.dataDir },
    })
  }
  const p = await createProtocol({ dataDir: ctx.dataDir, runtimePort })
  try {
    return await fn(p, runtimePort)
  } finally {
    await p.close()
  }
}

/** 事件环里按 sessionId 过滤的 helper（vp 单步内使用）。 */
function filterBySession(evt, sid) {
  return evt.payload?.sessionId === undefined || evt.payload?.sessionId === sid
}

// ── 文件树 / grep（evidence.* / shell.grep 的纯 fs 实现，零第三方依赖）────────

function walk(root, { maxDepth = 4, maxEntries = 500, followLinks = false } = {}) {
  const out = []
  const stack = [{ dir: root, depth: 0, rel: '' }]
  while (stack.length > 0 && out.length < maxEntries) {
    const { dir, depth, rel } = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      out.push({ path: rel || '.', type: 'error', error: e instanceof Error ? e.message : String(e) })
      continue
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      const childRel = rel ? `${rel}/${ent.name}` : ent.name
      let stat = null
      try {
        stat = fs.lstatSync(full)
      } catch {
        /* race */
      }
      const isLink = ent.isSymbolicLink()
      const isDir = ent.isDirectory()
      out.push({
        path: childRel,
        type: isLink ? 'symlink' : isDir ? 'dir' : 'file',
        ...(stat && !isDir ? { size: stat.size } : {}),
      })
      if (out.length >= maxEntries) break
      if (isDir && depth + 1 < maxDepth) stack.push({ dir: full, depth: depth + 1, rel: childRel })
      if (isLink && followLinks && depth + 1 < maxDepth) {
        try {
          if (fs.statSync(full).isDirectory()) stack.push({ dir: full, depth: depth + 1, rel: childRel })
        } catch {
          /* broken link */
        }
      }
    }
  }
  return out
}

const TEXT_EXT = new Set(['.log', '.jsonl', '.json', '.md', '.txt', '.ts', '.mjs', '.js', '.yaml', '.yml', ''])

function grepTree(root, pattern, { ignoreCase = false, maxMatches = 200, maxFileBytes = 2_000_000, glob } = {}) {
  const re = new RegExp(pattern, ignoreCase ? 'i' : '')
  const matches = []
  const files = []
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length > 0 && matches.length < maxMatches) {
    const { dir, depth } = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (matches.length >= maxMatches) break
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist' || ent.name === 'test-results') continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (depth < 8) stack.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!ent.isFile()) continue
      if (glob && !full.endsWith(glob)) continue
      if (!TEXT_EXT.has(path.extname(ent.name).toLowerCase())) continue
      let st
      try {
        st = fs.statSync(full)
      } catch {
        continue
      }
      if (st.size > maxFileBytes) continue
      let text
      try {
        text = fs.readFileSync(full, 'utf8')
      } catch {
        continue
      }
      files.push(full)
      const lines = text.split('\n')
      for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
        if (re.test(lines[i])) matches.push({ file: full, line: i + 1, text: lines[i].slice(0, 500) })
      }
    }
  }
  return { matches, filesScanned: files.length }
}

function flattenSessions(groups = []) {
  return groups.flatMap((g) => (g.sessions ?? []).map((s) => ({ ...s, __groupCwd: g.cwd })))
}

const CAPS = {
  // ── env ──────────────────────────────────────────────────────
  'env.doctor': {
    async run(ctx) {
      const script = path.join(SCRIPT_DIR, 'doctor.mjs')
      const args = [script, ctx.repo, '--data-dir', ctx.dataDir, '--json']
      if (ctx.name) args.push('--name', ctx.name)
      const r = spawnSync(process.execPath, args, { cwd: ctx.repo, encoding: 'utf8', timeout: 120_000 })
      let payload = null
      try {
        payload = JSON.parse(r.stdout)
      } catch {
        payload = null
      }
      if (!payload) {
        throw makeError('doctor 输出不可解析', {
          hint: '手工跑 doctor.mjs 看输出',
          evidence: { exitCode: r.status, stdout: String(r.stdout).slice(0, 800), stderr: String(r.stderr).slice(0, 800) },
        })
      }
      return {
        exitCode: r.status,
        observations: {
          verdict: payload.verdict,
          checks: payload.checks,
          vitePort: payload.vitePort,
          cdpPort: payload.cdpPort,
          running: payload.running,
          dataDir: payload.dataDir,
        },
        evidence: { checks: payload.checks },
      }
    },
  },

  'env.ports': {
    async run(ctx) {
      const p = ctx.printed
      const runtimePort = readRuntimePort(ctx.dataDir)
      const ports = [p.vitePort, p.cdpPort, runtimePort].filter((n) => n > 0)
      const owners = Object.fromEntries(ports.map((port) => [port, portOwners(port)]))
      return {
        observations: {
          instanceName: p.instanceName,
          dataDir: p.dataDir,
          vitePort: p.vitePort,
          cdpPort: p.cdpPort,
          runtimePortRange: p.runtimePortRange,
          runtimePort,
          owners,
          busy: ports.filter((port) => owners[port].length > 0),
        },
        evidence: { owners },
      }
    },
  },

  // ── session ──────────────────────────────────────────────────
  'session.create': {
    async run(ctx) {
      const cwd = flag('cwd', ctx.repo)
      const payload = { cwd }
      if (flag('label')) payload.label = flag('label')
      if (flag('model')) payload.modelOverride = flag('model')
      if (flag('thinking')) payload.thinkingOverride = flag('thinking')
      if (flag('preset')) payload.presetId = flag('preset')
      if (flag('client-uuid')) payload.clientUuid = flag('client-uuid')
      return withProtocol(ctx, async (p) => {
        const reply = await p.call('session.create', payload, { timeoutMs: 120_000 })
        const session = reply.session ?? {}
        return {
          observations: {
            sessionId: session.id,
            label: session.label,
            cwd: session.cwd,
            status: session.status,
            modelId: session.modelId,
            sessionFile: session.sessionFile,
            session,
          },
          evidence: { replyType: reply.__type },
        }
      })
    },
  },

  'session.list': {
    async run(ctx) {
      return withProtocol(ctx, async (p) => {
        const reply = await p.call('config.sessions', {})
        const groups = reply.groups ?? []
        const sessions = flattenSessions(groups)
        return {
          observations: {
            count: sessions.length,
            archiveCount: reply.archiveCount ?? 0,
            groupCount: groups.length,
            sessions: sessions.map((s) => ({ id: s.id, label: s.label, cwd: s.cwd, status: s.status, modelId: s.modelId })),
          },
          evidence: { groups: groups.length },
        }
      })
    },
  },

  'session.switch': {
    async run(ctx) {
      const sid = requiredFlag('sid', 'session.switch')
      return withProtocol(ctx, async (p) => {
        const reply = await p.call('session.switch', { sessionId: sid })
        return {
          observations: { sessionId: reply.sessionId ?? sid, session: reply.session ?? null },
          evidence: { replyType: reply.__type },
        }
      })
    },
  },

  'session.history': {
    async run(ctx) {
      const sid = requiredFlag('sid', 'session.history')
      const limitTurns = flag('limit-turns')
      return withProtocol(ctx, async (p) => {
        const payload = await p.history(sid, limitTurns ? { limitTurns: Number(limitTurns) } : {})
        const messages = payload.messages ?? []
        return {
          observations: {
            sessionId: sid,
            count: messages.length,
            truncated: payload.truncated,
            loadedTurns: payload.loadedTurns,
            totalTurnsEstimate: payload.totalTurnsEstimate,
            messages: messages.map((m) => ({
              id: m.id,
              role: m.role,
              piEntryId: m.piEntryId,
              text: typeof m.content === 'string' ? m.content.slice(0, 500) : undefined,
            })),
          },
          evidence: { replyType: 'session.history' },
        }
      })
    },
  },

  'session.delete': {
    async run(ctx) {
      const sid = requiredFlag('sid', 'session.delete')
      return withProtocol(ctx, async (p) => {
        const reply = await p.call('session.delete', { sessionId: sid }, { timeoutMs: 120_000 })
        return {
          observations: { sessionId: reply.sessionId ?? sid },
          evidence: { replyType: reply.__type },
        }
      })
    },
  },

  // ── chat ─────────────────────────────────────────────────────
  'chat.send': {
    async run(ctx) {
      const sid = requiredFlag('sid', 'chat.send')
      const text = flag('text', flag('content'))
      if (text === undefined) throw makeError('chat.send 需要 --text', { hint: 'node vp.mjs chat.send --sid <id> --text "..."' })
      const clientUuid = flag('client-uuid')
      const deliver = !hasFlag('no-deliver')
      return withProtocol(ctx, async (p) => {
        const sent = await p.send(sid, text, { clientUuid, deliver })
        return {
          observations: { sessionId: sid, clientUuid: sent.clientUuid, channel: sent.channel, reply: sent.reply ?? null },
          evidence: { channel: sent.channel },
        }
      })
    },
  },

  'chat.wait': {
    async run(ctx) {
      const sid = requiredFlag('sid', 'chat.wait')
      const timeoutMs = Number(flag('timeout-ms', '180000'))
      return withProtocol(ctx, async (p) => {
        const startedAt = Date.now()
        const sub = await p.subscribe(sid)
        // 状态快照里找 occupancy（last-value 语义，不依赖广播时序）
        const occ = sub.stateSnapshot
          .map((f) => (f?.type === 'session.occupancy' ? f.payload : null))
          .filter(Boolean)
          .find((x) => !x.sessionId || x.sessionId === sid)
        const busy = occ ? occ.turn !== 'idle' || occ.compacting || occ.bash : false
        if (!busy) {
          return {
            observations: { sessionId: sid, alreadyIdle: true, occupancy: occ ?? null, elapsedMs: Date.now() - startedAt },
            evidence: { stateSnapshotFrames: sub.stateSnapshot.length },
          }
        }
        const end = await p.waitTurnEnd(sid, { timeoutMs })
        return {
          observations: {
            sessionId: sid,
            alreadyIdle: false,
            type: end.type,
            ok: end.ok,
            stopReason: end.payload?.stopReason,
            error: end.payload?.message ?? end.payload?.content,
            elapsedMs: Date.now() - startedAt,
          },
          evidence: { occupancy: occ ?? null },
        }
      })
    },
  },

  'chat.abort': {
    async run(ctx) {
      const sid = requiredFlag('sid', 'chat.abort')
      return withProtocol(ctx, async (p) => {
        const reply = await p.call('message.abort', { sessionId: sid }, { timeoutMs: 60_000 })
        return {
          observations: { sessionId: sid, status: reply.status },
          evidence: { replyType: reply.__type },
        }
      })
    },
  },

  // ── model ────────────────────────────────────────────────────
  'model.list': {
    async run(ctx) {
      return withProtocol(ctx, async (p) => {
        const reply = await p.call('model.list', {})
        const models = reply.models ?? []
        return {
          observations: { count: models.length, models },
          evidence: { replyType: reply.__type },
        }
      })
    },
  },

  'model.switch': {
    async run(ctx) {
      const sid = requiredFlag('sid', 'model.switch')
      const provider = requiredFlag('provider', 'model.switch')
      const modelId = requiredFlag('model-id', 'model.switch')
      return withProtocol(ctx, async (p) => {
        const reply = await p.call('model.switch', { sessionId: sid, provider, modelId }, { timeoutMs: 120_000 })
        return {
          observations: {
            sessionId: reply.sessionId ?? sid,
            provider: reply.provider,
            modelId: reply.modelId,
            thinkingLevel: reply.thinkingLevel,
          },
          evidence: { replyType: reply.__type },
        }
      })
    },
  },

  // ── subagent / workflow ──────────────────────────────────────
  'subagent.list': {
    async run(ctx) {
      const sid = requiredFlag('sid', 'subagent.list')
      return withProtocol(ctx, async (p) => {
        const reply = await p.call('session.getSubagents', { sessionId: sid }, { timeoutMs: 120_000 })
        const subagents = reply.subagents ?? []
        return {
          observations: { sessionId: sid, count: subagents.length, found: reply.found, subagents },
          evidence: { replyType: reply.__type },
        }
      })
    },
  },

  'workflow.list': {
    async run(ctx) {
      const sid = requiredFlag('sid', 'workflow.list')
      return withProtocol(ctx, async (p) => {
        const reply = await p.call('session.getWorkflows', { sessionId: sid }, { timeoutMs: 120_000 })
        const workflows = reply.workflows ?? []
        return {
          observations: { sessionId: sid, count: workflows.length, found: reply.found, workflows },
          evidence: { replyType: reply.__type },
        }
      })
    },
  },

  // ── plugin / extension ───────────────────────────────────────
  'plugin.list': {
    async run(ctx) {
      return withProtocol(ctx, async (p) => {
        const reply = await p.call('plugin.list', {})
        const plugins = reply.plugins ?? []
        return {
          observations: {
            count: plugins.length,
            plugins: plugins.map((x) => ({ id: x.id ?? x.pluginId, name: x.name, status: x.status, enabled: x.enabled })),
          },
          evidence: { replyType: reply.__type },
        }
      })
    },
  },

  'extension.list': {
    async run(ctx) {
      return withProtocol(ctx, async (p) => {
        const reply = await p.call('extension.list', {})
        const extensions = reply.extensions ?? []
        return {
          observations: {
            count: extensions.length,
            extensions: extensions.map((x) => ({
              name: x.name,
              enabled: x.enabled,
              status: x.status,
              source: x.source,
              path: x.path,
            })),
          },
          evidence: { replyType: reply.__type },
        }
      })
    },
  },

  // ── evidence / shell ─────────────────────────────────────────
  'evidence.tree': {
    async run(ctx) {
      const root = path.resolve(flag('path', ctx.dataDir))
      if (!fs.existsSync(root)) {
        throw makeError(`路径不存在：${root}`, { hint: '给 --path <存在的目录>（默认 = dataDir）', evidence: { root } })
      }
      const maxDepth = Number(flag('depth', '4'))
      const maxEntries = Number(flag('max', '500'))
      const entries = walk(root, { maxDepth, maxEntries })
      return {
        observations: { root, count: entries.length, truncated: entries.length >= maxEntries, entries },
        evidence: { root },
      }
    },
  },

  'evidence.logs': {
    async run(ctx) {
      const sid = flag('sid')
      const explicit = flag('path')
      const kind = flag('kind', 'all') // all | runtime | pi
      const grep = flag('grep')
      const tail = Number(flag('tail', '200'))
      let text = ''
      let source = ''
      if (explicit) {
        source = path.resolve(explicit)
        text = readFilesUnder(source)
      } else if (kind === 'runtime') {
        source = path.join(ctx.dataDir, 'logs')
        text = readRuntimeLogs(ctx.dataDir)
      } else if (kind === 'pi') {
        source = sid ? path.join(ctx.dataDir, 'ext-sessions', sid, 'logs') : path.join(ctx.dataDir, 'ext-sessions')
        text = readPiLogs(ctx.dataDir)
      } else {
        source = path.join(ctx.dataDir, 'logs')
        text = `${readRuntimeLogs(ctx.dataDir)}\n${readPiLogs(ctx.dataDir)}`
      }
      let lines = text.split('\n')
      if (grep) {
        const re = new RegExp(grep, hasFlag('ignore-case') ? 'i' : '')
        lines = lines.filter((l) => re.test(l))
      }
      const sliced = lines.slice(-tail)
      return {
        observations: {
          source,
          kind,
          sid: sid ?? null,
          grep: grep ?? null,
          lineCount: sliced.length,
          lines: sliced,
          extensions: resolvedExtensionCount(ctx.dataDir),
        },
        evidence: { source },
      }
    },
  },

  'shell.grep': {
    async run(ctx) {
      const pattern = requiredFlag('pattern', 'shell.grep')
      const root = path.resolve(flag('path', ctx.repo))
      const result = grepTree(root, pattern, {
        ignoreCase: hasFlag('ignore-case'),
        maxMatches: Number(flag('max', '200')),
        glob: flag('glob'),
      })
      return {
        observations: { root, pattern, count: result.matches.length, filesScanned: result.filesScanned, matches: result.matches },
        evidence: { root },
      }
    },
  },
}

function readFilesUnder(root) {
  const st = fs.statSync(root)
  if (st.isFile()) return fs.readFileSync(root, 'utf8')
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) stack.push(full)
      else if (ent.isFile()) {
        try {
          out.push(`# ${full}\n${fs.readFileSync(full, 'utf8')}`)
        } catch {
          /* ignore */
        }
      }
    }
  }
  return out.join('\n')
}

async function main() {
  const startedAt = Date.now()
  if (!CAPABILITY) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        capability: null,
        reason: '缺 capability id',
        hint: 'node vp.mjs <capability> ...；可用：' + Object.keys(CAPS).join(' '),
      })}\n`,
    )
    process.exit(2)
  }
  const cap = CAPS[CAPABILITY]
  if (!cap) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        capability: CAPABILITY,
        reason: `未知 capability: ${CAPABILITY}`,
        hint: '可用：' + Object.keys(CAPS).join(' '),
      })}\n`,
    )
    process.exit(2)
  }
  try {
    const ctx = resolveContext()
    const result = await cap.run(ctx)
    const payload = {
      ok: true,
      capability: CAPABILITY,
      observations: result.observations ?? {},
      evidence: result.evidence ?? {},
      elapsedMs: Date.now() - startedAt,
    }
    // exitCode 非 0（如 doctor RED）不改变 vp 自身的传输成功语义：ok 仍 true，观测里带 exitCode
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    process.exit(0)
  } catch (e) {
    const reason = e?.reason ?? (e instanceof Error ? e.message : String(e))
    const payload = {
      ok: false,
      capability: CAPABILITY,
      reason,
      hint: e?.hint ?? '看 evidence 与 <dataDir>/logs/runtime-*.log；单步复现后按提示修复',
      evidence: e?.evidence ?? {},
      elapsedMs: Date.now() - startedAt,
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    process.exit(1)
  }
}

main()
