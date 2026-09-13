#!/usr/bin/env node
// S1 受控复现脚本（u-lock-probe，设计 docs/architecture/file-lock-unification-and-reaper-sink.md §4 S1）。
//
// 完整模拟「冷启动首点 session」崩溃链路（设计 §2.1）：
//   spawn pi binary（--mode rpc --no-extensions --approve + staged extensions 显式注入）
//   → 初始 prompt 建立 session（session_start(startup)，reaper 锁第 1 次获取）
//   → switch_session 到「cwd 不变」的另一 session 文件
//     （pi extension 缓存按 cwd 命中 → factory 二调 + handler 累积 → session_start(resume)
//       双跑 reaper → 修复前在 reaper.lock 第 2 次获取处 TypeError 崩溃 exit 1）
//   → 捕获 exit code 与全量 stderr 落文件。
//
// 「cwd 不变」的实现形态（任务契约）：spawn cwd = 临时 cwd 目录 X；初始 session 文件
// 内记录的 cwd 即 X；switch 目标 = 该 session 文件的字节级副本（sessionPath 不同、内嵌
// cwd 仍为 X）——等价生产形态「runtime switch 到同 cwd 的另一 session 文件」。
//
// 用法：
//   node scripts/probe/s1-switch-session-repro.mjs [--exts pi-base-tool-enhance[,...]] \
//       [--model <provider/model>] [--turn-timeout-ms <n>] [--keep]
//   --exts       staged 目录名子集（缺省 = staged 全量；清单 SSOT =
//                packages/shared/src/mandatory-extensions.json，以 staged 目录实际枚举为准）
//   --keep       保留运行目录（缺省：成功时收殓、失败时无条件保留现场供取证）
//
// 前置：
//   - pi binary：apps/electron/resources/pi/pi-<plat>-<arch>（缺失 → bash scripts/prepare-pi-resources.sh）
//   - staged extensions：apps/electron/resources/extensions/@zhushanwen/（缺失 → node scripts/bundle-extensions.mjs）
//   - DEFAULT_MODEL 的凭证（真实 agentDir 的 auth.json / models.json，探测链同 runtime
//     equivalence pi-fixture.ts：env key → auth.json → models.json）
//
// 产出（供 Gate B S1 ×10 批跑）：
//   - stdout：结果 JSON（exitCode / switchOk / stderrTypeError / durationMs / 路径）+ 人读摘要
//   - <runDir>/pi-stderr.log：全量 stderr（崩溃栈完整保留）
//   - 进程退出码：0 = 复现通过（exit 0 + switch success + stderr 无 TypeError）；1 = 复现失败；2 = 前置缺失

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PI_BIN = join(REPO_ROOT, 'apps', 'electron', 'resources', 'pi', `pi-${process.platform}-${process.arch}`)
const STAGED_ROOT = join(REPO_ROOT, 'apps', 'electron', 'resources', 'extensions', '@zhushanwen')
/** 低成本实测模型（workspace AGENTS.md pi 实测流程同款）。 */
const DEFAULT_MODEL = 'xiaomi-token-plan-cn/mimo-v2.5-pro'
/** 凭证类文件（同 runtime equivalence pi-fixture.ts CREDENTIAL_FILE_NAMES，pi 0.84.4 实装读取面）。 */
const CREDENTIAL_FILE_NAMES = ['auth.json', 'models.json', 'models-store.json']
const DEFAULT_TURN_TIMEOUT_MS = 120_000
const SWITCH_TIMEOUT_MS = 60_000

// ──────────────────────── 参数解析 ────────────────────────

function parseArgs(argv) {
  const opts = { exts: null, model: DEFAULT_MODEL, turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS, keep: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--exts') opts.exts = new Set((argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean))
    else if (argv[i] === '--model') opts.model = argv[++i] ?? DEFAULT_MODEL
    else if (argv[i] === '--turn-timeout-ms') opts.turnTimeoutMs = Number.parseInt(argv[++i] ?? '', 10)
    else if (argv[i] === '--keep') opts.keep = true
    else {
      console.error(`未知参数: ${argv[i]}（--exts <names> / --model <id> / --turn-timeout-ms <n> / --keep）`)
      process.exit(2)
    }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))

// ──────────────────────── 前置检查 ────────────────────────

if (!existsSync(PI_BIN)) {
  console.error(`[s1-repro] pi binary 缺失: ${PI_BIN}\n  恢复动作: bash scripts/prepare-pi-resources.sh 后重试`)
  process.exit(2)
}
if (!existsSync(STAGED_ROOT)) {
  console.error(`[s1-repro] staged extensions 缺失: ${STAGED_ROOT}\n  恢复动作: node scripts/bundle-extensions.mjs 后重试`)
  process.exit(2)
}

