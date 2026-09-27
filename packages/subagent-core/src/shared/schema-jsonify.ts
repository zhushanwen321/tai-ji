/**
 * Schema JSON 序列化（schema 指令嵌入 LLM prompt 的唯一出口）。
 *
 * 函数名保留 Cached 后缀仅为调用方 import 面稳定（原 WeakMap 引用级缓存已删——
 * 单 call 内 2 次 stringify 的节省低于缓存维护成本，收敛为直调 JSON.stringify）。
 *
 * 层归属：Shared（resolver 与 session-runner 共用，无 Pi 依赖）。
 */

/**
 * JSON.stringify(schema) 的 fail-loud 版。
 *
 * 护栏：TS lib 对 object 参数声明 JSON.stringify 返回 string，但 schema 含
 * `toJSON: () => undefined` 钩子时运行时返回 undefined——显式检查并抛含恢复指引
 * 的错误，不回退 String(value)（"[object Object]" 会静默拼进 LLM 指令，比崩溃
 * 更难排查）。
 */
export function stringifySchemaCached(schema: object): string {
  const serialized: string | undefined = JSON.stringify(schema);
  if (serialized === undefined) {
    throw new Error(
      `[subagent-workflow] stringifySchemaCached: JSON.stringify returned undefined — ` +
        `the schema object defines a toJSON hook returning undefined. ` +
        `Recovery: check the schema source (agent definition / workflow script), remove that toJSON ` +
        `or make it return a JSON-serializable value.`,
    );
  }
  return serialized;
}
