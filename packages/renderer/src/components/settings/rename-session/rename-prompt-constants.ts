/**
 * RenameSessionPage 的标题提示词数据常量（与页面分离：内置词表含 emoji 属数据内容
 * 而非 UI 装饰，taste/no-emoji-in-template 只看 SFC 模板——数据常量独立 .ts 承载）。
 *
 * 与 extension 侧 extensions/universal/rename-session/src/llm.ts 的 BUILTIN_TEMPLATES /
 * RENAME_SYSTEM_PROMPT / GENERIC_SYSTEM_PROMPT 同值镜像（跨包不 import，extension 改词表
 * 须同步本处——预览文案漂移只影响展示，不影响实际生效内容）。
 */
import type { RenameStyle } from '@taiji/shared'

/** 内置风格词表的 renderer 镜像（只读预览用；custom 风格不在此表）。 */
export const BUILTIN_PREVIEW: Readonly<Record<Exclude<RenameStyle, 'custom'>, string>> = {
  slug: '根据以上对话，为这个会话生成一个 slug 式标题。要求：\n- 名词或动名词词组，例：「修复登录超时」「重构配置加载」「refactor-config-loader」\n- 反例（错误）：「我帮你修复了登录 bug」「This session is about fixing bugs」\n- 英文小写 kebab-case，中文直接用词组，不要句号\n使用对话所用的语言。只输出标题文本。',
  sentence: '根据以上对话，为这个会话生成一个简短标题：一个不超过 20 字的完整短句，概括本次任务的目标或结果，不加句尾标点。反例（错误）：「重构」。使用对话所用的语言。只输出标题文本。',
  emoji: '根据以上对话，为这个会话生成一个标题：以一个贴切的 emoji 开头，后接不超过 15 字的词组或短句。例：「🔧 重构配置加载」「🐛 修复登录超时」。使用对话所用的语言。只输出标题文本。',
}

/** slug 风格的 systemPrompt（参考折叠区展示）——与 extension RENAME_SYSTEM_PROMPT 同值镜像。 */
export const SLUG_SYSTEM_PROMPT =
  '你是会话标题生成器。根据对话生成 slug 式标题：名词或动名词词组，不要完整句子、不要主谓宾、不要代词或「已/完成了」这类时态表述、不要句尾标点。英文用小写 kebab-case。使用对话所用的语言，3-6 个词。只输出标题文本。'

/** 风格示例标题（演示用固定值，非 UI 文案；custom 无固定示例由页面渲染 '—'）。 */
export const STYLE_EXAMPLES: Readonly<Record<RenameStyle, string>> = {
  slug: 'refactor-config-loader',
  sentence: '重构配置加载模块',
  emoji: '🔧 重构配置加载',
  custom: '—',
}