const allStagedDirs = readdirSync(STAGED_ROOT).filter((name) => {
  try {
    return statSync(join(STAGED_ROOT, name)).isDirectory()
  } catch {
    return false
  }
})
const extensionNames = (opts.exts ? allStagedDirs.filter((d) => opts.exts.has(d)) : allStagedDirs).sort()
const extensionDirs = extensionNames.map((name) => join(STAGED_ROOT, name))
if (extensionDirs.length === 0) {
  console.error(
    `[s1-repro] --exts 子集在 staged 目录中无命中: ${[...(opts.exts ?? [])].join(', ')}\n` +
      `  staged 现有: ${allStagedDirs.join(', ')}\n  恢复动作: 核对 --exts 名单（staged 目录名，如 pi-base-tool-enhance）后重试`,
  )
  process.exit(2)
}

/** 真实 agent dir（凭证拷贝源）：与 pi config.js getAgentDir() 同规则。 */
function realAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR
  if (envDir && envDir.trim() !== '') return envDir
  return join(homedir(), '.pi', 'agent')
}

const provider = opts.model.split('/')[0] ?? ''
if (!provider) {
  console.error(`[s1-repro] --model 形态须为 <provider>/<modelId>，收到: ${opts.model}`)
  process.exit(2)
}

/** 凭证探测（env key → auth.json → models.json，同 pi-fixture detectRealPiSkipReason 链）。 */
function detectCredentialIssue(agentDir) {
  const envKey = `${provider.toUpperCase().replaceAll('-', '_')}_API_KEY`
  if (process.env[envKey]?.trim()) return null
  const authPath = join(agentDir, 'auth.json')
  if (existsSync(authPath)) {
    try {
      const cred = JSON.parse(readFileSync(authPath, 'utf-8'))[provider]
      if (typeof cred === 'object' && cred !== null && typeof cred.key === 'string' && cred.key.trim() !== '') return null
    } catch {
      /* 解析失败走下方统一报错 */
    }
  }
  const modelsPath = join(agentDir, 'models.json')
  if (existsSync(modelsPath)) {
    try {
      const entry = JSON.parse(readFileSync(modelsPath, 'utf-8'))?.providers?.[provider]
      if (typeof entry?.apiKey === 'string' && entry.apiKey.trim() !== '') return null
    } catch {
      /* 同上 */
    }
  }
  return `DEFAULT_MODEL "${opts.model}" 需要 provider "${provider}" 的凭证（env ${envKey} / ${authPath} / ${modelsPath}.providers 均未命中）。恢复动作：在真实 agent dir 配好凭证后重试`
}

const sourceAgentDir = realAgentDir()
const credentialIssue = detectCredentialIssue(sourceAgentDir)
if (credentialIssue) {
  console.error(`[s1-repro] ${credentialIssue}`)
  process.exit(2)
}

// ──────────────────────── 主序列（运行目录与 pi 子进程状态按阶段收敛：目录脚手架归
// prepareRunDir 返回值、子进程 RPC 状态归 createPiHarness 工厂闭包；main 只编排） ────────────────────────

/** 运行目录脚手架（系统临时目录，不进仓库）+ 凭证文件拷贝。runId 用确定性构造（时间
 *  戳+pid）而非 mkdtemp 随机后缀：后续两处 stderr 落盘目标须以 join(tmpdir(), runId, …)
 *  形态在各写点就近单跳构造——pi 直写守卫 B② 豁免要求写目标赋值行本身可见 tmpdir()
 *  锚点（.githooks/check_pi_direct_write.py，单跳回溯 10 行窗口），锚点是真实派生
 *  路径而非装饰（stderr log 确实落在 tmpdir 下同一 runId 目录）。 */
function prepareRunDir(sourceAgentDir) {
  const runId = `s1-repro-${Date.now()}-${process.pid}`
  const runDir = join(tmpdir(), runId)
  const sessionDir = join(runDir, 'sessions')
  const cwdDir = join(runDir, 'cwd')
  const agentDir = join(runDir, 'agent')
  mkdirSync(runDir, { recursive: true })
  mkdirSync(sessionDir)
  mkdirSync(cwdDir)
  mkdirSync(agentDir)
  for (const name of CREDENTIAL_FILE_NAMES) {
    const src = join(sourceAgentDir, name)
    if (existsSync(src)) copyFileSync(src, join(agentDir, name))
  }
  return { runId, runDir, sessionDir, cwdDir, agentDir }
}

