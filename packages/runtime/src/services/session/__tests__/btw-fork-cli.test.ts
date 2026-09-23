/**
 * forkViaCliPi（V2① 双旗标 bootstrap 机制）+ createLine 默认 fork 装配链。
 * 用 fake pi 可执行文件（tmp 内 node 脚本）驱动真实 spawn/轮询/失败路径——
 * 不依赖真实 pi 二进制与凭证；真实 pi 双旗标语义的实测证据见
 * btw-pi-fork-semantics.test.ts（forkFrom 实装直驱）与 V2 探针（实施计划偏差登记）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BtwService, forkViaCliPi } from '../btw-service.js'
import { getBtwThreadDir } from '../../../infra/pi/pi-paths.js'
import {
  cleanupDir, makeHarness, makeTmpDir, useTmpDataDir,
  type BtwHarness,
} from './helpers/btw-harness.js'

const MAIN_SID = 'main-sid-001'
const CWD = '/Users/x/proj'

let restoreDataDir: () => void
let fx: string
let scriptDir: string

beforeEach(() => {
  restoreDataDir = useTmpDataDir()
  fx = makeTmpDir()
  scriptDir = mkdtempSync(join(tmpdir(), 'taiji-btw-fakepi-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  cleanupDir(fx)
  rmSync(scriptDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  restoreDataDir()
  vi.restoreAllMocks()
})

/** 写 fake pi 脚本（node shebang；把 argv 落盘供断言；行为由 mode 决定）。 */
function writeFakePi(name: string, body: string): string {
  const file = join(scriptDir, name)
  writeFileSync(file, `#!/usr/bin/env node\nconst fs = require('node:fs')\nconst args = process.argv.slice(2)\nfs.writeFileSync(${JSON.stringify(join(scriptDir, name + '.argv'))}, JSON.stringify(args))\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

const sleepCode = (ms: number) => `setTimeout(() => {}, ${ms})`

describe('forkViaCliPi：一次性 fork bootstrap 机制', () => {
  it('探测到线目录内新增 .jsonl 即返回（pre-existing 文件不误认）+ argv 双旗标原样传递', async () => {
    const threadDir = join(fx, 'threadA')
    mkdirSync(threadDir, { recursive: true })
    writeFileSync(join(threadDir, 'pre-existing.jsonl'), '{}\n') // 已有文件
    const src = join(fx, 'src.jsonl')
    writeFileSync(src, '{"type":"session"}\n')
    const script = writeFakePi('ok.js', `
      const dir = args[args.indexOf('--session-dir') + 1]
      fs.mkdirSync(dir, { recursive: true })
      setTimeout(() => {
        fs.writeFileSync(dir + '/2026T_fresh.jsonl', '{"type":"session","id":"fresh"}\\n')
      }, 30)
      ${sleepCode(5000)}
    `)

    const got = await forkViaCliPi({ piCommand: script, sourceFile: src, threadDir, cwd: fx, timeoutMs: 5000 })

    expect(got).toBe(join(threadDir, '2026T_fresh.jsonl')) // 新文件，不是 pre-existing
    const argv = JSON.parse(readFileSync(join(scriptDir, 'ok.js.argv'), 'utf8')) as string[]
    expect(argv).toEqual(['--mode', 'rpc', '--fork', src, '--session-dir', threadDir])
  })

  it('bootstrap 异常退出（无文件）→ BtwError fork_failed 携带 stderr（调用方回落分支②）', async () => {
    const script = writeFakePi('fail.js', `process.stderr.write('Cannot fork: source session file is empty or invalid\\n')\nprocess.exit(1)`)

    await expect(
      forkViaCliPi({ piCommand: script, sourceFile: '/nope.jsonl', threadDir: join(fx, 't2'), cwd: fx }),
    ).rejects.toMatchObject({ code: 'fork_failed', message: expect.stringContaining('exited (code 1)') })
    expect(readFileSync(join(scriptDir, 'fail.js.argv'), 'utf8')).toContain('--fork')
  })

  it('piCommand 不存在（spawn ENOENT）→ 快速 BtwError fork_failed（不 uncaught、不空等到超时）', async () => {
    await expect(
      forkViaCliPi({ piCommand: join(fx, 'no-such-pi-binary'), sourceFile: '/x.jsonl', threadDir: join(fx, 't5'), cwd: fx }),
    ).rejects.toMatchObject({ code: 'fork_failed', message: expect.stringContaining('spawn failed') })
  })

  it('超时 → BtwError fork_failed timed out（控制面秒级有界，规则 #19）', async () => {
    const script = writeFakePi('hang.js', sleepCode(30000))

    const t0 = Date.now()
    await expect(
      forkViaCliPi({ piCommand: script, sourceFile: '/any.jsonl', threadDir: join(fx, 't3'), cwd: fx, timeoutMs: 400 }),
    ).rejects.toMatchObject({ code: 'fork_failed', message: expect.stringContaining('timed out after 400ms') })
    expect(Date.now() - t0).toBeLessThan(5000)
  })
})

describe('createLine 默认 fork 装配链（resolvePiCommand → forkViaCliPi → 附着）', () => {
  it('deps 未注入 forkSession 时走 CLI bootstrap 全链', async () => {
    const h: BtwHarness = makeHarness()
    const svc = new BtwService(h.deps)
    try {
      // forkViaCliPi 的 spawn cwd = 线 cwd——必须是真实存在的目录（不存在 → spawn ENOENT）
      const cwd = join(fx, 'proj')
      mkdirSync(cwd, { recursive: true })
      const src = join(fx, 'src.jsonl')
      writeFileSync(src, '{"type":"session","id":"main"}\n{"type":"message","id":"e1"}\n')
      h.deps.resolveMainSessionFile = vi.fn(() => src)
      const threadDir = getBtwThreadDir(cwd, MAIN_SID)
      const forkFile = join(threadDir, '2026T_cli.jsonl')
      // fake pi：双旗标启动后往线目录写带 header 的 fork 文件（id=cli），随后保活待收
      const chainBody = `
        const dir = args[args.indexOf('--session-dir') + 1]
        fs.mkdirSync(dir, { recursive: true })
        setTimeout(() => {
          fs.writeFileSync(dir + '/2026T_cli.jsonl', JSON.stringify({type:'session',id:'cli',cwd:${JSON.stringify(cwd)}}) + '\\n')
        }, 20)
        ${sleepCode(5000)}
      `
      h.deps.resolvePiCommand = () => writeFakePi('chain.js', chainBody)
      // get_state 读回须与 fork header id 一致（附着一致性守卫）
      h.state = { sessionId: 'cli', sessionFile: forkFile }
      h.deps.forkSession = undefined // 强制走默认 CLI 链

      const res = await svc.createLine({ mainSid: MAIN_SID, cwd })

      expect(res).toMatchObject({ vid: 'btw:cli', snapshotKind: 'forked', sessionFilePath: forkFile })
      expect(existsSync(forkFile)).toBe(true)
      expect(h.spawned[0].client.switchSession).toHaveBeenCalledWith(forkFile)
      expect(h.registered[0]).toMatchObject({ id: 'btw:cli', hidden: true })
      // argv 双旗标原样传递（V2① 同款组合）
      const argv = JSON.parse(readFileSync(join(scriptDir, 'chain.js.argv'), 'utf8')) as string[]
      expect(argv).toEqual(['--mode', 'rpc', '--fork', src, '--session-dir', threadDir])
    } finally {
      svc.dispose()
    }
  })
})
