#!/usr/bin/env node
/**
 * per-worktree dev 实例装配器（多 agent 多 worktree 并行 dev 互不干扰的唯一入口）。
 *
 * 背景（C-dev-01）：单机多 AI agent 在多个 worktree 各自验收时，旧链所有实例共享
 * 同一数据目录 + 固定端口（Vite 1420 / CDP 9222 / runtime offset 100），
 * 互写同一会话库导致验收证据无法绑定 worktree（2026-09-12 H3 Gate B 归因困境成因之一），
 * 且第二个实例 Vite 端口被占后 Electron 仍加载旧实例的 1420 = 静默跑旧代码。
 *
 * 职责（装配后 spawn 原 concurrently 链，不改各腿自身逻辑）：
 *   1. 从 worktree 名 hash 稳定派生端口（同 worktree 重启不变，CDP 连接/日志可复现）：
 *      - TAIJI_VITE_PORT            1420 + hash%300
 *      - TAIJI_CDP_PORT             9222 + hash%300
 *      - TAIJI_AGENT_PORT_OFFSET    100 + (hash%40)*10（runtime 端口段 = 3210+offset 起
 *        10 个，offset 步进 10 保证实例段不重叠；打包版 offset=0 天然避开）
 *   2. 数据目录 ~/.taiji-dev/instances/<worktree>/，首次从只读模板
 *      ~/.taiji-dev.template/ 复制（模板只含配置面，运行时状态见 EXCLUDES）；
 *      Electron userData / 单实例锁从 TAIJI_AGENT_DATA_DIR 派生（main.ts），自动隔离。
 *   3. 透传 TAIJI_DEV_BACKGROUND=1（外部设置时 window-factory 走 showInactive 不抢前台焦点，
 *      AI agent 真机验收必须带——见 browser-automation skill 对策 2）。
 *
 * 判定逻辑（hash 派生 / env 装配 / 模板过滤 / ensureInstanceDir）在 dev-instance-lib.mjs
 * 可测纯函数层（MF-8），本文件只保留参数解析 / 真实 fs / process 编排。
 *
 * 用法：
 *   pnpm dev                          装配并启动（package.json dev 的入口）
 *   node scripts/dev-instance.mjs --print          只打印派生参数不启动（探测/验证）
 *   node scripts/dev-instance.mjs --fresh          删除本实例目录后从模板重建（验收要干净环境时）
 *   node scripts/dev-instance.mjs --data-dir <path>  实验用独立数据目录（值域 = ~/.taiji-dev/
 *                                                  <suffix>，见 dev-instance-lib resolveCustomDataDir）。
 *                                                  隔离并行验收互不踩（基线采集/mock 实例/多实验并行），
 *                                                  取代「临时改 main.ts dataDir + 用完 revert」的实验
 *                                                  通道；树内值经 main.ts dev 解析（resolveDevDataDir
 *                                                  树内采信）直接生效。
 *   node scripts/dev-instance.mjs init-template [--force]   从现有 ~/.taiji-dev 生成只读模板
 *   node scripts/dev-instance.mjs init-template --seed-from <旧模板路径>
 *                                                  数据目录改名一次性种子（taiji-full-rename R3）：
 *                                                  按白名单从旧模板复制生成新模板（EXCLUDES
 *                                                  挡旧 sessions/日志/调度数据，非数据迁移）
 *   TAIJI_DEV_INSTANCE_NAME=foo pnpm dev             显式指定实例名（默认 = worktree 目录名）
 *
 * 模板预置默认模型 xiaomi-token-plan-cn/mimo-v2.5-pro（快速测试模型，本仓等价性测试
 * pi-fixture.ts 同款）——每个实例副本天生默认用它，GUI 派发不再吃慢模型。
 */

