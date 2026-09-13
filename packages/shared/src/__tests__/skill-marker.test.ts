/**
 * skill-marker 单测：私有标记语法（D3）、降级块形态（D7）、末尾集中包裹块（R4 D11：
 * 正常/降级两形态构建逐字断言 + 剥块定位切片）、CJK 感知估算（D6）。
 *
 * 重点验收面：标记序列化/解析往返无损（含 location 缺省、引号/反斜杠转义边界）、
 * 降级块构建/解析往返、CJK 估算边界（纯中文/纯英文/混合/空串/全角标点/代码密集）、
 * 解析位置切片（后续 core 反解析依赖 index/length 保留标记前后正文）。
 */
import { describe, it, expect } from 'vitest'
import {
  SKILL_MARKER_TAG,
  SKILLS_BLOCK_TAG,
  SKILL_DATA_BLOCK_TAG,
  SKILL_FALLBACK_GUIDANCE,
  CONTEXT_WINDOW_RATIO,
  CJK_CHAR_RE,
  CODE_DENSE_NON_CJK_RATIO,
  CODE_DENSE_NON_CJK_CHARS_PER_TOKEN,
  NON_CJK_CHARS_PER_TOKEN,
  escapeSkillAttr,
  unescapeSkillAttr,
  buildSkillMarker,
  parseSkillMarkers,
  buildSkillsFallbackBlock,
  parseSkillsFallbackBlocks,
  buildSkillDataBlockExpansions,
  buildSkillDataBlockFallback,
  findSkillDataBlockRange,
  estimateTokens,
} from '../skill-marker'

describe('buildSkillMarker', () => {
  it('name + location 产出标记形态', () => {
    expect(buildSkillMarker('cw-cli', '/abs/path/SKILL.md')).toBe(
      '<xyz-skill name="cw-cli" location="/abs/path/SKILL.md"/>',
    )
  })

  it('location 缺省时不输出该属性', () => {
    expect(buildSkillMarker('cw-cli')).toBe('<xyz-skill name="cw-cli"/>')
  })

  it('location 空串等价缺省（归一为不输出属性）', () => {
    expect(buildSkillMarker('cw-cli', '')).toBe('<xyz-skill name="cw-cli"/>')
  })
})

describe('属性值转义（escape/unescape）', () => {
  it('引号与反斜杠均转义为反斜杠前缀', () => {
    expect(escapeSkillAttr('a"b\\c')).toBe('a\\"b\\\\c')
  })

  it('反转义还原转义对；孤立反斜杠 + 普通字符（如 \\n 字面）原样保留', () => {
    expect(unescapeSkillAttr('a\\"b\\\\c')).toBe('a"b\\c')
    expect(unescapeSkillAttr('C:\\new')).toBe('C:\\new')
  })

  it('连续混合序列往返无损（防单遍扫描二次转义）', () => {
    const samples = ['a\\"b', '\\\\\\', '"', '\\', '\\\\\\"x', '&quot;&amp;']
    for (const s of samples) {
      expect(unescapeSkillAttr(escapeSkillAttr(s))).toBe(s)
    }
  })
})

