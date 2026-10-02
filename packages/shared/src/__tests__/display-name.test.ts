/**
 * shared display-name 单测（GUI 短名派生单点，dev-merge 审查 Must-Fix D）。
 *
 * 守护：与 core 侧（@zhushanwen/subagent-core shared/agent-ref.ts 的同名导出）
 * 行为逐字节等价的锚定向量——双分隔符 basename + 扩展名剥离 + 非路径/裸名原样。
 * 任一侧改语义须同步另一侧与其测试向量（两侧 JSDoc 互认注记）。
 */
import { describe, expect, it } from 'vitest'
import { displayAgentName, displayWorkflowName } from '../display-name.js'

describe('displayAgentName（agent ref .md → basename 短名）', () => {
  it('POSIX 绝对路径：/a/b/worker.md → worker', () => {
    expect(displayAgentName('/Users/x/.agents/agents/worker.md')).toBe('worker')
  })

  it('Windows 反分隔符：C:\\a\\worker.md → worker（跨平台切分锚定向量）', () => {
    expect(displayAgentName('C:\\a\\worker.md')).toBe('worker')
  })

  it('混合分隔符与深层嵌套：以最后一个分隔符切', () => {
    expect(displayAgentName('/a\\b/c/reviewer.md')).toBe('reviewer')
  })

  it('非路径值（默认 agent 名）原样返回', () => {
    expect(displayAgentName('general-purpose')).toBe('general-purpose')
  })

  it('无后缀 basename 原样返回（不猜测语义）', () => {
    expect(displayAgentName('worker')).toBe('worker')
  })

  it('空串返回空串（调用方模板插值安全）', () => {
    expect(displayAgentName('')).toBe('')
  })
})

describe('displayWorkflowName（workflow ref .js → basename 短名）', () => {
  it('POSIX 绝对路径：/a/b/batch.js → batch', () => {
    expect(displayWorkflowName('/abs/workflows/batch.js')).toBe('batch')
  })

  it('Windows 反分隔符：C:\\a\\batch.js → batch', () => {
    expect(displayWorkflowName('C:\\a\\batch.js')).toBe('batch')
  })

  it('裸名原样返回', () => {
    expect(displayWorkflowName('batch')).toBe('batch')
  })

  it('与 core 侧同名导出等价锚：.js 才剥，其他后缀不剥', () => {
    expect(displayWorkflowName('/a/b/tool.md')).toBe('tool.md')
  })
})