import { spawn, spawnSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEV_DATA_PARENT,
  TEMPLATE_DIR,
  TEMPLATE_TOP_DIRS,
  TEMPLATE_TOP_FILES,
  buildDevEnv,
  copyTreeFiltered,
  deriveParams,
  ensureInstanceDir,
  resolveCustomDataDir,
} from './dev-instance-lib.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(__dirname, '..') // apps/electron
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..')

const DEFAULT_MODEL_PROVIDER = 'xiaomi-token-plan-cn'
const DEFAULT_MODEL_ID = 'mimo-v2.5-pro'

/** worktree 名：git toplevel 的 basename（bare repo + worktree 模式下即 worktree 目录名） */
function resolveInstanceName(cliName) {
  if (cliName) return cliName
  if (process.env.TAIJI_DEV_INSTANCE_NAME) return process.env.TAIJI_DEV_INSTANCE_NAME
  try {
    const top = execSync('git rev-parse --show-toplevel', { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    return path.basename(top)
  } catch {
    return path.basename(REPO_ROOT)
  }
}

// ── 模板管理 ──────────────────────────────────────────────────────

/** 从现有 ~/.taiji-dev 生成只读模板（配置面白名单 + 预置快速默认模型）；
 *  --seed-from <旧模板路径> 时改从旧数据目录名的模板种子（白名单复制语义不变，
 *  TEMPLATE_DIR_EXCLUDES 挡旧 sessions/日志/调度数据——非数据迁移，见 R3）。 */
function initTemplate(force, seedFrom) {
  const seedSource = seedFrom ?? DEV_DATA_PARENT
  if (fs.existsSync(TEMPLATE_DIR)) {
    if (!force) {
      console.error(`[dev-instance] 模板已存在: ${TEMPLATE_DIR}（重建加 --force）`)
      process.exit(1)
    }
    fs.rmSync(TEMPLATE_DIR, { recursive: true, force: true })
  }
  if (!fs.existsSync(seedSource)) {
    console.error(`[dev-instance] 源目录不存在: ${seedSource}\n` +
      `先手动跑一次 dev 生成初始配置（pnpm --filter @taiji/electron dev:vite 等任一即可），再 init-template；` +
      (seedFrom
        ? `或核对 --seed-from 指向的旧模板路径是否正确`
        : `或从改名前旧模板一次性种子：node scripts/dev-instance.mjs init-template --seed-from <旧模板路径>`))
    process.exit(1)
  }
  fs.mkdirSync(TEMPLATE_DIR, { recursive: true })
  for (const f of TEMPLATE_TOP_FILES) {
    const src = path.join(seedSource, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEMPLATE_DIR, f))
  }
  for (const d of TEMPLATE_TOP_DIRS) {
    const src = path.join(seedSource, d)
    if (fs.existsSync(src)) copyTreeFiltered(src, path.join(TEMPLATE_DIR, d))
  }
  presetDefaultModel(path.join(TEMPLATE_DIR, 'agent', 'settings.json'))
  console.log(`[dev-instance] ✅ 模板就绪: ${TEMPLATE_DIR}` +
    (seedFrom ? `（种子源: ${seedSource}）` : '') +
    `\n    默认模型预置: ${DEFAULT_MODEL_PROVIDER}/${DEFAULT_MODEL_ID}` +
    `\n    模板是只读源，勿直接修改；调整配置后删模板重建（init-template --force）`)
}

/** settings.json 预置默认模型（缺文件则创建最小骨架） */
function presetDefaultModel(settingsPath) {
  let settings = {}
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch {
    settings = {}
  }
  settings.defaultProvider = DEFAULT_MODEL_PROVIDER
  settings.defaultModel = DEFAULT_MODEL_ID
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}

// ── 装配 & 启动 ───────────────────────────────────────────────────

function printBanner(p, env) {
  console.log(`
┌─ dev 实例装配 ─────────────────────────────────────────
│  worktree/实例:  ${p.name}
│  数据目录:       ${p.dataDir}
│  Vite:           http://localhost:${p.vitePort}
│  CDP:            http://localhost:${p.cdpPort}
│  runtime 端口段:  ${3210 + p.portOffset}-${3210 + p.portOffset + 9} (offset=${p.portOffset})
│  后台模式:       ${env.TAIJI_DEV_BACKGROUND === '1' ? '是（showInactive，不抢焦点）' : '否（前台；AI 验收请 TAIJI_DEV_BACKGROUND=1 pnpm dev）'}
└───────────────────────────────────────────────────────`)
}

function launch(env) {
  // [F7] 前置链保持原 dev script 语义：bundle-extensions 恒重建 staged 引擎副本
  const pre = [
    ['node', [path.join(REPO_ROOT, 'scripts', 'bundle-extensions.mjs')]],
    ['node', [path.join(APP_ROOT, 'scripts', 'electron-ensure.mjs')]],
  ]
  for (const [cmd, args] of pre) {
    const r = spawnSync(cmd, args, { stdio: 'inherit', env })
    if (r.status !== 0) {
      console.error(`[dev-instance] 前置步骤失败: ${cmd} ${args.join(' ')} (exit ${r.status})`)
      process.exit(r.status ?? 1)
    }
  }
  const child = spawn('pnpm', ['exec', 'concurrently', 'pnpm run dev:vite', 'pnpm run dev:electron'], {
    cwd: APP_ROOT,
    stdio: 'inherit',
    env,
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
}

// ── CLI ───────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const nameIdx = argv.indexOf('--name')
const cliName = nameIdx !== -1 ? argv[nameIdx + 1] : undefined

if (argv[0] === 'init-template') {
  const seedIdx = argv.indexOf('--seed-from')
  const seedFrom = seedIdx !== -1 ? argv[seedIdx + 1] : undefined
  if (seedIdx !== -1 && !seedFrom) {
    console.error('[dev-instance] --seed-from 需要显式路径参数（指向改名前旧模板目录）')
    process.exit(1)
  }
  initTemplate(hasFlag('--force'), seedFrom)
} else {
  const p = deriveParams(resolveInstanceName(cliName))
  // --data-dir 实验数据目录：必须在 buildDevEnv 之前解析覆盖——env 在 buildDevEnv 内
  // 固化 TAIJI_AGENT_DATA_DIR = p.dataDir，后改 p 不生效。值域校验失败 = 响亮退出并给
  // 恢复指引（resolveCustomDataDir：树内严格子路径、拒保留目录防 --fresh 误删）；
  // 树内值经 main.ts dev 解析（resolveDevDataDir 树内采信）直接生效，无需装配标记。
  const dataDirIdx = argv.indexOf('--data-dir')
  if (dataDirIdx !== -1) {
    const cliDataDir = argv[dataDirIdx + 1]
    try {
      p.dataDir = resolveCustomDataDir(cliDataDir)
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    }
  }
  const env = buildDevEnv(p)
  // dev 装配 spawn 的 electron cwd = apps/electron（下方 launch 的 cwd: APP_ROOT），
  // main 侧 local-file 白名单按 cwd/appPath 构造命中不了 worktree 根下的用户文件
  // （对话流 <img src="docs/..."> 相对路径解析出的绝对路径会被 403）。显式注入项目根，
  // main 侧仅 dev 态消费（打包态 env 不会被装配器注入且调用侧双重防泄漏），
  // 供 local-file 图片预览恢复「项目根」语义。
  env.TAIJI_DEV_PROJECT_ROOT = REPO_ROOT
  if (hasFlag('--mock')) {
    env.VITE_MOCK = 'true'
    env.TAIJI_MOCK = '1'
  }
  ensureInstanceDir(p, hasFlag('--fresh'), {
    fail: (msg) => { console.error(msg); process.exit(1) },
  })
  printBanner(p, env)
  if (hasFlag('--print')) process.exit(0)
  launch(env)
}
