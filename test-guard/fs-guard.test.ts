/**
 * fs-guard 防线自测（2026-09-02 会话丢失事故）。
 *
 * 三视角：
 * - 构建者白盒：isRealDataDir / isDestructiveAllowed 判定边界（等值 / 前缀 / 前缀撞名
 *   如 ~/.taiji-other 不得误拒）
 * - 使用者黑盒：端到端——本文件运行于已挂 fs-guard 的 worker，直接调 node:fs 的
 *   rmSync/writeFileSync 验证拦截真实生效（白名单内放行、真实目录抛错）
 * - 观察者形态：拦截错误信息必须可操作（含白名单与恢复指引）
 *
 * 写句柄入口（fd/流写路径防线）：openSync 写 flags / callback open / createWriteStream /
 * promises.open 的写 flags 校验 path——写 fd 只能经此产生，闭合 writeSync/ftruncate 等
 * fd 消费点（详见 test/fs-guard.ts「边界」注释）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdtempSync,
  openSync,
  promises as fsPromises,
  rm as fsRm,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import * as fsAll from 'node:fs'
import { open as fspOpen, rm as fspRm } from 'node:fs/promises'
import * as fspAll from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FS_ASYNC_FNS,
  FS_OPEN_FNS,
  FS_PROMISES_OPEN_FNS,
  FS_SYNC_FNS,
  isDestructiveAllowed,
  isRealDataDir,
  wrapOpenFns,
} from './fs-guard-impl.js'
import { setup } from './global-setup.js'

describe('fs-guard 判定（纯函数）', () => {
  it('真实数据目录等值与其内任意深度路径一律拒绝', () => {
    expect(isRealDataDir(join(homedir(), '.taiji'))).toBe(true)
    expect(isRealDataDir(join(homedir(), '.taiji', 'agent', 'sessions'))).toBe(true)
    expect(isDestructiveAllowed(join(homedir(), '.taiji', 'agent', 'sessions', 'x.jsonl'))).toBe(false)
  })

  it('白名单成员（tmpdir / dev 数据目录）及其内路径放行', () => {
    expect(isDestructiveAllowed(tmpdir())).toBe(true)
    expect(isDestructiveAllowed(join(tmpdir(), 'some-fixture-abc', 'a.jsonl'))).toBe(true)
    expect(isDestructiveAllowed(join(homedir(), '.taiji-dev'))).toBe(true)
    expect(isDestructiveAllowed(join(homedir(), '.taiji-dev', 'agent', 'sessions', 'x.jsonl'))).toBe(true)
  })

  it('tmp 的 realpath 形式放行（macOS /var → /private/var symlink，fixture 路径经 realpathSync 后形态）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-guard-realpath-'))
    const realPath = realpathSync(dir)
    expect(isDestructiveAllowed(realPath)).toBe(true)
    expect(isDestructiveAllowed(join(realPath, 'nested', 'a.jsonl'))).toBe(true)
    rmSync(dir, { recursive: true, maxRetries: 5, retryDelay: 20 })
  })

  it('其余目录一律拒绝（工作区 / 家目录普通文件 / 前缀撞名）', () => {
    expect(isDestructiveAllowed(join(homedir(), 'Code', 'proj', 'f.txt'))).toBe(false)
    expect(isDestructiveAllowed(join(homedir(), 'notes.txt'))).toBe(false)
    // 前缀撞名：.taiji-other 不是 .taiji 的子路径，不受真实目录无条件拒绝影响，
    // 但也不在白名单内 → 仍拒绝（结果一致，路径归因不同——保证判定语义清晰）。
    expect(isDestructiveAllowed(join(homedir(), '.taiji-other', 'f.txt'))).toBe(false)
  })
})

/** 随机后缀假路径（家目录下不存在；零旧字面量，随机避免跨 run 撞名）。 */
function fakeHomePath(): string {
  return resolve(join(homedir(), `.some-fake-dir-${Math.random().toString(36).slice(2)}`))
}

