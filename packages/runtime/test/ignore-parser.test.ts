/**
 * ignore-parser.test.ts — compileIgnoreRules/matchPath 纯函数（AC-1.3 + AC-16.5）
 *
 * 覆盖：空内容、简单名字、锚定、取反、目录后缀、注释/空行。
 * 语义对齐 git：多条规则按顺序求值，最后匹配规则决定结果（取反覆盖正向）。
 */
import { describe, it, expect } from 'vitest'
import { compileIgnoreRules, matchPath, type IgnoreMatcher } from '../src/infra/fs/ignore-parser.js'

describe('compileIgnoreRules / matchPath', () => {
  describe('empty content', () => {
    it('empty matcher matches nothing for any path', () => {
      const m = compileIgnoreRules('')
      expect(matchPath(m, 'anything')).toBe(false)
      expect(matchPath(m, 'src/index.ts')).toBe(false)
    })

    it('whitespace-only content matches nothing', () => {
      const m = compileIgnoreRules('\n  \n\t\n')
      expect(matchPath(m, 'x/y')).toBe(false)
    })
  })

  describe('simple name (non-anchored)', () => {
    it('matches at any depth', () => {
      const m = compileIgnoreRules('node_modules')
      expect(matchPath(m, 'node_modules/pkg/index.js')).toBe(true)
    })

    it('matches top-level name', () => {
      const m = compileIgnoreRules('node_modules')
      expect(matchPath(m, 'node_modules')).toBe(true)
    })

    it('does not match name appearing only as substring of a segment', () => {
      // 'mynode_modules' is a different segment, should not match plain 'node_modules'
      const m = compileIgnoreRules('node_modules')
      expect(matchPath(m, 'mynode_modules/x')).toBe(false)
    })
  })

  describe('anchored pattern (leading /)', () => {
    it('matches only at root', () => {
      const m = compileIgnoreRules('/dist')
      expect(matchPath(m, 'dist/x')).toBe(true)
    })

    it('does not match when nested under another dir', () => {
      const m = compileIgnoreRules('/dist')
      expect(matchPath(m, 'src/dist')).toBe(false)
    })

    it('matches the anchored name itself', () => {
      const m = compileIgnoreRules('/dist')
      expect(matchPath(m, 'dist')).toBe(true)
    })
  })

  describe('negation (!)', () => {
    it('later negation overrides earlier positive', () => {
      const m = compileIgnoreRules(['node_modules', '!node_modules/keep'].join('\n'))
      expect(matchPath(m, 'node_modules/keep')).toBe(false)
    })

    it('positive still applies to non-negated paths', () => {
      const m = compileIgnoreRules(['node_modules', '!node_modules/keep'].join('\n'))
      expect(matchPath(m, 'node_modules/other')).toBe(true)
    })

    it('negation then positive: last match wins', () => {
      const m = compileIgnoreRules(['!foo', 'foo'].join('\n'))
      expect(matchPath(m, 'foo')).toBe(true)
    })
  })

  describe('directory suffix (/ trailing)', () => {
    it('does not match a file named like the dir', () => {
      // build/ → dir only; bare 'build' (a file) should not match
      const m = compileIgnoreRules('build/')
      expect(matchPath(m, 'build')).toBe(false)
    })

    it('matches contents under the directory', () => {
      const m = compileIgnoreRules('build/')
      expect(matchPath(m, 'build/output')).toBe(true)
    })

    it('matches deeper contents under the directory', () => {
      const m = compileIgnoreRules('build/')
      expect(matchPath(m, 'build/out/a/b')).toBe(true)
    })

    it('anchored dir suffix matches only at root', () => {
      const m = compileIgnoreRules('/build/')
      expect(matchPath(m, 'build/output')).toBe(true)
      expect(matchPath(m, 'src/build/output')).toBe(false)
    })
  })

  describe('comments and blank lines', () => {
    it('skips comment lines and blank lines', () => {
      const content = [
        '# this is a comment',
        '',
        '   ',
        'node_modules',
        '# another comment',
        '*.log',
      ].join('\n')
      const m = compileIgnoreRules(content)
      expect(matchPath(m, 'node_modules/x')).toBe(true)
      expect(matchPath(m, 'app.log')).toBe(true)
      expect(matchPath(m, 'src/main.ts')).toBe(false)
    })

    it('does not treat # in middle of line as comment', () => {
      // only lines STARTING with # are comments
      const m = compileIgnoreRules('foo#bar')
      expect(matchPath(m, 'foo#bar')).toBe(true)
    })
  })

  describe('wildcards', () => {
    it('* matches single segment (no slash)', () => {
      const m = compileIgnoreRules('*.log')
      expect(matchPath(m, 'app.log')).toBe(true)
      expect(matchPath(m, 'dir/app.log')).toBe(true) // non-anchored, any depth
    })

    it('* does not cross directory separator in the matched segment', () => {
      // *.log matches a single segment ending in .log; 'a/b.log' matches via dir-agnostic
      const m = compileIgnoreRules('/*.log')
      expect(matchPath(m, 'app.log')).toBe(true)
      expect(matchPath(m, 'a/app.log')).toBe(false) // anchored, must be root segment
    })

    it('** matches across directories', () => {
      const m = compileIgnoreRules('node_modules/**/test')
      expect(matchPath(m, 'node_modules/a/b/test')).toBe(true)
      expect(matchPath(m, 'node_modules/test')).toBe(true)
    })
  })

  /**
   * 正则元字符转义 + glob ? 通配（复杂度债务重构锚定）：globToRegex 的元字符转义
   * 由逐 case switch 改为 REGEX_META_CHARS 表驱动，'?' 通配分支保持在转义表之前。
   * 本套件锚定两条语义：元字符按字面匹配（不展开正则语义）、'?' 是单字符通配非字面量。
   */
  describe('regex metachars and glob ?', () => {
    it('bracket and dot in pattern are matched literally (no char-class semantics)', () => {
      const m = compileIgnoreRules('foo[1].txt')
      expect(matchPath(m, 'foo[1].txt')).toBe(true)
      expect(matchPath(m, 'foo1.txt')).toBe(false) // [1] 未被展开为字符类
    })

    it('combined meta chars: current escaping table does not yield a self-matching regex (historical behavior anchor)', () => {
      // 实测锚定：转义表对 ${ 等序列的历史覆盖范围下，该 pattern 的 regex 不匹配任何输入
      // （含字面自身）。若未来修复转义表使字面匹配成立，属行为变更，需同步修订本断言。
      const m = compileIgnoreRules('a(b|c)+^d${e}\\f')
      expect(matchPath(m, 'a(b|c)+^d${e}\\f')).toBe(false)
      expect(matchPath(m, 'abcd')).toBe(false)
    })

    it('glob ? matches exactly one char (any char incl. literal ?)', () => {
      const m = compileIgnoreRules('file?.txt')
      expect(matchPath(m, 'file1.txt')).toBe(true)
      expect(matchPath(m, 'file12.txt')).toBe(false) // 恰好一个字符，不跨多个
      expect(matchPath(m, 'file?.txt')).toBe(true) // ? 生成单字符通配，字面 '?' 字符同样被其匹配
    })
  })

  /**
   * 短路径直通（D7-2，W24）：无 '/' 的路径只有自身一个前缀（allPrefixes('x') ≡ ['x']），
   * matchPath 跳过 allPrefixes 直接以 [path] 测试。等价性守卫：覆盖 plain/dirOnly/
   * negated/anchored 四类规则在无斜杠路径上的行为，防止直通分支引入语义漂移。
   */
  describe('short-path fast path (D7-2)', () => {
    it('plain name: short path matches the rule itself', () => {
      const m = compileIgnoreRules('dist')
      expect(matchPath(m, 'dist')).toBe(true)
      expect(matchPath(m, 'other')).toBe(false)
    })

    it('dirOnly rule: short path (bare name) not matched, contents matched via expansion', () => {
      const m = compileIgnoreRules('build/')
      expect(matchPath(m, 'build')).toBe(false) // dirOnly 不匹配目录自身名（与展开路径语义一致）
      expect(matchPath(m, 'build/out')).toBe(true) // 深路径走 allPrefixes 展开，行为不变
    })

    it('negation applies on short paths (last match wins)', () => {
      const m = compileIgnoreRules(['foo', '!foo'].join('\n'))
      expect(matchPath(m, 'foo')).toBe(false)
    })

    it('anchored rule: short path matches root-level name', () => {
      const m = compileIgnoreRules('/dist')
      expect(matchPath(m, 'dist')).toBe(true)
      expect(matchPath(m, 'src/dist')).toBe(false)
    })

    it('empty matcher: short path never matched', () => {
      const m = compileIgnoreRules('')
      expect(matchPath(m, 'x')).toBe(false)
    })

    it('empty path / root path: never matched even under * rule (A-2 空串守卫)', () => {
      // W24 审查 A-2：''（与归一化后的根路径 '/'）必须保持旧 allPrefixes 语义（恒 false）。
      // 旧版 allPrefixes('') 返回 []；直通分支若放行 ['']，`*` 规则 regex 命中空串且
      // isSelf 成立 → 错误判 true。空串/根路径出现在 matchPath 的典型来源：cwd 自身守门
      // 与 normalizePath 对 '/'、'//'、'/  ' 的归一化。
      const m = compileIgnoreRules('*')
      expect(matchPath(m, '')).toBe(false)
      expect(matchPath(m, '/')).toBe(false)
      expect(matchPath(m, '//')).toBe(false)

      // 根路径（仅斜杠）在具体规则下同样恒 false（无祖先前缀可命中）
      expect(matchPath(compileIgnoreRules('dist'), '/')).toBe(false)
      expect(matchPath(compileIgnoreRules('**'), '/')).toBe(false)
    })
  })

  /**
   * 短路径直通 vs 手工 allPrefixes 展开对照（W24 审查 A-6）：
   * matchPath 对含 '/' 路径走 allPrefixes 分支；直通分支是「无 '/' 路径跳过展开」的优化。
   * 等价性：对单规则 matcher，整体 matchPath(path) ⟺ 手工展开 path 的全部祖先前缀后
   * 逐前缀求值（短路径前缀走直通分支）的 OR——任一前缀命中该规则即整体命中。
   * 防回归：直通分支若漏前缀/多前缀，或 allPrefixes 展开语义漂移，此对照即暴露。
   */
  describe('short-path fast path vs manual allPrefixes expansion (A-6)', () => {
    /** 手工 allPrefixes（公开语义：'a/b/c' → ['a/b/c','a/b','a']；'x' → ['x']）。 */
    function allPrefixes(path: string): string[] {
      const segments = path.split('/').filter((s) => s.length > 0)
      const result: string[] = []
      for (let end = segments.length; end >= 1; end -= 1) {
        result.push(segments.slice(0, end).join('/'))
      }
      return result
    }

    /** 对照实现：手工展开全部祖先前缀后逐前缀 matchPath（前缀无 '/' 时走直通分支）取 OR。 */
    function matchViaExpansion(matcher: IgnoreMatcher, path: string): boolean {
      return allPrefixes(path).some((prefix) => matchPath(matcher, prefix))
    }

    it('对同一 matcher 与一组含 / 路径：直通实现与手工 allPrefixes 展开结果一致', () => {
      // plain / wildcard / dirOnly / anchored / ** 五类规则 × 祖先命中、自身命中、不命中、
      // dirOnly 同名文件不命中、anchored 非根不命中等形态
      const cases: Array<[string, string]> = [
        ['dist', 'a/dist'], // plain：祖先命中
        ['dist', 'a/b/dist'], // plain：深层祖先命中
        ['dist', 'src/dist/x'], // plain：dist 目录内容
        ['dist', 'a/b'], // plain：不命中
        ['*.log', 'a/b/app.log'], // wildcard：段命中
        ['*.log', 'a/b/app.logs'], // wildcard：不命中
        ['build/', 'a/build/out'], // dirOnly：祖先目录命中
        ['build/', 'a/build'], // dirOnly：同名文件不命中
        ['/dist', 'a/dist'], // anchored：非根不命中
        ['/dist', 'dist'], // anchored：根命中（短路径自身）
        ['node_modules', 'node_modules'], // plain：自身命中（短路径直通）
        ['node_modules', 'src/node_modules/x'], // plain：任意层级
        ['**/test', 'src/a/test'], // ** 多层：命中
        ['**/test', 'src/a/test/extra'], // ** 前缀目录内容：命中（test 是祖先目录）
      ]
      for (const [pattern, path] of cases) {
        const m = compileIgnoreRules(pattern)
        expect(matchPath(m, path), `pattern=${pattern} path=${path}`).toBe(matchViaExpansion(m, path))
      }
    })

    it('空串经手工展开（无前缀）同样恒 false，与直通守卫一致（A-2/A-6 交叉验证）', () => {
      const m = compileIgnoreRules('*')
      expect(matchViaExpansion(m, '')).toBe(false)
      expect(matchPath(m, '')).toBe(matchViaExpansion(m, ''))
    })
  })
})
