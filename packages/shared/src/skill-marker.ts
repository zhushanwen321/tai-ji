/**
 * Composer 多 skill 注入的标记语法与预算估算 SSOT（foundation 模块）。
 *
 * 设计依据：docs/design/composer-multi-skill-injection.md §3.3：
 * - D3：skill segment 序列化产私有标记 `<xyz-skill name="..." location="..."/>`——
 *   与 pi 原生 `<skill>` 展开格式正交，runtime 只认私有标记展开，手打 /skill: 行为零变化
 * - D6：注入量预检的 CJK 感知 token 估算 + 0.8 contextWindow 阈值（常量单一处便于调参）
 * - D7：超预算整条降级为标记模式（标记清单 + 指引行，模型自主 read 的最小指令形态；
 *   R4 起降级块并入 D11 包裹块，旧 `<xyz-skills>` tag 退役但构建/解析保留以兼容存量落盘消息）
 * - D11（R4）：正文保留 `<xyz-skill/>` 占位标记 + 消息末尾集中追加 `<xyz-skill-data>`
 *   包裹块——正常形态（块内 pi 对齐展开全文）与降级形态（块内标记清单 + 指引行）共用
 *   包裹；本模块供块构建（runtime 注入器）与剥块定位切片（core 反解析三形态①）消费
 *
 * 消费方：runtime 注入器（解析/展开/降级）、shared 序列化与 core 反解析（依赖解析位置
 * 切片保留前后正文）、scripts 探针（CJK 正则同源引用）。纯文本语法层，不依赖 node API，
 * renderer barrel 整包 import 安全。
 */

/** `<xyz-skill/>` 单标记标签裸名（构建/解析/降级块三处共用，避免字符串漂移）。 */
export const SKILL_MARKER_TAG = 'xyz-skill'

/** `<xyz-skills>` 降级包裹块标签裸名（R4 起退役，仅存量落盘消息的构建/解析兼容面）。 */
export const SKILLS_BLOCK_TAG = 'xyz-skills'

/**
 * `<xyz-skill-data>` 末尾集中追加包裹块标签裸名（R4 D11）：正常形态（块内 pi 对齐
 * 展开的 `<skill>` 全文）与降级形态（块内 `<xyz-skill/>` 清单 + 指引行，原 `<xyz-skills>`
 * 统一并入）共用包裹。tag 名即新旧消息自识别锚点（存量 `<xyz-skills>` 与 R4 新块靠
 * tag 即可区分，D11 被否变体④的裁决依据），对模型传达「数据附挂区」语义。
 */
export const SKILL_DATA_BLOCK_TAG = 'xyz-skill-data'

/**
 * 降级块指引行文案（D7 正文定稿，SSOT；adversarial-review-fixes §3.4 C5 改英文——
 * 该块进 LLM 上下文，与 pi available_skills 的英文措辞风格对齐）。
 * 三要素保持：read 工具名 + 路径（"files above" 指块内标记的 name/location）+ 时机
 * （before continuing the task）。
 * 不带句号：D7 正文引号内无句号（§3.1 场景 2 示意图中的句号属示意排版）；
 * 本模块只保证块与指引行的相对形态（指引行紧跟块后一行），是否补标点由调用方/呈现层决定。
 */
export const SKILL_FALLBACK_GUIDANCE = 'Use the read tool to load the skill files above before continuing the task'

/**
 * 注入量预检阈值：预估 token > 0.8 × contextWindow 时整条消息降级为标记模式（D6）。
 * 0.2 余量留给 system prompt / 历史占用；CJK 估算取密度上界偏保守，实际触发只会提早不推迟。
 */
export const CONTEXT_WINDOW_RATIO = 0.8

/**
 * D6 估算系数（单一处便于调参，探针/校准回填检查点 6 时同源调整）：
 * - CJK 每字符 token 数：tokenizer 密度区间约 0.6~1，取上界 1.0 = 高估 = 更早降级
 * - 非 CJK 每 token 字符数：英文约 4 chars/token，÷4 为准确值
 */
export const CJK_TOKENS_PER_CHAR = 1.0
export const NON_CJK_CHARS_PER_TOKEN = 4

