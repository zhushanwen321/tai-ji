/**
 * BATCH-CR chat 轮 revive（pi-workflow-run-resource-model D3 验收 A5，场景 V5；
 * 设计 G1 闲置零进程 + G8 续聊与进程生死解耦）。
 *
 * 场景（chat 域，与 workflow 域 batch-window-lifecycle 对称）：GUI 定向通道
 * session.subagentAction（runtime 短路 /subagents 命令直达扩展，不经 LLM）——
 *  1. start 派一个 chat subagent（成员任务带 bash sleep）→ 轮完成 record 转 idle；
 *  2. A5/V5 断言①：idle 后 pi 薄壳退出（ps 计数回落基线——chat 轮 idle 收尾链
 *     finalizeRoundToIdle 追加的窗口 dispose，u3 接线）；
 *  3. message（@ chip 同通道）发续聊 → 断言②：新薄壳 respawn ≤5s（「revive 到首个
 *     run 事件 ≤5s」的进程侧判据——respawn+握手完成；事件侧时延记 diag 不硬断言）；
 *  4. 断言③：续写轮完成（status running→idle、turns 增至 2）；断言④：历史完整
 *     （sessionFile 同一路径且含两轮任务文本——冷续写读同一 session 文件）。
 *
 * agent 定义播种：agentDir/agents/wl-chat-worker.md（resource-discovery user 级源）。
 * 执行侧约定与 batch-window-lifecycle.spec.ts 同款（双凭证门 skip、空载串行、失败
 * writeDiag 归因禁盲重试）。
 */
import { test, expect, type Page } from '@playwright/test'
import {
  launchRealApp,
  waitForRuntime,
  wsRoundTrip,
  openListenWs,
  readRuntimeLogs,
  readPiLogs,
  waitForExtensionsReady,
  type WsFrame,
} from './fixtures/launch-app-real'
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_PROJECT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sample-project')
const WORKER_SLUG = 'wl-chat-worker'

const FIRST_TASK = '[WL-CHAT-7777] First run `sleep 15` using the bash tool, wait for it to finish, then reply with a one-word summary.'
const REVIVE_TEXT = '[WL-CHAT-7778] Summarize your previous round in one word (no tools needed).'

const PROC_TIMEOUT_MS = 120_000
const ROUND_TIMEOUT_MS = 300_000
const MAIN_TURN_TIMEOUT_MS = 180_000
/** revive 到新薄壳的可感知判据（设计 V5「revive 到首个 run 事件 ≤5s」的进程侧
 *  近似——respawn + 握手是链路最深一环；事件侧时延落 diag）。 */
const REVIVE_SPAWN_BUDGET_MS = 5_000
const ORPHAN_GRACE_MS = 60_000

const WORKER_AGENT_MD = `---
name: ${WORKER_SLUG}
description: D3 A5 chat revive acceptance worker (e2e seeded)
---

You are a deterministic test worker. Follow the task text literally, using the bash tool when it says so.
`

// ── 凭证门与播种 / 诊断 helpers（batch-window-lifecycle 同款） ─────────────

function sourceAgentDir(): string {
  const override = process.env['TAIJI_BATCH_CREDENTIAL_SOURCE']
  if (override && override.trim() !== '') return override
  return path.join(os.homedir(), '.taiji', 'agent')
}

function realCredentialSkipReason(): string | null {
  const src = sourceAgentDir()
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(src, 'auth.json'), 'utf8')) as Record<string, { key?: unknown }>
    if (Object.values(auth).some((c) => typeof c?.key === 'string' && c.key.trim() !== '')) return null
  } catch {
    console.warn(`[batch-cr] auth.json 不可读，继续探测 models.json：${src}`)
  }
  try {
    const models = JSON.parse(fs.readFileSync(path.join(src, 'models.json'), 'utf8')) as {
      providers?: Record<string, { apiKey?: unknown }>
    }
    if (Object.values(models.providers ?? {}).some((p) => typeof p?.apiKey === 'string' && p.apiKey.trim() !== '')) {
      return null
    }
  } catch {
    console.warn(`[batch-cr] models.json 不可读：${src}`)
  }
  return `${src} 的 auth.json / models.json 均无非空 key（本机 provider 凭证缺失）`
}

