// @vitest-environment jsdom
// [镜像守卫 U-A6 / 设计 D4-7 短期层] ui↔renderer base64 解码函数镜像行为守卫。
//
// 镜像两侧（ui→renderer 依赖禁令所致，两侧注释互指）：
// - renderer：composables/logic/markdown.ts 的 decodeBase64（export；其 encodeBase64 产出
//   data-path/data-code/data-source 属性值）
// - ui：features/chat/markdown-links.ts 的 decodeB64（镜像纯函数模块，经
//   helpers/markdown-renderer-mirror.ts 源码提取构造——chat 内部模块不在 ui exports
//   白名单，renderer 不 import）
//
// 守卫语义：同一组文本经参照实现（referenceB64，UTF-8 等价编码）得到合法 base64，两侧解码
// 输出逐例相等且还原原文——任一侧语义漂移即红灯。HISTORICAL 事故锚点：迁移时丢
// decodeBase64 致点击打开错误路径（ui 侧函数注释自证）。
//
// 已知语义差异（登记，不纳入相等断言）：非法 base64 输入下 ui 侧 try/catch 回退返回原串、
// renderer 侧 atob 抛错——真差异非漂移（renderer 侧输入是自己 encode 的可信产物，ui 侧输入
// 是 DOM dataset 不可信来源，防御面不同），不属本守卫「合法域同输出」范畴。
//
// 运行：cd packages/renderer && npx vitest run src/__tests__/composables/mirror-guard-base64.test.ts
import { describe, it, expect, vi } from 'vitest'

// stub shiki：markdown.ts 顶层拉 shiki/langs/themes 重依赖，聚焦 base64 链路（口径同
// composables/markdown-base64.test.ts）
vi.mock('shiki/core', () => ({
  createHighlighterCore: vi.fn(() =>
    Promise.resolve({
      codeToHtml: vi.fn((code: string) => `<pre class="shiki"><code>${code}</code></pre>`),
      getLoadedLanguages: () => ['typescript'],
    }),
  ),
}))

import { decodeBase64 } from '@/composables/logic/markdown'
import { loadUiMarkdownRendererMirrors, referenceB64 } from '@/__tests__/helpers/markdown-renderer-mirror'

const TEXT_CASES: string[] = [
  '', // 空串（btoa('') → ''，解码还原 ''）
  'a', // 1 字节（base64 padding 边界 ==）
  'ab', // 2 字节（padding 边界 =）
  'abc', // 3 字节（无 padding）
  'hello',
  '中文',
  '😀🎉', // 4 字节 surrogate pair
  'mix 中文 and 😀 and\nnewline\ttab',
  'a"b\\c\'d<e>&f', // 引号/反斜杠/HTML 特殊字符（data-path 属性载荷形态）
  '<script>alert(1)</script>',
  `${'a'.repeat(5000)}中文${'😀'.repeat(500)}`, // 大文本（编解码多字节密集）
]

/** 硬编码期望向量（编码产物不漂移的双保险，口径同 markdown-base64.test.ts） */
const B64_VECTORS: Array<[b64: string, expected: string]> = [
  ['aGVsbG8=', 'hello'],
  ['5Lit5paH', '中文'],
  ['8J+YgA==', '😀'],
  ['', ''],
]

describe('镜像守卫：base64 解码（renderer decodeBase64 ↔ ui decodeB64）', () => {
  it('参照编码的合法 base64：两侧同输入同输出且还原原文', async () => {
    const ui = await loadUiMarkdownRendererMirrors()
    for (const text of TEXT_CASES) {
      const b64 = referenceB64(text)
      expect(decodeBase64(b64), `renderer decodeBase64(referenceB64) 输入原文 ${JSON.stringify(text.slice(0, 20))}`).toBe(
        text,
      )
      expect(ui.decodeB64(b64), `ui decodeB64(referenceB64) 输入原文 ${JSON.stringify(text.slice(0, 20))}`).toBe(text)
    }
  })

  it('硬编码 base64 向量：两侧解码一致（编码产物不漂移双保险）', async () => {
    const ui = await loadUiMarkdownRendererMirrors()
    for (const [b64, expected] of B64_VECTORS) {
      expect(decodeBase64(b64), `renderer decodeBase64(${JSON.stringify(b64)})`).toBe(expected)
      expect(ui.decodeB64(b64), `ui decodeB64(${JSON.stringify(b64)})`).toBe(expected)
    }
  })
})
