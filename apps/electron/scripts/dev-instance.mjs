#!/usr/bin/env node
/**
 * per-worktree dev 实例装配器（多 agent 多 worktree 并行 dev 互不干扰的唯一入口）。
 *
 * 背景（C-dev-01）：单机多 AI agent 在多个 worktree 各自验收时，旧链所有实例共享
 * ~/.xyz-agent-dev 数据目录 + 固定端口（Vite 1420 / CDP 9222 / runtime offset 100），
 * 互写同一会话库导致验收证据无法绑定 worktree（2026-09-12 H3 Gate B 归因困境成因之一），
 * 且第二个实例 Vite 端口被占后 Electron 仍加载旧实例的 1420 = 静默跑旧代码。
 *
 * 职责（装配后 spawn 原 concurrently 链，不改各腿自身逻辑）：
 *   1. 从 worktree 名 hash 稳定派生端口（同 worktree 重启不变，CDP 连接/日志可复现）：
 *      - XYZ_VITE_PORT            1420 + hash%300
 *      - XYZ_CDP_PORT             9222 + hash%300
 *      - XYZ_AGENT_PORT_OFFSET    100 + (hash%40)*10（runtime 端口段 = 3210+offset 起
 *        10 个，offset 步进 10 保证实例段不重叠；打包版 offset=0 天然避开）
 *   2. 数据目录 ~/.xyz-agent-dev/instances/<worktree>/，首次从只读模板
 *      ~/.xyz-agent-dev.template/ 复制（模板只含配置面，运行时状态见 EXCLUDES）；
 *      Electron userData / 单实例锁从 XYZ_AGENT_DATA_DIR 派生（main.ts），自动隔离。
 *   3. 透传 XYZ_DEV_BACKGROUND=1（外部设置时 window-factory 走 showInactive 不抢前台焦点，
 *      AI agent 真机验收必须带——见 browser-automation skill 对策 2）。
 *
 * 用法：
 *   pnpm dev                          装配并启动（package.json dev 的入口）
 *   node scripts/dev-instance.mjs --print          只打印派生参数不启动（探测/验证）
 *   node scripts/dev-instance.mjs --fresh          删除本实例目录后从模板重建（验收要干净环境时）
 *   node scripts/dev-instance.mjs init-template [--force]   从现有 ~/.xyz-agent-dev 生成只读模板
 *   XYZ_DEV_INSTANCE_NAME=foo pnpm dev             显式指定实例名（默认 = worktree 目录名）
 *
 * 模板预置默认模型 xiaomi-token-plan-cn/mimo-v2.5-pro（快速测试模型，本仓等价性测试
 * pi-fixture.ts 同款）——每个实例副本天生默认用它，GUI 派发不再吃慢模型。
 */

