/**
 * RT-8#1 CLI 不判 error 回包修复验证（code-harden 审计批次 2，验收①）：
 * ws-client `msg.id===id` 即 resolve(payload)，而 broker sendError 的 error envelope
 * 复用同 id（payload 只有 code/message）→ set-provider / delete-provider 失败仍打印
 * configured/deleted 且 exit 0，读命令显示空列表。修复 = 按 msg.type==='error' reject，
 * 经 index.ts 统一落 stderr + exit 1。
 *
 * 集成形态：真实 ws WebSocketServer 模拟 runtime 信令面（auth.result → error/success
 * envelope，wire 形状对齐 message-broker.sendError + server.ts 全局 catch），spawn 真实
 * CLI 子进程（tsx 直跑 src/cli/index.ts），断言退出码 / stdout / stderr 三面。
 *
 * 运行：cd packages/runtime && npx vitest run test/cli-error-envelope.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY = resolve(__dirname, '../src/cli/index.ts')

/** 服务端对业务命令的回包模式（测试按用例切换） */
type ServerMode =
  | { kind: 'error'; code: string; message: string }
  | { kind: 'success' }

let server: WebSocketServer | null = null
let dataDir = ''
/** 当前回包模式；auth.result 不受其影响（恒 ok） */
let mode: ServerMode = { kind: 'error', code: 'handler_error', message: 'boom' }

/** spawn 真实 CLI 子进程，收集退出码与 stdout/stderr */
function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TAIJI_AGENT_DATA_DIR: dataDir },
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', rejectP)
    child.on('close', (code) => { resolveP({ code, stdout, stderr }) })
  })
}

beforeAll(async () => {
  // 临时数据目录：runtime.port + runtime-token（CLI 的端口/token 发现通道）
  dataDir = mkdtempSync(join(tmpdir(), 'taiji-cli-integration.'))
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  // port 0 = 随机端口，须等 listening 后才能取真实端口
  await new Promise<void>((resolveListening) => { server?.once('listening', resolveListening) })
  const port = (server.address() as { port: number }).port
  writeFileSync(join(dataDir, 'runtime.port'), String(port), 'utf-8')
  writeFileSync(join(dataDir, 'runtime-token'), 'integration-test-token', 'utf-8')

  server.on('connection', (ws: WebSocket) => {
    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as { type: string; id?: string }
      if (msg.type === 'auth') {
        ws.send(JSON.stringify({ type: 'auth.result', payload: { ok: true } }))
        return
      }
      // 业务命令回包：error envelope 复用请求 id（对齐 message-broker.sendError 的
      // wire 形状 { type:'error', id, payload:{ code, message } }）
      if (mode.kind === 'error') {
        ws.send(JSON.stringify({ type: 'error', id: msg.id, payload: { code: mode.code, message: mode.message } }))
      } else {
        ws.send(JSON.stringify({ type: 'config.providerUpdated', id: msg.id, payload: {} }))
      }
    })
  })
})

afterAll(() => {
  server?.close()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// 子进程 spawn + tsx 注册链，CI 满并行下冷启可达数秒（对齐 plugin-sandbox fork 用例的
// 显式超时登记口径）；本地实测 <1s/条
const TEST_TIMEOUT_MS = 20_000

describe('RT-8#1: CLI error envelope → 非 0 退出（写命令）', () => {
  it('delete-provider 对不存在的 provider（runtime 回 PROVIDER_NOT_FOUND）→ exit ≠ 0，stdout 无 "deleted"，stderr 含 code/消息/恢复动作', async () => {
    mode = { kind: 'error', code: 'PROVIDER_NOT_FOUND', message: 'Provider "ghost" not found' }
    const result = await runCli(['delete-provider', '--name', 'ghost'])
    expect(result.code).not.toBe(0)
    expect(result.code).not.toBe(null)
    expect(result.stdout).not.toContain('deleted')
    expect(result.stderr).toContain('PROVIDER_NOT_FOUND')
    expect(result.stderr).toContain('Provider "ghost" not found')
    expect(result.stderr).toMatch(/retry|logs/)
  }, TEST_TIMEOUT_MS)

  it('set-provider 失败（runtime 回 invalid_provider_type）→ exit ≠ 0，stdout 无 "configured"，stderr 含 code/消息', async () => {
    mode = { kind: 'error', code: 'invalid_provider_type', message: 'Unknown provider type "bogus"' }
    const result = await runCli(['set-provider', '--name', 'my-id', '--provider', 'bogus'])
    expect(result.code).not.toBe(0)
    expect(result.code).not.toBe(null)
    expect(result.stdout).not.toContain('configured')
    expect(result.stderr).toContain('invalid_provider_type')
    expect(result.stderr).toContain('Unknown provider type "bogus"')
  }, TEST_TIMEOUT_MS)

  it('list-providers（读命令）失败 → exit ≠ 0（不得显示空列表假成功）', async () => {
    mode = { kind: 'error', code: 'handler_error', message: 'config store unavailable' }
    const result = await runCli(['list-providers'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('handler_error')
  }, TEST_TIMEOUT_MS)
})

describe('RT-8#1: 成功路径输出不变（回归保护）', () => {
  it('delete-provider 成功回包 → exit 0 + stdout "provider ghost deleted"', async () => {
    mode = { kind: 'success' }
    const result = await runCli(['delete-provider', '--name', 'ghost'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('provider ghost deleted')
  }, TEST_TIMEOUT_MS)
})
