// @vitest-environment jsdom
// [镜像守卫 U-A6 / 设计 D4-7 短期层] ui↔renderer 相对路径判定/resolve 函数镜像行为守卫。
//
// 镜像两侧（ui→renderer 依赖禁令所致，两侧注释互指、改动需同批同步）：
// - renderer：composables/logic/markdown-sanitize.ts 的 isRelativeResourcePath / resolveResourcePath
// - ui：features/chat/markdown-links.ts 的 isRelativeHref / resolveHrefPath（镜像纯函数模块，
//   经 helpers/markdown-renderer-mirror.ts 源码提取构造——chat 内部模块不在 ui exports
//   白名单，renderer 不 import）
//
// 守卫语义：两侧喂同一组代表性输入（含空串/锚点/协议相对/scheme/绝对路径/../ 穿越/含特殊
// 字符路径等边界），逐例断言输出等于设计语义锚定值——任一侧漂移或双侧同漂均红灯。
// jsdom 环境口径与 markdown 管线测试族一致（markdown-sanitize 顶层注册 DOMPurify hook）。
//
// 运行：cd packages/renderer && npx vitest run src/__tests__/composables/mirror-guard-relative-path.test.ts
import { describe, it, expect } from 'vitest'
import { isRelativeResourcePath, resolveResourcePath } from '@/composables/logic/markdown-sanitize'
import { loadUiMarkdownRendererMirrors } from '@/__tests__/helpers/markdown-renderer-mirror'

/**
 * 判定函数语义锚（renderer 侧 docstring：非 # 开头（页内锚点）、非 // 开头（协议相对）、
 * 无 scheme 前缀；空串非路径。绝对路径判定为 true——绝对排除发生在 img hook 调用点，
 * 函数本体不承担，两侧同款语义）。
 */
const HREF_CASES: Array<[input: string, expected: boolean]> = [
  // 空串
  ['', false],
  // 页内锚点
  ['#', false],
  ['#section-锚点', false],
  // 协议相对（远程）
  ['//', false],
  ['//host.example.com/a.png', false],
  // scheme 前缀（http/data/mailto/javascript/tel + 大小写不敏感 + 单字母 scheme）
  ['http://example.com/x.png', false],
  ['https://example.com', false],
  ['HTTPS://EXAMPLE.COM/X', false],
  ['data:image/png;base64,AAAA', false],
  ['mailto:user@example.com', false],
  ['javascript:alert(1)', false],
  ['tel:+8613800000000', false],
  ['c:/x/y.png', false],
  ['x:y', false],
  ['a:b:c', false],
  ['http:x', false],
  // 数字开头非 scheme（SCHEME_RE 首字符限 [a-z]）
  ['1abc:x', true],
  // 相对路径
  ['a/b.png', true],
  ['./a.png', true],
  ['../a.png', true],
  ['a/./b/../c.png', true],
  // 绝对路径（判定 true；绝对排除在调用点，两侧同款）
  ['/abs/a.png', true],
  ['/', true],
  // 含特殊字符（空格/中文）
  ['a b/图 片.png', true],
  ['图/片.png', true],
]

/**
 * resolve 函数语义锚（renderer 侧 docstring：POSIX path.resolve 语义的纯函数实现——
 * base 恒为绝对目录、rel 相对可带 / 开头；'' 与 '.' 段跳过、'..' 出 base、越界收口在根）。
 */
const RESOLVE_CASES: Array<[base: string, rel: string, expected: string]> = [
  ['/base/dir', 'a.png', '/base/dir/a.png'],
  ['/base/dir', './a.png', '/base/dir/a.png'],
  ['/base/dir', '../a.png', '/base/a.png'],
  ['/base/dir', '../../../a.png', '/a.png'], // 越界收口在根
  ['/base/dir', 'a/../b.png', '/base/dir/b.png'],
  ['/base/dir', '/abs/x.png', '/abs/x.png'], // rel 绝对 → 直接取 rel
  ['/base/dir', '', '/base/dir'],
  ['/base/dir', '.', '/base/dir'],
  ['/base/dir', '..', '/base'],
  ['/base/dir', '../..', '/'],
  ['/base/', 'a.png', '/base/a.png'], // base 尾斜杠：空段跳过
  ['/base//dir', 'a.png', '/base/dir/a.png'],
  ['/base/dir', 'a//b.png', '/base/dir/a/b.png'],
  ['/base/dir', 'a b/图 片.png', '/base/dir/a b/图 片.png'],
  ['/base/dir', './', '/base/dir'],
  ['/', 'a.png', '/a.png'],
  ['/base/dir', 'a.png/', '/base/dir/a.png'], // 尾斜杠产生空尾段，跳过
  ['/base/dir', '...', '/base/dir/...'], // 三点是普通段名，非 ..
  ['/base/dir', '..a.png', '/base/dir/..a.png'], // .. 前缀是普通段名
]

describe('镜像守卫：相对路径判定（renderer isRelativeResourcePath ↔ ui isRelativeHref）', () => {
  it('两侧同输入同输出（边界逐例锚定）', async () => {
    const ui = await loadUiMarkdownRendererMirrors()
    for (const [input, expected] of HREF_CASES) {
      expect(
        isRelativeResourcePath(input),
        `renderer isRelativeResourcePath(${JSON.stringify(input)})`,
      ).toBe(expected)
      expect(ui.isRelativeHref(input), `ui isRelativeHref(${JSON.stringify(input)})`).toBe(expected)
    }
  })
})

describe('镜像守卫：相对路径 resolve（renderer resolveResourcePath ↔ ui resolveHrefPath）', () => {
  it('两侧同输入同输出（POSIX resolve 语义边界逐例锚定）', async () => {
    const ui = await loadUiMarkdownRendererMirrors()
    for (const [base, rel, expected] of RESOLVE_CASES) {
      const label = `resolve(${JSON.stringify(base)}, ${JSON.stringify(rel)})`
      expect(resolveResourcePath(base, rel), `renderer resolveResourcePath ${label}`).toBe(expected)
      expect(ui.resolveHrefPath(base, rel), `ui resolveHrefPath ${label}`).toBe(expected)
    }
  })
})
