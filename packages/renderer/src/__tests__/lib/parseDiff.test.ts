/**
 * parseDiff unified diff 解析纯函数单测。
 *
 * 覆盖：
 * - 标准 patch：文件头跳过 + hunk 头解析 + context/add/del 分类 + 行号推进
 * - 多 hunk：行号计数器随 hunk 头重置
 * - 空 patch / 非 diff 文本 → 空 hunks
 * - 行号连续性（context 推进双计数，add 推进 newNo，del 推进 oldNo）
 * - hunk 头省略 count（@@ -1 +1 @@）
 * - 'No newline at end of file' meta 行
 * - 空行作 context 处理
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/lib/parseDiff.test.ts
 */
import { describe, it, expect } from 'vitest'
import { parseDiff, diffCharsLCS, computeInlineDiff, type DiffHunk } from '@/composables/logic/parseDiff'

/** 标准 unified diff 样例（含文件头 + 单 hunk + context/add/del） */
const STANDARD_PATCH = `diff --git a/src/existing.ts b/src/existing.ts
index 111..222 100644
--- a/src/existing.ts
+++ b/src/existing.ts
@@ -1,3 +1,5 @@
 line1
+new line
 line2
+added line`

describe('parseDiff', () => {
  it('空 patch → 空 hunks', () => {
    expect(parseDiff('')).toEqual({ hunks: [] })
  })

  it('非 diff 文本（无 hunk 头）→ 空 hunks', () => {
    expect(parseDiff('just some text\nno diff here')).toEqual({ hunks: [] })
  })

  it('标准 patch：解析单 hunk 的行分类与行号', () => {
    const { hunks } = parseDiff(STANDARD_PATCH)
    expect(hunks).toHaveLength(1)
    const h = hunks[0]
    expect(h.oldStart).toBe(1)
    expect(h.newStart).toBe(1)

    // hunk 内行序列：hunk头 + context + add + context + add
    expect(h.lines).toHaveLength(5)
    const [h0, h1, h2, h3, h4] = h.lines

    expect(h0.type).toBe('hunk')
    expect(h0.content).toContain('@@ -1,3 +1,5 @@')

    // line1（context）：双行号推进
    expect(h1).toMatchObject({ type: 'context', oldNo: 1, newNo: 1, content: 'line1' })
    // +new line（add）：仅 newNo
    expect(h2).toMatchObject({ type: 'add', newNo: 2, content: 'new line' })
    expect(h2.oldNo).toBeUndefined()
    // line2（context）：双行号推进
    expect(h3).toMatchObject({ type: 'context', oldNo: 2, newNo: 3, content: 'line2' })
    // +added line（add）
    expect(h4).toMatchObject({ type: 'add', newNo: 4, content: 'added line' })
  })

  it('del 行仅推进 oldNo', () => {
    const patch = `--- a/f.txt
+++ b/f.txt
@@ -1,2 +1 @@
-removed
 keep`
    const { hunks } = parseDiff(patch)
    const lines = hunks[0].lines
    // hunk头 + del + context
    expect(lines[1]).toMatchObject({ type: 'del', oldNo: 1, content: 'removed' })
    expect(lines[1].newNo).toBeUndefined()
    expect(lines[2]).toMatchObject({ type: 'context', oldNo: 2, newNo: 1, content: 'keep' })
  })

  it('多 hunk：行号计数器随各 hunk 头重置', () => {
    const patch = `--- a/f
+++ b/f
@@ -1,1 +1,1 @@
 a
@@ -10,1 +20,1 @@
 b`
    const { hunks } = parseDiff(patch)
    expect(hunks).toHaveLength(2)
    expect(hunks[0].oldStart).toBe(1)
    expect(hunks[0].newStart).toBe(1)
    expect(hunks[1].oldStart).toBe(10)
    expect(hunks[1].newStart).toBe(20)
  })

  it('hunk 头省略 count（@@ -1 +1 @@）', () => {
    const patch = `--- a/f
+++ b/f
@@ -5 +5 @@
 x`
    const { hunks } = parseDiff(patch)
    expect(hunks[0].oldStart).toBe(5)
    expect(hunks[0].newStart).toBe(5)
  })

  it("'\\ No newline at end of file' 归为 meta", () => {
    const patch = `--- a/f
+++ b/f
@@ -1,1 +1,1 @@
 x
\\ No newline at end of file`
    const lines = parseDiff(patch).hunks[0].lines
    const meta = lines[lines.length - 1]
    expect(meta.type).toBe('meta')
    expect(meta.content).toBe('\\ No newline at end of file')
  })

  it('hunk 内空行作 context 处理', () => {
    const patch = `--- a/f
+++ b/f
@@ -1,2 +1,3 @@
 a

b`
    const { hunks } = parseDiff(patch)
    const lines = hunks[0].lines
    // hunk头 + context(a) + context(空行) + context(b)
    expect(lines[2]).toMatchObject({ type: 'context', content: '' })
  })

  it('文件头 meta 行被跳过（不进 hunks）', () => {
    const patch = `diff --git a/x b/x
index 111..222 100644
--- a/x
+++ b/x
@@ -1,1 +1,1 @@
 x`
    const { hunks } = parseDiff(patch)
    // 文件头 4 行不进任何 hunk
    const allTypes = hunks.flatMap((h) => h.lines.map((l) => l.type))
    expect(allTypes).not.toContain('meta')
    expect(hunks[0].lines[0].type).toBe('hunk')
  })
})

