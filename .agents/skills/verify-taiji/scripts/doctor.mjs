#!/usr/bin/env node
/**
 * verify-taiji doctor：只读体检，回答「这个实例值不值得驱动」。
 *
 * 用法：node doctor.mjs <repo> [--data-dir <dir>] [--json]
 *   <repo>     worktree 根（含 apps/electron/scripts/dev-instance.mjs）
 *   --data-dir 与启动时一致的隔离数据目录（省略 = 常驻实例目录）
 *   --json     机器可读输出
 *
 * 判定五项：装配参数 / 端口归属 / CDP 指向 / runtime 健康 / 扩展装载。
 * 本脚本不杀任何进程；底层跑 dev-instance.mjs --print，对不存在的实例目录会
 * 从模板创建目录（幂等副作用，可接受）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const argv = process.argv.slice(2)

/** 所有带值 flag —— 位置参数解析必须跳过它们的值（审查 C M9：只认 argv[0] 会错位）。 */
const VALUE_FLAGS = new Set(['data-dir', 'name'])

function flagValue(name) {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  const v = argv[i + 1]
  return v !== undefined && !v.startsWith('--') ? v : undefined
}

/**
 * 第一个非 flag 位置参数 = repo。
 * [HISTORICAL] 旧实现 `argv.indexOf(a) === 0` 只认 argv[0]：一旦写成
 * `doctor <repo> --data-dir D --name N` 之外的顺序（或 --name 在前），
 * `--data-dir` 的值会被误当 repo，进而报「--data-dir 必须落在 ~/.taiji-dev 之内: <repo>/--name」。
 */
function firstPositional() {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a.slice(2))) i++ // 跳过 flag 值
      continue
    }
    return a
  }
  return undefined
}

const repo = firstPositional()
const cliDataDir = flagValue('data-dir')
const rawCliName = flagValue('name')
const asJson = argv.includes('--json')

/**
 * 实例名解析（审查 C M9/M10 核心修复）。
 *
 * 优先级：`--name` 显式 > `<dataDir>/verify-instance.json` 记录的实例名 > worktree 默认名。
 * [HISTORICAL] 旧实现忽略 `--data-dir` 里的实例元数据，于是「给了一个运行中实例的
 * data-dir、但不给 --name」时，doctor 按 worktree 默认名派生端口 → 判「实例未启动」并打 GREEN
 * （审查实测：真实实例 vite=1639/cdp=9382，doctor 报 1665/9304 未启动 + GREEN）。
 * 数据目录本身就是实例的身份，端口必须从它派生。
 */
const cliName = (() => {
  if (rawCliName) return rawCliName
  if (!cliDataDir) return undefined
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(cliDataDir, 'verify-instance.json'), 'utf8'))
    if (typeof meta.instanceName === 'string' && meta.instanceName.length > 0) return meta.instanceName
  } catch {
    /* 无元数据（非本技能起的实例 / 首次）：回落 worktree 默认名 */
  }
  return undefined
})()

if (!repo || !fs.existsSync(path.join(repo, 'apps/electron/scripts/dev-instance.mjs'))) {
  console.error('用法: node doctor.mjs <repo> [--data-dir <dir>] [--name <实例名>] [--json]  （<repo> = worktree 根，需含 apps/electron/scripts/dev-instance.mjs）')
  process.exit(2)
}

// ── 1. 装配参数（经权威源 dev-instance.mjs --print，避免重复实现派生逻辑）──
const printArgs = ['apps/electron/scripts/dev-instance.mjs', '--print']
if (cliDataDir) printArgs.push('--data-dir', cliDataDir)
if (cliName) printArgs.push('--name', cliName)
const printed = spawnSync('node', printArgs, { cwd: repo, encoding: 'utf8', timeout: 60_000 })

const checks = []
const fail = (name, detail, action) => checks.push({ name, status: 'FAIL', detail, action })
const pass = (name, detail) => checks.push({ name, status: 'PASS', detail })

let vitePort = 0
let cdpPort = 0
let dataDir = ''

if (printed.status !== 0) {
  fail('装配参数', `dev-instance.mjs --print 退出码 ${printed.status}`, (printed.stderr || printed.stdout || '').trim())
} else {
  const text = printed.stdout
  const grab = (label) => {
    const m = text.match(new RegExp(`${label}:\\s*(.+)`))
    return m ? m[1].trim() : ''
  }
  const vite = grab('Vite').match(/:(\d+)\s*$/)
  const cdp = grab('CDP').match(/:(\d+)\s*$/)
  vitePort = vite ? Number(vite[1]) : 0
  cdpPort = cdp ? Number(cdp[1]) : 0
  dataDir = grab('数据目录')
  if (!vitePort || !cdpPort || !dataDir) {
    fail('装配参数', `banner 解析失败（vite=${vitePort} cdp=${cdpPort} dataDir=${dataDir || '空'}），装配器输出格式可能已变`, text.slice(0, 400))
  } else {
    pass('装配参数', `worktree=${grab('worktree/实例')} vite=${vitePort} cdp=${cdpPort} dataDir=${dataDir}`)
  }
}

