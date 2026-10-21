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
const repo = argv.find((a) => !a.startsWith('--') && argv.indexOf(a) === 0)
const dataDirIdx = argv.indexOf('--data-dir')
const cliDataDir = dataDirIdx !== -1 ? argv[dataDirIdx + 1] : undefined
const nameIdx = argv.indexOf('--name')
const cliName = nameIdx !== -1 ? argv[nameIdx + 1] : undefined
const asJson = argv.includes('--json')

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
if (viteOwners.length === 0 && cdpOwners.length === 0) {
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
    pass('runtime 健康', '实例未启动，无 runtime.port 属预期')
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
