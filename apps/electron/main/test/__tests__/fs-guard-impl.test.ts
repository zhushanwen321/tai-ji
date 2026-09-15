/**
 * fs-guard-impl isWriteOpenArg 写句柄 flags 判定单测（review S-10：main 侧副本零单测补齐）。
 *
 * isWriteOpenArg 是模块私有函数，行为经导出的 wrapOpenFns 间接投影：wrap 后的入口函数
 * 收到写 flags 时先 guardPaths 校验 path（非白名单 → 抛 [vitest-fs-guard] BLOCKED），
 * 读 flags 直接透传原函数。以「白名单外探针路径」做判定位：抛 = 判定为写、透传 = 判定
 * 为读。探针路径是不存在的家目录下路径——guardPaths 是纯字符串前缀判定，不触碰 fs，
 * 真实数据目录零接触（仓规测试红线）。
 *
 * 判定语义（源码 fs-guard-impl.ts isWriteOpenArg）：
 * - string flags：含 a/w/x/+ 任一为写（正则 /[awx+]/）——'r'/'rs'/'sr' 只读
 * - number flags：O_ACCMODE 位（& 0o3）非零为写，O_CREAT 等附加位不构成写判定
 * - object options：取 .flags 同判定；flags 非 string/number 时落缺省
 * - 第二参缺省：open 系 'r'（放行）、createWriteStream 'w'（默认即写，必拦）
 */
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isDestructiveAllowed, wrapOpenFns } from '../fs-guard-impl.js'
import { setup } from '../global-setup.js'

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
 * 注入 env 合法性过滤 + global-setup fail-fast（taiji-full-rename R3 白名单排除式补强）。
 *
 * 覆盖一致性审查 B 组 P2 缝隙：注入的 TAIJI_AGENT_DATA_DIR 指向家目录下非白名单路径
 * （含改名前旧形态数据目录）时——guard 白名单过滤剔除注入值、global-setup 拒跑退出。
 * 本文件在 legacy 池（无 guard wrapper），负例走纯函数判定视角，零真实 fs 写删。
 */
describe('注入 env 合法性过滤 + global-setup fail-fast（白名单排除式）', () => {
  /** 随机后缀假路径（家目录下不存在；零旧字面量，随机避免跨 run 撞名）。 */
  const fake = resolve(join(homedir(), `.some-fake-dir-${Math.random().toString(36).slice(2)}`))

  /** 设临时注入值跑 fn，finally 恢复原 env（不外泄到同池其他用例）。 */
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

  it('注入指向家目录下非白名单假路径：注入值不进白名单', () => {
    withInjectedEnv(fake, () => {
      // 告警是 impl 模块级一次性 flag，errSpy 必须先于首个触发判定的调用挂上
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(isDestructiveAllowed(fake)).toBe(false)
        expect(isDestructiveAllowed(join(fake, 'agent', 'sessions', 'x.jsonl'))).toBe(false)
        // 非法注入在 guard 层一次性 console.error 说明（防线语义由白名单达成）
        expect(errSpy).toHaveBeenCalled()
      } finally {
        errSpy.mockRestore()
      }
    })
  })

  it('合法注入（tmpdir 之下）仍进白名单（防过拦回归）', () => {
    withInjectedEnv(join(tmpdir(), 'some-fixture-abc'), () => {
      expect(isDestructiveAllowed(join(tmpdir(), 'some-fixture-abc', 'x.jsonl'))).toBe(true)
    })
  })

  it('global-setup fail-fast：注入指向家目录下非白名单假路径 → 拒跑退出码 1，错误含恢复动作', () => {
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