/** 设临时注入值跑 fn，finally 恢复原 env（不外泄到同 worker 其他用例）。 */
function withInjectedEnv(value: string, fn: () => void): void {
  const prev = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = value
  try {
    fn()
  } finally {
    if (prev === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = prev
  }
}

describe('注入 env 合法性过滤（taiji-full-rename R3：白名单排除式）', () => {
  it('注入指向家目录下非白名单假路径：注入值不进白名单，端到端破坏性操作被拒', () => {
    const fake = fakeHomePath()
    withInjectedEnv(fake, () => {
      // 告警是 impl 模块级一次性 flag，errSpy 必须先于首个触发判定的调用挂上
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        // 纯函数视角：假路径及其子路径不因 env 注入获得放行
        expect(isDestructiveAllowed(fake)).toBe(false)
        expect(isDestructiveAllowed(join(fake, 'agent', 'sessions', 'x.jsonl'))).toBe(false)
        // 非法注入在 guard 层一次性 console.error 说明（防线语义由白名单达成）
        expect(errSpy).toHaveBeenCalled()
        // 切面视角：本文件 import 的 fs 已是 wrapper，whitelistPrefixes 动态读 env
        expect(() => rmSync(join(fake, 'sessions'), { recursive: true, maxRetries: 5, retryDelay: 20 })).toThrow(/vitest-fs-guard/)
      } finally {
        errSpy.mockRestore()
      }
    })
  })

  it('合法注入（tmp 之下）仍进白名单（防过拦回归）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-guard-inject-ok-'))
    withInjectedEnv(dir, () => {
      expect(isDestructiveAllowed(join(dir, 'x.jsonl'))).toBe(true)
    })
    rmSync(dir, { recursive: true, maxRetries: 5, retryDelay: 20 })
  })
})

describe('global-setup fail-fast（第一层防线，白名单形态）', () => {
  it('注入指向家目录下非白名单假路径：拒跑退出码 1，错误含恢复动作', () => {
    const fake = fakeHomePath()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    withInjectedEnv(fake, () => {
      try {
        setup()
        expect(exitSpy).toHaveBeenCalledWith(1)
        expect(errSpy.mock.calls.some((args) => args.join('').includes('unset TAIJI_AGENT_DATA_DIR'))).toBe(true)
      } finally {
        exitSpy.mockRestore()
        errSpy.mockRestore()
      }
    })
  })
})

describe('fs-guard 切面端到端（本文件 import 的 fs 已是 wrapper）', () => {
  it('白名单内写 / 删正常执行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-guard-e2e-'))
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'x')
    rmSync(file)
    rmSync(dir, { recursive: true, maxRetries: 5, retryDelay: 20 })
  })

  it('真实目录的删除被拦截且错误信息可操作', () => {
    expect(() => rmSync(join(homedir(), '.taiji'), { recursive: true, maxRetries: 5, retryDelay: 20 })).toThrow(/vitest-fs-guard/)
    let caught: Error | undefined
    try {
      writeFileSync(join(homedir(), '.taiji', 'agent', 'sessions', 'probe.txt'), 'x')
      expect.unreachable('expected fs-guard to block write into real data dir')
    } catch (e) {
      caught = e as Error
    }
    // 观察者视角：错误必须指向恢复动作（全局规则：错误信息可操作）
    expect(caught.message).toContain('~/.taiji-dev')
    expect(caught.message).toContain('mkdtempSync')
  })
})

describe('fs-guard 写句柄入口（fd/流写路径防线）', () => {
  it('白名单内 openSync 写文件成功，fd 写入生效（tmp fixture 标准形态不误伤）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-guard-fdwrite-'))
    const file = join(dir, 'w.txt')
    const fd = openSync(file, 'w')
    writeSync(fd, 'x')
    closeSync(fd)
    expect(readFileSync(file, 'utf8')).toBe('x')
    rmSync(dir, { recursive: true, maxRetries: 5, retryDelay: 20 })
  })

  it('真实数据目录 openSync("w") 被拦（绕道 fd 写不可达）', () => {
    expect(() =>
      openSync(join(homedir(), '.taiji', 'agent', 'sessions', 'probe-fd.txt'), 'w'),
    ).toThrow(/vitest-fs-guard/)
  })

  it('真实数据目录 createWriteStream 被拦（打开发生在流构造时，wrapper 先校验）', () => {
    expect(() =>
      createWriteStream(join(homedir(), '.taiji', 'agent', 'sessions', 'probe-stream.txt')),
    ).toThrow(/vitest-fs-guard/)
  })

  it('fs/promises open 写真实数据目录被拦（FileHandle 写句柄唯一入口）', () => {
    expect(() =>
      fspOpen(join(homedir(), '.taiji', 'agent', 'sessions', 'probe-fh.txt'), 'w'),
    ).toThrow(/vitest-fs-guard/)
  })

  it('只读 openSync("r") 对任意路径不拦（读不在防护范围，含本仓库文件）', () => {
    const repoPkg = fileURLToPath(new URL('../package.json', import.meta.url))
    const fd = openSync(repoPkg, 'r')
    closeSync(fd)
  })
})

/** 白名单外探针路径（不存在；guardPaths 纯字符串判定，测试全程零 fs 写删）。 */
const PROBE = join(homedir(), '__fs_guard_probe_nonexistent__', 'f.txt')

type OpenEntryName = 'openSync' | 'open' | 'createWriteStream'