// ── 2. 端口归属 ─────────────────────────────────────────────────
function portOwners(port) {
  if (!port) return []
  const r = spawnSync('lsof', ['-ti', `:${port}`, '-P'], { encoding: 'utf8', timeout: 10_000 })
  return r.status === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []
}
function cmdOf(pid) {
  const r = spawnSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8', timeout: 10_000 })
  return r.status === 0 ? r.stdout.trim() : ''
}
const viteOwners = portOwners(vitePort)
const cdpOwners = portOwners(cdpPort)
const running = cdpOwners.length > 0

/**
 * 交叉核对：dataDir 里的实例元数据 vs --print 派生端口（审查 C M9/M10 的第二道防线）。
 *
 * 即使实例名还原失败（人工起的实例没有 verify-instance.json），只要 dataDir 有
 * `runtime.port` 或元数据里记了 vite/cdp，就能判断「这个 dataDir 对应的实例到底在不在」。
 * 若元数据记录的端口与本次派生的不一致 → 以元数据为准（数据目录即身份），并提示。
 */
let metaPorts = null
if (cliDataDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(cliDataDir, 'verify-instance.json'), 'utf8'))
    if (meta.vitePort > 0 || meta.cdpPort > 0) metaPorts = { vitePort: meta.vitePort, cdpPort: meta.cdpPort, instanceName: meta.instanceName }
  } catch {
    /* 无元数据 */
  }
}
const dataDirHasRuntime = Boolean(cliDataDir) && fs.existsSync(path.join(cliDataDir, 'runtime.port'))

if (metaPorts && (metaPorts.vitePort !== vitePort || metaPorts.cdpPort !== cdpPort)) {
  const metaViteOwners = portOwners(metaPorts.vitePort)
  const metaCdpOwners = portOwners(metaPorts.cdpPort)
  const metaRunning = metaCdpOwners.length > 0
  fail(
    '端口归属',
    `派生端口 vite:${vitePort}/cdp:${cdpPort} ≠ 元数据 vite:${metaPorts.vitePort}/cdp:${metaPorts.cdpPort}（实例名 ${metaPorts.instanceName ?? '?'}；元数据端口占用 vite=${metaViteOwners.length} cdp=${metaCdpOwners.length}）`,
    '数据目录即实例身份：用 `--name <元数据里的实例名>` 重跑，或直接给 --data-dir 让 doctor 从 verify-instance.json 还原（本轮已尝试）。禁止在此状态下驱动。',
  )
  vitePort = metaPorts.vitePort
  cdpPort = metaPorts.cdpPort
} else if (viteOwners.length === 0 && cdpOwners.length === 0 && dataDirHasRuntime) {
  // dataDir 有 runtime.port（说明这个实例起过）但派生端口无人占用 → 派生错位，不能判「未启动」绿灯
  fail(
    '端口归属',
    `${dataDir} 有 runtime.port（实例曾启动）但派生端口 vite:${vitePort}/cdp:${cdpPort} 无人占用——端口派生与实例不符`,
    '实例可能是用别的 --name 起的：找出它的 verify-instance.json（或 `ps aux | grep dev-instance` 看 --name），带上正确 --name 复跑。禁止在此状态下驱动。',
  )
} else if (viteOwners.length === 0 && cdpOwners.length === 0) {
  pass('端口归属', `vite:${vitePort} cdp:${cdpPort} 均未被占用（实例未启动）`)
} else {
  const owners = [...new Set([...viteOwners, ...cdpOwners])]
    .map((pid) => `PID ${pid}: ${cmdOf(pid).slice(0, 120)}`)
    .join(' | ')
  pass('端口归属', `vite:${vitePort}=${viteOwners.length} 个占用者, cdp:${cdpPort}=${cdpOwners.length} 个占用者 → ${owners}`)
}