describe('diffCharsLCS', () => {
  it('完全相同 → 单个 normal segment', () => {
    expect(diffCharsLCS('hello', 'hello')).toEqual([{ text: 'hello', kind: 'normal' }])
  })

  it('a 空 → 单个 add segment', () => {
    expect(diffCharsLCS('', 'abc')).toEqual([{ text: 'abc', kind: 'add' }])
  })

  it('b 空 → 单个 del segment', () => {
    expect(diffCharsLCS('abc', '')).toEqual([{ text: 'abc', kind: 'del' }])
  })

  it('完全不同 → del 段 + add 段', () => {
    const segs = diffCharsLCS('abc', 'qrs')
    expect(segs).toHaveLength(2)
    expect(segs[0]).toEqual({ text: 'abc', kind: 'del' })
    expect(segs[1]).toEqual({ text: 'qrs', kind: 'add' })
  })

  it('单字符差异：前缀相同 + 中间单字符改动 + 后缀相同', () => {
    // "const x = 1" → "const y = 1"，仅中间 x→y 不同
    const segs = diffCharsLCS('const x = 1', 'const y = 1')
    // 期望：normal("const ") + del("x") + add("y") + normal(" = 1")
    expect(segs.map((s) => ({ text: s.text, kind: s.kind }))).toEqual([
      { text: 'const ', kind: 'normal' },
      { text: 'x', kind: 'del' },
      { text: 'y', kind: 'add' },
      { text: ' = 1', kind: 'normal' },
    ])
  })

  it('前缀变化：开头不同 + 后缀相同', () => {
    const segs = diffCharsLCS('fooBar', 'bazBar')
    expect(segs).toEqual([
      { text: 'foo', kind: 'del' },
      { text: 'baz', kind: 'add' },
      { text: 'Bar', kind: 'normal' },
    ])
  })

  it('后缀变化：前缀相同 + 结尾不同', () => {
    const segs = diffCharsLCS('getValue', 'getValues')
    expect(segs).toEqual([
      { text: 'getValue', kind: 'normal' },
      { text: 's', kind: 'add' },
    ])
  })

  it('纯新增行（a 是 b 的前缀）', () => {
    const segs = diffCharsLCS('const x', 'const x = 1')
    expect(segs).toEqual([
      { text: 'const x', kind: 'normal' },
      { text: ' = 1', kind: 'add' },
    ])
  })

  it('Unicode 字符按 code point 拆分（emoji 不被拆成代理对）', () => {
    const segs = diffCharsLCS('a🎉b', 'a🎊b')
    // emoji 各占一个 segment 字符，不被拆成两个 UTF-16 code unit
    expect(segs).toEqual([
      { text: 'a', kind: 'normal' },
      { text: '🎉', kind: 'del' },
      { text: '🎊', kind: 'add' },
      { text: 'b', kind: 'normal' },
    ])
  })

  it('超长行（合计 > 1000 字符）退化为整行级，不跑 O(m×n) DP', () => {
    // 两段 600 字符的行（合计 1200 > 1000），应退化为 del + add 整行
    const longA = 'a'.repeat(600)
    const longB = 'b'.repeat(600)
    const segs = diffCharsLCS(longA, longB)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toEqual({ text: longA, kind: 'del' })
    expect(segs[1]).toEqual({ text: longB, kind: 'add' })
  })
})