describe('parseSkillMarkers 往返无损', () => {
  it('常规 name + location 往返', () => {
    const marker = buildSkillMarker('code-review-graph', '/Users/x/.agents/skills/code-review-graph/SKILL.md')
    const parsed = parseSkillMarkers(`前文 ${marker} 后文`)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe('code-review-graph')
    expect(parsed[0].location).toBe('/Users/x/.agents/skills/code-review-graph/SKILL.md')
  })

  it('location 缺省往返后保持缺省（不产生 undefined/空串错位）', () => {
    const parsed = parseSkillMarkers(buildSkillMarker('cw-cli'))
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe('cw-cli')
    expect(parsed[0].location).toBeUndefined()
  })

  it('路径含空格往返无损', () => {
    const loc = '/Users/x/My Skills/SKILL.md'
    const parsed = parseSkillMarkers(buildSkillMarker('cw-cli', loc))
    expect(parsed[0].location).toBe(loc)
  })

  it('location 含引号/反斜杠的转义往返无损', () => {
    const trickyLocations = [
      '/Users/x/说"你好"/SKILL.md',
      'C:\\Users\\x\\SKILL.md',
      'a\\b"c\\\\d/SKILL.md',
      '/path/ends\\',
    ]
    for (const loc of trickyLocations) {
      const parsed = parseSkillMarkers(`前 ${buildSkillMarker('cw-cli', loc)} 后`)
      expect(parsed).toHaveLength(1)
      expect(parsed[0].location).toBe(loc)
    }
  })

  it('name 含转义字符往返无损（解析器对属性值不做业务校验，忠实还原）', () => {
    const parsed = parseSkillMarkers(buildSkillMarker('a"b\\c'))
    expect(parsed[0].name).toBe('a"b\\c')
  })

  it('残缺标记不解析（顺序错乱 / 非自闭合 / 未闭合引号 / 尾部截断）——破坏即透传（D8）', () => {
    expect(parseSkillMarkers('<xyz-skill location="/b.md" name="a"/>')).toHaveLength(0)
    expect(parseSkillMarkers('<xyz-skill name="a">')).toHaveLength(0)
    expect(parseSkillMarkers('<xyz-skill name="a" location="/b">')).toHaveLength(0)
    expect(parseSkillMarkers('<xyz-skill name="a location="/b"/>')).toHaveLength(0)
    expect(parseSkillMarkers('<xyz-skill name="a" loc')).toHaveLength(0)
    expect(parseSkillMarkers('正文无标记')).toHaveLength(0)
  })

  it('混排多标记返回精确位置切片（前后正文可无损还原）', () => {
    const m1 = buildSkillMarker('a')
    const m2 = buildSkillMarker('b', '/b.md')
    const text = `帮我看看 ${m1} 中间说明 ${m2} 收尾`
    const parsed = parseSkillMarkers(text)
    expect(parsed).toHaveLength(2)
    // index 与独立定位交叉验证（防 index 计算漂移）
    expect(parsed[0].index).toBe(text.indexOf(m1))
    expect(parsed[1].index).toBe(text.indexOf(m2))
    expect(parsed[0].length).toBe(m1.length)
    expect(parsed[1].length).toBe(m2.length)
    // 按区间切片：正文全部保留（u3 core 反解析依赖此契约）
    expect(text.slice(0, parsed[0].index)).toBe('帮我看看 ')
    expect(text.slice(parsed[0].index + parsed[0].length, parsed[1].index)).toBe(' 中间说明 ')
    expect(text.slice(parsed[1].index + parsed[1].length)).toBe(' 收尾')
  })
})