function seedDataDir(dataDir: string): void {
  const src = sourceAgentDir()
  const dst = path.join(dataDir, 'agent')
  fs.mkdirSync(dst, { recursive: true })
  for (const f of ['models.json', 'auth.json']) {
    const p = path.join(src, f)
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dst, f))
  }
  let source: Record<string, unknown> = {}
  try {
    source = JSON.parse(fs.readFileSync(path.join(src, 'settings.json'), 'utf8')) as Record<string, unknown>
  } catch {
    console.warn(`[batch-cr] settings.json 不可读，defaultProvider/defaultModel 缺失将由门禁拦截：${src}`)
  }
  const defaultProvider = source['defaultProvider']
  const defaultModel = source['defaultModel']
  if (typeof defaultProvider !== 'string' || !defaultProvider
    || typeof defaultModel !== 'string' || !defaultModel) {
    throw new Error(`[batch-cr] ${src}/settings.json 缺 defaultProvider/defaultModel——先在太极设置页完成 provider 配置`)
  }
  fs.writeFileSync(
    path.join(dst, 'settings.json'),
    JSON.stringify({ defaultProvider, defaultModel, retry: source['retry'] ?? { enabled: false } }, null, 2),
  )
  // chat subagent 定义播种（resource-discovery user 级源 <agentDir>/agents/）
  fs.mkdirSync(path.join(dst, 'agents'), { recursive: true })
  fs.writeFileSync(path.join(dst, 'agents', `${WORKER_SLUG}.md`), WORKER_AGENT_MD)
}

function writeDiag(name: string, data: Record<string, unknown>): void {
  fs.writeFileSync(`/tmp/${name}`, JSON.stringify(data, null, 2))
  console.log(`[batch-cr] diag → /tmp/${name}`)
}

async function waitUntil<T>(poll: () => T | undefined, deadlineMs: number, intervalMs = 200): Promise<T | undefined> {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    const v = poll()
    if (v !== undefined) return v
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return poll()
}

/** 引擎宿主薄壳 pid 快照（特征并集权威单源）。 */
function shellPids(): Set<number> {
  const out = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts', 'count-engine-shell-processes.mjs')],
    { encoding: 'utf8', timeout: 10_000 },
  )
  const parsed = JSON.parse(out) as { processes: { pid: number }[] }
  return new Set(parsed.processes.map((p) => p.pid))
}

interface SubagentListItem { // oe-exempt:20260927:test:e2e 剧本内视图形状声明（DOM mock 类型，非架构契约面）
  subagentId: string
  sessionFile: string | null
  slug: string
  status: string
  turns?: number
  task?: string
}

/** 查 subagent 列表（session.getSubagents）。 */
async function getSubagents(port: number, sid: string): Promise<SubagentListItem[]> {
  const reply = await wsRoundTrip(port, {
    type: 'session.getSubagents',
    id: `cr-list-${Date.now()}`,
    payload: { sessionId: sid },
  }, `cr-list-${Date.now()}`, 15_000)
  const payload = (reply.payload ?? {}) as { subagents?: SubagentListItem[] }
  return payload.subagents ?? []
}

