/**
 * useComposerBash 单元测试。
 *
 * 被测对象：domain/composer/dispatch/bash.ts —— bash 命令模式（`!`/`!!` 前缀）。
 * 职责：isBashMode 派生 + extractBashCommand 判别联合解析 + trySendBash 三态分流。
 *
 * 策略：mock ComposerBashOptions（sendBash / clearInput / sessionId 等 vi.fn + draft/isSending ref），
 * 纯函数 + 轻量 composable，无外部依赖。
 *
 * 注意：源码逻辑 isExcluded = startsWith('!!')，故单 `!` 前缀 excludeFromContext=false，
 * 双 `!!` 前缀 excludeFromContext=true。
 *
 * 运行：cd packages/core && npx vitest run src/domain/composer/dispatch/bash.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { useComposerBash, type ComposerBashOptions } from './bash'

/** 构造可控 opts（默认 sessionId='s1', sendBash resolve undefined） */
// mock 成员 = 真实签名 & vi.fn 能力（裸 Mock 无法赋给具体签名字段）
// 返回类型 = 真实 Options（vi.fn 带实现签名后与具体签名结构兼容；断言经断言侧
// mock 视图取，不在返回类型里交叉 Mock——vitest 4 Mock 泛型与交叉类型不稳定）
function makeOpts(overrides?: Partial<ComposerBashOptions>): ComposerBashOptions {
  return {
    draft: ref(''),
    clearInput: vi.fn<() => void>(() => {}),
    isSending: ref(false),
    sessionId: () => 's1',
    sendBash: vi.fn<(sessionId: string, command: string, excludeFromContext: boolean) => Promise<void>>(
      (_sessionId, _command, _excludeFromContext) => Promise.resolve(undefined),
    ),
    ...overrides,
  }
}

describe('useComposerBash.extractBashCommand', () => {
  const { extractBashCommand } = useComposerBash(makeOpts())

  it('纯文本 → not-bash', () => {
    expect(extractBashCommand('hello world')).toEqual({ type: 'not-bash' })
  })

  it('单 `!` → empty（无命令内容）', () => {
    expect(extractBashCommand('!')).toEqual({ type: 'empty' })
  })

  it('双 `!!` → empty（无命令内容）', () => {
    expect(extractBashCommand('!!')).toEqual({ type: 'empty' })
  })

  it('`!cmd` → command（exclude=false）', () => {
    expect(extractBashCommand('!cmd')).toEqual({
      type: 'command',
      command: 'cmd',
      excludeFromContext: false,
    })
  })

  it('`!!cmd` → command（exclude=true）', () => {
    expect(extractBashCommand('!!cmd')).toEqual({
      type: 'command',
      command: 'cmd',
      excludeFromContext: true,
    })
  })

  it('`! echo hi` → command（含空格命令保留）', () => {
    expect(extractBashCommand('! echo hi')).toEqual({
      type: 'command',
      command: 'echo hi',
      excludeFromContext: false,
    })
  })

  it('前后空白被 trim（`  !!ls  `）→ command ls', () => {
    expect(extractBashCommand('  !!ls  ')).toEqual({
      type: 'command',
      command: 'ls',
      excludeFromContext: true,
    })
  })
})

describe('useComposerBash.trySendBash', () => {
  it('not-bash → 返回 false，sendBash / clearInput 均不调', async () => {
    const opts = makeOpts()
    const { trySendBash } = useComposerBash(opts)
    const handled = await trySendBash('hello')
    expect(handled).toBe(false)
    expect(opts.sendBash).not.toHaveBeenCalled()
    expect(opts.clearInput).not.toHaveBeenCalled()
    expect(opts.isSending.value).toBe(false)
  })

  it('empty（单 `!`）→ 返回 true，sendBash / clearInput 不调，保持 bash 模式', async () => {
    const opts = makeOpts()
    const { trySendBash } = useComposerBash(opts)
    const handled = await trySendBash('!')
    expect(handled).toBe(true)
    expect(opts.sendBash).not.toHaveBeenCalled()
    expect(opts.clearInput).not.toHaveBeenCalled()
  })

  it('command → 调 sendBash(sessionId, command, exclude) + clearInput + isSending toggle', async () => {
    const opts = makeOpts()
    const { trySendBash } = useComposerBash(opts)
    const handled = await trySendBash('!ls -la')
    expect(handled).toBe(true)
    expect(opts.clearInput).toHaveBeenCalledTimes(1)
    expect(opts.sendBash).toHaveBeenCalledWith('s1', 'ls -la', false)
    // finally 复位 isSending
    expect(opts.isSending.value).toBe(false)
  })

  it('command (sessionId=null) → 返回 false，sendBash 不调', async () => {
    const opts = makeOpts({ sessionId: () => null })
    const { trySendBash } = useComposerBash(opts)
    const handled = await trySendBash('!ls')
    expect(handled).toBe(false)
    expect(opts.sendBash).not.toHaveBeenCalled()
  })

  it('isBashMode 派生：draft 以 `!` 开头为 true', () => {
    const opts = makeOpts({ draft: ref('!partial') })
    const { isBashMode } = useComposerBash(opts)
    expect(isBashMode.value).toBe(true)
    opts.draft.value = 'normal text'
    expect(isBashMode.value).toBe(false)
    // 前导空白不影响
    opts.draft.value = '   !cmd'
    expect(isBashMode.value).toBe(true)
  })
})
