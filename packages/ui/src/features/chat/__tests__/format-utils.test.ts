/**
 * format-utils 纯函数测试（W3 折叠头截短 + 末行截取）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/format-utils.test.ts
 */
import { describe, it, expect } from 'vitest'
import { shortenForHeader, tailLines, formatClock } from '../format-utils'

describe('shortenForHeader', () => {
  // U1: bash 命令——绝对路径 4 段截短，相对路径不动
  it('U1: bash cd 绝对路径截短 + 相对路径保留', () => {
    const input = 'cd /Users/z/Code/repo-wt && rg -l -i "drawer" packages/renderer/src'
    expect(shortenForHeader(input)).toBe(
      'cd \u2026/Code/repo-wt && rg -l -i "drawer" packages/renderer/src',
    )
  })

  // U2: home 规则优先——替换后 ~/notes/a.md 不再是 ≥3 段绝对路径
  it('U2: home 前缀替换为 ~，阻止规则②触发', () => {
    expect(shortenForHeader('/Users/z/notes/a.md', { home: '/Users/z' })).toBe('~/notes/a.md')
  })

  // U3: 相对路径 + 两段绝对路径——原样返回
  it('U3: 相对路径与两段绝对路径不变', () => {
    expect(shortenForHeader('packages/ui/src/chat/Block.vue')).toBe('packages/ui/src/chat/Block.vue')
    expect(shortenForHeader('/a/b.vue')).toBe('/a/b.vue')
  })

  // U4: 空输入返回空串
  it('U4: 空字符串与 null 返回空串', () => {
    expect(shortenForHeader('')).toBe('')
    expect(shortenForHeader(null as unknown as string)).toBe('')
  })

  // U5: URL——scheme+host 占位保护，路径原样保留
  it('U5: URL scheme+host 保护，路径部分保留原样', () => {
    const input = 'curl https://example.com/a/b/c/d.tar.gz'
    expect(shortenForHeader(input)).toBe('curl https://example.com/a/b/c/d.tar.gz')
  })

  // 追加：真实 bash 场景长命令
  it('真实 bash 场景：长路径截短含子串', () => {
    const input =
      'cd /Users/zhushanwen/Code/xyz-agent-workspace/fix-drawer-subagent-render && rg -l -i "drawer" packages/renderer/src --type vue --type ts | head -30'
    const result = shortenForHeader(input)
    expect(result).toContain('\u2026/xyz-agent-workspace/fix-drawer-subagent-render')
  })

  // 追加：引号内路径同样生效
  it('引号内绝对路径同样截短', () => {
    expect(shortenForHeader('edit "/a/b/c/d.txt"')).toBe('edit "\u2026/c/d.txt"')
  })
})

describe('tailLines', () => {
  // U6: 正常取末 n 行
  it('U6: 取末 3 行', () => {
    expect(tailLines('l1\nl2\nl3\nl4', 3)).toEqual(['l2', 'l3', 'l4'])
  })

  // U7: 不足 n 行全返 + 空文本返回 []
  it('U7: 不足 n 行全返；空文本返回 []', () => {
    expect(tailLines('l1\nl2', 3)).toEqual(['l1', 'l2'])
    expect(tailLines('', 3)).toEqual([])
  })

  // ── 尾部扫描实现对拍（2026-08 性能优化：全文 split → 尾部倒找第 n 个换行）──
  // tailLinesRef = 优化前实现（内联作参照基准），对拍保证逐 case 等价。
  function tailLinesRef(text: string, n: number): string[] {
    if (!text) return []
    const lines = text.split('\n')
    return lines.length <= n ? lines : lines.slice(-n)
  }

  /** 线性同余伪随机（seeded，可复现，不引第三方库） */
  function makeLcg(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 4294967296
    }
  }

  /** 生成随机文本：可打印字符行 + 随机换行（含连续换行/尾随换行/换行开头） */
  function randomText(rand: () => number, targetLen: number): string {
    const chars = 'abcdefghij klmn\nop qrst\nuv wxyz0123\n456789'
    let out = ''
    while (out.length < targetLen) {
      out += chars[Math.floor(rand() * chars.length)]
    }
    return out
  }

  it('对拍: 边界 case 等价（空串/单行/尾随换行/连续换行/换行开头/行数=n-1,n,n+1）', () => {
    const texts = ['', 'abc', 'a\n', '\n', '\n\n', '\na', '\nb\nc', 'a\nb', 'a\nb\nc', 'a\n\nc\n', '\n\n\n\na\n\nb\n']
    for (const text of texts) {
      for (const n of [1, 2, 3, 5, 100]) {
        expect(tailLines(text, n)).toEqual(tailLinesRef(text, n))
      }
    }
  })

  it('对拍: 非正 n 兜底等价（n=0 全部行 / n<0 前缀 slice）', () => {
    for (const text of ['abc', 'a\nb\nc', '\n\n']) {
      for (const n of [0, -1, -2]) {
        expect(tailLines(text, n)).toEqual(tailLinesRef(text, n))
      }
    }
  })

  it('对拍: 随机长文本（50KB 级）多 n 等价', () => {
    const rand = makeLcg(42)
    for (let i = 0; i < 5; i++) {
      const text = randomText(rand, 50000)
      for (const n of [1, 2, 3, 7, 50, 1000]) {
        expect(tailLines(text, n)).toEqual(tailLinesRef(text, n))
      }
    }
  })

  it('对拍: 随机短文本密集 n 扫描等价', () => {
    const rand = makeLcg(7)
    for (let i = 0; i < 50; i++) {
      const text = randomText(rand, rand() < 0.5 ? 12 : 120)
      for (let n = 1; n <= 10; n++) {
        expect(tailLines(text, n)).toEqual(tailLinesRef(text, n))
      }
    }
  })
})

describe('formatClock', () => {
  it('A6: 本地时区 HH:MM:SS（用 Date 本地 getter 断言，禁硬编码时区）', () => {
    const ms = 1_700_000_000_000
    const result = formatClock(ms)
    const d = new Date(ms)
    const expected = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    expect(result).toBe(expected)
  })

  it('A6: 多个不同时间点均正确格式化', () => {
    const timestamps = [0, 1_000_000, 1_700_000_000_000, Date.now()]
    for (const ms of timestamps) {
      const d = new Date(ms)
      const expected = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
      expect(formatClock(ms)).toBe(expected)
    }
  })

  it('A6: 非法入参返回空串', () => {
    expect(formatClock(NaN)).toBe('')
    expect(formatClock(-1)).toBe('')
    expect(formatClock(Infinity)).toBe('')
    expect(formatClock(-Infinity)).toBe('')
    expect(formatClock('abc' as unknown as number)).toBe('')
    expect(formatClock(undefined as unknown as number)).toBe('')
    expect(formatClock(null as unknown as number)).toBe('')
  })

  it('A6: epoch 0 格式化——用本地 getter 断言（不同 CI 时区不同）', () => {
    const d = new Date(0)
    const expected = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    expect(formatClock(0)).toBe(expected)
  })
})
