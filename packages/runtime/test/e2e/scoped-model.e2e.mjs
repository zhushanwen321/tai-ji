#!/usr/bin/env node
/**
 * scoped-model.e2e.mjs — 端到端探针（node ≥22 内置 WebSocket）
 *
 * 用法：node scoped-model.e2e.mjs <E1|E2|E3|E4|E5|E6|E8|E10> <dataDir>
 *       node scoped-model.e2e.mjs smoke            (仅验证 setScopedModels 可用)
 *
 * 每个场景输出 "<id> PASS"/"<id> FAIL" 标记行到 stdout，exit code 与标记一致。
 * 内部断言失败输出详细诊断到 stderr。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const id = process.argv[2]
const dataDir = process.argv[3]

if (!id) {
  console.error('Usage: node scoped-model.e2e.mjs <E1|E2|E3|E4|E5|E6|E8|E10|smoke> [dataDir]')
  process.exit(1)
}

// ── 工具函数 ──────────────────────────────────────────────────

/**
 * pass/fail 用信号异常而非 process.exit：scenarioFn 内 process.exit 会跳过
 * runScenario 的 finally（killProc 清理 runtime 进程树），导致每场景泄漏进程。
 * 抛信号让异常传播先执行各层 finally，主路由统一 exit。
 */
class PassSignal extends Error {}
class FailSignal extends Error {}

function pass(eid) {
  console.log(`${eid} PASS`)
  throw new PassSignal(eid)
}

function fail(eid, reason) {
  console.error(`[e2e] ${eid} FAIL: ${reason}`)
  console.log(`${eid} FAIL`)
  throw new FailSignal(reason)
}

/**
 * 杀整棵 runtime 进程树（detached 建组后，组信号覆盖 pnpm + tsx + runtime）。
 * 用 SIGKILL：SIGTERM 组信号实测会被 runtime 的 graceful shutdown handler 吊住
 * （等 pi 子进程/flush，tsx 子进程逃逸成孤儿常驻）。探针场景无需 graceful——
 * providers.json/settings.json 的写入都在 rpc reply 前同步原子落盘，
 * kill 时机恒在断言通过之后。
 */
function killProc(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  try {
    process.kill(-proc.pid, 'SIGKILL')
  } catch {
    try { proc.kill('SIGKILL') } catch { /* already dead */ }
  }
}

/** 启动 runtime 子进程，返回 { proc, port, token } */
function startRuntime(dataDir, token = 'test-token-sm-e2e') {
  return new Promise((resolve, reject) => {
    // cwd 必须是 worktree 根目录（.git file 指向 worktree）
    const repoRoot = process.cwd()
    const env = {
      ...process.env,
      TAIJI_AGENT_DATA_DIR: dataDir,
      TAIJI_RUNTIME_TOKEN: token,
      TAIJI_AGENT_PORT_OFFSET: '0',
    }
    // tsx 直接跑 workspace 依赖同样正确解析（node_modules symlink 布局由 pnpm install 建好）
    // 不传 --port，让 runtime 用 BASE_PORT + offset，然后从日志解析实际端口
    // 用随机 offset 避免与正在运行的 taiji 实例冲突（dev 常态占用 3210/3310/1420 等，
    // offset 从 200 起避开 dev runtime 的 3310）
    const offset = Math.floor(Math.random() * 900) + 200
    env.TAIJI_AGENT_PORT_OFFSET = String(offset)

    // 不经 pnpm exec 直接用 worktree 绝对路径 tsx 启动：pnpm 会给 PATH 前置相对条目
    // ./node_modules/.bin，runtime 内 findPiExecutable 的 which pi 原样返回该相对路径，
    // RpcClient 以 session cwd（≠ repoRoot）spawn pi 时 ENOENT（E10 实测）。前置绝对
    // bin 目录后 which 返回绝对路径，session cwd 可安全指向隔离 dataDir。
    const binDir = join(repoRoot, 'node_modules', '.bin')
    env.PATH = `${binDir}:${env.PATH ?? ''}`
    const expectedPort = 3210 + offset
    const proc = spawn(join(binDir, 'tsx'), ['packages/runtime/src/index.ts'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 建独立进程组：proc.kill() 只杀 pnpm 父进程，tsx runtime 会变孤儿常驻
      // （实测每场景泄漏 1-4 个进程）。detached + 组信号 kill 整棵进程树。
      detached: true,
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })

    // 等待 "listening on" 日志或直接用 expectedPort
    const timeout = setTimeout(() => {
      killProc(proc)
      reject(new Error(`runtime startup timeout (30s)\nstdout: ${stdout}\nstderr: ${stderr}`))
    }, 30_000)

    const checkReady = (data) => {
      const s = data.toString()
      if (s.includes('[runtime] listening') || s.includes('[runtime] ready')) {
        clearTimeout(timeout)
        proc.stdout.removeListener('data', checkReady)
        proc.stderr.removeListener('data', checkReady)
        resolve({ proc, port: expectedPort, token })
      }
    }
    proc.stdout.on('data', checkReady)
    proc.stderr.on('data', checkReady)

    proc.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
    proc.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout)
        reject(new Error(`runtime exited with code ${code}\nstderr: ${stderr}`))
      }
    })
  })
}