/** 构造 wrap 后的入口：orig 是 spy——透传时被调；拦截时 guard 先抛、orig 不触达。 */
function makeEntry(name: OpenEntryName) {
  const orig = vi.fn(() => 'fd')
  const wrapped = wrapOpenFns({}, { [name]: orig }, [name])
  const call = (...args: unknown[]): unknown => (wrapped[name] as (...a: unknown[]) => unknown)(...args)
  return {
    /** 期望判定为写：调用抛 BLOCKED 且 orig 未触达（拦截发生在原函数之前）。 */
    expectBlocked: (...args: unknown[]) => {
      expect(() => call(...args)).toThrow(/\[vitest-fs-guard\] BLOCKED/)
      expect(orig).not.toHaveBeenCalled()
    },
    /** 期望判定为读：不抛且 orig 透传被调。 */
    expectPassed: (...args: unknown[]) => {
      expect(() => call(...args)).not.toThrow()
      expect(orig).toHaveBeenCalledTimes(1)
      orig.mockClear()
    },
  }
}

describe('isWriteOpenArg string flags（经 wrapOpenFns 行为投影）', () => {
  it("'w' → 拦；'r+' → 拦（含 + 即写）", () => {
    const { expectBlocked } = makeEntry('openSync')
    expectBlocked(PROBE, 'w')
    expectBlocked(PROBE, 'r+')
  })

  it("'r' / 'rs' → 放行（'rs' 是 Node 只读 flags，不因多字母误判写）；对照 'rs+' → 拦", () => {
    const { expectPassed, expectBlocked } = makeEntry('openSync')
    expectPassed(PROBE, 'r')
    expectPassed(PROBE, 'rs')
    expectBlocked(PROBE, 'rs+')
  })

  it('number flags：O_WRONLY(1) / O_RDWR(2) → 拦；O_RDONLY(0) / 仅 O_CREAT(0o100) → 放行（O_ACCMODE 位判定）', () => {
    const { expectPassed, expectBlocked } = makeEntry('openSync')
    expectBlocked(PROBE, 1)
    expectBlocked(PROBE, 2)
    expectPassed(PROBE, 0)
    expectPassed(PROBE, 0o100)
  })
})

describe('isWriteOpenArg object 形态与缺省 flags', () => {
  it("{flags:'w'} → 拦；{flags:'r'} → 放行；{flags:2}（number 形态）→ 拦", () => {
    const { expectPassed, expectBlocked } = makeEntry('openSync')
    expectBlocked(PROBE, { flags: 'w' })
    expectPassed(PROBE, { flags: 'r' })
    expectBlocked(PROBE, { flags: 2 })
  })

  it("object 缺 flags / flags 非法类型 → 落缺省 flags（openSync 缺省 'r' 放行，脏 options 不崩溃）", () => {
    const { expectPassed } = makeEntry('openSync')
    expectPassed(PROBE, {})
    expectPassed(PROBE, { flags: true as unknown as string })
    expectPassed(PROBE)
  })

  it("createWriteStream 缺省 flags 'w' → 无第二参 / options 不带 flags 均必拦（写流入口默认写判定）", () => {
    const { expectBlocked } = makeEntry('createWriteStream')
    expectBlocked(PROBE)
    expectBlocked(PROBE, { encoding: 'utf8' })
  })

  it("callback open：缺省 / 'r' 放行、'a' 拦截（三入口逐个覆盖同名判定）", () => {
    const { expectPassed, expectBlocked } = makeEntry('open')
    expectPassed(PROBE)
    expectPassed(PROBE, 'r')
    expectBlocked(PROBE, 'a')
  })
})

/**
 * G1 防线自检（fs-guard 自己的守卫）：
 * - 名单完备性：wrap 名单 × 真实模块键集的确定性差集断言，名单单源化后防「Node 升级
 *   移除 API 后名单残留死名」「名单漏挂/工厂装配回归」「sync/async 名单单侧分叉」
 *   （2026-09-17 拦截面缺口即后两者叠加形态：FS_ASYNC_FNS 挂了 promises 工厂、
 *   node:fs 工厂漏挂 callback 版 + promises 访问器透传）。
 * - 四访问面探针：sync / callback / promises 直引 / fs.promises 访问器，四个到达真实
 *   fs 层的访问面逐一端到端验证拦截生效——单测断言「wrapper 函数 !== 原函数」只能证明
 *   装配差异存在，四探针证明的才是「破坏调用确实被 BLOCKED」这一防线本体语义。
 */

/** 白名单外且必然不存在的诱饵路径（安全红线：测试不得创建它；无 force/recursive）。 */
function probeBaitPath(): string {
  return resolve(homedir(), '.taiji-fs-guard-probe', randomUUID())
}

