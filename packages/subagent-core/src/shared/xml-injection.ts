// src/shared/xml-injection.ts
//
// XML 注入段渲染共享原语——subagent / workflow / model 三个 injector 的 format
// 函数曾是三份手写同构（escapeXml 逐字重复 + 同一段落骨架），提取此模块消除重复。
// 调用方保留各自的排序契约与条目渲染（字段差异大，不强行归一）。

/**
 * 转义 XML 特殊字符（注入段进每 turn system prompt，内容含 < > & 等会破坏
 * XML 结构——全部字段过一遍转义防注入段破碎）。
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * XML 注入段渲染骨架：`"\n\n<tag>"` 前导（衔接宿主 prompt 末尾）+ 引导语 +
 * 条目行 + 闭合标签，以 "\n" join。空条目返回空串（不注入）。
 *
 * 三个 injector 共用此骨架保证段落结构逐字节同构；KV-cache 契约（顺序稳定 =
 * 注入段字节稳定）由调用方排序保证，本函数不重排。
 */
export function renderXmlSection(section: {
	tag: string;
	guide: string;
	items: string[];
}): string {
  if (section.items.length === 0) return "";
  const lines = [`\n\n<${section.tag}>`, section.guide, ...section.items, `</${section.tag}>`];
  return lines.join("\n");
}