// ── 3. CDP 指向（防连错实例看旧代码）────────────────────────────
function cdpPages(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 3000 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
  })
}
const cdpCheck = await (async () => {
  if (!cdpPort) return
  if (!running) {
    pass('CDP 指向', `CDP ${cdpPort} 无进程（实例未启动，启动后复检）`)
    return
  }
  const pages = await cdpPages(cdpPort)
  if (!pages) {
    fail('CDP 指向', `CDP ${cdpPort} 被占用但 /json/list 不可达`, '占用者可能不是 Electron dev 实例；按端口归属项的 PID 与命令行识别，属于他人实例（含打包版）就换 worktree 或等待，禁止盲杀')
    return
  }
  if (pages.length === 0) {
    fail('CDP 指向', 'CDP 可达但页面列表为空', '实例可能仍在启动（窗口未建）；等 10s 后复跑 doctor')
  } else if (pages.some((p) => (p.url || '').includes(`:${vitePort}`))) {
    pass('CDP 指向', `${pages.length} 个页面，含本实例 vite:${vitePort} 的 URL → 连接 http://localhost:${cdpPort} 即为该实例`)
  } else {
    fail('CDP 指向', `CDP 页面 URL 不含本实例 vite 端口（${pages.map((p) => p.url).join(', ').slice(0, 200)}）`, '连错实例（旧 worktree / 打包版）看旧代码的典型症状；确认目标 worktree 后换对实例再驱动')
  }
})()

// ── 4. runtime 健康 ─────────────────────────────────────────────
if (!dataDir) {
  // 装配参数已 FAIL，跳过
} else {
  const portFile = path.join(dataDir, 'runtime.port')
  const tokenFile = path.join(dataDir, 'runtime-token')
  const hasPort = fs.existsSync(portFile)
  const hasToken = fs.existsSync(tokenFile)
  if (!hasPort && !running) {
    // 但若 runtime.port 在盘（曾启动过），说明实例可能仍在跑而端口派生错位 —— 不能绿灯
    if (fs.existsSync(path.join(dataDir, 'runtime.port'))) {
      pass('runtime 健康', 'runtime.port 在盘但实例未确认运行（端口派生可能错位，见端口归属项）')
    } else {
      pass('runtime 健康', '实例未启动，无 runtime.port 属预期')
    }
  } else if (!hasPort) {
    fail('runtime 健康', `${portFile} 不存在（实例进程在而 runtime 未就绪）`, 'runtime spawn 慢属常态，等 30s 复跑；持续缺失看 <dataDir>/logs/ 下 runtime 日志排查')
  } else {
    const detail = `runtime.port=${fs.readFileSync(portFile, 'utf8').trim()} token=${hasToken ? '在' : '缺'}`
    if (!hasToken) {
      fail('runtime 健康', detail, 'runtime-token 缺失 = main 与 runtime 装配断链；重启实例，仍失败看 <dataDir>/logs/ 下 main-/runtime- 日志')
    } else {
      pass('runtime 健康', detail)
    }
  }
}

// ── 5. 扩展装载 ─────────────────────────────────────────────────
if (dataDir && running) {
  const logDir = path.join(dataDir, 'logs')
  let logs = ''
  if (fs.existsSync(logDir)) {
    logs = fs
      .readdirSync(logDir)
      .filter((f) => f.startsWith('runtime-'))
      .map((f) => fs.readFileSync(path.join(logDir, f), 'utf8'))
      .join('\n')
  }
  const matches = [...logs.matchAll(/resolved (\d+) extensions from (\d+) sources/g)]
  if (matches.length === 0) {
    fail('扩展装载', 'runtime 日志尚无 "resolved N extensions" 信号', '扩展装载未完成时建 session 会缺命令/工具；等 30s 复跑，持续缺失看 <dataDir>/logs/runtime-*.log')
  } else {
    const n = Number(matches[matches.length - 1][1])
    if (n >= 8) {
      pass('扩展装载', `resolved ${n} extensions`)
    } else {
      fail('扩展装载', `仅 resolved ${n} extensions（<8，装载不完整）`, '看 <dataDir>/logs/runtime-*.log 的扩展解析错误段')
    }
  }
} else if (dataDir) {
  pass('扩展装载', '实例未启动，跳过（启动后以日志信号复检）')
}

// ── 汇总 ─────────────────────────────────────────────────────────
const fails = checks.filter((c) => c.status === 'FAIL')
if (asJson) {
  console.log(JSON.stringify({ repo, dataDir, vitePort, cdpPort, running, checks, verdict: fails.length === 0 ? 'GREEN' : 'RED' }, null, 2))
} else {
  for (const c of checks) {
    console.log(`[${c.status}] ${c.name}: ${c.detail}`)
    if (c.action) console.log(`       处置: ${c.action}`)
  }
  console.log(fails.length === 0 ? '判定: GREEN — 可以驱动' : `判定: RED — ${fails.length} 项未过，先处置再驱动`)
}
process.exit(fails.length === 0 ? 0 : 1)
