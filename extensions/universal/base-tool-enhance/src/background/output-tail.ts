/**
 * 输出文件 tail 读取薄壳（D7：输出落文件不占内存，查询时按需读尾部）。
 *
 * tail 算法单点在 extension-protocol（ext-simplify-13：与 runtime 桌面预览侧共用，
 * 原两份同构实现签名已实际漂移）。本模块只保留 bte 私有需求：
 *  - 50KB / 2000 行截断上限常量（pi 内置 bash 同款，bash.js truncate.ts）——口径是
 *    本包产品决策，由调用方（bash-output-tool）传参给 protocol 原语
 *  - readTailSummary：exit 边沿的 tail 摘要（存条目 / M3 通知用）
 */

import { readOutputTail as readOutputTailPrimitive } from "@xyz-agent/extension-protocol/background-task";

/** pi 内置 bash 同款截断上限（last 2000 lines / 50KB = 51200 bytes，先到为准）。 */
export const TAIL_MAX_LINES = 2000;
export const TAIL_MAX_BYTES = 51_200;
/** exit 边沿 tail 摘要参数（存条目/M3 通知用）。 */
const SUMMARY_TAIL_LINES = 5;
const SUMMARY_MAX_CHARS = 800;

/**
 * 轮询器 exit 边沿的 tail 摘要（存进条目、M3 通知用）：末尾几行的紧凑文本。
 */
export function readTailSummary(outputFile: string, maxChars: number = SUMMARY_MAX_CHARS): string | undefined {
	const tail = readOutputTailPrimitive(outputFile, { maxLines: SUMMARY_TAIL_LINES, maxBytes: maxChars });
	if (tail === undefined) return undefined;
	const compact = tail.text.trim();
	return compact.length > 0 ? compact.slice(-maxChars) : undefined;
}
