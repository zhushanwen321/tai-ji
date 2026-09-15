/**
 * file-type 判定纯函数单测。
 *
 * 覆盖：
 * - 各 FileKind 的扩展名映射（markdown/image/code）
 * - 未知扩展名 → text 兜底
 * - 无扩展名 → text
 * - dotfile（.eslintrc）处理
 * - 路径含目录前缀（src/a/b.ts）
 * - 大小写不敏感（.MD/.TS）
 * - extToLang 映射 + fallback 'typescript'
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/lib/file-type.test.ts
 */
import { describe, it, expect } from 'vitest'
import { detectFileKind, extToLang } from '@/composables/logic/file-type'

describe('detectFileKind', () => {
  describe('markdown', () => {
    const cases = ['README.md', 'doc.markdown', 'page.mdx']
    for (const p of cases) {
      it(`${p} → markdown`, () => {
        expect(detectFileKind(p)).toBe('markdown')
      })
    }
  })

  describe('image', () => {
    const cases = ['logo.png', 'photo.jpg', 'icon.jpeg', 'anim.gif', 'vec.svg', 'pic.webp', 'old.bmp', 'fav.ico']
    for (const p of cases) {
      it(`${p} → image`, () => {
        expect(detectFileKind(p)).toBe('image')
      })
    }
  })

  describe('code', () => {
    const cases = ['a.ts', 'b.tsx', 'c.js', 'd.jsx', 'Comp.vue', 'cfg.json', 'app.py', 'srv.go', 'lib.rs', 'Main.java']
    for (const p of cases) {
      it(`${p} → code`, () => {
        expect(detectFileKind(p)).toBe('code')
      })
    }
  })

  it('未知扩展名 → text', () => {
    expect(detectFileKind('notes.unknownext')).toBe('text')
    expect(detectFileKind('data.csv')).toBe('text')
  })

  it('无扩展名 → text', () => {
    expect(detectFileKind('Makefile')).toBe('text')
    expect(detectFileKind('LICENSE')).toBe('text')
  })

  it('路径含目录前缀', () => {
    expect(detectFileKind('src/components/Panel.vue')).toBe('code')
    expect(detectFileKind('docs/architecture/readme.md')).toBe('markdown')
  })

  it('大小写不敏感', () => {
    expect(detectFileKind('README.MD')).toBe('markdown')
    expect(detectFileKind('App.TS')).toBe('code')
    expect(detectFileKind('IMG.PNG')).toBe('image')
  })

  it('dotfile 扩展名处理', () => {
    expect(detectFileKind('.eslintrc')).toBe('text')
    expect(detectFileKind('.gitignore')).toBe('text')
  })
})

describe('extToLang', () => {
  it('ts → typescript', () => {
    expect(extToLang('a.ts')).toBe('typescript')
    expect(extToLang('a.tsx')).toBe('typescript')
  })

  it('js → javascript', () => {
    expect(extToLang('a.js')).toBe('javascript')
  })

  it('vue → vue', () => {
    expect(extToLang('Comp.vue')).toBe('vue')
  })

  it('py → python', () => {
    expect(extToLang('app.py')).toBe('python')
  })

  it('sh → bash', () => {
    expect(extToLang('run.sh')).toBe('bash')
  })

  it('未知扩展名 fallback typescript', () => {
    expect(extToLang('notes.unknownext')).toBe('typescript')
    expect(extToLang('Makefile')).toBe('typescript')
  })
})
