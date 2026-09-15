/**
 * Schema JSON 序列化缓存（IF7/#13，TC6/DM4）。
 *
 * 同一 schema 对象引用的重复 JSON.stringify 消除：resolver（compact，instruction
 * 与 schemaEnv 复用同串，formatSchemaInstruction 现居 resolver）在单次 agent call
 * 内对同一 schema 对象各 stringify 一次；worker-message-pump 重试路径再加一次。本
 * helper 用 WeakMap 按对象引用缓存两种格式，命中返回缓存串。
 *
 * 返回值与直接 JSON.stringify 逐字节一致（compact = JSON.stringify(x)、
 * pretty = JSON.stringify(x, null, 2)）。
 *
 * 失效语义：无。WeakMap 键随 schema/opts 对象 GC 自动回收；单 call 生命周期内
 * schema 对象引用稳定（resolver/runner 均只读），引用稳定即值稳定；postMessage
 * 克隆使跨 call 恒为新对象，天然隔离（DM4）。
 *
 * 层归属：Shared（resolver 与 session-runner 共用，无 Pi 依赖）。
 */

const cache = new WeakMap<object, { compact?: string; pretty?: string }>();

/** pretty 格式（JSON.stringify(x, null, N)）的缩进空格数。 */
const PRETTY_PRINT_INDENT_SPACES = 2;

/**
 * JSON.stringify(schema) 的引用级缓存版。
 *
 * @param schema schema 对象（调用方 if 守卫保证非 undefined，helper 不判空）
 * @param mode "compact" = JSON.stringify(x)；"pretty" = JSON.stringify(x, null, 2)。
 *   pretty 为预留模式，当前生产仅 compact 消费（resolver instruction 与 schemaEnv
 *   复用同串；pretty 暂无生产调用方，仅供测试/未来调试通道）。
 */
export function stringifySchemaCached(schema: object, mode: "compact" | "pretty"): string {
  let entry = cache.get(schema);
  if (!entry) {
    entry = {};
    cache.set(schema, entry);
  }
  const hit = entry[mode];
  if (hit !== undefined) return hit;
  // [review 修复] TS lib 盲区：lib 对 object 参数声明 JSON.stringify 返回 string，但
  // schema 含 `toJSON: () => undefined` 钩子时运行时返回 undefined——直接违反本函数
  // 声明的 string 返回类型，且 `entry[mode] = undefined` 赋值不生效（缓存永不命中，
  // 重复 stringify 仅是性能损耗）。显式标注 string | undefined 捕获该窗口，fail-loud
  // 抛含恢复指引的错误——不回退 String(value)（"[object Object]" 会静默拼进 LLM
  // 指令，比崩溃更难排查）。抛错时 entry[mode] 未被赋值，缓存无毒化。
  const serialized: string | undefined =
    mode === "compact" ? JSON.stringify(schema) : JSON.stringify(schema, null, PRETTY_PRINT_INDENT_SPACES);
  if (serialized === undefined) {
    throw new Error(
      `[subagent-workflow] stringifySchemaCached: JSON.stringify returned undefined (mode=${mode}) — ` +
        `the schema object defines a toJSON hook returning undefined. ` +
        `Recovery: check the schema source (agent definition / workflow script), remove that toJSON ` +
        `or make it return a JSON-serializable value.`,
    );
  }
  entry[mode] = serialized;
  return serialized;
}
