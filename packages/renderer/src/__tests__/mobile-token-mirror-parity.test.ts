/**
 * desktop ↔ mobile 令牌镜像一致性单测（ui-signal-density D3 / §5.3 U9，v8 断言面）。
 *
 * packages/mobile-renderer/src/styles/tokens.css 是 renderer style.css tokens 段的
 * 镜像副本（文件头注释自述「真值源仍是 renderer style.css……改动须同步两处」），
 * 此前同步只有头注释口头约束、无机器检查，e2e-map 的 scope 也无一条覆盖
 * packages/mobile-renderer/**——本测试把人读对账（§4.1 V4⑥）升级为机器断言。
 *
 * 断言面四组（两文件逐字相等）：
 *  1. :root 玄块 accent 主三值（--accent / --accent-hover / --accent-fg）
 *  2. :root 玄块 color-mix 派生式（--accent-soft / --accent-ring，两文件同为字面）
 *  3. shadcn 映射段（--primary / --ring 两行 var(--accent) 引用）
 *  4. desktop 侧定稿值锚定（防止双侧一起漂移成镜像一致的错值；D3 定稿 #a5adc2 族）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/mobile-token-mirror-parity.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const desktopSource = readFileSync(resolve(import.meta.dirname, '../style.css'), 'utf-8')
const mobileSource = readFileSync(
  resolve(import.meta.dirname, '../../../mobile-renderer/src/styles/tokens.css'),
  'utf-8',
)

/** 取文件第一个 `:root {` 块文本（玄主题块；[data-theme]/preset 块均在其后，不参与） */
function firstRootBlock(source: string, file: string): string {
  const start = source.indexOf(':root {')
  const end = source.indexOf('\n}', start)
  if (start < 0 || end < 0) throw new Error(`${file} 未找到 :root 块`)
  return source.slice(start, end)
}

/** 取 :root 块内某变量的完整声明行（trim 后，含行尾注释） */
function decl(block: string, name: string, file: string): string {
  const line = block.split('\n').find((l) => l.trimStart().startsWith(`${name}:`))
  if (!line) throw new Error(`${file} :root 块未找到 ${name} 声明`)
  return line.trim()
}

const desktopRoot = firstRootBlock(desktopSource, 'renderer style.css')
const mobileRoot = firstRootBlock(mobileSource, 'mobile-renderer tokens.css')

describe('mobile tokens.css ↔ renderer style.css 令牌镜像逐字一致（D3 / V4⑥ 单测侧）', () => {
  it('组 1：:root 玄块 accent 主三值逐字相等', () => {
    for (const name of ['--accent', '--accent-hover', '--accent-fg']) {
      expect(decl(mobileRoot, name, 'mobile')).toBe(decl(desktopRoot, name, 'desktop'))
    }
  })

  it('组 2：:root 玄块 color-mix 派生式（--accent-soft / --accent-ring）逐字相等', () => {
    for (const name of ['--accent-soft', '--accent-ring']) {
      expect(decl(mobileRoot, name, 'mobile')).toBe(decl(desktopRoot, name, 'desktop'))
    }
  })

  it('组 3：shadcn 映射段 --primary / --ring 两行 var(--accent) 引用逐字相等', () => {
    for (const name of ['--primary', '--ring']) {
      expect(decl(mobileRoot, name, 'mobile')).toBe(decl(desktopRoot, name, 'desktop'))
    }
  })

  it('组 4：desktop 侧定稿值锚定（D3：弱蓝灰 #a5adc2 族；防双侧同漂的假一致）', () => {
    expect(decl(desktopRoot, '--accent', 'desktop')).toContain('#a5adc2')
    expect(decl(desktopRoot, '--accent-hover', 'desktop')).toContain('#b5bdd4')
    // PR-3 门禁通过（fg #1a1a1c 对 #a5adc2 对比 7.74:1 ≥ 4.5 AA），故 fg 保持不动
    expect(decl(desktopRoot, '--accent-fg', 'desktop')).toContain('#1a1a1c')
  })
})
