// @zhushanwen/pi-llm-shared —— 统一 public API 出口。
// resolve: 模型解析（仅 ref 精确指定）+ selector 归一化 + thinking 级别校验
// call: LLM 调用（completeSimple + 凭证 + 文本提取）
// config: 泛型配置读写（mtime+size 双 key 缓存 + 原子写）
export {
	resolveModel,
	parseModelRef,
	getCurrentModelId,
	normalizeModelSelector,
	isThinkingLevel,
	type ModelSelector,
} from "./resolve.ts";
export { callLLM, joinTextBlocks, extractText, type CallLLMOptions, type CallLLMResult } from "./call.ts";
export { getConfigPath, loadConfig, saveConfig, clearConfigCache } from "./config.ts";
export { migrateLegacyConfig } from "./migrate.ts";
