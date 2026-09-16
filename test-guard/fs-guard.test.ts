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
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { open as fspOpen } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDestructiveAllowed, isRealDataDir } from './fs-guard-impl.js'
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