/**
 * B2 代码密集收紧（adversarial-review-fixes §3.3 B2）：非 CJK 字符占比超过该阈值的文本，
 * 非 CJK 分母从 ÷4（NON_CJK_CHARS_PER_TOKEN）收紧为 ÷3（CODE_DENSE_NON_CJK_CHARS_PER_TOKEN）。
 *
 * 依据：代码密集 SKILL.md（代码块 / 驼峰标识符 / 符号密集）的真实 token 密度约
 * 2.5~3.5 chars/token，÷4 低估 1-2 倍——低估放行全文注入 → pi 超窗 → 持续失败态
 * （pi overflow 链救不了「单条 ≥ keepRecentTokens」的落点）。收紧方向 = 高估 =
 * 更早降级：降级是可用性降级非功能失效（模型可自主 read，恢复动作有 toast 提示），
 * 反向风险（超窗卡死）不可接受，显式接受「宁可多降级」（受影响面 = 代码密集型
 * SKILL.md 的降级触发频率升高）。普通中英混排（占比 ≤70%）不受影响，保持 ÷4 准确值。
 */
export const CODE_DENSE_NON_CJK_RATIO = 0.7
export const CODE_DENSE_NON_CJK_CHARS_PER_TOKEN = 3

/**
 * CJK 字符类（D6「CJK 统一表意文字及常用全角标点范围」的具体区间，scripts 探针同源引用）：
 * - U+3000–U+303F CJK 符号和标点（全角空格、。、《》等）
 * - U+3400–U+4DBF 表意文字扩展 A
 * - U+4E00–U+9FFF CJK 统一表意文字（正文汉字主体）
 * - U+F900–U+FAFF CJK 兼容表意文字
 * - U+FF00–U+FFEF 半角及全角形式（全角标点 ！？与全角字母数字——全角数字/字母的
 *   tokenizer 密度接近汉字，按 CJK 计入 1.0 侧保持高估方向）
 *
 * 刻意不带 g 标志：带 g 的共享正则经 .test() 会推进 lastIndex 产生跨调用漏判；
 * 需要全局形态的消费方（探针等）自行 `new RegExp(CJK_CHAR_RE.source, 'g')`。
 */
export const CJK_CHAR_RE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/

/**
 * 属性值转义/反转义：`\` → `\\`、`"` → `\"`。
 *
 * 选反斜杠方案而非 HTML 实体：封闭规则「`\` 后只允许 `\` 或 `"`」无双转义歧义
 * （实体方案遇用户路径含字面 `&quot;` 时反转义顺序会产生歧义）；`&` 等其余字符
 * 原样保留（自建解析器不解析实体）。escape 用单遍 replace——单遍内产出不会再被
 * 同一遍扫描，天然避免二次转义；unescape 同理单遍配对还原。
 */
