#!/usr/bin/env node
/**
 * session-trace RPC fixture 录制脚本（trace-runtime 单元，探针 P1 / A24 / A31 mock 数据源）。
 *
 * 用途：用本地 pi CLI（AGENTS.md「extension 改动优先在本地 pi CLI 实测」通道）对 3 个
 * session 文件真实调用 get_entries RPC，录制响应到
 * `src/services/session/__tests__/__fixtures__/get-entries-<n>-<name>.json`，
 * 同时落一份 pi 读取后落盘的 session JSONL 到 `get-entries-<n>-<name>.jsonl` ——
 * parity 测试（A24）对这两个产物逐条 diff（RPC 内存态 == 文件态）。
 *
 * 输入源：packages/core 的 session-trace fixtures（真实 session 复制脱敏 + 等结构合成）。
 * 三个 session 的选择（覆盖面）：
 *   1. real-mixed-kinds            —— 真实数据：custom×44/custom_message/model_change/
 *                                     id-less session_info 侧支（124 行）
 *   2. synthetic-compaction-single —— compaction 语义（firstKeptEntryId + model_change）
 *   3. real-fork-header            —— fork header parentSession=源 sessionId fallback 形态
 *
 * 录制方式：pi --mode rpc --session-dir <tmp> 起 RPC 进程 → stdin 发 switch_session（加载
 * session 文件）→ **等 switch_session 响应到达后**再发 get_entries（响应驱动，无固定
 * sleep 竞态）→ 收响应后 stdin EOF 退出 → 复制 pi 落盘后的 session 文件。全程无 prompt，
 * 零 LLM 调用。
 *
 * 已知固定差异（录制产物 vs core 源 fixture，README 同步记载）：
 *   - header.cwd 改写到临时工作区（源是脱敏假路径，pi 的 assertSessionCwdExists 拒载不存在
 *     的 cwd；entries 逐行不变）。
 *   - pi resume 会追加 1 条 thinking_level_change（无历史 thinking level 时应用默认档），
 *     RPC 响应与落盘文件**同时**包含它——parity 仍逐条相等，是真实 pi 行为的如实录制。
 *
 * 隔离：PI_CODING_AGENT_DIR 指向临时空目录（不加载用户 extensions / settings，防用户环境
 * 的 extension custom entry 污染录制产物——首次录制曾因此混入 unified-hooks:loaded 等
 * 4 条本机 extension entry）。--model 仅满足启动配置校验，不产生调用。
 *
 * 手动执行（产物已随 git 提交，仅在 pi 版本升级需重录时使用）：
 *   TRACE_FIXTURE_PI_BIN=<pi 二进制> node packages/runtime/scripts/record-get-entries-fixtures.mjs
 * 默认 PI_BIN 取 workspace 缓存的 pi 0.84.1（与 @earendil-works/pi-coding-agent 锁定版本一致）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const RUNTIME_ROOT = resolve(here, '..')
const CORE_FIXTURES = resolve(RUNTIME_ROOT, '../core/src/domain/session-trace/__fixtures__')
const OUT_DIR = resolve(RUNTIME_ROOT, 'src/services/session/__tests__/__fixtures__')

/** 录制清单：core fixture → 输出名。改清单时同步改 __fixtures__/README.md 与 trace-parity 测试的清单断言。 */
const SESSIONS = [
  { src: 'real-mixed-kinds.jsonl', out: 'get-entries-1-mixed-kinds' },
  { src: 'synthetic-compaction-single.jsonl', out: 'get-entries-2-compaction-single' },
  { src: 'real-fork-header.jsonl', out: 'get-entries-3-fork-header' },
]

const PI_BIN = process.env.TRACE_FIXTURE_PI_BIN
  ?? resolve(RUNTIME_ROOT, '../../../.pi-binary-cache/pi-0.84.1-darwin-arm64/pi-darwin-arm64')
/** 模型仅满足 pi 启动配置校验（录制全程无 prompt，不产生 LLM 调用）。可用 TRACE_FIXTURE_PI_MODEL 覆盖。 */
const PI_MODEL = process.env.TRACE_FIXTURE_PI_MODEL ?? 'xiaomi-token-plan-cn/mimo-v2.5-pro'

/**
 * 子进程 env：剥离全部 PI_* 运行时变量（本脚本可能在 pi 子进程环境内跑——PI_MODEL/
 * PI_PROVIDER 等会泄漏给嵌套 pi，首次录制曾因此被宿主环境改写模型选型报 ambiguous）。
 */
function childEnv(agentDir) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('PI_')) continue
    env[k] = v
  }
  env.PI_CODING_AGENT_DIR = agentDir
  return env
}

/**
 * 准备单条录制输入：复制 core fixture → 临时 session 目录，header.cwd 改写到存在的临时
 * 工作区。返回 pi 进程将加载的 session 文件绝对路径。header 之外逐行不变（entries parity
 * 的前提）。
 */
