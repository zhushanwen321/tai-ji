/**
 * provider-live-sync 真机验收（e2e 资产 E2E-MODELS-02，L2.5 faux 轨）。
 *
 * 触发面（docs/testing/e2e-map.json）：`extensions/universal/provider-live-sync/**` +
 * 模型切换链（session-model-control / model-message-handler / composer 提示链）+
 * `packages/runtime/src/services/provider-config-helper.ts`（写侧）+ pi 版本 bump。
 * 运行：`node scripts/verify-provider-live-sync.mjs`（仓库根为 cwd，约 30s，零外网）。
 *
 * 覆盖的语义（= 本扩展存在的理由，PS-41/42 的行为级证据）：
 * 运行中 pi 进程「新增 provider/模型/凭据」后能否直接切换、删除后是否同步生效且不塌陷。
 *
 * 手法：真实 pi CLI（`pi -ne --mode rpc`）+ 真实 provider-live-sync 扩展 + 隔离的
 * PI_CODING_AGENT_DIR（临时目录，不碰真实数据目录）。通过 stdin JSONL 发 RPC。
 *
 * 场景（= 用户报告的原始 bug）：
 *   1. 启动 pi（agent dir 里既无 models.json、也无该 provider 的任何痕迹）→ 记基线：
 *      `set_model livetest/lt-1` 必失败（`Model not found`）——证明快照确实冻结；
 *   2. 运行中写盘 models.json（新增 custom provider `livetest` + 模型 `lt-1` + apiKey）；
 *   3. 等 ≤3s（扩展轮询周期 2s）→ 再发 `set_model livetest/lt-1`；
 *   4. 断言：成功，且 `get_state.model.id === 'lt-1'`（pi 侧真生效）；
 *   5. 反向：删除该 provider → 等 ≤3s → `set_model` 对**另一个仍存在的**模型仍成功（无塌陷）。
 *
 * 用法：node .tmp/verification/pi-live-provider-e2e.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// 仓库根：优先 cwd（e2e-map 的 run 约定「仓库根为 cwd」），否则从脚本位置上溯（scripts/ 的父目录）
const ROOT = existsSync(join(process.cwd(), 'node_modules/.bin/pi'))
  ? process.cwd()
  : resolve(import.meta.dirname, '..')
const PI_BIN = join(ROOT, 'node_modules/.bin/pi')
const EXT = join(ROOT, 'extensions/universal/provider-live-sync')
const CUSTOM_PROVIDER = 'livetest'
const CUSTOM_MODEL = 'lt-1'

/**
 * 本地 mock LLM（OpenAI chat-completions 流式最简形态）：只为让 pi 真正跑一个 turn——
 * pi 的 session 文件**延迟写入**（首条 assistant 消息前不存在），而 `model_change` entry
 * 需要一个已落盘的会话文件才能被观察到。全程无外网。
 */
const mockServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += String(c) })
  req.on('end', () => {
    if (!req.url?.includes('/chat/completions')) { res.writeHead(404).end('{}'); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'mock-1', object: 'chat.completion.chunk', created: 0, model: 'lt-1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    res.write(chunk({ role: 'assistant', content: '' }))
    res.write(chunk({ content: 'ok' }))
    res.write(chunk({}, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((r) => mockServer.listen(0, '127.0.0.1', r))
const mockPort = mockServer.address().port

const agentDir = mkdtempSync(join(tmpdir(), 'pi-live-e2e-'))
const sessionDir = mkdtempSync(join(tmpdir(), 'pi-live-e2e-sessions-'))
const modelsPath = join(agentDir, 'models.json')
const log = (...a) => console.log('[e2e]', ...a)

const customModelsJson = JSON.stringify({
  providers: {
    [CUSTOM_PROVIDER]: {
      name: 'Live Test Provider',
      api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      models: [{ id: CUSTOM_MODEL, name: 'LT One' }],
    },
  },
}, null, 2)

// 起步凭据：给内置 catalog provider 一个假 key（离线，仅用于让 pi 有 base 可用模型）。
// 真实 taiji 场景里这等价于「用户此前已配置过一家 provider」。
writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({
  deepseek: { type: 'api_key', key: 'sk-fake-base' },
}, null, 2))

const child = spawn(PI_BIN, [
  '-ne', '--mode', 'rpc',
  '--session-dir', sessionDir,
  '--approve',
  '--extension', EXT,
], {
  cwd: ROOT,
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stderrBuf = ''
child.stderr.on('data', (d) => { stderrBuf += String(d) })

const pending = new Map()
let seq = 0
let outBuf = ''
child.stdout.on('data', (d) => {
  outBuf += String(d)
  let idx
  while ((idx = outBuf.indexOf('\n')) >= 0) {
    const line = outBuf.slice(0, idx); outBuf = outBuf.slice(idx + 1)
    const t = line.trim(); if (!t) continue
    let msg
    try { msg = JSON.parse(t) } catch { continue }
    if (msg.type === 'response' && msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg); pending.delete(msg.id)
    }
  }
})

function rpcRaw(command, timeoutMs = 20000) {
  const id = `c${++seq}`
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => { pending.delete(id); rejectP(new Error(`timeout: ${command.type}`)) }, timeoutMs)
    pending.set(id, (msg) => { clearTimeout(timer); resolveP(msg) })
    // wire 形态 = {id, type, ...params}（与 runtime rpc-client 的 sendCommand 同款：`{id, type, ...params}`）
    child.stdin.write(JSON.stringify({ id, ...command }) + '\n')
  })
}

const rpc = (type, params = {}, timeoutMs = 20000) => rpcRaw({ type, ...params }, timeoutMs)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` :: ${detail}` : ''}`)
}

try {
  // 就绪：等 stderr 出现扩展加载 / 或直接发 get_state 探活
  let ready = false
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    try {
      const r = await rpc('get_state', {}, 3000)
      if (r && r.success !== false) { ready = true; break }
    } catch { /* 未就绪 */ }
  }
  check('pi 进程就绪（get_state 可响应）', ready, ready ? '' : stderrBuf.slice(-300))
  if (!ready) throw new Error('pi not ready')

  check('前置：agent dir 无 models.json（catalog-only 形态）', !existsSync(modelsPath), agentDir)

  // ① 基线：新 provider 的模型此时不可切（快照冻结的证据）
  const before = await rpc('set_model', { provider: CUSTOM_PROVIDER, modelId: CUSTOM_MODEL })
  const beforeFailed = before.success === false && String(before.error ?? '').includes('Model not found')
  check('基线：运行中新增前 set_model 失败（Model not found）', beforeFailed, String(before.error ?? JSON.stringify(before)).slice(0, 120))

  // 关键时序：扩展**首拍只建基线**（不 refresh——pi 在 spawn 期已按磁盘状态建过快照）。
  // 因此必须在「首拍之后」再写盘，否则改写会被并进基线、内容判定为「无变化」。
  await sleep(3000)

  // ② 运行中写盘新增 provider/模型定义 + 凭据（taiji 的真实双写：models.json 定义 + auth.json 凭据）
  writeFileSync(modelsPath, customModelsJson)
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({
    deepseek: { type: 'api_key', key: 'sk-fake-base' },
    [CUSTOM_PROVIDER]: { type: 'api_key', key: 'sk-fake-live-test' },
  }, null, 2))
  log('已写入 models.json（provider livetest + 模型 lt-1）与 auth.json（api_key）')

  // ③ 等扩展轮询命中（2s 周期 → 余量 4.5s）
  await sleep(4500)

  // ④ 再切：应成功且 pi 侧真生效
  const after = await rpc('set_model', { provider: CUSTOM_PROVIDER, modelId: CUSTOM_MODEL })
  check('修复后：运行中新增 provider 的模型可直接切换', after.success !== false, String(after.error ?? '').slice(0, 160))
  const state = await rpc('get_state')
  const effective = state?.data?.model ?? state?.model
  check('pi 侧真生效（get_state.model.id = lt-1）', effective?.id === CUSTOM_MODEL, JSON.stringify(effective))

  // ④a 真实 turn（mock LLM，无外网）：让 pi 落盘会话文件并追加 model_change
  const promptRes = await rpc('prompt', { message: 'hi' }, 30000)
  log('prompt 结果:', promptRes.success !== false ? 'ok' : String(promptRes.error ?? '').slice(0, 120))
  await sleep(1200)

  // ④b 持久层证据：model_change 落 pi session JSONL（successCriteria #3 的「落 JSONL」半边）
  const sessionFiles = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'))
  const jsonlText = sessionFiles.map((f) => readFileSync(join(sessionDir, f), 'utf-8')).join('\n')
  const hasModelChange = jsonlText.includes('"model_change"')
  check('pi 侧落 model_change entry 到 session JSONL', hasModelChange, `files=${sessionFiles.length}`)

  // ⑤ 反向：运行中删除该 provider 定义 → 其模型退出可用集合，同时其它模型不受影响（无塌陷）
  const preDelete = await rpc('get_available_models')
  const otherModel = (preDelete?.data?.models ?? []).find((m) => m.provider !== CUSTOM_PROVIDER)
  // 先切到 base 模型（删掉自定义 provider 后不能停在已消失的模型上）
  if (otherModel) await rpc('set_model', { provider: otherModel.provider, modelId: otherModel.id })
  writeFileSync(modelsPath, JSON.stringify({ providers: {} }, null, 2))
  log('已清空 models.json 的 providers（等价运行中删除该 provider）')
  await sleep(4500)
  const gone = await rpc('set_model', { provider: CUSTOM_PROVIDER, modelId: CUSTOM_MODEL })
  check('运行中删除 provider 后其模型不可切（删除生效）', gone.success === false, String(gone.error ?? '').slice(0, 100))
  if (otherModel) {
    const again = await rpc('set_model', { provider: otherModel.provider, modelId: otherModel.id })
    check('删 provider 后其它模型仍可切（无塌陷）', again.success !== false, `${otherModel.provider}/${otherModel.id}`)
  } else {
    check('删 provider 后其它模型仍可切（无塌陷）', false, '无其它可用模型（前置凭据未生效）')
  }

  // 扩展日志证据：应出现 change detected + refresh（stderr）
  const sawDetect = stderrBuf.includes('config change detected')
  check('扩展日志：检测到变更并刷新（[provider-live-sync] config change detected）', sawDetect, sawDetect ? '' : stderrBuf.slice(-400))
} catch (e) {
  check('执行未抛异常', false, e instanceof Error ? e.message : String(e))
} finally {
  child.kill('SIGTERM')
  mockServer.close()
  await sleep(300)
  rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  const failed = results.filter((r) => !r.ok)
  log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) { log('失败项：', JSON.stringify(failed, null, 1)); process.exitCode = 1 }
}
