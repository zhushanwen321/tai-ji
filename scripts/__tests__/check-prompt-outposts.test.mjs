/**
 * check_prompt_outposts.py 检测核心单测（A2 D-A2-3）：检查自身的判定行为必须
 * 机器锁定——误放行会让「忘挂注入」回到人责（MF-B/MF-C 复发面），误拦会逼人
 * 加豁免瓦解白名单治理。python 脚本无模块导出可 import，经 --root 参数指向
 * tmp fixture 树子进程验证退出码（--root 形态全量扫描 fixture 树、不做 staged
 * 交集；pre-commit 无参调用、CI 用 --all）。
 *
 * 指纹单源：fixture 注入内容从检查本体的 OUTPOST_CALLSITES 常量提取（fs 读取 +
 * 正则解析登记四元组的前三元素），白名单增删 / 指纹改写不再需要同步改本测试
 * ——fixture 永远用现行活指纹，登记漂移在这里结构性不可发生。
 *
 * 运行：npx vitest run scripts/__tests__/check-prompt-outposts.test.mjs（仓库根）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../.githooks/check_prompt_outposts.py')

let fixtureRoot

/** python 双/单引号字符串字面量还原为值（登记指纹现行形态无转义序列，仅还原引号与反斜杠）。 */
function unquote(raw) {
  return raw.slice(1, -1).replace(/\\(["'\\])/g, '$1')
}

/** 从检查本体源码提取 OUTPOST_CALLSITES：每条登记四元组取 (suffix, snippet, injection)，reason 不参与判定。 */
function extractOutpostCallsites() {
  const src = readFileSync(SCRIPT, 'utf-8')
  const block = src.match(/OUTPOST_CALLSITES\s*=\s*\[([\s\S]*?)\n\]/)
  if (!block) throw new Error('未找到 OUTPOST_CALLSITES 常量块——检查本体结构变更，需同步本文件提取正则')
  const STR = `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`
  const entryRe = new RegExp(`\\(\\s*${STR}\\s*,\\s*${STR}\\s*,\\s*("(?:injected|exempt)")`, 'g')
  const entries = []
  for (const m of block[1].matchAll(entryRe)) {
    entries.push([unquote(m[1]), unquote(m[2]), unquote(m[3])])
  }
  if (entries.length === 0) throw new Error('OUTPOST_CALLSITES 提取为空——登记条目格式变更，需同步本文件提取正则')
  return entries
}

const OUTPOST_CALLSITES = extractOutpostCallsites()

const CALL_LINE_RE = /\.\s*(?:prompt|steer|followUp)\s*\(/

/** 由指纹生成调用行：行内须同时命中 CALL_RE 且包含指纹子串。命令类指纹自身不含
 *  方法调用（真实宿主形态是包在模板字符串里调用），包进 `client.prompt(\`…\`)`。 */
function whitelistedLine(snippet) {
  return CALL_LINE_RE.test(snippet) ? snippet : `client.prompt(\`${snippet}\`)`
}

/** 在 fixture 树写一个 ts 文件（路径相对 packages/runtime/src）。 */
function writeSrc(relPath, lines) {
  const abs = join(fixtureRoot, 'packages/runtime/src', relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, `${lines.join('\n')}\n`)
}

/** 跑检查（--root fixture），返回 { status, stdout }。非零退出不抛（断言用）。 */
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
  it('白名单登记形态：全部现行条目按真实指纹放行 → exit 0（指纹取自检查本体，登记漂移结构性不可发生）', () => {
    const byFile = new Map()
    for (const [suffix, snippet] of OUTPOST_CALLSITES) {
      const lines = byFile.get(suffix) ?? []
      lines.push(whitelistedLine(snippet))
      byFile.set(suffix, lines)
    }
    for (const [suffix, lines] of byFile) writeSrc(suffix, lines)

    const injected = OUTPOST_CALLSITES.filter((e) => e[2] === 'injected').length
    const r = runGuard()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('未登记违规 0')
    expect(r.stdout).toContain(`白名单登记 ${OUTPOST_CALLSITES.length} 条`)
    expect(r.stdout).toContain(`已注入 ${injected} / 内部豁免 ${OUTPOST_CALLSITES.length - injected}`)
    expect(r.stdout).toContain(`命中放行 ${OUTPOST_CALLSITES.length} 处`)
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