export function escapeSkillAttr(value: string): string {
  return value.replace(/["\\]/g, (ch) => `\\${ch}`)
}

export function unescapeSkillAttr(raw: string): string {
  return raw.replace(/\\(["\\])/g, '$1')
}

/**
 * 构建单个 `<xyz-skill/>` 自闭合标记（D3）。
 * location 缺省或空串时不输出该属性——空串路径无意义，输出 `location=""` 会污染
 * 反解析结果（空串与缺省在 Segment 语义上等价，统一归一为缺省）。
 */
export function buildSkillMarker(name: string, location?: string): string {
  const locPart =
    location !== undefined && location !== '' ? ` location="${escapeSkillAttr(location)}"` : ''
  return `<${SKILL_MARKER_TAG} name="${escapeSkillAttr(name)}"${locPart}/>`
}

/** 解析出的单标记：name/location 为反转义后的原始值；index/length 供反解析做正文切片。 */
export interface ParsedSkillMarker {
  name: string
  location?: string
  index: number
  length: number
}

/**
 * 属性值捕获片段：`[^"\\]` 逐个吃普通字符，`\\.` 整体吃转义对——保证遇到未转义的
 * `"`（结构边界）立即停止，转义引号不会被误判为标记结束。经 RegExp 构造器拼接复用。
 */
const SKILL_ATTR_VALUE = '((?:[^"\\\\]|\\\\.)*)'

/**
 * 私有标记解析正则。属性顺序固定 name → location（本模块 buildSkillMarker 的唯一生产格式）：
 * 解析刻意不宽松——顺序错乱/非自闭合一律不识别，与 D8「标记被破坏则透传」语义一致，
 * 手打残缺标记不会被误展开。matchAll 克隆正则迭代，无 module 级 lastIndex 残留问题。
 */
const SKILL_MARKER_RE = new RegExp(
  `<${SKILL_MARKER_TAG} name="${SKILL_ATTR_VALUE}"(?: location="${SKILL_ATTR_VALUE}")?/>`,
  'g',
)

/**
 * 全局解析文本中全部 `<xyz-skill/>` 标记（混排在正文中也命中），返回标记区间信息。
 * 调用方（core 反解析）按 index/length 切片即可保留标记前后的全部正文。
 */
export function parseSkillMarkers(text: string): ParsedSkillMarker[] {
  const results: ParsedSkillMarker[] = []
  for (const m of text.matchAll(SKILL_MARKER_RE)) {
    results.push({
      name: unescapeSkillAttr(m[1]),
      ...(m[2] !== undefined ? { location: unescapeSkillAttr(m[2]) } : {}),
      index: m.index,
      length: m[0].length,
    })
  }
  return results
}

/**
 * 构建降级块（D7）：`<xyz-skills>` 包裹全部自闭合标记 + 紧跟块后一行的指引文案。
 * 归拢成块的取舍见设计（块 + 单指引行的指令遵循率高于散点）；末尾不加换行，
 * 由调用方决定与后文的拼接方式。
 * 注意：此存量形态的指引行在块外（紧随闭标签一行，SKILLS_BLOCK_RE 的可选吞尾组
 * 与之配套）；R4 D11 降级形态的指引行在包裹块内，两者不可混用。R4 起新消息降级
 * 一律走 buildSkillDataBlockFallback（旧 tag 退役）；本函数保留为存量形态的构建
 * 锚点（回归测试/探针引用），不再有生产调用方。
 */
export function buildSkillsFallbackBlock(
  skills: ReadonlyArray<{ name: string; location?: string }>,
): string {
  const lines = skills.map((s) => buildSkillMarker(s.name, s.location))
  return [`<${SKILLS_BLOCK_TAG}>`, ...lines, `</${SKILLS_BLOCK_TAG}>`, SKILL_FALLBACK_GUIDANCE].join(
    '\n',
  )
}

/** 解析出的降级块：块内全部标记 + 块整体区间（index/length 供反解析保留块外正文）。 */
export interface ParsedSkillsBlock {
  skills: ParsedSkillMarker[]
  index: number
  length: number
}

/**
 * 降级块解析正则：非贪婪匹配首个闭合标签，并可选吞入紧随一行的指引文案——构建产物
 * 中指引行是块的组成部分，解析区间若止步于闭合标签，反解析按区间切片保留正文时会把
 * 指引行当孤立正文残留。指引行设为可选：hook 改写删掉指引行时块本身仍可识别（提取
 * name/location 的能力不失效）。多块场景靠 g 标志逐个命中；嵌套块不在生产形态中，
 * 首个闭合标签即视为块结束。
 */
const escapeRegExpSource = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SKILLS_BLOCK_RE = new RegExp(
  `<${SKILLS_BLOCK_TAG}>[\\s\\S]*?</${SKILLS_BLOCK_TAG}>(?:\\n${escapeRegExpSource(SKILL_FALLBACK_GUIDANCE)})?`,
  'g',
)

/**
 * 全局解析文本中全部 `<xyz-skills>` 降级块，块内标记复用 parseSkillMarkers 提取
 * （name/location/转义行为与单标记解析完全一致）。文本中无块时返回空数组。
 */
export function parseSkillsFallbackBlocks(text: string): ParsedSkillsBlock[] {
  const results: ParsedSkillsBlock[] = []
  for (const m of text.matchAll(SKILLS_BLOCK_RE)) {
    results.push({ skills: parseSkillMarkers(m[0]), index: m.index, length: m[0].length })
  }
  return results
}

// ── R4 D11：末尾集中追加包裹块（`<xyz-skill-data>`）────────────────────────

/**
 * 构建正常形态包裹块（R4 D11）：`<xyz-skill-data>` 包裹全部已展开的 `<skill>` block，
 * 形态与设计 §3.1 场景 1 逐字一致（首行开标签、每个 block 独立一行、末行闭标签，
 * 行间 '\n' 连接）。输入是「已按 get_commands 权威映射展开完成」的 block 全文——
 * 展开本身（D5 pi 逐字对齐）与同 name 去重都在 runtime 调用方完成，本函数只负责
 * 包裹与分隔约定。不追加指引行（D11 选定：正文标记与块内 `<skill>` 的 name 双向
 * 对齐已完备，指引行仅降级形态保留）；末尾不加换行，与后文的拼接（正文 + 空行 +
 * 块）由调用方完成。
 */
export function buildSkillDataBlockExpansions(expansions: ReadonlyArray<string>): string {
  return [`<${SKILL_DATA_BLOCK_TAG}>`, ...expansions, `</${SKILL_DATA_BLOCK_TAG}>`].join('\n')
}

/**
 * 构建降级形态包裹块（R4 D11，原 D7 降级块统一并入）：`<xyz-skill-data>` 包裹
 * `<xyz-skill/>` 标记清单 + 置于清单后的指引行，形态与设计 §3.1 场景 2 逐字一致。
 * 标记产出复用存量 buildSkillsFallbackBlock 同款能力（buildSkillMarker 逐项 +
 * SKILL_FALLBACK_GUIDANCE 单指引行），但指引行位于包裹块内（D11 场景 2，与存量
 * D7 块外指引行形态不同）——降级与正常两形态同构后，反解析「先剥块、再认标记」
 * 规则统一（D7 三形态①）。
 */
export function buildSkillDataBlockFallback(
  skills: ReadonlyArray<{ name: string; location?: string }>,
): string {
  const lines = skills.map((s) => buildSkillMarker(s.name, s.location))
  return [
    `<${SKILL_DATA_BLOCK_TAG}>`,
    ...lines,
    SKILL_FALLBACK_GUIDANCE,
    `</${SKILL_DATA_BLOCK_TAG}>`,
  ].join('\n')
}

/** findSkillDataBlockRange 的命中区间：slice 约定 `[start, end)`，text.slice(start, end) 即块全文。 */
export interface SkillDataBlockRange {
  start: number
  end: number
}

/**
 * `<xyz-skill-data>` 块定位正则：非贪婪匹配首个完整块（开闭标签间任意内容含换行）。
 * 与 SKILLS_BLOCK_RE 同构但无吞尾组——降级形态的指引行位于块内（D11 §3.1 场景 2），
 * 无块外指引行需要吞入。无 g 标志：本函数只取首个命中，exec 不产生 lastIndex 残留。
 */
const SKILL_DATA_BLOCK_RE = new RegExp(
  `<${SKILL_DATA_BLOCK_TAG}>[\\s\\S]*?</${SKILL_DATA_BLOCK_TAG}>`,
)

/**
 * 定位文本中首个完整 `<xyz-skill-data>...</xyz-skill-data>` 块（供 core 反解析剥块，
 * D7 三形态①「任意位置剥块优先」）。非贪婪语义：止于首个闭合标签——嵌套块不在生产
 * 形态中，与 parseSkillsFallbackBlocks 的「首个闭合即块结束」一致；无完整块（缺开
 * 标签或缺闭合标签）返回 null。切片用法：块前 = text.slice(0, start)、块后 = text.slice(end)。
 */
export function findSkillDataBlockRange(text: string): SkillDataBlockRange | null {
  const m = SKILL_DATA_BLOCK_RE.exec(text)
  return m ? { start: m.index, end: m.index + m[0].length } : null
}

/**
 * CJK 感知 token 估算（D6）：`CJK 字符数 × 1.0 + 非 CJK 字符数 ÷ 分母`，系数见
 * CJK_TOKENS_PER_CHAR / NON_CJK_CHARS_PER_TOKEN；非 CJK 占比 > CODE_DENSE_NON_CJK_RATIO
 * 时代码密集文本分母收紧为 ÷ CODE_DENSE_NON_CJK_CHARS_PER_TOKEN（B2，见该常量注释）。
 * 保留小数不取整——阈值比较由调用方完成，取整口径（向上/向下）属调用方语义，
 * 本函数不擅自决定。
 *
 * 逐 code point 计数（for-of）：CJK 区间全在 BMP 内不受影响；astral 字符（emoji 等）
 * 按 1 个非 CJK 计，避免 UTF-16 双 code unit 口径混用导致的计数错位。占比分母用
 * 总 code point 数，空串短路为 0（避免 0/0 除零）。
 */
export function estimateTokens(text: string): number {
  let cjkCount = 0
  let totalCount = 0
  for (const ch of text) {
    totalCount++
    if (CJK_CHAR_RE.test(ch)) cjkCount++
  }
  const nonCjkCount = totalCount - cjkCount
  const isCodeDense = totalCount > 0 && nonCjkCount / totalCount > CODE_DENSE_NON_CJK_RATIO
  const charsPerToken = isCodeDense ? CODE_DENSE_NON_CJK_CHARS_PER_TOKEN : NON_CJK_CHARS_PER_TOKEN
  return cjkCount * CJK_TOKENS_PER_CHAR + nonCjkCount / charsPerToken
}
