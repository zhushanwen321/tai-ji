/**
 * check-test-blind-wait.mjs 单测（盲等形态拦截防再发）。
 *
 * 背景：「sleep 固定毫秒后断言异步效果」在 CPU 忙时偶发假红（v0.11.9 ui 包
 * CPU 并发偶发失败的根因形态），检查对 staged 测试文件拦截该形态。本文件验证
 * 判定形态、豁免表、useFakeTimers 跳过与退出码契约——检查脚本自身静默放行 =
 * 防再发失效，故与被检对象同等对待进 CI。
 *
 * 端到端组在临时目录（mkdtemp 自建自删）跑真实脚本进程。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(fileURLToPath(new URL('.', import.meta.url)), '../../.githooks/check-test-blind-wait.mjs')

let tmpDirs = []
function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'blind-wait-check-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  tmpDirs = []
})

/** 在 tmp 下写测试文件并以绝对路径跑检查脚本，返回 { status, output } */
function runCheck(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
  const r = spawnSync('node', [SCRIPT, ...Object.keys(files).map((n) => join(dir, n))], {
    encoding: 'utf8',
  })
  return { status: r.status, output: `${r.stdout}${r.stderr}` }
}

describe('check-test-blind-wait 判定形态', () => {
  it('resolve 形态盲等（await new Promise((r) => setTimeout(r, N>=50))）命中并 exit 1', () => {
    const dir = makeTmp()
    const r = runCheck(dir, {
      'a.test.ts': `it('x', async () => {\n  await new Promise((r) => setTimeout(r, 260))\n  expect(x).toBe(1)\n})\n`,
    })
    expect(r.status).toBe(1)
    expect(r.output).toContain('a.test.ts:2')
    expect(r.output).toContain('260ms')
    expect(r.output).toContain('vi.waitFor')
  })

  it('sleep helper 调用形态（sleep/delay/waitForMs N>=50）命中', () => {
    const dir = makeTmp()
    const r = runCheck(dir, {
      'a.test.ts': `it('x', async () => {\n  await sleep(300)\n  expect(x).toBe(1)\n})\n`,
    })
    expect(r.status).toBe(1)
    expect(r.output).toContain('a.test.ts:2')
  })

  it('N < 50（宏任务让步 / 分片采样）不命中', () => {
    const dir = makeTmp()
    const r = runCheck(dir, {
      'a.test.ts': `await new Promise((r) => setTimeout(r, 0))\nawait sleep(10)\nawait new Promise((r) => setTimeout(r, 49))\n`,
    })
    expect(r.status).toBe(0)
    expect(r.output).toContain('通过')
  })

  it('文件含 useFakeTimers → 整文件跳过（假时钟内 timer 是确定性推进）', () => {
    const dir = makeTmp()
    const r = runCheck(dir, {
      'a.test.ts': `vi.useFakeTimers()\nit('x', async () => {\n  await new Promise((r) => setTimeout(r, 300))\n})\n`,
    })
    expect(r.status).toBe(0)
  })

  it('豁免表登记的文件跳过（BLIND_WAIT_EXEMPT 唯一登记处）', () => {
    // 从脚本源码提取豁免表首条 key（表内容变化时测试仍成立），按该相对路径
    // 结构在 tmp 下摆放同路径文件，cwd=tmp 跑脚本——查表命中则豁免 exit 0
    const tableSrc = readFileSync(SCRIPT, 'utf8').match(/const BLIND_WAIT_EXEMPT = \{([\s\S]*?)\n\}/)[1]
    const firstKey = tableSrc.split("'").filter((_, i) => i % 2 === 1)[0]
    expect(firstKey).toBeTruthy()
    const dir = makeTmp()
    const target = join(dir, firstKey)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, `await sleep(300)\n`)
    const r = spawnSync('node', [SCRIPT, firstKey], { cwd: dir, encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(`${r.stdout}${r.stderr}`).not.toContain('盲等')
  })

  it('非测试文件名不入检查范围', () => {
    const dir = makeTmp()
    const src = join(dir, 'helper.ts')
    writeFileSync(src, `await sleep(300)\n`)
    const r = spawnSync('node', [SCRIPT, src], { encoding: 'utf8' })
    expect(r.status).toBe(0)
  })

  it('仓根 e2e/ 前缀（Playwright 真实进程层域）跳过', () => {
    const dir = makeTmp()
    const target = join(dir, 'e2e/real-flow.spec.ts')
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, `await new Promise((r) => setTimeout(r, 1000))\n`)
    const r = spawnSync('node', [SCRIPT, 'e2e/real-flow.spec.ts'], { cwd: dir, encoding: 'utf8' })
    expect(r.status).toBe(0)
  })

  it('行内 // 注释里的形态文字不误报', () => {
    const dir = makeTmp()
    const r = runCheck(dir, {
      'a.test.ts': `// 负向断言无完成信号可等——分片采样替换单点 sleep(300)：\nit('x', async () => {\n  await sleep(30) // sleep(300) 出现在注释里不算，代码本体 30ms 低于阈值\n})\n`,
    })
    // 第一行是纯注释行（整行剥除不命中）；第三行 // 前的 sleep(30) < 50ms 不命中，
    // 注释里的 sleep(300) 被剥除
    expect(r.status).toBe(0)
  })

  it('staged 列表含已删除文件（磁盘竞态）不崩、跳过继续', () => {
    const dir = makeTmp()
    const ghost = join(dir, 'deleted.test.ts')
    const r = spawnSync('node', [SCRIPT, ghost], { encoding: 'utf8' })
    expect(r.status).toBe(0)
  })
})