test('CR (batch real): chat 轮 idle 薄壳退出（V5①）+ revive 冷续写新薄壳 ≤5s 历史完整（V5②③④）', async ({ }, testInfo) => {
  test.setTimeout(420_000)
  test.skip(process.env['TAIJI_PI_LIVE'] !== '1', '真实 LLM 轨门：TAIJI_PI_LIVE=1 才执行')
  const credSkip = realCredentialSkipReason()
  test.skip(credSkip !== null, credSkip ?? '')

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiji-batch-cr-'))
  seedDataDir(dataDir)
  const { page, cleanup } = await launchRealApp({ dataDir })
  let listen: { ws: { close: () => void }; events: WsFrame[] } | undefined
  try {
    await expect(page).toHaveTitle(/太极/)
    const port = await waitForRuntime(dataDir, 30_000)
    expect(port).toBeGreaterThan(0)
    await waitForExtensionsReady(dataDir)
    await page.screenshot({ path: testInfo.outputPath('cr-ready.png'), fullPage: true })

    const createReply = await wsRoundTrip(port, {
      type: 'session.create',
      id: 'cr-create',
      payload: { cwd: SAMPLE_PROJECT, label: 'batch-cr-chat-revive' },
    }, 'cr-create')
    expect(createReply.type).toBe('session.created')
    const sid = ((createReply.payload ?? {}) as { session?: { id?: string } }).session?.id
    if (typeof sid !== 'string' || sid === '') throw new Error('session.created reply 应携带非空 session.id')
    const sub = await openListenWs(port, sid)
    listen = sub

    const shellBase = shellPids()

    // ── 预热 turn（主 session JSONL 首次 flush 触发）：pi session 延迟写入——首条
    // assistant 消息前文件不存在（AGENTS.md pi session 规则）。subagentAction 通道
    // 不经主 LLM，若不先产生一轮主对话，主 session 文件不落盘 → getSubagents 投影
    // （entry 游标 + journal tail 读 JSONL）恒空。真实用户场景 = 先有对话再派
    // subagent，预热 turn 与之同构。 ──
    const warmReply = await wsRoundTrip(port, {
      type: 'message.send',
      id: 'cr-warm',
      // 工具调用型 prompt（与 batch-window-lifecycle 的 dispatch 同型——真机已验证
      // 该形态的完整事件链；纯文本轮曾观察 LLM 零响应，规避之）
      payload: { sessionId: sid, content: 'First run `echo ready` using the bash tool, wait for it to finish, then reply with only the word READY. [CR-WARM-7776]' },
    }, 'cr-warm', 30_000)
    expect(warmReply.type, '预热 prompt 应被接受').not.toBe('error')
    const warmDone = await waitUntil(() => sub.events.filter((e) => e.type === 'message.complete').length > 0, MAIN_TURN_TIMEOUT_MS)
    expect(warmDone, `预热 turn 未在 ${MAIN_TURN_TIMEOUT_MS}ms 内完成`).toBe(true)
    sub.events.length = 0

    // ── start：派 chat subagent（轮 1） ──
    const startReply = await wsRoundTrip(port, {
      type: 'session.subagentAction',
      id: 'cr-start',
      payload: { sessionId: sid, action: 'start', slug: WORKER_SLUG, task: FIRST_TASK },
    }, 'cr-start', 30_000)
    expect(startReply.type, 'start action 应被受理').not.toBe('error')

    // 轮 1 完成：record 转 idle
    const idle1 = await waitUntil(async () => {
      const items = await getSubagents(port, sid).catch(() => [])
      return items.find((i) => i.slug === WORKER_SLUG && i.status === 'idle')
    }, ROUND_TIMEOUT_MS, 2_000)
    if (!idle1) {
      const items = await getSubagents(port, sid).catch(() => [])
      writeDiag('batch-cr-round1-not-idle.json', {
        items,
        runtimeLogsTail: readRuntimeLogs(dataDir).slice(-3000),
        piLogsTail: readPiLogs(dataDir).slice(-3000),
      })
    }
    expect(idle1, `轮 1 应在 ${ROUND_TIMEOUT_MS}ms 内转 idle（diag 含列表现场）`).toBeDefined()
    const subagentId = idle1!.subagentId
    console.log(`[batch-cr] 轮 1 idle：subagentId=${subagentId} turns=${idle1!.turns}`)

    // ── V5①：idle 后薄壳退出（chat 轮 idle 收尾 dispose） ──
    const shellBack1 = await waitUntil(() => shellPids().size <= shellBase.size, ORPHAN_GRACE_MS, 1_000)
    if (!shellBack1) {
      writeDiag('batch-cr-idle-shell-residue.json', {
        shellBase: [...shellBase],
        shellNow: [...shellPids()],
      })
    }
    expect(shellBack1, `轮 1 idle 后薄壳应退出（计数回落基线；${ORPHAN_GRACE_MS}ms 窗；G1 闲置零进程）`).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('cr-idle-shell-down.png'), fullPage: true })

    // ── V5②：revive（message）→ 新薄壳 ≤5s ──
    const reviveAt = Date.now()
    const msgReply = await wsRoundTrip(port, {
      type: 'session.subagentAction',
      id: 'cr-revive',
      payload: { sessionId: sid, action: 'message', subagentId, text: REVIVE_TEXT },
    }, 'cr-revive', 30_000)
    expect(msgReply.type, 'message action 应被受理（@ 定向通道）').not.toBe('error')
    const respawnSeen = await waitUntil(() => {
      const now = shellPids()
      return [...now].some((p) => !shellBase.has(p))
    }, REVIVE_SPAWN_BUDGET_MS, 100)
    const respawnMs = Date.now() - reviveAt
    const firstEvents = sub.events.map((e) => String(e['type']))
    if (!respawnSeen) {
      writeDiag('batch-cr-revive-spawn-slow.json', {
        respawnMs,
        shellNow: [...shellPids()],
        shellBase: [...shellBase],
        eventsSeen: firstEvents,
      })
    }
    expect(respawnSeen, `revive 后新薄壳应在 ${REVIVE_SPAWN_BUDGET_MS}ms 内 respawn（实际 ${respawnMs}ms；超线归因 spawn/握手/续写分段）`).toBe(true)
    console.log(`[batch-cr] revive respawn：${respawnMs}ms（预算 ${REVIVE_SPAWN_BUDGET_MS}ms）；事件面首批：${firstEvents.slice(0, 6).join(',') || '（无）'}`)

    // ── V5③：续写轮完成（running→idle，turns 增至 2） ──
    const idle2 = await waitUntil(async () => {
      const items = await getSubagents(port, sid).catch(() => [])
      const me = items.find((i) => i.subagentId === subagentId)
      return me && me.status === 'idle' && (me.turns ?? 0) >= 2 ? me : undefined
    }, ROUND_TIMEOUT_MS, 2_000)
    if (!idle2) {
      const items = await getSubagents(port, sid).catch(() => [])
      writeDiag('batch-cr-round2-not-idle.json', { items })
    }
    expect(idle2, `续写轮应在 ${ROUND_TIMEOUT_MS}ms 内完成（turns≥2）`).toBeDefined()

    // ── V5④：历史完整（同 sessionFile 含两轮任务文本） ──
    const sessionFile = idle2!.sessionFile
    expect(sessionFile, 'record 投影应携带 sessionFile 路径').toBeTruthy()
    const sessionText = fs.readFileSync(sessionFile!, 'utf8')
    expect(sessionText.includes('WL-CHAT-7777'), 'session 文件应含轮 1 任务文本（冷续写历史完整）').toBe(true)
    expect(sessionText.includes('WL-CHAT-7778'), 'session 文件应含 revive 续聊文本（同文件续写）').toBe(true)

    // 收尾：续写轮 idle 后薄壳再次退出（idle dispose 对 revive 轮同样生效）
    const shellBack2 = await waitUntil(() => shellPids().size <= shellBase.size, ORPHAN_GRACE_MS, 1_000)
    expect(shellBack2, '续写轮 idle 后薄壳应再次退出（idle 收尾对每轮生效）').toBe(true)

    await page.screenshot({ path: testInfo.outputPath('cr-done.png'), fullPage: true })
    console.log(`[batch-cr] PASS：idle 退出 → revive respawn ${respawnMs}ms → turns=2 历史完整 → 再 idle 再退出`)
  } finally {
    try {
      listen?.ws.close()
    } finally {
      await cleanup()
      if (!process.env['PLAYWRIGHT_DEBUG_KEEP_DATA']) {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    }
  }
})
