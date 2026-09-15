/**
 * AI Classifier barrel（层 3 入口）——只暴露有真实消费的 2 符号（E10 收敛）。
 *
 * 唯一生产消费者 production.ts：createClassifier（+ 装配所需的 ClassifierDeps 类型）。
 * prompt / json-parser / model-resolver 的消费方与测试均走深路径 import；
 * 类型一律直接从 ../types.js import，barrel 不做类型 re-export。
 */

export type { ClassifierDeps } from "./classifier.js";
export { createClassifier } from "./classifier.js";
