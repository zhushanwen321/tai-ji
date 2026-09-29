// src/orchestration/canonical-json.ts
//
// canonical JSON 序列化与哈希（键字典序递归排序的稳定序列化形态）。
//
// 为什么需要：回放一致性校验与 schema 模式调用的输入比对依赖「同一逻辑值恒产
// 同一序列化」——JSON.stringify 的键序由插入序决定，schema 对象经 worker IPC
// 往返与历史记录对照时，两个执行实例的对象构造序可能不同（从缓存/外部数据
// 重建的键序不保证），同值不同文即假 mismatch。canonical 形态（对象键字典序
// 递归排序、数组保序、原始值直出）消除该漂移——场景 13 的「零误报 mismatch」。
//
// 语义边界：undefined 值的键跳过（JSON 语义）；BigInt / 循环引用抛 TypeError
// （调用方按校验失败处置——这两类值本就不可 IPC 传输，出现在比对面即编程错误）。
//
// 落位独立模块：消费方含 worker-message-pump（回放比对）与 terminal-actions
// （agent-started 入参全文落账——canonical 形态与比对管道同源，parse 往返后
// 再 canonical 化幂等）。两文件间已有 pump → terminal-actions 的依赖边，
// 工具留在任一侧都会形成反向 import 成环（原实装居 pump、注释说明的正是该
// 约束；第二消费方出现时抽出，依赖图保持无环）。
import { createHash } from "node:crypto";

/** canonical JSON 序列化（对象键字典序递归排序、数组保序、原始值直出）。 */
export function canonicalJsonStringify(value: unknown): string {
  return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonical(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serializeCanonical(v)}`).join(",")}}`;
}

/** canonical 形态的 SHA-256 哈希（十六进制，64 字符）——回放一致性比对的键形态。 */
export function canonicalJsonHash(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
}