describe('computeInlineDiff', () => {
  /** 构造 hunk 的辅助函数 */
  function makeHunk(lines: { type: 'context' | 'add' | 'del' | 'hunk'; content: string; oldNo?: number; newNo?: number }[]): DiffHunk {
    return { oldStart: 1, newStart: 1, lines: lines.map((l) => ({ ...l })) }
  }

  it('del+add 配对：双方都写回 segments', () => {
    const hunk = makeHunk([
      { type: 'del', content: 'const x = 1', oldNo: 1 },
      { type: 'add', content: 'const y = 1', newNo: 1 },
    ])
    computeInlineDiff(hunk)
    const [delLine, addLine] = hunk.lines

    // del 行 segments：normal + del + normal（无 add 片段）
    expect(delLine.segments).toBeDefined()
    expect(delLine.segments!.map((s) => s.kind)).not.toContain('add')
    expect(delLine.segments).toEqual([
      { text: 'const ', kind: 'normal' },
      { text: 'x', kind: 'del' },
      { text: ' = 1', kind: 'normal' },
    ])

    // add 行 segments：normal + add + normal（无 del 片段）
    expect(addLine.segments).toBeDefined()
    expect(addLine.segments!.map((s) => s.kind)).not.toContain('del')
    expect(addLine.segments).toEqual([
      { text: 'const ', kind: 'normal' },
      { text: 'y', kind: 'add' },
      { text: ' = 1', kind: 'normal' },
    ])
  })

  it('未配对的行（del 块后无 add 块）无 segments', () => {
    const hunk = makeHunk([
      { type: 'del', content: 'removed line', oldNo: 1 },
      { type: 'context', content: 'unchanged', oldNo: 2, newNo: 1 },
    ])
    computeInlineDiff(hunk)
    // del 行后是 context 不是 add，不配对
    expect(hunk.lines[0].segments).toBeUndefined()
  })

  it('多行配对取较小行数：2 del + 1 add → 仅第一对配对', () => {
    const hunk = makeHunk([
      { type: 'del', content: 'line1 old', oldNo: 1 },
      { type: 'del', content: 'line2 old', oldNo: 2 },
      { type: 'add', content: 'line1 new', newNo: 1 },
    ])
    computeInlineDiff(hunk)
    expect(hunk.lines[0].segments).toBeDefined() // del[0] 配对 add[0]
    expect(hunk.lines[1].segments).toBeUndefined() // del[1] 无配对
    expect(hunk.lines[2].segments).toBeDefined() // add[0] 配对 del[0]
  })

  it('context 行不产生 segments', () => {
    const hunk = makeHunk([
      { type: 'context', content: 'same', oldNo: 1, newNo: 1 },
      { type: 'del', content: 'old', oldNo: 2 },
      { type: 'add', content: 'new', newNo: 2 },
      { type: 'context', content: 'same2', oldNo: 3, newNo: 3 },
    ])
    computeInlineDiff(hunk)
    expect(hunk.lines[0].segments).toBeUndefined() // context
    expect(hunk.lines[3].segments).toBeUndefined() // context
    expect(hunk.lines[1].segments).toBeDefined() // del 配对
    expect(hunk.lines[2].segments).toBeDefined() // add 配对
  })

  it('完全相同的 del+add 行 → segments 全 normal', () => {
    const hunk = makeHunk([
      { type: 'del', content: 'same content', oldNo: 1 },
      { type: 'add', content: 'same content', newNo: 1 },
    ])
    computeInlineDiff(hunk)
    expect(hunk.lines[0].segments).toEqual([{ text: 'same content', kind: 'normal' }])
    expect(hunk.lines[1].segments).toEqual([{ text: 'same content', kind: 'normal' }])
  })
})

describe('parseDiff 集成：字符级 diff', () => {
  it('parseDiff 返回的 hunks 中 del+add 行有 segments', () => {
    const patch = `--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
-const x = 1
+const y = 1
 keep`
    const { hunks } = parseDiff(patch)
    const lines = hunks[0].lines
    // hunk头 + del + add + context
    expect(lines[1].type).toBe('del')
    expect(lines[2].type).toBe('add')
    expect(lines[1].segments).toBeDefined()
    expect(lines[2].segments).toBeDefined()
    // del 行含 del 片段
    expect(lines[1].segments!.some((s) => s.kind === 'del')).toBe(true)
    // add 行含 add 片段
    expect(lines[2].segments!.some((s) => s.kind === 'add')).toBe(true)
  })
})
