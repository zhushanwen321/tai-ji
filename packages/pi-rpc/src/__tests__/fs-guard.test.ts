/**
 * fs-guard / global-setup 防线自测（taiji-full-rename R3 白名单排除式补强，同构副本）。
 *
 * 覆盖一致性审查 B 组 P2 缝隙：注入的 TAIJI_AGENT_DATA_DIR 指向家目录下非白名单路径
 * （含改名前旧形态数据目录）时——① global-setup fail-fast 拒跑退出；② fs-guard 白名单
 * 过滤剔除注入值，破坏性 fs 操作被拒。合法注入（tmp 之下）仍放行（防过拦回归）。
 *
 * 探针路径是不存在的家目录下假路径（随机后缀）；guardPaths 是纯字符串前缀判定，
 * 全程不触碰任何真实目录（仓规测试红线）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isDestructiveAllowed } from '../../test/fs-guard-impl.js'
import { setup } from '../../test/global-setup.js'

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

describe('fs-guard 注入合法性过滤（白名单排除式）', () => {
  it('注入指向家目录下非白名单假路径：注入值不进白名单，破坏性操作被拒', () => {
    const fake = fakeHomePath()
    withInjectedEnv(fake, () => {
      // 告警是 impl 模块级一次性 flag，errSpy 必须先于首个触发判定的调用挂上
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(isDestructiveAllowed(fake)).toBe(false)
        expect(isDestructiveAllowed(join(fake, 'agent', 'sessions', 'x.jsonl'))).toBe(false)
        // 非法注入在 guard 层一次性 console.error 说明（防线语义由白名单达成）
        expect(errSpy).toHaveBeenCalled()
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

describe('global-setup fail-fast（白名单形态）', () => {
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
