import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { BUILTIN_PREVIEW, SLUG_SYSTEM_PROMPT } from '../rename-prompt-constants'

/**
 * 内置词表跨包镜像的字面同值锁定：BUILTIN_PREVIEW / SLUG_SYSTEM_PROMPT 与 extension 侧
 * extensions/universal/rename-session/src/llm.ts 的 BUILTIN_TEMPLATES（经 RENAME_INSTRUCTION /
 * SENTENCE_INSTRUCTION / EMOJI_INSTRUCTION）及 RENAME_SYSTEM_PROMPT 同值（跨包不 import 的
 * 手写镜像，漂移只影响 GUI 预览与实际生效 prompt 不一致）。
 *
 * 检查方式：fs 读对侧源文件，断言本侧每个字符串以「双引号 + \n 转义」的字面量形态
 * （即 JSON.stringify 形态）出现在对侧源码中——改任一侧文案而不同步另一侧即红。
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../..')
const LLM_TS_PATH = join(REPO_ROOT, 'extensions', 'universal', 'rename-session', 'src', 'llm.ts')

describe('rename 内置词表跨包镜像同值锁定（BUILTIN_PREVIEW ↔ llm.ts BUILTIN_TEMPLATES）', () => {
  const llmSource = readFileSync(LLM_TS_PATH, 'utf-8')

  it('三个内置风格的预览文案与 extension BUILTIN_TEMPLATES 词表逐条字面同值', () => {
    for (const preview of Object.values(BUILTIN_PREVIEW)) {
      expect(llmSource).toContain(JSON.stringify(preview))
    }
  })

  it('slug 风格 systemPrompt 展示文案与 extension RENAME_SYSTEM_PROMPT 字面同值', () => {
    expect(llmSource).toContain(JSON.stringify(SLUG_SYSTEM_PROMPT))
  })
})