describe('buildSkillsFallbackBlock（D7 降级块）', () => {
  it('单 skill：块形态 + 指引行精确断言', () => {
    const block = buildSkillsFallbackBlock([{ name: 'cw-cli', location: '/c/SKILL.md' }])
    expect(block).toBe(
      [
        '<xyz-skills>',
        '<xyz-skill name="cw-cli" location="/c/SKILL.md"/>',
        '</xyz-skills>',
        'Use the read tool to load the skill files above before continuing the task',
      ].join('\n'),
    )
  })

  it('多 skill：每标记独立一行、location 缺省不输出属性', () => {
    const block = buildSkillsFallbackBlock([
      { name: 'a', location: '/a.md' },
      { name: 'b' },
    ])
    expect(block).toBe(
      [
        '<xyz-skills>',
        '<xyz-skill name="a" location="/a.md"/>',
        '<xyz-skill name="b"/>',
        '</xyz-skills>',
        SKILL_FALLBACK_GUIDANCE,
      ].join('\n'),
    )
  })

  it('指引行文案常量精确匹配（C5 英文定稿，对齐 pi available_skills 措辞风格）', () => {
    expect(SKILL_FALLBACK_GUIDANCE).toBe(
      'Use the read tool to load the skill files above before continuing the task',
    )
  })

  it('历史中文指引行（C5 前形态）：块本身仍可解析，中文指引行残留为正文（登记性锁定）', () => {
    // C5 改英文后 SKILLS_BLOCK_RE 的可选指引行组只匹配英文——已落盘历史 session 的
    // 中文指引行不再被吞进块区间，残留为孤立正文（可接受：块还原能力不受影响）。
    const legacy = '<xyz-skills>\n<xyz-skill name="a" location="/a/SKILL.md"/>\n</xyz-skills>\n请使用 read 工具加载上述 skill 文件后再继续任务'
    const blocks = parseSkillsFallbackBlocks(legacy)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].skills).toHaveLength(1)
    expect(blocks[0].skills[0]).toMatchObject({ name: 'a', location: '/a/SKILL.md' })
    // 残留含块尾与指引行之间的分隔换行（块区间止于 </xyz-skills>，可选指引行组不匹配中文）
    expect(legacy.slice(blocks[0].index + blocks[0].length)).toBe(
      '\n请使用 read 工具加载上述 skill 文件后再继续任务',
    )
  })
})

describe('parseSkillsFallbackBlocks（D7 降级块解析）', () => {
  it('构建 → 解析往返：多 skill 全部还原（含 location 缺省）', () => {
    const block = buildSkillsFallbackBlock([
      { name: 'code-review-graph', location: '/x/SKILL.md' },
      { name: 'code-simplify' },
    ])
    const blocks = parseSkillsFallbackBlocks(`前文\n${block}\n后文`)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].skills).toHaveLength(2)
    expect(blocks[0].skills[0]).toMatchObject({ name: 'code-review-graph', location: '/x/SKILL.md' })
    expect(blocks[0].skills[1]).toMatchObject({ name: 'code-simplify' })
    expect(blocks[0].skills[1].location).toBeUndefined()
  })

  it('块位置切片：块前后正文保留', () => {
    const block = buildSkillsFallbackBlock([{ name: 'a' }])
    const text = `正文头\n${block}\n尾`
    const blocks = parseSkillsFallbackBlocks(text)
    expect(blocks[0].index).toBe(text.indexOf(`<${SKILLS_BLOCK_TAG}>`))
    expect(text.slice(0, blocks[0].index)).toBe('正文头\n')
    expect(text.slice(blocks[0].index + blocks[0].length)).toBe('\n尾')
  })

  it('正文混排多个降级块逐个命中', () => {
    const b1 = buildSkillsFallbackBlock([{ name: 'a' }])
    const b2 = buildSkillsFallbackBlock([{ name: 'b', location: '/b.md' }])
    const blocks = parseSkillsFallbackBlocks(`甲 ${b1} 乙 ${b2} 丙`)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].skills[0].name).toBe('a')
    expect(blocks[1].skills[0].name).toBe('b')
  })

  it('指引行被改写删除时块本身仍识别（提取能力不失效）', () => {
    const stripped = '<xyz-skills>\n<xyz-skill name="a" location="/a.md"/>\n</xyz-skills>'
    const text = `前\n${stripped}\n后`
    const blocks = parseSkillsFallbackBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].skills[0].name).toBe('a')
    // 区间止于闭合标签（指引行不存在，可选组不吞入），切片交叉验证
    expect(blocks[0].index).toBe(text.indexOf(`<${SKILLS_BLOCK_TAG}>`))
    expect(text.slice(blocks[0].index, blocks[0].index + blocks[0].length)).toBe(stripped)
    expect(text.slice(blocks[0].index + blocks[0].length)).toBe('\n后')
  })

  it('文本无降级块返回空数组；游离单标记不算块', () => {
    expect(parseSkillsFallbackBlocks('纯文本消息')).toHaveLength(0)
    expect(parseSkillsFallbackBlocks(buildSkillMarker('a'))).toHaveLength(0)
  })
})

