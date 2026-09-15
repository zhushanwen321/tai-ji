/**
 * DEFAULT_PI_SYSTEM_PROMPT 内容守护（W2 重提取 0.84.1，验收 C3）。
 *
 * 锁定 0.84.1 相对 0.80.3 的三处 diff 不回退：
 * ① 工具列表 7 行（+grep/find/ls）；② guidelines 含 bash PI_* 环境变量行；
 * ③ pi 文档路由行含 environment variables。
 * 完整 diff 复现（pi 升级时重跑）：node --input-type=module 动态加载仓库根
 * node_modules 下 @earendil-works/pi-coding-agent/dist/core/tools/index.js，
 * 用 createAllToolDefinitions + buildSystemPrompt 构建默认段对照本常量。
 *（注释不写动态导入的代码形态——fallow 会把注释里的模块路径误解析为依赖声明）
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_PI_SYSTEM_PROMPT, DEFAULT_PI_SYSTEM_PROMPT_VERSION } from '../pi-default-prompt.js'

describe('DEFAULT_PI_SYSTEM_PROMPT（0.84.1 重提取）', () => {
  it('版本标注 = 0.84.1', () => {
    expect(DEFAULT_PI_SYSTEM_PROMPT_VERSION).toBe('0.84.1')
  })

  it('Available tools = 7 工具（0.80.3 是 4，W2 diff ①）', () => {
    expect(DEFAULT_PI_SYSTEM_PROMPT).toContain('- grep: Search file contents for patterns (respects .gitignore)')
    expect(DEFAULT_PI_SYSTEM_PROMPT).toContain('- find: Find files by glob pattern (respects .gitignore)')
    expect(DEFAULT_PI_SYSTEM_PROMPT).toContain('- ls: List directory contents')
    for (const line of [
      '- read: Read file contents',
      '- bash: Execute bash commands (ls, grep, find, etc.)',
      '- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call',
      '- write: Create or overwrite files',
    ]) {
      expect(DEFAULT_PI_SYSTEM_PROMPT).toContain(line)
    }
  })

  it('Guidelines 含 bash PI_* 环境变量行（W2 diff ②）', () => {
    expect(DEFAULT_PI_SYSTEM_PROMPT).toContain(
      '- You can inspect PI_* environment variables for current model and session details.',
    )
  })

  it('pi 文档路由行含 environment variables（W2 diff ③，system-prompt.js:81）', () => {
    expect(DEFAULT_PI_SYSTEM_PROMPT).toContain('environment variables (docs/environment-variables.md)')
  })

  it('占位符语义保持：路径用 <pi package dir>，不含动态 cwd 段', () => {
    expect(DEFAULT_PI_SYSTEM_PROMPT).toContain('<pi package dir>/README.md')
    expect(DEFAULT_PI_SYSTEM_PROMPT).not.toContain('Current working directory:')
  })
})
