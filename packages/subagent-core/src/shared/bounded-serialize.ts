/**
 * bounded JSON pretty 序列化原语（sink 设计 U6a / B7）。
 *
 * 来源：自 pi-sw（extensions/universal/subagent-workflow）interface/helpers.ts
 * 的同名私有函数**逐字平移**（函数体逐字符一致，仅补 export）——输出与该实现
 * 字节级一致，由 `__tests__/bounded-serialize.test.ts` 的等价锚定 + 硬编码字节
 * 快照断言守护。pi-sw 本地实现删除与消费切换归 u-sw-misc 单元（设计 U11）。
 */

// ── bounded pretty 序列化（IF13/#19，TC5/ES5）────────────────

const JSON_INDENT = 2;

/**
 * bounded JSON pretty 序列化：只生成会被保留的前缀（≤8000 输出与
 * JSON.stringify(value, null, JSON_INDENT) 逐字节一致；>8000 输出与
 * 全量序列化后 .slice(0, budget) + "\n... (truncated)" 逐字节一致——
 * 等价测试锚定，见 __tests__/bounded-serialize.test.ts）。
 *
 * 现状成本：全量 stringify 产生数 MB 中间串再丢弃 99%；本函数在输出字符流
 * 越过 budget 后停止一切生成。保真策略：原语（string/number/boolean/null/bigint）
 * 逐值复用 JSON.stringify（转义/Unicode/数字格式原生一致，零重实现），仅结构
 * 拼装（2 空格缩进/逗号/括号）自实现。
 *
 * 特殊值语义（TC5 a-d，与原生 JSON.stringify 全值域对齐）：
 * (a) 含 toJSON 的对象 → 该子树整体走一次 JSON.stringify(subtree)（原生会先调
 *     toJSON，如 Date 输出带引号序列化串；bounded 拼装展开会与原生不同）。注意
 *     边界：toJSON 返回对象时原生 pretty 会按缩进展开，本实现按原语串接其
 *     compact 形态——设计 TC5 锚定面为 Date 型（返回字符串）toJSON。
 * (b) 任何 stringify 抛出（BigInt → TypeError）→ 整体回退 String(value)（对齐
 *     旧实现整体 try/catch 的整串回退；禁止逐节点回退——输出形态与整串回退不同）。
 * (c) 对象属性值为 undefined/function/symbol → 拼装时跳过（原生省略）。
 * (d) 数组元素为 undefined/function/symbol → 序列化为 "null"（原生行为）。
 *
 * 截断边界（输出字符流层级，与对完整串 slice 逐字节等价）：逐段 append 时本段
 * 会使总长越过 budget → 只 append 本段前 (budget - 已累积) 字符（恰好 budget，
 * 可切在转义序列/括号中间，不补任何结构闭合）；越过（exceeded）才追加
 * "\n... (truncated)" 标记——恰好 ===budget 不加（> 判定）。
 *
 * 祖先 Set 循环引用守卫：命中 → 整体回退 String(value)（同 (b) 整串回退语义）。
 */
export function boundedPrettySerialize(value: unknown, budget: number): string {
  const ancestors = new Set<object>();
  let out = "";
  let exceeded = false;

  /** 逐段追加：越过 budget 时截到恰好 budget 并置 exceeded（后续生成全部剪枝）。 */
  function append(s: string): void {
    if (exceeded) return;
    if (out.length + s.length <= budget) {
      out += s;
      return;
    }
    out += s.slice(0, budget - out.length);
    exceeded = true;
  }

  /** 数组分支：元素逐个缩进序列化（(d) undefined/function/symbol → "null"）。 */
  function serializeArray(
    arr: unknown[],
    depth: number,
    childIndent: string,
    closeIndent: string,
  ): void {
    if (arr.length === 0) {
      append("[]");
      return;
    }
    append("[\n");
    for (let i = 0; i < arr.length && !exceeded; i++) {
      if (i > 0) append(",\n");
      append(childIndent);
      const el = arr[i];
      // (d) 数组元素 undefined/function/symbol → "null"
      if (el === undefined || typeof el === "function" || typeof el === "symbol") {
        append("null");
      } else {
        serialize(el, depth + 1);
      }
    }
    append("\n" + closeIndent + "]");
  }

  /** 对象分支：(c) 属性 undefined/function/symbol 跳过后逐对序列化。 */
  function serializeObject(
    obj: object,
    depth: number,
    childIndent: string,
    closeIndent: string,
  ): void {
    // (c) 对象属性 undefined/function/symbol 跳过（Object.entries 同原生：
    // 只取 own enumerable，symbol 键天然不出现；getter 求值语义与原生一致）
    const entries = Object.entries(obj).filter(
      ([, val]) => val !== undefined && typeof val !== "function" && typeof val !== "symbol",
    );
    if (entries.length === 0) {
      append("{}");
      return;
    }
    append("{\n");
    for (let i = 0; i < entries.length && !exceeded; i++) {
      if (i > 0) append(",\n");
      append(childIndent + JSON.stringify(entries[i][0]) + ": ");
      serialize(entries[i][1], depth + 1);
    }
    append("\n" + closeIndent + "}");
  }

  function serialize(v: unknown, depth: number): void {
    if (exceeded) return;
    const t = typeof v;
    // 原语逐值复用原生序列化；bigint 的 JSON.stringify 抛 TypeError → 顶层 catch
    // 整体回退 (b)；NaN/Infinity → "null"（原生行为）
    if (v === null || t === "string" || t === "number" || t === "boolean" || t === "bigint") {
      append(JSON.stringify(v));
      return;
    }
    if (t === "object" && v !== null) {
      const obj = v as object;
      if (ancestors.has(obj)) {
        // 循环引用 → 整体回退 String(value)（旧实现同款整串回退）
        throw new TypeError("circular reference");
      }
      // (a) toJSON 子树整体 stringify（Reflect.get 取属性，避免不安全断言）
      if (typeof Reflect.get(obj, "toJSON") === "function") {
        append(JSON.stringify(obj));
        return;
      }
      ancestors.add(obj);
      const childIndent = " ".repeat(JSON_INDENT * (depth + 1));
      const closeIndent = " ".repeat(JSON_INDENT * depth);
      if (Array.isArray(obj)) {
        serializeArray(obj as unknown[], depth, childIndent, closeIndent);
      } else {
        serializeObject(obj, depth, childIndent, closeIndent);
      }
      ancestors.delete(obj);
      return;
    }
    // 顶层 undefined/function/symbol（调用方守卫后不可达；防御兜底对齐原生 "null"）
    append(JSON.stringify(v) ?? "null");
  }

  try {
    serialize(value, 0);
    return exceeded ? out + "\n... (truncated)" : out;
  } catch {
    // (b) 整体回退：String(value)（超 budget 仍截断 + 标记，与旧实现截断路径一致）
    const fallback = String(value);
    return fallback.length > budget
      ? fallback.slice(0, budget) + "\n... (truncated)"
      : fallback;
  }
}