import { spawn, spawnSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(__dirname, '..') // apps/electron
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..')

const DEV_DATA_PARENT = path.join(os.homedir(), '.xyz-agent-dev')
const INSTANCES_DIR = path.join(DEV_DATA_PARENT, 'instances')
const TEMPLATE_DIR = path.join(os.homedir(), '.xyz-agent-dev.template')

const DEFAULT_MODEL_PROVIDER = 'xiaomi-token-plan-cn'
const DEFAULT_MODEL_ID = 'mimo-v2.5-pro'

// ── 模板配置面（白名单制：只复制这些顶层条目，其余一律不进模板/实例）──────────
// agent/（pi agent 目录，PI_CODING_AGENT_DIR = <dataDir>/agent，v2 方案 B 布局）是
// 「配置+运行时状态」混合体，整目录复制但排除运行时子目录（EXCLUDES）。npm/ 是用户
// 安装的 pi 扩展（~30M），属配置面。
const TEMPLATE_TOP_FILES = [
  'config.json', 'config.toml', 'pi-presets.json', 'model-db.json',
  'provider-catalog-overlay.json', 'proxy-config.json', 'projects.json', 'recent-workspaces.json',
]
const TEMPLATE_TOP_DIRS = ['agent', 'npm', 'plugins', 'skills', 'agents', 'secrets']
// 混合目录内的运行时状态子目录（会话/记录/调度状态/日志），永不进模板
const TEMPLATE_DIR_EXCLUDES = [
  'subagents', 'records', 'scheduler', 'workflow-state', 'token-stats', 'cache-ratio', 'logs', 'sessions',
]

// ── 实例参数派生 ──────────────────────────────────────────────────

/** FNV-1a 32bit：稳定（同输入同输出）、无依赖、分布均匀 */
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** worktree 名：git toplevel 的 basename（bare repo + worktree 模式下即 worktree 目录名） */
function resolveInstanceName(cliName) {
  if (cliName) return cliName
  if (process.env.XYZ_DEV_INSTANCE_NAME) return process.env.XYZ_DEV_INSTANCE_NAME
  try {
    const top = execSync('git rev-parse --show-toplevel', { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    return path.basename(top)
  } catch {
    return path.basename(REPO_ROOT)
  }
}

function deriveParams(name) {
  const h = fnv1a(name)
  return {
    name,
    vitePort: 1420 + (h % 300),
    cdpPort: 9222 + ((h >>> 8) % 300),
    portOffset: 100 + ((h >>> 16) % 40) * 10,
    dataDir: path.join(INSTANCES_DIR, name),
  }
}

// ── 模板管理 ──────────────────────────────────────────────────────

function copyTreeFiltered(src, dst) {
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (entry) => {
      // entry 相对被复制根的路径（首层无前导分隔）；排除运行时状态子目录（任意深度命中名字）
      const rel = path.relative(src, entry)
      if (!rel) return true
      return !TEMPLATE_DIR_EXCLUDES.includes(path.basename(rel))
    },
  })
}

/** 从现有 ~/.xyz-agent-dev 生成只读模板（配置面白名单 + 预置快速默认模型） */
function initTemplate(force) {
  if (fs.existsSync(TEMPLATE_DIR)) {
    if (!force) {
      console.error(`[dev-instance] 模板已存在: ${TEMPLATE_DIR}（重建加 --force）`)
      process.exit(1)
    }
    fs.rmSync(TEMPLATE_DIR, { recursive: true, force: true })
  }
  if (!fs.existsSync(DEV_DATA_PARENT)) {
    console.error(`[dev-instance] 源目录不存在: ${DEV_DATA_PARENT}\n` +
      `先手动跑一次旧链 dev 生成初始配置（pnpm --filter @xyz-agent/electron dev:vite 等任一即可），再 init-template`)
    process.exit(1)
  }
  fs.mkdirSync(TEMPLATE_DIR, { recursive: true })
  for (const f of TEMPLATE_TOP_FILES) {
    const src = path.join(DEV_DATA_PARENT, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEMPLATE_DIR, f))
  }
  for (const d of TEMPLATE_TOP_DIRS) {
    const src = path.join(DEV_DATA_PARENT, d)
    if (fs.existsSync(src)) copyTreeFiltered(src, path.join(TEMPLATE_DIR, d))
  }
  presetDefaultModel(path.join(TEMPLATE_DIR, 'agent', 'settings.json'))
  console.log(`[dev-instance] ✅ 模板就绪: ${TEMPLATE_DIR}` +
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

// ── 实例目录 ──────────────────────────────────────────────────────

function ensureInstanceDir(p, fresh) {
  const resolved = path.resolve(p.dataDir)
  // 安全断言：--fresh 只允许删 instances/ 直属子目录，防误删任意路径
  if (!resolved.startsWith(INSTANCES_DIR + path.sep)) {
    console.error(`[dev-instance] 实例目录越界（须在 ${INSTANCES_DIR} 下）: ${resolved}`)
    process.exit(1)
  }
  if (fresh && fs.existsSync(resolved)) {
    fs.rmSync(resolved, { recursive: true, force: true })
    console.log(`[dev-instance] --fresh 已清空实例目录: ${resolved}`)
  }
  if (fs.existsSync(resolved)) return
  if (!fs.existsSync(TEMPLATE_DIR)) {
    console.error(`[dev-instance] 模板不存在: ${TEMPLATE_DIR}\n` +
      `先执行: node ${path.relative(process.cwd(), path.join(APP_ROOT, 'scripts/dev-instance.mjs'))} init-template`)
    process.exit(1)
  }
  fs.cpSync(TEMPLATE_DIR, resolved, { recursive: true })
  console.log(`[dev-instance] ✅ 实例目录已从模板创建: ${resolved}`)
}

// ── 装配 & 启动 ───────────────────────────────────────────────────

function buildEnv(p) {
  return {
    ...process.env,
    // 端口与数据目录由装配器统一决定（保证 vite/electron/runtime/loadURL 四点一致），
    // 不尊重外部碎片注入——要定制实例名用 XYZ_DEV_INSTANCE_NAME
    XYZ_AGENT_DATA_DIR: p.dataDir,
    XYZ_AGENT_PORT_OFFSET: String(p.portOffset),
    XYZ_VITE_PORT: String(p.vitePort),
    XYZ_CDP_PORT: String(p.cdpPort),
    XYZ_VITE_DEV_URL: `http://localhost:${p.vitePort}`,
  }
}

function printBanner(p, env) {
  console.log(`
┌─ dev 实例装配 ─────────────────────────────────────────
│  worktree/实例:  ${p.name}
│  数据目录:       ${p.dataDir}
│  Vite:           http://localhost:${p.vitePort}
│  CDP:            http://localhost:${p.cdpPort}
│  runtime 端口段:  ${3210 + p.portOffset}-${3210 + p.portOffset + 9} (offset=${p.portOffset})
│  后台模式:       ${env.XYZ_DEV_BACKGROUND === '1' ? '是（showInactive，不抢焦点）' : '否（前台；AI 验收请 XYZ_DEV_BACKGROUND=1 pnpm dev）'}
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
  initTemplate(hasFlag('--force'))
} else {
  const p = deriveParams(resolveInstanceName(cliName))
  const env = buildEnv(p)
  if (hasFlag('--mock')) {
    env.VITE_MOCK = 'true'
    env.XYZ_MOCK = '1'
  }
  ensureInstanceDir(p, hasFlag('--fresh'))
  printBanner(p, env)
  if (hasFlag('--print')) process.exit(0)
  launch(env)
}
