/**
 * argv 日志脱敏共享纯函数单测（设计 `.tmp/tech-design/mode-system-composer-density.md`
 * §7.2「argv 日志脱敏」+ §7.6 写入面 + 探针 P15）。
 *
 * 锁定：
 * - 值型 flag（`--system-prompt` / `--append-system-prompt`）的值遮蔽为 `<N chars>`；
 * - 非值 token（诊断信息）原样保留；
 * - `--flag=value` 等号形态；
 * - 换行归一 + 长度封顶；
 * - 值里含 flag 字面量（含值本身等于 flag 名）不误伤——按索引/token 遮蔽，非全局替换；
 * - 字符串形态（ps command）多 token 值整体吸收，正文不泄漏。
 */
import { describe, expect, it } from 'vitest'
import { ARGV_REDACT_MAX, redactArgv, redactArgvLine } from './argv-redact.js'

describe('redactArgv（数组形态；rpc-client spawn 日志）', () => {
  it('值型 flag 的值遮蔽为 <N chars>，非值 token 原样保留', () => {
    const out = redactArgv(['--mode', 'rpc', '--no-extensions', '--system-prompt', 'hello world'])
    expect(out).toBe('--mode rpc --no-extensions --system-prompt <11 chars>')
    expect(out).not.toContain('hello world')
  })

  it('两个提示词 flag 同批遮蔽', () => {
    const out = redactArgv(['--system-prompt', 'aaa', '--append-system-prompt', 'bbbb'])
    expect(out).toBe('--system-prompt <3 chars> --append-system-prompt <4 chars>')
  })

  it('--flag=value 等号形态（防御性覆盖）', () => {
    const out = redactArgv(['--append-system-prompt=abc\ndef'])
    expect(out).toBe('--append-system-prompt <7 chars>')
    expect(out).not.toContain('\n')
  })

  it('值里含 flag 字面量不误伤（按索引遮蔽，非全局替换）', () => {
    const value = 'use --append-system-prompt to append'
    const out = redactArgv(['--system-prompt', value])
    expect(out).toBe(`--system-prompt <${value.length} chars>`)
  })

  it('值本身等于某 flag 名 → 整个值被遮蔽，不被当作 flag', () => {
    const out = redactArgv(['--system-prompt', '--append-system-prompt'])
    expect(out).toBe('--system-prompt <22 chars>')
  })

  it('换行值不注入换行', () => {
    const out = redactArgv(['--system-prompt', 'line1\nline2'])
    expect(out).toBe('--system-prompt <11 chars>')
    expect(out).not.toContain('\n')
  })

  it('长度封顶（超出截断加省略号）', () => {
    expect(redactArgv(['--mode', 'rpc'], 5)).toBe('--mod…')
    expect(redactArgv(['--mode', 'rpc'])).toBe('--mode rpc')
    expect(ARGV_REDACT_MAX).toBeGreaterThan(0)
  })

  it('无值型 flag → 逐字节原样（诊断信息零损失）', () => {
    const args = ['--mode', 'rpc', '--no-extensions', '--approve', '--extension', '/x/y']
    expect(redactArgv(args)).toBe(args.join(' '))
  })
})

describe('redactArgvLine（字符串形态；reap-orphan-pi argv 摘要 → crash journal）', () => {
  it('保留诊断 token，遮蔽多 token 提示词值', () => {
    const line = '/opt/pi/pi --mode rpc --no-extensions --approve --system-prompt hello world --no-skills'
    const out = redactArgvLine(line)
    expect(out).toBe(
      '/opt/pi/pi --mode rpc --no-extensions --approve --system-prompt <11 chars> --no-skills',
    )
    expect(out).not.toContain('hello')
    expect(out).not.toContain('world')
  })

  it('两个提示词 flag 同时出现（各自吸收到下一个已知 flag）', () => {
    const line = 'pi --system-prompt aaa bbb --append-system-prompt ccc ddd --thinking high'
    const out = redactArgvLine(line)
    expect(out).toBe('pi --system-prompt <7 chars> --append-system-prompt <7 chars> --thinking high')
  })

  it('换行值归一为单行', () => {
    const out = redactArgvLine('pi --system-prompt line1\nline2 --mode rpc')
    expect(out).toBe('pi --system-prompt <11 chars> --mode rpc')
    expect(out).not.toContain('\n')
  })

  it('等号形态', () => {
    const out = redactArgvLine('pi --append-system-prompt=abc def --mode rpc')
    expect(out).toBe('pi --append-system-prompt <7 chars> --mode rpc')
    expect(out).not.toContain('abc')
  })

  it('值含单横线 markdown 列表不被误判为 flag 边界', () => {
    const out = redactArgvLine('pi --system-prompt - item one - item two --no-skills')
    expect(out).toBe('pi --system-prompt <21 chars> --no-skills')
  })

  it('长度封顶（reap 200 字符窗口）', () => {
    const long = `pi --extension ${'a'.repeat(300)}`
    const out = redactArgvLine(long, 200)
    expect(out.length).toBe(201)
    expect(out.endsWith('…')).toBe(true)
  })

  it('reap 判据 token 不因脱敏丢失（pi 路径 / --mode rpc / --extension 值）', () => {
    const line =
      '/opt/pi/pi --mode rpc --no-extensions --approve --extension /Applications/TaiJi.app/Contents/Resources/extensions/pi-agent-ext'
    const out = redactArgvLine(line)
    expect(out).toContain('/opt/pi/pi')
    expect(out).toContain('--mode rpc')
    expect(out).toContain('--extension /Applications/TaiJi.app')
  })
})