describe('G1 防线自检——名单完备性（名单 × 真实模块键集差集）', () => {
  it('node:fs：wrap 名单内每个名字真实存在且均已被 wrapper 替换，promises 访问器已装配', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('node:fs')
    const actualPromises = await vi.importActual<Record<string, unknown>>('node:fs/promises')
    const names = [...FS_SYNC_FNS, ...FS_ASYNC_FNS, ...FS_OPEN_FNS]
    // Node 升级移除 API 后名单漏清理 → 红（死名静默留在名单里会掩盖漏挂的装配断言）
    const deadNames = names.filter((n) => !(n in actual))
    expect(deadNames, `名单含真实模块已不存在的名字，须清理名单: ${deadNames.join(', ')}`).toEqual([])
    // 名单漏挂 / 工厂装配回归（wrapper 未替换原函数）→ 红
    const notWrapped = names.filter((n) => fsAll[n] === actual[n])
    expect(notWrapped, `node:fs 名单成员未被 wrapper 替换（漏挂或装配回归）: ${notWrapped.join(', ')}`).toEqual([])
    // promises 访问器装配：浅拷贝透传原始 promises 模块正是本次拦截面缺口的形态——
    // 装配成功后 fs.promises 与真实 promises 模块必须是不同对象，且名单函数逐一被替换
    expect(fsAll.promises, 'fs.promises 仍是原始模块透传（访问器面未装配）').not.toBe(actualPromises)
    const accessorNotWrapped = [...FS_ASYNC_FNS].filter(
      (n) => (fsAll.promises as Record<string, unknown>)[n] === actualPromises[n],
    )
    expect(
      accessorNotWrapped,
      `fs.promises 访问器面名单函数未被替换: ${accessorNotWrapped.join(', ')}`,
    ).toEqual([])
  })

  it('node:fs/promises：wrap 名单内每个名字真实存在且均已被 wrapper 替换', async () => {
    const actualPromises = await vi.importActual<Record<string, unknown>>('node:fs/promises')
    const names = [...FS_ASYNC_FNS, ...FS_PROMISES_OPEN_FNS]
    const deadNames = names.filter((n) => !(n in actualPromises))
    expect(deadNames, `名单含真实模块已不存在的名字，须清理名单: ${deadNames.join(', ')}`).toEqual([])
    const notWrapped = names.filter((n) => fspAll[n] === actualPromises[n])
    expect(notWrapped, `node:fs/promises 名单成员未被 wrapper 替换: ${notWrapped.join(', ')}`).toEqual([])
  })

  it('sync/async 名单对偶：破坏性 API 禁止只挂单侧（名单单侧分叉的哨兵）', () => {
    // 2026-09-17 缺口的名单级形态：Sync 侧有 XSync 而 callback 侧漏挂 X（或反之）。
    // 两侧名单必须逐名对偶（open 族单列，不进本断言）。
    const syncStems = FS_SYNC_FNS.map((s) => s.replace(/Sync$/, '')).sort()
    expect(syncStems, 'FS_SYNC_FNS 与 FS_ASYNC_FNS 失去逐名对偶，须两侧行单同步挂载').toEqual(
      [...FS_ASYNC_FNS].sort(),
    )
  })
})

describe('G1 防线自检——四访问面端到端探针（对白名单外不存在诱饵路径的破坏调用必须全被 BLOCKED）', () => {
  it('sync 面：node:fs rmSync 被拦', () => {
    const bait = probeBaitPath()
    expect(existsSync(bait)).toBe(false)
    expect(() => rmSync(bait)).toThrow(/fs-guard|BLOCKED/)
    expect(existsSync(bait)).toBe(false)
  })

  it('callback 面：node:fs rm 被拦（wrapper 同步抛出，回调不得触达真实 fs）', () => {
    const bait = probeBaitPath()
    expect(existsSync(bait)).toBe(false)
    let cbCalled = false
    expect(() =>
      fsRm(bait, () => {
        cbCalled = true
      }),
    ).toThrow(/fs-guard|BLOCKED/)
    expect(cbCalled).toBe(false)
    expect(existsSync(bait)).toBe(false)
  })

  it('promises 直引面：node:fs/promises rm 被拦', () => {
    const bait = probeBaitPath()
    expect(existsSync(bait)).toBe(false)
    expect(() => fspRm(bait)).toThrow(/fs-guard|BLOCKED/)
    expect(existsSync(bait)).toBe(false)
  })

  it('fs.promises 访问器面：node:fs.promises.rm 被拦（访问器透传即本缺口回归形态）', () => {
    const bait = probeBaitPath()
    expect(existsSync(bait)).toBe(false)
    expect(() => fsPromises.rm(bait)).toThrow(/fs-guard|BLOCKED/)
    expect(existsSync(bait)).toBe(false)
  })
})