function prepareSession(srcPath, sessionDir, workspaceDir, index) {
  const text = readFileSync(srcPath, 'utf-8')
  const lines = text.split('\n')
  const headerLineIdx = lines.findIndex((l) => {
    try {
      const v = JSON.parse(l)
      return typeof v === 'object' && v !== null && v.type === 'session'
    } catch {
      return false
    }
  })
  if (headerLineIdx === -1) throw new Error(`no session header line found in ${srcPath}`)
  const header = JSON.parse(lines[headerLineIdx])
  if (typeof header.id !== 'string' || !header.id) throw new Error(`header.id missing in ${srcPath}`)
  const sessionId = header.id
  header.cwd = workspaceDir
  lines[headerLineIdx] = JSON.stringify(header)
  const dest = join(sessionDir, `2026-08-20T00-00-00-000Z_rec-${index + 1}-${sessionId}.jsonl`)
  writeFileSync(dest, lines.join('\n'))
  return dest
}

/**
 * 起 pi RPC 进程录制单条 session：switch_session（等响应）→ get_entries（等响应）→ EOF。
 * 响应驱动时序（stdout 上出现对应 command 的 response 才发下一条），无固定 sleep。
 */
function recordSession(piBin, model, agentDir, sessionDir, sessionPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(piBin, ['--mode', 'rpc', '--session-dir', sessionDir, '--model', model], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv(agentDir),
    })
    const responses = []
    const stderrChunks = []
    let buffer = ''
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        let v
        try {
          v = JSON.parse(line)
        } catch {
          continue
        }
        if (v?.type !== 'response') continue
        responses.push(v)
        if (v.command === 'switch_session') {
          if (!v.success) {
            settle(rejectPromise, new Error(`switch_session failed: ${JSON.stringify(v)}`))
            child.kill()
            return
          }
          child.stdin.write(`${JSON.stringify({ id: 'ge-1', type: 'get_entries' })}\n`)
        } else if (v.command === 'get_entries') {
          if (!v.success) {
            settle(rejectPromise, new Error(`get_entries failed: ${JSON.stringify(v)}`))
            child.kill()
            return
          }
          // 收到目标响应：EOF 触发 pi 正常退出（onInputEnd → shutdown flush），exit 后取文件
          child.stdin.end()
        }
      }
    })
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (c) => stderrChunks.push(c))
    child.on('exit', (code) => {
      const entriesResp = responses.find((v) => v.command === 'get_entries' && v.success)
      if (!entriesResp) {
        settle(rejectPromise, new Error(`pi exited (code=${code}) before get_entries response; stderr: ${stderrChunks.join('')}`))
        return
      }
      settle(resolvePromise, { response: entriesResp })
    })
    child.on('error', (e) => settle(rejectPromise, e))

    child.stdin.write(`${JSON.stringify({ id: 'sw-1', type: 'switch_session', sessionPath })}\n`)
  })
}

async function main() {
  const rootTmp = mkdtempSync(join(tmpdir(), 'trace-fixtures-'))
  const agentDir = join(rootTmp, 'agent')
  const sessionDir = join(rootTmp, 'sessions')
  const workspaceDir = join(rootTmp, 'ws')
  mkdirSync(agentDir)
  mkdirSync(sessionDir)
  mkdirSync(workspaceDir)
  mkdirSync(OUT_DIR, { recursive: true })

  const summary = []
  for (let i = 0; i < SESSIONS.length; i++) {
    const { src, out } = SESSIONS[i]
    const sessionPath = prepareSession(join(CORE_FIXTURES, src), sessionDir, workspaceDir, i)
    const t0 = Date.now()
    const { response } = await recordSession(PI_BIN, PI_MODEL, agentDir, sessionDir, sessionPath)
    const elapsedMs = Date.now() - t0
    // 录制产物 1：get_entries 响应（含 meta 头：录制时间 / pi 二进制 / 源 fixture / 耗时——P3 附注用）
    const meta = {
      __recordedAt: new Date().toISOString(),
      __piBin: PI_BIN,
      __sourceFixture: `packages/core/src/domain/session-trace/__fixtures__/${src}`,
      __elapsedMs: elapsedMs,
    }
    writeFileSync(join(OUT_DIR, `${out}.json`), `${JSON.stringify({ ...meta, response }, null, 1)}\n`)
    // 录制产物 2：pi 落盘后的 session 文件（含 resume 追加的 thinking_level_change；parity 对比基准）
    cpSync(sessionPath, join(OUT_DIR, `${out}.jsonl`))
    const entryCount = response.data?.entries?.length ?? 0
    summary.push(`${out}: ${entryCount} entries, leafId=${response.data?.leafId ?? 'null'}, ${elapsedMs}ms`)
    console.log(`[record] ${src} -> ${out}.json/.jsonl (${entryCount} entries, ${elapsedMs}ms)`)
  }

  rmSync(rootTmp, { recursive: true, force: true })
  console.log('[record] done. summary:')
  for (const s of summary) console.log(`  - ${s}`)
}

main().catch((e) => {
  console.error('[record] FAILED:', e)
  process.exit(1)
})