/** WS 客户端封装 */
class WsClient {
  constructor(port, token) {
    this.port = port
    this.token = token
    this.ws = null
    this.nextId = 1
    this.pending = new Map() // id → { resolve, reject }
    this.broadcasts = [] // 收到的广播消息
    this._onMessage = null
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${this.port}`
      // node ≥22 内置 WebSocket (undici)
      this.ws = new WebSocket(url)

      const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 10_000)

      this.ws.addEventListener('open', () => {
        // 发送 auth
        this.ws.send(JSON.stringify({ type: 'auth', payload: { token: this.token } }))
      })

      this.ws.addEventListener('message', (ev) => {
        let msg
        try { msg = JSON.parse(ev.data) } catch { return }

        if (msg.type === 'auth.result') {
          if (msg.payload?.ok) {
            clearTimeout(timeout)
            resolve()
          } else {
            clearTimeout(timeout)
            reject(new Error('auth failed'))
          }
          return
        }

        // 广播消息收集（带索引：水位线等待需要知道消息在缓冲中的位置）
        if (msg.type && !msg.id?.startsWith?.('req_')) {
          this.broadcasts.push(msg)
          if (this._onMessage) this._onMessage(msg, this.broadcasts.length - 1)
          return
        }

        // reply 消息
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          res(msg)
        }
      })

      this.ws.addEventListener('error', (ev) => {
        clearTimeout(timeout)
        reject(new Error(`WS error: ${ev.message || 'unknown'}`))
      })

      this.ws.addEventListener('close', () => {
        clearTimeout(timeout)
      })
    })
  }

  /** 发送 RPC 请求，等待 reply */
  async rpc(type, payload = {}, timeoutMs = 10_000) {
    const id = `req_${this.nextId++}`
    const msg = { type, id, payload }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC timeout: ${type} (id=${id})`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (reply) => { clearTimeout(timer); resolve(reply) },
        reject: (err) => { clearTimeout(timer); reject(err) },
      })
      this.ws.send(JSON.stringify(msg))
    })
  }

  /**
   * 等待特定类型的广播消息（水位线语义：只匹配 from 之后的消息）。
   *
   * 时序背景（E1 根因）：runtime 在 auth 成功后推送整套初始状态（含全量 model.list），
   * 从缓冲头部 find 会拿到初始推送而非本轮写操作触发的广播。
   * - 写操作 reply 先于广播（toggle/delete）→ rpc 前取 mark = broadcasts.length，
   *   rpc 后 waitForBroadcast(type, timeout, mark) 只等新消息。
   * - 新连接等待初始推送（E3/E8 重启后 config.defaults）→ from=0 即可（缓冲里只有
   *   本连接的初始推送，existing 命中即目标）。
   */
  async waitForBroadcast(type, timeoutMs = 10_000, from = 0) {
    const existing = this.broadcasts.slice(from).find(b => b.type === type)
    if (existing) return existing
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for broadcast: ${type} (from=${from}, got=${JSON.stringify(this.broadcasts.map(b => b.type))})`)), timeoutMs)
      this._onMessage = (msg, idx) => {
        if (idx >= from && msg.type === type) {
          clearTimeout(timer)
          this._onMessage = null
          resolve(msg)
        }
      }
    })
  }

  /**
   * 从尾往前找已收到的最近一条 type 广播。适用于「广播先于 reply 发出」的写操作
   * （setScopedModels：broadcastProviderList → config.defaults → reply，TCP 有序保证
   * reply 到达时该轮广播必已在缓冲中）——从尾找第一条即本轮广播，天然跳过初始推送。
   */
  latestBroadcast(type) {
    for (let i = this.broadcasts.length - 1; i >= 0; i--) {
      if (this.broadcasts[i].type === type) return this.broadcasts[i]
    }
    return null
  }

  /** 广播缓冲水位线（rpc 前取，rpc 后 waitForBroadcast(type, t, mark) 等本轮新广播） */
  markBroadcasts() {
    return this.broadcasts.length
  }

  /** 清空广播缓冲 */
  clearBroadcasts() {
    this.broadcasts = []
  }

  close() {
    if (this.ws) this.ws.close()
  }
}

/** 预置 provider 数据（auth.json + models.json + providers.json） */
function presetProviders(dataDir, opts = {}) {
  const agentDir = join(dataDir, 'agent')
  const configDir = join(agentDir, 'config')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(configDir, { recursive: true })

  // auth.json
  const auth = opts.auth ?? {}
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify(auth, null, 2))

  // models.json
  const modelsConfig = {
    providers: opts.modelsProviders ?? {},
  }
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify(modelsConfig, null, 2))

  // providers.json (extras store) — 位于 config/ 子目录（pi-paths getProviderExtrasPath）
  const providersConfig = {
    version: 1,
    providers: opts.providersExtras ?? {},
    scopedModels: opts.scopedModels ?? [],
  }
  writeFileSync(join(configDir, 'providers.json'), JSON.stringify(providersConfig, null, 2))

  // settings.json
  const settings = opts.settings ?? {}
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(settings, null, 2))
}

// ── smoke 模式 ────────────────────────────────────────────────
if (id === 'smoke') {
  const smokeDir = dataDir || mkdtempSync(join(tmpdir(), 'taiji-smoke-'))
  presetProviders(smokeDir, {
    auth: { 'openai': { type: 'api_key', key: 'sk-test' } },
    modelsProviders: {
      'openai': { models: [{ id: 'gpt-4o' }] },
    },
  })
  // process.exit 会跳过 finally（见顶部 PassSignal 注释），exit 前必须先完成
  // killProc——connect/rpc 抛错路径同样不泄漏 runtime 进程组。
  let smokeExit = 1
  try {
    const { proc, port, token } = await startRuntime(smokeDir)
    const client = new WsClient(port, token)
    try {
      await client.connect()
      const reply = await client.rpc('config.setScopedModels', { models: ['openai/gpt-4o'] })
      if (reply.type === 'config.scopedModels') {
        smokeExit = 0
      } else {
        console.error(`[smoke] unexpected reply type: ${reply.type}`)
      }
    } finally {
      client.close()
      killProc(proc)
    }
  } catch (err) {
    // startRuntime 失败：超时路径已自清理，spawn error/异常退出无存活进程组
    console.error(`[smoke] ${err.message}`)
  }
  process.exit(smokeExit)
}

// ── E1-E6, E8, E10 ────────────────────────────────────────────

if (!dataDir) {
  console.error('dataDir required for E1-E8')
  process.exit(1)
}

// 公共 provider 配置
const CUSTOM_PROVIDER = 'test-provider'
const CUSTOM_MODEL_1 = 'model-a'
const CUSTOM_MODEL_2 = 'model-b'
const CUSTOM_MODEL_3 = 'model-c'
const CATALOG_PROVIDER = 'openai'
const CATALOG_MODEL = 'gpt-4o'
const AUTH_ONLY_PROVIDER = 'kimi-coding'
const AUTH_ONLY_MODEL = 'k3-256k'

function setupBaseProviders(extra = {}) {
  presetProviders(dataDir, {
    auth: {
      [CATALOG_PROVIDER]: { type: 'api_key', key: 'sk-test' },
      [AUTH_ONLY_PROVIDER]: { type: 'api_key', key: 'sk-test-kimi' },
      ...extra.auth,
    },
    modelsProviders: {
      [CATALOG_PROVIDER]: {
        models: [{ id: CATALOG_MODEL }],
      },
      [CUSTOM_PROVIDER]: {
        models: [
          { id: CUSTOM_MODEL_1 },
          { id: CUSTOM_MODEL_2 },
          { id: CUSTOM_MODEL_3 },
        ],
      },
      ...extra.modelsProviders,
    },
    ...extra,
  })
}

// builtin-providers.json 中 kimi-coding 模型集


async function runScenario(scenarioFn) {
  const { proc, port, token } = await startRuntime(dataDir)
  const client = new WsClient(port, token)
  try {
    await client.connect()
    await scenarioFn(client, { proc, port, token })
  } finally {
    // PassSignal/FailSignal 传播时也执行（pass/fail 抛信号 → 此处清理 → 主路由 exit）
    client.close()
    killProc(proc)
  }
}

/** 重启 runtime（E3, E8 需要） */
async function restartRuntime(proc, token) {
  killProc(proc)
  await delay(300)
  const result = await startRuntime(dataDir, token)
  const client = new WsClient(result.port, token)
  await client.connect()
  return { ...result, client }
}

// ── 场景实现 ──────────────────────────────────────────────────

async function scenarioE1() {
  setupBaseProviders()
  await runScenario(async (client) => {
    const models = [
      `${CATALOG_PROVIDER}/${CATALOG_MODEL}`,
      `${CUSTOM_PROVIDER}/${CUSTOM_MODEL_1}`,
      `${CUSTOM_PROVIDER}/${CUSTOM_MODEL_2}`,
    ]
    const reply = await client.rpc('config.setScopedModels', { models })
    if (reply.type === 'error') fail('E1', `setScopedModels error reply: ${JSON.stringify(reply.payload)}`)
    if (reply.type !== 'config.scopedModels') fail('E1', `unexpected reply type: ${reply.type}`)
    if (JSON.stringify(reply.payload.scopedModels) !== JSON.stringify(models)) {
      fail('E1', `reply scopedModels mismatch: ${JSON.stringify(reply.payload.scopedModels)}`)
    }

    // setScopedModels 的广播先于 reply 发出（TCP 有序）：reply 到达时本轮 model.list 必已
    // 入缓冲，从尾往前找即本轮广播（跳过 auth 后初始推送的全量 model.list）。
    const modelListBroadcast = client.latestBroadcast('model.list')
    if (!modelListBroadcast) fail('E1', 'no model.list broadcast received')
    const broadcastedIds = modelListBroadcast.payload.models.map(m => `${m.providerId}/${m.id}`)
    if (broadcastedIds.length !== models.length) fail('E1', `expected ${models.length} models, got ${broadcastedIds.length}: ${JSON.stringify(broadcastedIds)}`)
    for (let i = 0; i < models.length; i++) {
      if (broadcastedIds[i] !== models[i]) fail('E1', `model[${i}] expected ${models[i]}, got ${broadcastedIds[i]}`)
    }

    // 隔离性断言
    if (!dataDir.includes('taiji-sm-e2e-')) fail('E1', `dataDir not isolated: ${dataDir}`)

    pass('E1')
  })
}

async function scenarioE2() {
  setupBaseProviders()
  await runScenario(async (client) => {
    const models1 = [
      `${CATALOG_PROVIDER}/${CATALOG_MODEL}`,
      `${CUSTOM_PROVIDER}/${CUSTOM_MODEL_1}`,
      `${CUSTOM_PROVIDER}/${CUSTOM_MODEL_2}`,
    ]
    await client.rpc('config.setScopedModels', { models: models1 })
    if (!client.latestBroadcast('model.list')) fail('E2', 'no model.list after first setScopedModels')

    // 调序：把第二位移到首位
    const models2 = [
      `${CUSTOM_PROVIDER}/${CUSTOM_MODEL_1}`,
      `${CATALOG_PROVIDER}/${CATALOG_MODEL}`,
      `${CUSTOM_PROVIDER}/${CUSTOM_MODEL_2}`,
    ]
    const reply = await client.rpc('config.setScopedModels', { models: models2 })
    if (reply.type === 'error') fail('E2', `setScopedModels error reply: ${JSON.stringify(reply.payload)}`)
    // 广播先于 reply，从尾找本轮 model.list；全序断言（不只首位——中后位错乱同样要抓）
    const modelListBroadcast = client.latestBroadcast('model.list')
    const broadcastedIds = modelListBroadcast.payload.models.map(m => `${m.providerId}/${m.id}`)
    if (JSON.stringify(broadcastedIds) !== JSON.stringify(models2)) {
      fail('E2', `broadcast order mismatch: expected ${JSON.stringify(models2)}, got ${JSON.stringify(broadcastedIds)}`)
    }

    // 断言 settings.json defaultModel
    const settingsPath = join(dataDir, 'agent', 'settings.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const expectedDefault = models2[0]
    const actualDefault = settings.defaultProvider && settings.defaultModel
      ? `${settings.defaultProvider}/${settings.defaultModel}`
      : null
    if (actualDefault !== expectedDefault) fail('E2', `defaultModel expected ${expectedDefault}, got ${actualDefault}`)

    pass('E2')
  })
}

async function scenarioE3() {
  // auth.json-only catalog provider (kimi-coding 无 models.json 条目)
  setupBaseProviders()
  await runScenario(async (client, { proc, token }) => {
    const targetModel = `${AUTH_ONLY_PROVIDER}/${AUTH_ONLY_MODEL}`
    const reply = await client.rpc('config.setScopedModels', { models: [targetModel] })
    if (reply.type === 'error') fail('E3', `setScopedModels error reply: ${JSON.stringify(reply.payload)}`)
    if (!client.latestBroadcast('model.list')) fail('E3', 'no model.list after setScopedModels')

    // 断言 settings.json defaultModel
    const settingsPath = join(dataDir, 'agent', 'settings.json')
    let settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const actualDefault = settings.defaultProvider && settings.defaultModel
      ? `${settings.defaultProvider}/${settings.defaultModel}`
      : null
    if (actualDefault !== targetModel) fail('E3', `defaultModel expected ${targetModel}, got ${actualDefault}`)

    // 重启 runtime
    const { client: newClient, proc: newProc } = await restartRuntime(proc, token)
    try {
      // 等待 config.defaults 推送
      const defaultsPush = await newClient.waitForBroadcast('config.defaults', 15_000)
      if (defaultsPush.payload.defaultModel !== targetModel) {
        fail('E3', `config.defaults push expected ${targetModel}, got ${defaultsPush.payload.defaultModel}`)
      }

      // 再次读 settings.json 确认未被冲掉
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      const postRestartDefault = settings.defaultProvider && settings.defaultModel
        ? `${settings.defaultProvider}/${settings.defaultModel}`
        : null
      if (postRestartDefault !== targetModel) {
        fail('E3', `post-restart defaultModel expected ${targetModel}, got ${postRestartDefault}`)
      }
    } finally {
      newClient.close()
      killProc(newProc)
    }

    pass('E3')
  })
}

async function scenarioE4() {
  setupBaseProviders({
    settings: { enabledModels: [`${CUSTOM_PROVIDER}/*`, `${CATALOG_PROVIDER}/*`] },
  })
  await runScenario(async (client) => {
    const models = [
      `${CUSTOM_PROVIDER}/${CUSTOM_MODEL_1}`,
      `${CATALOG_PROVIDER}/${CATALOG_MODEL}`,
    ]
    const setReply = await client.rpc('config.setScopedModels', { models })
    if (setReply.type === 'error') fail('E4', `setScopedModels error reply: ${JSON.stringify(setReply.payload)}`)
    if (!client.latestBroadcast('model.list')) fail('E4', 'no model.list after setScopedModels')

    // Toggle OFF custom provider（toggle handler reply 先发、广播后发 → 水位线等新广播）
    const markOff = client.markBroadcasts()
    const offReply = await client.rpc('config.toggleProviderEnabled', { providerId: CUSTOM_PROVIDER, enabled: false })
    if (offReply.type === 'error') fail('E4', `toggle OFF error reply: ${JSON.stringify(offReply.payload)}`)
    await client.waitForBroadcast('config.providers', 10_000, markOff)

    // 主动拉取 model.list（toggle 是同步 mutation，reply 到达时已生效）
    const modelListReply = await client.rpc('model.list', {})
    const modelIds = modelListReply.payload.models.map(m => `${m.providerId}/${m.id}`)
    const hasCustom = modelIds.some(id => id.startsWith(`${CUSTOM_PROVIDER}/`))
    if (hasCustom) fail('E4', `CUSTOM_PROVIDER models should be gone after toggle OFF, got: ${JSON.stringify(modelIds)}`)

    // 断言 providers.json scopedModels 仍含 custom provider 条目
    const providersPath = join(dataDir, 'agent', 'config', 'providers.json')
    const providersData = JSON.parse(readFileSync(providersPath, 'utf-8'))
    const scopedModels = providersData.scopedModels ?? []
    const hasCustomScoped = scopedModels.some(m => m.startsWith(`${CUSTOM_PROVIDER}/`))
    if (!hasCustomScoped) fail('E4', `scopedModels should retain CUSTOM_PROVIDER entries, got: ${JSON.stringify(scopedModels)}`)

    // 恢复 toggle ON（同样水位线等新广播）
    const markOn = client.markBroadcasts()
    const onReply = await client.rpc('config.toggleProviderEnabled', { providerId: CUSTOM_PROVIDER, enabled: true })
    if (onReply.type === 'error') fail('E4', `toggle ON error reply: ${JSON.stringify(onReply.payload)}`)
    await client.waitForBroadcast('config.providers', 10_000, markOn)

    const modelListReply2 = await client.rpc('model.list', {})
    const modelIds2 = modelListReply2.payload.models.map(m => `${m.providerId}/${m.id}`)
    const hasCustomAfterRestore = modelIds2.some(id => id.startsWith(`${CUSTOM_PROVIDER}/`))
    if (!hasCustomAfterRestore) fail('E4', `CUSTOM_PROVIDER models should reappear after toggle ON, got: ${JSON.stringify(modelIds2)}`)

    pass('E4')
  })
}

async function scenarioE5() {
  setupBaseProviders()
  await runScenario(async (client) => {
    // 记录全量模型数
    const fullListReply = await client.rpc('model.list', {})
    const fullCount = fullListReply.payload.models.length

    // 设非空 scoped（广播先于 reply → 从尾找本轮 model.list）
    const scopedModels = [
      `${CUSTOM_PROVIDER}/${CUSTOM_MODEL_1}`,
      `${CATALOG_PROVIDER}/${CATALOG_MODEL}`,
    ]
    const setReply = await client.rpc('config.setScopedModels', { models: scopedModels })
    if (setReply.type === 'error') fail('E5', `setScopedModels error reply: ${JSON.stringify(setReply.payload)}`)
    const scopedBroadcast = client.latestBroadcast('model.list')
    const scopedCount = scopedBroadcast.payload.models.length
    if (scopedCount >= fullCount) fail('E5', `scoped count (${scopedCount}) should be < full count (${fullCount})`)

    // 记录 defaultModel。前置 setScopedModels（非空）已触发 default 同步链，
    // defaultBefore 为 null = 同步链断裂（S2 契约：default = scoped[0]），显式 FAIL 不静默跳过
    const settingsPath = join(dataDir, 'agent', 'settings.json')
    const settingsBefore = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const defaultBefore = settingsBefore.defaultProvider && settingsBefore.defaultModel
      ? `${settingsBefore.defaultProvider}/${settingsBefore.defaultModel}`
      : null
    if (defaultBefore === null) {
      fail('E5', `defaultModel is null after setScopedModels — default sync chain should have produced scoped[0]=${scopedModels[0]}, settings: ${JSON.stringify(settingsBefore)}`)
    }

    // 清空
    const clearReply = await client.rpc('config.setScopedModels', { models: [] })
    if (clearReply.type === 'error') fail('E5', `clear scopedModels error reply: ${JSON.stringify(clearReply.payload)}`)
    const fullBroadcast = client.latestBroadcast('model.list')
    const restoredCount = fullBroadcast.payload.models.length
    if (restoredCount !== fullCount) fail('E5', `restored count (${restoredCount}) should equal full count (${fullCount})`)

    // default 不变
    const settingsAfter = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const defaultAfter = settingsAfter.defaultProvider && settingsAfter.defaultModel
      ? `${settingsAfter.defaultProvider}/${settingsAfter.defaultModel}`
      : null
    if (defaultAfter !== defaultBefore) fail('E5', `defaultModel changed from ${defaultBefore} to ${defaultAfter}`)

    pass('E5')
  })
}

async function scenarioE6() {
  setupBaseProviders()
  await runScenario(async (client) => {
    const models = [
      `${CUSTOM_PROVIDER}/${CUSTOM_MODEL_1}`,
      `${CATALOG_PROVIDER}/${CATALOG_MODEL}`,
    ]
    const setReply = await client.rpc('config.setScopedModels', { models })
    if (setReply.type === 'error') fail('E6', `setScopedModels error reply: ${JSON.stringify(setReply.payload)}`)
    if (!client.latestBroadcast('model.list')) fail('E6', 'no model.list after setScopedModels')

    // 删除 CUSTOM_PROVIDER（delete handler reply 先发、广播后发 → 水位线等新广播）
    const mark = client.markBroadcasts()
    const delReply = await client.rpc('config.deleteProvider', { providerId: CUSTOM_PROVIDER })
    if (delReply.type === 'error') fail('E6', `deleteProvider error reply: ${JSON.stringify(delReply.payload)}`)
    await client.waitForBroadcast('config.providers', 10_000, mark)

    // 双重断言
    // 1. 广播侧（水位线之后的本轮 config.providers）
    const providersBroadcast = client.broadcasts.slice(mark).find(b => b.type === 'config.providers')
    const broadcastScoped = providersBroadcast?.payload?.scopedModels ?? []
    const hasCustomInBroadcast = broadcastScoped.some(m => m.startsWith(`${CUSTOM_PROVIDER}/`))
    if (hasCustomInBroadcast) fail('E6', `broadcast scopedModels should not contain CUSTOM_PROVIDER, got: ${JSON.stringify(broadcastScoped)}`)

    // 2. 文件侧
    const providersPath = join(dataDir, 'agent', 'config', 'providers.json')
    const providersData = JSON.parse(readFileSync(providersPath, 'utf-8'))
    const fileScoped = providersData.scopedModels ?? []
    const hasCustomInFile = fileScoped.some(m => m.startsWith(`${CUSTOM_PROVIDER}/`))
    if (hasCustomInFile) fail('E6', `file scopedModels should not contain CUSTOM_PROVIDER, got: ${JSON.stringify(fileScoped)}`)

    // 保留其他 provider 条目
    const hasCatalog = fileScoped.some(m => m.startsWith(`${CATALOG_PROVIDER}/`))
    if (!hasCatalog) fail('E6', `file scopedModels should retain CATALOG_PROVIDER, got: ${JSON.stringify(fileScoped)}`)

    pass('E6')
  })
}

async function scenarioE8() {
  setupBaseProviders()
  await runScenario(async (client, { proc, token }) => {
    const models = [
      `${CUSTOM_PROVIDER}/${CUSTOM_MODEL_1}`,
      `${CATALOG_PROVIDER}/${CATALOG_MODEL}`,
    ]
    const setReply = await client.rpc('config.setScopedModels', { models })
    if (setReply.type === 'error') fail('E8', `setScopedModels error reply: ${JSON.stringify(setReply.payload)}`)
    if (!client.latestBroadcast('model.list')) fail('E8', 'no model.list after setScopedModels')

    // 断言 settings.json defaultModel == A
    const settingsPath = join(dataDir, 'agent', 'settings.json')
    let settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    let actualDefault = settings.defaultProvider && settings.defaultModel
      ? `${settings.defaultProvider}/${settings.defaultModel}`
      : null
    if (actualDefault !== models[0]) fail('E8', `expected defaultModel ${models[0]}, got ${actualDefault}`)

    // 重启 runtime，断言 config.defaults 推送（新连接 from=0：缓冲只有本连接的初始推送）
    const { client: newClient, proc: newProc } = await restartRuntime(proc, token)
    try {
      const defaultsPush = await newClient.waitForBroadcast('config.defaults', 15_000)
      if (defaultsPush.payload.defaultModel !== models[0]) {
        fail('E8', `config.defaults push expected ${models[0]}, got ${defaultsPush.payload.defaultModel}`)
      }

      // 调序：[B, A]
      const models2 = [
        `${CATALOG_PROVIDER}/${CATALOG_MODEL}`,
        `${CUSTOM_PROVIDER}/${CUSTOM_MODEL_1}`,
      ]
      const reorderReply = await newClient.rpc('config.setScopedModels', { models: models2 })
      if (reorderReply.type === 'error') fail('E8', `reorder error reply: ${JSON.stringify(reorderReply.payload)}`)
      if (!newClient.latestBroadcast('model.list')) fail('E8', 'no model.list after reorder')

      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      actualDefault = settings.defaultProvider && settings.defaultModel
        ? `${settings.defaultProvider}/${settings.defaultModel}`
        : null
      if (actualDefault !== models2[0]) fail('E8', `after reorder expected defaultModel ${models2[0]}, got ${actualDefault}`)

      // 再次重启
      const { client: client2, proc: proc2 } = await restartRuntime(newProc, token)
      try {
        const defaultsPush2 = await client2.waitForBroadcast('config.defaults', 15_000)
        if (defaultsPush2.payload.defaultModel !== models2[0]) {
          fail('E8', `second config.defaults push expected ${models2[0]}, got ${defaultsPush2.payload.defaultModel}`)
        }
      } finally {
        client2.close()
        killProc(proc2)
      }
    } finally {
      newClient.close()
      killProc(newProc)
    }

    pass('E8')
  })
}

/**
 * E10（设计验收 S5）：新会话 modelId 终态 = scoped[0]，catalog 与 custom 两种
 * provider 源各覆盖一遍（复用 E3 的 provider 布局：openai = catalog 源，
 * test-provider = models.json 自定义 custom 源）。链路：setScopedModels（同步
 * default = scoped[0]）→ session.create（spawn 读 getDefaultModel()）→ 断言双终态：
 * reply session.modelId + session.state_changed（pi get_state 播种快照）。
 */
async function scenarioE10() {
  // 不走 setupBaseProviders：其末尾 `...extra` 兜底 spread 会用原始 extra 覆盖前面
  // merge 好的 auth/modelsProviders（E10 实测踩坑：openai 条目被覆盖丢失 → default
  // auto-fix 漂到 test-provider/model-a），直接用 presetProviders 完整构造。
  // custom 源条目带 api + baseUrl + 凭证：E10 会真实 spawn pi 子进程（E1-E8 只走配置
  // 链路不 spawn），pi 0.84.1 对自定义 provider 的可用性判定比 taiji runtime 聚合严格，
  // 缺 api 时 --model 校验报 "Model not found"（隔离探针实测）。baseUrl 指向不监听
  // 端口即可——本场景不发 LLM turn，永不连接。
  presetProviders(dataDir, {
    auth: {
      [CATALOG_PROVIDER]: { type: 'api_key', key: 'sk-test' },
      [CUSTOM_PROVIDER]: { type: 'api_key', key: 'sk-test-custom' },
    },
    modelsProviders: {
      [CATALOG_PROVIDER]: {
        models: [{ id: CATALOG_MODEL }],
      },
      [CUSTOM_PROVIDER]: {
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9/v1',
        models: [
          { id: CUSTOM_MODEL_1 },
          { id: CUSTOM_MODEL_2 },
          { id: CUSTOM_MODEL_3 },
        ],
      },
    },
  })
  // 隔离性断言：dataDir 由调用方 mktemp 隔离传入，禁止触碰真实 ~/.taiji
  const realAgentDir = join(homedir(), '.taiji')
  const resolvedDataDir = resolve(dataDir)
  if (resolvedDataDir === realAgentDir || resolvedDataDir.startsWith(realAgentDir + sep)) {
    fail('E10', `dataDir must not touch real ~/.taiji, got: ${dataDir}`)
  }
  const workDir = join(dataDir, 'e10-work')
  mkdirSync(workDir, { recursive: true })
  await runScenario(async (client) => {
    const rounds = [
      { source: 'catalog', scoped: [`${CATALOG_PROVIDER}/${CATALOG_MODEL}`, `${CUSTOM_PROVIDER}/${CUSTOM_MODEL_1}`] },
      { source: 'custom', scoped: [`${CUSTOM_PROVIDER}/${CUSTOM_MODEL_2}`, `${CATALOG_PROVIDER}/${CATALOG_MODEL}`] },
    ]
    for (const { source, scoped } of rounds) {
      const setReply = await client.rpc('config.setScopedModels', { models: scoped })
      if (setReply.type === 'error') fail('E10', `[${source}] setScopedModels error reply: ${JSON.stringify(setReply.payload)}`)
      if (!client.latestBroadcast('model.list')) fail('E10', `[${source}] no model.list after setScopedModels`)

      const createReply = await client.rpc('session.create', { cwd: workDir, label: `e10-${source}` })
      if (createReply.type === 'error') fail('E10', `[${source}] session.create error reply: ${JSON.stringify(createReply.payload)}`)
      const session = createReply.payload?.session
      if (!session?.id) fail('E10', `[${source}] session.created reply missing session: ${JSON.stringify(createReply.payload)}`)

      // 终态 1：reply 的 session.modelId（create 时 modelOverride ?? getDefaultModel()）
      if (session.modelId !== scoped[0]) {
        const settingsDump = readFileSync(join(dataDir, 'agent', 'settings.json'), 'utf-8')
        fail('E10', `[${source}] reply session.modelId expected ${scoped[0]}, got ${session.modelId}; settings.json: ${settingsDump}`)
      }

      // 终态 2：session.state_changed——session 级 topic（messageBus.publish(sessionId)），
      // 须 session.subscribe 订阅后才推送。subscribe reply 的 stateSnapshot 是 state
      // topic 的 last-value：播种 fetch（get_state 快照，失败退避 1s/5s/15s 后 fallback
      // 双写缓存同样发帧）已落定则直接命中，否则轮询等订阅后的 live 帧。按 sessionId
      // 过滤——上一轮 session 的 state_changed 也在总线上。
      const subReply = await client.rpc('session.subscribe', { sessionId: session.id })
      if (subReply.type === 'error') fail('E10', `[${source}] session.subscribe error reply: ${JSON.stringify(subReply.payload)}`)
      const snapshotted = (subReply.payload?.stateSnapshot ?? []).find(
        m => m.type === 'session.state_changed' && m.payload?.sessionId === session.id,
      )
      const statePush = snapshotted?.payload ?? await waitStateChangedFor(client, session.id)
      if (statePush.modelId !== scoped[0]) {
        fail('E10', `[${source}] state_changed.modelId expected ${scoped[0]}, got ${statePush.modelId}`)
      }
    }

    pass('E10')
  })
}

/**
 * 轮询等待指定 session 的 session.state_changed 广播（含缓冲中已有的；从尾往前取
 * 最新一条）。state_changed 由 pi get_state 播种后异步发布，且 pi 子进程刚 spawn，
 * 就绪时间不定——轮询比一次性 find 稳，20s 上限覆盖慢启动。
 */
async function waitStateChangedFor(client, sessionId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (let i = client.broadcasts.length - 1; i >= 0; i--) {
      const b = client.broadcasts[i]
      if (b.type === 'session.state_changed' && b.payload?.sessionId === sessionId) {
        return b.payload
      }
    }
    await delay(200)
  }
  throw new Error(`timeout waiting session.state_changed for ${sessionId} (broadcasts: ${JSON.stringify(client.broadcasts.map(b => `${b.type}:${b.payload?.sessionId ?? ''}`))}`)
}

// ── 路由 ──────────────────────────────────────────────────────

const scenarios = {
  E1: scenarioE1,
  E2: scenarioE2,
  E3: scenarioE3,
  E4: scenarioE4,
  E5: scenarioE5,
  E6: scenarioE6,
  E8: scenarioE8,
  E10: scenarioE10,
}

const scenarioFn = scenarios[id]
if (!scenarioFn) {
  console.error(`Unknown scenario: ${id}`)
  process.exit(1)
}

try {
  await scenarioFn()
  // 场景应以 pass()/fail() 收尾（都抛信号）；走到这里 = 断言链漏网，按 FAIL 处理
  fail(id, 'scenario finished without pass() — assertion chain incomplete')
} catch (err) {
  if (err instanceof PassSignal) {
    process.exit(0)
  }
  if (!(err instanceof FailSignal)) {
    // 探针自身错误（连接失败/超时等）补 FAIL 标记行；FailSignal 已在 fail() 输出过
    console.error(`[e2e] ${id} FAIL: ${err.message}`)
    console.log(`${id} FAIL`)
  }
  process.exit(1)
}
