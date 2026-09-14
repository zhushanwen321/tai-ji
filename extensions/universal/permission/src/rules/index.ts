/**
 * rules 模块 barrel —— 只 re-export 有真实消费的公开 API（E10 收敛）。
 *
 * 生产消费面 = production.ts：getDefaultRules（内置规则拼接）+ matchRulesForArgv
 * （bash argv 匹配）。其余符号（matchRules / resolvePattern / wildcardToRegExp /
 * builtins 数据）无 barrel 消费——pipeline.ts 与各测试均走深路径 import；
 * 类型一律直接从 ../types.js import，barrel 不做类型 re-export。
 */
export { getDefaultRules } from "./builtins.js";
export { matchRulesForArgv } from "./matcher.js";