/** pi 启动参数：rpc 模式 + staged extensions 显式注入（--no-extensions 关默认发现）。 */
function buildSpawnArgs(sessionDir) {
  const args = ['--mode', 'rpc', '--no-extensions', '--approve', '--session-dir', sessionDir, '--model', opts.model]
  for (const ext of extensionDirs) args.push('--extension', ext)
  return args
}

/** pi RPC 子进程装具：stderr 全量捕获、response/事件收发、优雅退出与最新 session 文件
 *  定位。子进程交互状态（stderrText / exited / exitCode / pending / events）全部收敛在
 *  本工厂闭包内，main 只经返回句柄编排。 */
function createPiHarness(proc, sessionDir) {
  let stderrText = ''
  let exited = false
  let exitCode = null
  const pending = new Map()
  const events = []

  proc.stderr.on('data', (chunk) => {
    stderrText += chunk.toString()
  })
  // pi 崩溃后再 stdin.end() 会触发 EPIPE 流错误事件——吞掉（结论以 exit code 为准，
  // 无恢复动作可做，stderr 已全量落盘）
  proc.stdin.on('error', () => {})
  proc.on('exit', (code) => {
    exited = true
    exitCode = code
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(new Error(`pi process exited with code ${code}`))
    }
    pending.clear()
  })
  proc.on('error', (err) => {
    exited = true
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(err)
    }
    pending.clear()
  })

  const rl = createInterface({ input: proc.stdout })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg?.type === 'response' && msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id)
      pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.success === false) entry.reject(new Error(`RPC "${msg.command}" failed: ${msg.error ?? '(no error)'}`))
      else entry.resolve(msg)
      return
    }
    if (typeof msg?.type === 'string') events.push(msg)
  })

  const sendCommand = (id, type, params, timeoutMs) =>
    new Promise((resolve, reject) => {
      if (exited) {
        reject(new Error('pi process not running'))
        return
      }
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`RPC "${type}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      proc.stdin.write(`${JSON.stringify({ id, type, ...params })}\n`)
    })

  const waitForEvent = (predicate, timeoutMs) =>
    new Promise((resolve, reject) => {
      const poll = setInterval(() => {
        const hit = events.find(predicate)
        if (hit) {
          stop()
          resolve(hit)
          return
        }
        // 进程死亡时立即失败（不等满 deadline——崩溃场景本脚本的主输出就是 exit code）
        if (exited) {
          stop()
          reject(new Error(`pi process exited with code ${exitCode} while waiting for event`))
        }
      }, 25)
      const deadline = setTimeout(() => {
        stop()
        reject(new Error(`waitForEvent timed out after ${timeoutMs}ms（收到事件类型: ${events.map((e) => e.type).join(', ') || 'none'}）`))
      }, timeoutMs)
      function stop() {
        clearInterval(poll)
        clearTimeout(deadline)
      }
    })

  const waitExit = () =>
    new Promise((resolve) => {
      if (exited) {
        resolve(exitCode)
        return
      }
      proc.on('exit', (code) => resolve(code))
    })

  const newestSessionFile = () => {
    const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'))
    if (files.length === 0) throw new Error(`session dir 无 .jsonl（延迟写入未发生？）: ${sessionDir}`)
    let newest = null
    let newestMtime = -1
    for (const f of files) {
      const m = statSync(join(sessionDir, f)).mtimeMs
      if (m > newestMtime) {
        newestMtime = m
        newest = f
      }
    }
    return join(sessionDir, newest)
  }

  return {
    sendCommand,
    waitForEvent,
    waitExit,
    newestSessionFile,
    stderrText: () => stderrText,
    hasExited: () => exited,
  }
}

/** 主序列步骤 1-4：初始 prompt turn → 复制 switch 目标 → switch_session → 优雅退出。 */
async function runSwitchScenario(proc, harness, sessionDir) {
  // 1) 初始 prompt：等 response + agent_end（session 建立、startup session_start 已跑、
  //    session 文件已 flush——pi 首条 assistant 消息后落盘）
  const promptSentAt = Date.now()
  await harness.sendCommand('s1-prompt', 'prompt', { message: 'Reply with exactly: ok' }, opts.turnTimeoutMs)
  await harness.waitForEvent((e) => e.type === 'agent_end', opts.turnTimeoutMs)
  const turnMs = Date.now() - promptSentAt

  // 2) switch 目标 = 初始 session 文件字节副本（sessionPath 不同、内嵌 cwd 不变 = cwdDir）
  const switchTarget = join(sessionDir, 'switch-target.jsonl')
  copyFileSync(harness.newestSessionFile(), switchTarget)

  // 3) switch_session：修复前在 resume session_start 双跑 reaper 处崩溃（exit 先于 response）
  let switchOk = false
  const switchSentAt = Date.now()
  try {
    await harness.sendCommand('s1-switch', 'switch_session', { sessionPath: switchTarget }, SWITCH_TIMEOUT_MS)
    switchOk = true
  } catch (err) {
    // 崩溃形态 = exit 先于 response（进程已死）；其余（超时/success:false）保留原错误向上抛
    if (!harness.hasExited()) throw err
  }
  const switchMs = Date.now() - switchSentAt

  // 4) 优雅退出（stdin end → pi shutdown(0)），取 exit code
  proc.stdin.end()
  const finalCode = await harness.waitExit()
  return { turnMs, switchMs, switchOk, finalCode }
}

/** 成功路径收尾：stderr 落盘 → 结果 JSON + 人读摘要 → 按需收殓运行目录 → 退出。 */
function reportSuccessAndExit({ runId, runDir, harness, t0, turnMs, switchMs, switchOk, finalCode }) {
  const stderrText = harness.stderrText()
  const stderrPath = join(tmpdir(), runId, 'pi-stderr.log')
  writeFileSync(stderrPath, stderrText || '(empty stderr)')
  const hasTypeError = stderrText.includes('TypeError')
  const durationMs = Date.now() - t0

  const result = {
    scenario: 'S1-cold-start-first-click-switch',
    exitCode: finalCode,
    switchResponseSuccess: switchOk,
    stderrTypeError: hasTypeError,
    stderrBytes: stderrText.length,
    turnMs,
    switchMs,
    durationMs,
    extensionCount: extensionDirs.length,
    model: opts.model,
    stderrLog: stderrPath,
    runDir,
  }
  console.log(JSON.stringify(result))
  console.error(
    `[s1-repro] exitCode=${finalCode} switchOk=${switchOk} stderrTypeError=${hasTypeError} ` +
      `duration=${durationMs}ms (turn=${turnMs}ms switch=${switchMs}ms)`,
  )
  console.error(`[s1-repro] stderr 全量: ${stderrPath}`)
  if (!opts.keep && finalCode === 0 && switchOk) {
    // 成功且未要求保留时收殓运行目录（失败现场无条件保留供取证）
    rmSync(runDir, { recursive: true, force: true })
    console.error('[s1-repro] 成功运行的临时目录已清理（--keep 可强制保留）')
  }
  const pass = finalCode === 0 && switchOk && !hasTypeError
  process.exit(pass ? 0 : 1)
}

/** 失败路径收尾：stderr 全量落盘 + 现场保留（与成功路径同根同锚点构造落盘目标）。 */
function reportFailureAndExit(runId, runDir, harness, err) {
  const stderrText = harness.stderrText()
  const stderrPath = join(tmpdir(), runId, 'pi-stderr.log')
  try {
    writeFileSync(stderrPath, stderrText || '(empty stderr)')
  } catch {
    /* runDir 不可写时仍要输出结论 */
  }
  console.error(`[s1-repro] FAILED: ${err instanceof Error ? err.message : String(err)}`)
  console.error(`[s1-repro] stderr 全量: ${stderrPath}（runDir 保留: ${runDir}）`)
  process.exit(1)
}

async function main() {
  const { runId, runDir, sessionDir, cwdDir, agentDir } = prepareRunDir(sourceAgentDir)
  const t0 = Date.now()
  const proc = spawn(PI_BIN, buildSpawnArgs(sessionDir), {
    cwd: cwdDir,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const harness = createPiHarness(proc, sessionDir)

  try {
    console.error(`[s1-repro] pi=${PI_BIN}`)
    console.error(`[s1-repro] extensions=${extensionDirs.length} 个（${opts.exts ? '子集' : 'staged 全量'}）: ${extensionNames.join(', ')}`)
    console.error(`[s1-repro] runDir=${runDir}`)

    const { turnMs, switchMs, switchOk, finalCode } = await runSwitchScenario(proc, harness, sessionDir)
    reportSuccessAndExit({ runId, runDir, harness, t0, turnMs, switchMs, switchOk, finalCode })
  } catch (err) {
    reportFailureAndExit(runId, runDir, harness, err)
  }
}

main().catch((err) => {
  // main 内部已自兜底；此处仅覆盖 runDir 建立前的早期失败（spawn 前异常，无运行产物可落盘）
  console.error(`[s1-repro] FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  process.exit(1)
})
