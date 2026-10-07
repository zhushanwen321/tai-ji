/**
 * format-utils 纯函数测试（W3 折叠头截短 + 末行截取）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/format-utils.test.ts
 */
import { describe, it, expect } from 'vitest'
import { shortenForHeader, tailLines, stripAnsi, formatClock } from '../format-utils'

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
      'cd /Users/dev/Code/my-workspace/fix-drawer-subagent-render && rg -l -i "drawer" packages/renderer/src --type vue --type ts | head -30'
    const result = shortenForHeader(input)
    expect(result).toContain('\u2026/my-workspace/fix-drawer-subagent-render')
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
    const chars = 'abcdefghij klmn\nop qrst\nuv wqrs0123\n456789'
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

/**
 * tailLines × stripAnsi 执行顺序对拍（Block.vue tool 尾行窗口取数）。
 *
 * 背景：toolTailLines 先对全文 stripAnsi 再 tailLines，O(全文) 正则替换产出全文新串，
 * 只为取尾 2 行——架空 tailLines 的尾部扫描优化。改为先 tailLines 再对窗口行逐行
 * stripAnsi。等价性依据：stripAnsi 的 ANSI_RE = /\x1b\[[0-9;]*m/g 字符类 [0-9;] 不含
 * \n（也不含 \r，CRLF 安全）——strip 不增删换行、单次匹配不跨行，行边界 strip 前后
 * 不变，与 strip 后取尾逐字节一致。本组对拍锁定该等价性（参照实现 = 旧顺序）。
 */
describe('tailLines × stripAnsi 顺序对拍', () => {
  /** 旧顺序（参照基准）：全文 strip → tailLines */
  function stripThenTail(text: string, n: number): string[] {
    return tailLines(stripAnsi(text), n)
  }
  /** 新顺序：tailLines → 窗口行逐行 strip */
  function tailThenStrip(text: string, n: number): string[] {
    return tailLines(text, n).map(stripAnsi)
  }

  it('对拍: ANSI 状态跨行 / 行首行尾 ANSI / 空行 / 纯文本固定用例', () => {
    const cases = [
      '', // 空串
      'plain line 1\nplain line 2', // 纯文本
      '\x1b[31mred start', // 行首 ANSI 不闭合（色码到 EOF 不构成完整匹配）
      'no color\n\x1b[32mgreen line\x1b[0m\n\x1b[1;34mheading\x1b[0m', // ANSI 行首行尾
      '\x1b[31munclosed color\nspans line boundary\nstill red', // ANSI 状态跨行（开码不闭合）
      'a\n\n\x1b[31m\n\x1b[0m\n', // 空行 + 孤立 ANSI 行 + 尾随换行
      '\x1b[32m✓ success\x1b[0m\n\x1b[1;34m── build output ──\x1b[0m\nfinal line of output', // 真实 bash 输出形态
      `${'x'.repeat(5000)}\n\x1b[31mtail line\x1b[0m`, // 长头部 + ANSI 尾行
      'crlf\r\n\x1b[32mwin line\x1b[0m\r\n', // CRLF 行尾（\r 不在字符类，同安全）
    ]
    for (const text of cases) {
      for (const n of [1, 2, 3, 100]) {
        expect(tailThenStrip(text, n)).toEqual(stripThenTail(text, n))
      }
    }
  })

  it('固定期望: 真实 bash ANSI 输出尾 2 行内容（防两序同错）', () => {
    const raw = 'step-1\n\x1b[32m✓ step-2\x1b[0m\n\x1b[1;34m── final ──\x1b[0m'
    expect(tailThenStrip(raw, 2)).toEqual(['✓ step-2', '── final ──'])
  })

  /** 线性同余伪随机（与上方 tailLines 对拍组同型，seeded 可复现） */
  function makeLcg(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 4294967296
    }
  }

  /** 生成随机 ANSI 文本：普通词行 + 随机注入 SGR 色码（行首/行中/行尾，含不闭合码） */
  function randomAnsiText(rand: () => number, targetLen: number): string {
    const words = ['build', 'step', 'ok', 'err', 'x', 'done', 'pass']
    const codes = ['\x1b[31m', '\x1b[0m', '\x1b[1;34m', '\x1b[38;5;196m', '\x1b[2J', '\r']
    let out = ''
    while (out.length < targetLen) {
      const roll = rand()
      if (roll < 0.5) {
        out += `${words[Math.floor(rand() * words.length)]} `
      } else if (roll < 0.7) {
        out += '\n'
      } else {
        // 色码与 \x1b[2J / \r 混入（后者 stripAnsi 不处理，两序行为一致即等价）
        out += codes[Math.floor(rand() * codes.length)]
      }
    }
    return out
  }

  it('对拍: 随机 ANSI 文本（20KB 级）多 n 等价', () => {
    const rand = makeLcg(2026)
    for (let i = 0; i < 5; i++) {
      const text = randomAnsiText(rand, 20000)
      for (const n of [1, 2, 3, 7, 50]) {
        expect(tailThenStrip(text, n)).toEqual(stripThenTail(text, n))
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
