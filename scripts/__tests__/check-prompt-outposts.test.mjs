/**
 * check_prompt_outposts.py 检测核心单测（A2 D-A2-3）：守卫自身的判定行为必须
 * 机器锁定——误放行会让「忘挂注入」回到人责（MF-B/MF-C 复发面），误拦会逼人
 * 加豁免瓦解白名单治理。python 脚本无模块导出可 import，经 --root 参数指向
 * tmp fixture 树子进程验证退出码（无参默认仓库根，pre-commit/CI 均无参调用）。
 *
 * 运行：npx vitest run scripts/__tests__/check-prompt-outposts.test.mjs（仓库根）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../.githooks/check_prompt_outposts.py')

let fixtureRoot

/** 在 fixture 树写一个 ts 文件（路径相对 packages/runtime/src）。 */
function writeSrc(relPath, lines) {
  const abs = join(fixtureRoot, 'packages/runtime/src', relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, `${lines.join('\n')}\n`)
}

/** 跑守卫（--root fixture），返回 { status, stdout }。非零退出不抛（断言用）。 */
function runGuard() {
  try {
    const stdout = execFileSync('python3', [SCRIPT, '--root', fixtureRoot], { encoding: 'utf-8' })
    return { status: 0, stdout }
  } catch (e) {
    return { status: e.status, stdout: String(e.stdout ?? '') }
  }
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'prompt-outposts-test-'))
})

afterEach(() => {
  // maxRetries：teardown 递归删除与在途写竞争（满载 ENOTEMPTY flake，教训 d9ad39cb8）
  rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('check_prompt_outposts.py 判定行为', () => {
  it('白名单登记形态：已注入 / 内部命令豁免全放行 → exit 0', () => {
    writeSrc('services/session/message-dispatcher.ts', [
      "import { x } from 'y'",
      'async function f(client) {',
      '  const injection = await injector.inject(client, promptText)',
      '  await client.prompt(injection.text, images)',
      '  await client.steer(injection.text)',
      '  await client.followUp(injection.text)',
      '}',
    ])
    writeSrc('services/session/session-service.ts', [
      'async function reload(client) {',
      "  await client.prompt('/__taiji_reload__', undefined, undefined, { maintenance: true })",
      '}',
    ])
    const r = runGuard()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('未登记违规 0')
    expect(r.stdout).toContain('命中放行 4 处')
  })

  it('未登记的 client.prompt( 调用点 → exit 2 且报出文件与行', () => {
    writeSrc('services/session/new-outpost.ts', [
      'async function send(client, text) {',
      '  await client.prompt(text)',
      '}',
    ])
    const r = runGuard()
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('services/session/new-outpost.ts:2')
    expect(r.stdout).toContain('.prompt(')
  })

  it('任意接收者命中（srcClient.prompt(）——设计期 grep 用 client. 字面量漏出的形态必拦', () => {
    writeSrc('services/handoff-service.ts', [
      'async function h(srcClient) {',
      '  await srcClient.prompt(someUndocumentedVar)',
      '}',
    ])
    const r = runGuard()
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('services/handoff-service.ts:2')
  })

  it('steer / followUp 未登记同样拦截（三方法族全扫）', () => {
    writeSrc('services/session/a.ts', ['async function a(client) {', '  await client.steer(text)', '}'])
    writeSrc('services/session/b.ts', ['async function b(client) {', '  await client.followUp(text)', '}'])
    const r = runGuard()
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('.steer(')
    expect(r.stdout).toContain('.followUp(')
  })

  it('注释行不命中（行首 // 、* 、/* 剥离）；裸函数调用 prompt( 前无点号不命中', () => {
    writeSrc('services/session/comments-only.ts', [
      '// await client.prompt(text)',
      ' * await client.prompt(text)',
      '/* await client.prompt(text)',
      'async function prompt(text) { return text }',
      'const x = prompt(text)',
    ])
    const r = runGuard()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('未登记违规 0')
  })

  it('测试文件排除（.test.ts / __tests__/ 目录不扫）', () => {
    writeSrc('services/session/__tests__/x.test.ts', [
      'const client = { prompt: vi.fn() }',
      "await client.prompt('t')",
    ])
    const r = runGuard()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('未登记违规 0')
  })

  it('扫描根缺失 → exit 1（脚本自身异常通道，不静默放行）', () => {
    try {
      execFileSync('python3', [SCRIPT, '--root', join(fixtureRoot, 'no-such-dir')], { encoding: 'utf-8' })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e.status).toBe(1)
    }
  })
})