describe('estimateTokens（D6 CJK 感知估算 + B2 代码密集收紧）', () => {
  it('纯中文：CJK × 1.0', () => {
    expect(estimateTokens('你好世界')).toBe(4)
  })

  it('纯英文（非 CJK 占比 100% > 70%）：÷3 收紧（B2）', () => {
    expect(estimateTokens('abcd')).toBe(4 / 3)
  })

  it('空串为 0（占比分母为 0 时短路，无除零）', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('中英混合（非 CJK 占比 ≤ 70%）：CJK × 1.0 + 非 CJK ÷ 4（空格计入非 CJK）', () => {
    // '你好ab' = 2 CJK + 2 非 CJK，占比 50% 未过收紧阈值
    expect(estimateTokens('你好ab')).toBe(2.5)
    // '中文 abc 中文' = 4 CJK + 5 非 CJK（空格 a b c 空格），占比 5/9 ≈ 56%
    expect(estimateTokens('中文 abc 中文')).toBe(4 + 5 / 4)
  })

  it('B2 收紧边界：占比恰 70% 不触发（严格大于），略超即 ÷3', () => {
    // 3 CJK + 7 非 CJK：7/10 = 0.7 恰等于阈值，不触发 → ÷4
    expect(estimateTokens('一二三abcdefg')).toBe(3 + 7 / NON_CJK_CHARS_PER_TOKEN)
    // 3 CJK + 8 非 CJK：8/11 ≈ 72.7% > 70% → ÷3
    expect(estimateTokens('一二三abcdefgh')).toBe(3 + 8 / CODE_DENSE_NON_CJK_CHARS_PER_TOKEN)
  })

  it('全角标点计入 CJK（U+FF01！/ U+FF0C，/ U+3002。）', () => {
    expect(estimateTokens('你好！')).toBe(3)
    expect(estimateTokens('你好，世界。')).toBe(6)
  })

  it('代码密集样本（base64 长串，占比 100%）：全部按非 CJK ÷3 收紧（B2）', () => {
    const b64 =
      'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkhQCMkJSYqKCk='
    expect(estimateTokens(b64)).toBe(b64.length / CODE_DENSE_NON_CJK_CHARS_PER_TOKEN)
  })

  it('全角空格（U+3000）计入 CJK', () => {
    expect(estimateTokens('　')).toBe(1)
  })

  it('B2 收紧常量：阈值 0.7 / 收紧分母 3（单一调参处）', () => {
    expect(CODE_DENSE_NON_CJK_RATIO).toBe(0.7)
    expect(CODE_DENSE_NON_CJK_CHARS_PER_TOKEN).toBe(3)
  })
})

// ── B2 校准样本（adversarial-review-fixes §3.3 B2）─────────────────────────
//
// 防漂锚机制：三类真实形态样本（中文 / 英文 / 代码密集 SKILL.md 正文）对照校准基线
// 断言偏差 ≤30%——估算公式与真实 token 数的偏差超 30% 时本组翻红，翻红即回头调系数
// （重审触发条件，见设计原文），不是静默放行。
//
// TODO(B2 校准回填)：以下基线为字符比推算值（规则：CJK 0.8 tokens/char——密度区间
// 0.6~1.0 中位；非 CJK 3.5 chars/token——markdown 技术文档形态，英文散文 4.0 / 代码
// 2.5~3.5 的折中），非 tokenizer 实测。待 REAL_PI 环境用真实模型 tokenizer 对三样本
// 实测后回填实测值常量并复核偏差断言。回填时若改样本文本，须同步重算下方计数注释。

/** 校准样本 1：中文 SKILL.md 正文形态（CJK 主导，含标题/列表/编号步骤）。 */
const CALIBRATION_SAMPLE_ZH = [
  '代码审查技能使用指南',
  '',
  '本技能用于审查 Git 差异并提供结构化反馈。使用前先确认以下前置条件：',
  '',
  '- 仓库处于干净状态，无未提交的临时改动',
  '- 测试套件可以在本地完整运行',
  '- 审查范围明确限定在当前分支与主分支的差异',
  '',
  '执行步骤：',
  '',
  '1. 读取差异内容，按文件分组归类',
  '2. 对每个文件检查命名规范、类型安全与边界条件',
  '3. 汇总问题清单，按严重程度排序输出',
  '',
  '输出格式必须包含问题描述、代码位置与修复建议三个字段，缺一不可。',
].join('\n')

/** 校准样本 2：英文 SKILL.md 正文形态（markdown 结构，散文主导）。 */
const CALIBRATION_SAMPLE_EN = [
  '# Code Review Guide',
  '',
  'Use this skill to review Git diffs and produce structured feedback. Before',
  'starting, verify the following preconditions:',
  '',
  '- The working tree is clean with no uncommitted changes',
  '- The test suite runs to completion locally',
  '- The review scope is limited to the diff between this branch and main',
  '',
  '## Steps',
  '',
  '1. Read the diff and group changes by file',
  '2. For each file, check naming conventions, type safety, and edge cases',
  '3. Collect findings and sort them by severity before writing the report',
  '',
  'The output must include the problem description, the code location, and a',
  'suggested fix for every finding.',
].join('\n')

/** 校准样本 3：代码密集 SKILL.md 正文形态（ts 代码块 + 反引号行内代码 + 符号密度高）。 */
const CALIBRATION_SAMPLE_CODE = [
  'Usage:',
  '',
  '```ts',
  "import { createClient } from './client'",
  '',
  'const client = createClient({',
  "  baseUrl: 'https://api.example.com/v1',",
  '  retry: { maxAttempts: 3, backoffMs: 250 },',
  "  headers: { 'X-Trace-Id': crypto.randomUUID() },",
  '})',
  '',
  'export async function fetchUser(id: string): Promise<User | null> {',
  '  if (!/^[a-z0-9-]{8,36}$/.test(id)) throw new InvalidIdError(id)',
  '  const res = await client.get(`/users/${id}?fields=profile,settings`)',
  '  return res.status === 404 ? null : (await res.json()) as User',
  '}',
  '```',
  '',
  'Notes:',
  '- `retry.backoffMs` doubles on each attempt (250 -> 500 -> 1000)',
  '- All errors extend `BaseError`; catch narrowly, never blanket-catch',
].join('\n')

/**
 * 校准基线（字符比推算，待实测回填——见上方 TODO）。表达式即推算规则的自解释形态，
 * 计数来源（写定样本时的实测计数）：
 * - ZH：180 CJK + 34 非 CJK（占比 15.9%，不触发收紧）
 * - EN：0 CJK + 619 非 CJK（占比 100%，触发 ÷3）
 * - CODE：0 CJK + 641 非 CJK（占比 100%，触发 ÷3）
 */
const BASELINE_ZH = 180 * 0.8 + 34 / 3.5
const BASELINE_EN = 619 / 3.5
const BASELINE_CODE = 641 / 3.5

/** 统计文本的非 CJK code point 数（与生产 estimateTokens 同源字符类）。 */
function countNonCjk(text: string): number {
  let non = 0
  for (const ch of text) {
    if (!CJK_CHAR_RE.test(ch)) non++
  }
  return non
}

describe('estimateTokens B2 校准样本（三类真实形态，偏差 ≤30% 防漂锚）', () => {
  it('中文样本：估算偏差 ≤30% 且方向为高估（CJK 取密度上界）', () => {
    const est = estimateTokens(CALIBRATION_SAMPLE_ZH)
    const dev = Math.abs(est - BASELINE_ZH) / BASELINE_ZH
    expect(dev, `中文样本估算偏差 ${(dev * 100).toFixed(1)}% 超 30%——公式或基线漂移，回头调系数（B2 重审条件）`).toBeLessThanOrEqual(0.3)
    expect(est, '估算须 ≥ 基线（保守高估方向，宁可多降级）').toBeGreaterThanOrEqual(BASELINE_ZH)
  })

  it('英文样本：估算偏差 ≤30% 且方向为高估（÷3 收紧 vs 3.5 推算基线）', () => {
    const est = estimateTokens(CALIBRATION_SAMPLE_EN)
    const dev = Math.abs(est - BASELINE_EN) / BASELINE_EN
    expect(dev, `英文样本估算偏差 ${(dev * 100).toFixed(1)}% 超 30%——公式或基线漂移，回头调系数（B2 重审条件）`).toBeLessThanOrEqual(0.3)
    expect(est, '估算须 ≥ 基线（保守高估方向，宁可多降级）').toBeGreaterThanOrEqual(BASELINE_EN)
  })

  it('代码密集样本：估算偏差 ≤30%，且收紧（÷3）确实生效', () => {
    const est = estimateTokens(CALIBRATION_SAMPLE_CODE)
    const dev = Math.abs(est - BASELINE_CODE) / BASELINE_CODE
    expect(dev, `代码密集样本估算偏差 ${(dev * 100).toFixed(1)}% 超 30%——公式或基线漂移，回头调系数（B2 重审条件）`).toBeLessThanOrEqual(0.3)
    // 收紧生效的结构断言：est ≥ 非 CJK 字符数 ÷3（占比判定失效回落 ÷4 时 est < ÷3 值，翻红）
    const nonCjk = countNonCjk(CALIBRATION_SAMPLE_CODE)
    expect(est, '代码密集样本估算须 ≥ 收紧后字符比推算值（÷3 生效的证明）').toBeGreaterThanOrEqual(nonCjk / CODE_DENSE_NON_CJK_CHARS_PER_TOKEN)
    expect(est, '估算须严格大于 ÷4 推算值（未收紧即漂移——B2 收紧失效）').toBeGreaterThan(nonCjk / NON_CJK_CHARS_PER_TOKEN)
  })
})

describe('常量与 CJK 字符类定义', () => {
  it('阈值常量为 0.8（单一调参处）', () => {
    expect(CONTEXT_WINDOW_RATIO).toBe(0.8)
  })

  it('标签名常量与构建/解析产物一致', () => {
    expect(SKILL_MARKER_TAG).toBe('xyz-skill')
    expect(SKILLS_BLOCK_TAG).toBe('xyz-skills')
  })

  it('CJK 区间边界：五个区间逐一边缘码位判定', () => {
    // [否, 是] 对：区间外沿/内沿各一
    const edges: Array<[string, boolean]> = [
      ['\u2FFF', false], ['\u3000', true], ['\u303F', true], ['\u3040', false],
      ['\u33FF', false], ['\u3400', true], ['\u4DBF', true], ['\u4DC0', false],
      ['\u4DFF', false], ['\u4E00', true], ['\u9FFF', true], ['\uA000', false],
      ['\uF8FF', false], ['\uF900', true], ['\uFAFF', true], ['\uFB00', false],
      ['\uFEFF', false], ['\uFF01', true], ['\uFFEF', true], ['\uFFF0', false],
    ]
    for (const [ch, expected] of edges) {
      expect(CJK_CHAR_RE.test(ch)).toBe(expected)
    }
  })

  it('半角字母数字与 emoji 不属 CJK（按非 CJK ÷4 侧计入）', () => {
    expect(CJK_CHAR_RE.test('a')).toBe(false)
    expect(CJK_CHAR_RE.test('1')).toBe(false)
    expect(CJK_CHAR_RE.test('😀')).toBe(false)
  })
})

// ── R4 D11：末尾集中追加包裹块（`<xyz-skill-data>`）────────────────────────

describe('buildSkillDataBlockExpansions（R4 D11 正常形态包裹块）', () => {
  it('常量标签名为 xyz-skill-data（与 SKILL_MARKER_TAG/SKILLS_BLOCK_TAG 命名同族）', () => {
    expect(SKILL_DATA_BLOCK_TAG).toBe('xyz-skill-data')
  })

  it('单 skill：与设计 §3.1 场景 1 形态逐字一致（首行开标签、block 独立一行、末行闭标签）', () => {
    const expansion = [
      '<skill name="code-review-graph" location="/Users/x/.agents/skills/code-review-graph/SKILL.md">',
      'References are relative to /Users/x/.agents/skills/code-review-graph.',
      '',
      '（SKILL.md 全文…）',
      '</skill>',
    ].join('\n')
    expect(buildSkillDataBlockExpansions([expansion])).toBe(
      [`<${SKILL_DATA_BLOCK_TAG}>`, expansion, `</${SKILL_DATA_BLOCK_TAG}>`].join('\n'),
    )
  })

  it('多 skill：每个展开 block 独立一行、顺序保持输入序（去重由 runtime 负责，本函数不做）', () => {
    const e1 = '<skill name="a" location="/a/SKILL.md">\nA 正文\n</skill>'
    const e2 = '<skill name="b" location="/b/SKILL.md">\nB 正文\n</skill>'
    const block = buildSkillDataBlockExpansions([e1, e2])
    expect(block).toBe([`<${SKILL_DATA_BLOCK_TAG}>`, e1, e2, `</${SKILL_DATA_BLOCK_TAG}>`].join('\n'))
  })

  it('空列表：仅包裹壳（join 语义；mapping_unavailable 时是否调用由 runtime 裁决）', () => {
    expect(buildSkillDataBlockExpansions([])).toBe('<xyz-skill-data>\n</xyz-skill-data>')
  })

  it('正常形态不追加指引行（D11 选定：name 双向对齐已完备，指引行仅降级形态保留）', () => {
    const block = buildSkillDataBlockExpansions(['<skill name="a">\nbody\n</skill>'])
    expect(block).not.toContain(SKILL_FALLBACK_GUIDANCE)
  })
})

describe('buildSkillDataBlockFallback（R4 D11 降级形态包裹块）', () => {
  it('单 skill：与设计 §3.1 场景 2 形态逐字一致（标记清单 + 指引行在包裹块内）', () => {
    expect(buildSkillDataBlockFallback([{ name: 'cw-cli', location: '/c/SKILL.md' }])).toBe(
      [
        '<xyz-skill-data>',
        '<xyz-skill name="cw-cli" location="/c/SKILL.md"/>',
        SKILL_FALLBACK_GUIDANCE,
        '</xyz-skill-data>',
      ].join('\n'),
    )
  })

  it('多 skill：每标记独立一行、location 缺省不输出属性、指引行置于清单后', () => {
    expect(
      buildSkillDataBlockFallback([
        { name: 'a', location: '/a.md' },
        { name: 'b' },
      ]),
    ).toBe(
      [
        '<xyz-skill-data>',
        '<xyz-skill name="a" location="/a.md"/>',
        '<xyz-skill name="b"/>',
        SKILL_FALLBACK_GUIDANCE,
        '</xyz-skill-data>',
      ].join('\n'),
    )
  })

  it('与存量 buildSkillsFallbackBlock 的关系：标记清单同源，指引行位置不同（块内 vs 存量块外）', () => {
    const skills: ReadonlyArray<{ name: string; location?: string }> = [
      { name: 'a', location: '/a.md' },
      { name: 'b' },
    ]
    const legacy = buildSkillsFallbackBlock(skills)
    const r4 = buildSkillDataBlockFallback(skills)
    // 标记清单（无指引行的中间行）逐字一致：内容产出复用存量能力
    const markerLines = (s: string) => s.split('\n').filter((l) => l.startsWith('<xyz-skill '))
    expect(markerLines(r4)).toEqual(markerLines(legacy))
    // 指引行位置差异：存量 D7 在闭标签后一行（块外），R4 D11 在闭标签前一行（块内）
    expect(legacy.endsWith(`${SKILL_FALLBACK_GUIDANCE}`)).toBe(true)
    expect(r4.endsWith(`${SKILL_FALLBACK_GUIDANCE}\n</${SKILL_DATA_BLOCK_TAG}>`)).toBe(true)
  })
})

describe('findSkillDataBlockRange（R4 D11 剥块定位切片）', () => {
  it('命中：区间为 slice 约定（[start, end)），切片即块全文，块前后正文无损', () => {
    const block = buildSkillDataBlockFallback([{ name: 'a', location: '/a.md' }])
    const text = `帮我 review 这段代码 <xyz-skill name="a" location="/a.md"/>\n\n${block}`
    const range = findSkillDataBlockRange(text)
    if (!range) throw new Error('expected a block range')
    const start = text.indexOf(`<${SKILL_DATA_BLOCK_TAG}>`)
    // index 与独立定位交叉验证（防 index 计算漂移）
    expect(range).toEqual({ start, end: start + block.length })
    expect(text.slice(range.start, range.end)).toBe(block)
    expect(text.slice(0, range.start)).toBe(
      '帮我 review 这段代码 <xyz-skill name="a" location="/a.md"/>\n\n',
    )
    expect(text.slice(range.end)).toBe('')
  })

  it('未命中：纯文本 / 只有开标签未闭合 / 只有闭合标签 → null', () => {
    expect(findSkillDataBlockRange('纯文本消息')).toBeNull()
    expect(findSkillDataBlockRange('<xyz-skill-data>\n<xyz-skill name="a"/>')).toBeNull()
    expect(findSkillDataBlockRange('正文 </xyz-skill-data> 尾')).toBeNull()
  })

  it('嵌套截断：非贪婪止于首个闭合标签（嵌套非生产形态，与 parseSkillsFallbackBlocks 同语义）', () => {
    const close = '</xyz-skill-data>'
    const text = `<${SKILL_DATA_BLOCK_TAG}>A<${SKILL_DATA_BLOCK_TAG}>B${close}C${close}`
    const range = findSkillDataBlockRange(text)
    if (!range) throw new Error('expected a block range')
    expect(range.start).toBe(0)
    expect(range.end).toBe(text.indexOf(close) + close.length)
    expect(text.slice(range.end)).toBe(`C${close}`)
  })

  it('多块取首个：正文混排多块时返回第一处命中（防御 hook 改写把块挪位）', () => {
    const b1 = buildSkillDataBlockFallback([{ name: 'a' }])
    const b2 = buildSkillDataBlockExpansions(['<skill name="b">\nB 全文\n</skill>'])
    const text = `甲 ${b1} 乙 ${b2} 丙`
    const range = findSkillDataBlockRange(text)
    if (!range) throw new Error('expected a block range')
    expect(text.slice(range.start, range.end)).toBe(b1)
    expect(range.start).toBe(text.indexOf(`<${SKILL_DATA_BLOCK_TAG}>`))
  })

  it('块位于文本中段（D7 三形态①任意位置剥块）+ 两形态均定位', () => {
    const cases = [
      buildSkillDataBlockExpansions(['<skill name="x">\nX 全文\n</skill>']),
      buildSkillDataBlockFallback([{ name: 'y', location: '/y.md' }]),
    ]
    for (const block of cases) {
      const text = `头部 ${block} 尾部`
      const range = findSkillDataBlockRange(text)
      if (!range) throw new Error('expected a block range')
      expect(text.slice(0, range.start)).toBe('头部 ')
      expect(text.slice(range.start, range.end)).toBe(block)
      expect(text.slice(range.end)).toBe(' 尾部')
    }
  })

  it('旧解析器不误认新块（tag 退役但新旧自识别——存量 parseSkillsFallbackBlocks 对新块零命中）', () => {
    const block = buildSkillDataBlockFallback([{ name: 'a', location: '/a.md' }])
    expect(parseSkillsFallbackBlocks(`前\n${block}\n后`)).toHaveLength(0)
  })
})
