// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）
// 运行命令：npx vitest run tests/structured-output.test.ts
//
// 测试 structured-output extension 的核心逻辑：
// 1. Schema 解析与 Ajv 编译
// 2. Tool execute 校验（通过/失败）
// 3. 环境变量检测逻辑
// 4. workflow 模式透传断言（U1/D2：pi-ai 参数层是唯一校验权威，execute 不再 ajv 复核）
// 5. createWorkflowToolDefinition 注册期防御 + parameters 合成（D4 注入 / P6 包装 / fail-fast）
// 6. index 装配分岔（D1：env 有值 → workflow 变体；无值 → 日常变体）
//
// [HISTORICAL] 08-01 事故的「权威 schema 唯一校验」语义已由 pi-ai 参数层承接：
// 工具 parameters 即权威 schema（见 createWorkflowToolDefinition），execute 透传。
// 旧的 execute 内权威 ajv 校验（validateWithAuthoritative）已删除——它不是双保险
// 而是第二校验权威（方案 A 禁止形态）。LLM 自报 schema 绕过的防线从「execute 内
// 复核」变为「模型根本没有 schema 参数可传」（结构约束）。

// 直接使用真实的 Ajv，因为这是核心依赖
import Ajv from "ajv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 被测主入口（src/index.ts 导出 executeStructuredOutput 供直接调用；
// 双变体工厂供注册期防御/合成与 env→execute 桥接测试调用）
import {
  createDailyToolDefinition,
  createWorkflowToolDefinition,
  executeStructuredOutput,
  SO_SCHEMA_SIZE_WARN_BYTES,
} from "../src/index.js";
// mock pi 公共 fixture（M5-T4：与 characterization-hook.test.ts 共享）
import {
  createMockPi,
  FAILED_TOOL_END,
  loadExtension,
  restoreSchemaEnv,
  SCHEMA,
  SCHEMA_ENV_NAME,
  SUCCESS_TOOL_END,
  turnEndPayload,
} from "./mock-pi-fixture.js";

// ── 纯逻辑测试：Schema 解析 + Ajv 校验 ──────────────────────

describe("Schema parsing and Ajv validation", () => {
  let ajv: Ajv;

  beforeEach(() => {
    ajv = new Ajv({ strict: false });
  });

  it("compiles a valid schema and validates matching input", () => {
    const schema = {
      type: "object",
      properties: {
        mustFix: { type: "boolean" },
        issues: { type: "array", items: { type: "string" } },
      },
      required: ["mustFix"],
    };

    const validate = ajv.compile(schema);

    expect(validate({ mustFix: true, issues: ["bug"] })).toBe(true);
    expect(validate({ mustFix: false })).toBe(true);
    expect(validate({ mustFix: true, extra: "ok" })).toBe(true); // additionalProperties allowed by default
  });

  it("rejects input that does not match schema", () => {
    const schema = {
      type: "object",
      properties: {
        count: { type: "number" },
      },
      required: ["count"],
    };

    const validate = ajv.compile(schema);

    expect(validate({ count: "not-a-number" })).toBe(false);
    expect(validate({})).toBe(false); // missing required
    expect(validate({ count: 42 })).toBe(true);
  });

  it("produces detailed error messages on validation failure", () => {
    const schema = {
      type: "object",
      properties: {
        score: { type: "number", minimum: 0, maximum: 100 },
      },
      required: ["score"],
    };

    const validate = ajv.compile(schema);
    validate({ score: -1 });

    expect(validate.errors).toBeDefined();
    expect(validate.errors!.length).toBeGreaterThan(0);
    const errorMsg = validate.errors!.map((e) => `${e.instancePath} ${e.message}`).join("; ");
    expect(errorMsg).toContain("must be");
  });

  it("validates nested object schemas", () => {
    const schema = {
      type: "object",
      properties: {
        result: {
          type: "object",
          properties: {
            items: { type: "array" },
          },
          required: ["items"],
        },
      },
      required: ["result"],
    };

    const validate = ajv.compile(schema);

    expect(validate({ result: { items: [1, 2, 3] } })).toBe(true);
    expect(validate({ result: {} })).toBe(false); // missing items
    expect(validate({})).toBe(false); // missing result
  });
});

// ── 环境变量解析逻辑 ──────────────────────────────────────

describe("PI_WORKFLOW_SCHEMA schema JSON parsing", () => {
  // 注：旧版测的是 STRUCTURED_OUTPUT_SCHEMA env 名（错误）+ 已删除的 block 语义。
  // 实际 env 名是 PI_WORKFLOW_SCHEMA（见 src/tool-definition.ts ENV_SCHEMA）。
  // env 驱动的装配分岔行为由下面的 'index assembly fork' 测试组用 mock pi 覆盖；
  // 这里仅保留 schema JSON 解析的纯逻辑。
  it("parses valid JSON schema", () => {
    const raw = JSON.stringify({
      type: "object",
      properties: { answer: { type: "string" } },
    });
    const parsed = JSON.parse(raw);
    expect(parsed.type).toBe("object");
    expect(parsed.properties.answer.type).toBe("string");
  });

  it("JSON.parse throws on invalid JSON", () => {
    expect(() => JSON.parse("{invalid json")).toThrow();
  });

  it("Ajv rejects invalid schema type value", () => {
    const ajv = new Ajv({ strict: false });
    // Schema with invalid type value — compile throws in non-strict mode too
    const badSchema = { type: "not-a-real-type" };
    expect(() => ajv.compile(badSchema)).toThrow();
  });
});

// ── Tool execute 模拟测试 ──────────────────────────────────

describe("Tool execute behavior simulation", () => {
  it("returns terminate:true on valid input", () => {
    const ajv = new Ajv({ strict: false });
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const validate = ajv.compile(schema);

    const params = { ok: true };
    const valid = validate(params);

    expect(valid).toBe(true);
    // Simulated tool result
    const result = {
      content: [{ type: "text" as const, text: "Structured output recorded successfully." }],
      details: params,
      terminate: true,
    };
    expect(result.terminate).toBe(true);
    expect(result.details).toEqual({ ok: true });
  });

  it("throws with Ajv error details on invalid input", () => {
    const ajv = new Ajv({ strict: false });
    const schema = {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    };
    const validate = ajv.compile(schema);

    const params = { count: "not-a-number" };
    const valid = validate(params);

    expect(valid).toBe(false);
    expect(validate.errors).toBeDefined();

    // Simulated tool error
    const errors = validate.errors!.map((e) => `${e.instancePath} ${e.message}`).join("; ");
    const errorMsg = `Schema validation failed: ${errors}`;
    expect(errorMsg).toContain("must be");
  });

  it("accepts passthrough params (any JSON object)", () => {
    const ajv = new Ajv({ strict: false });
    // Complex schema matching real workflow usage
    const schema = {
      type: "object",
      properties: {
        mustFix: { type: "boolean" },
        issues: { type: "array", items: { type: "string" } },
        metadata: {
          type: "object",
          properties: {
            score: { type: "number" },
            confidence: { type: "number" },
          },
        },
      },
      required: ["mustFix"],
    };
    const validate = ajv.compile(schema);

    // Valid complex input
    expect(validate({
      mustFix: true,
      issues: ["unused variable", "missing return type"],
      metadata: { score: 0.85, confidence: 0.92 },
    })).toBe(true);

    // Minimal valid input
    expect(validate({ mustFix: false })).toBe(true);
  });
});

// ── Workflow hook: "called but failed" retry (Fix A) ──────
//
// 验证 setupWorkflowHook 的核心行为：当模型调用了 structured-output 但校验失败
// （isError=true）时，turn_end 应主动 steer 提示修正（而非旧实现的撒手交给 Pi 自然修正）。
// 通过 mock pi API（捕获 on() 回调 + spy sendUserMessage）驱动真实扩展入口点。

describe("Workflow hook: structured-output failure retry", () => {
  const originalSchemaEnv = process.env[SCHEMA_ENV_NAME];

  afterEach(() => {
    // fixture 的 restoreSchemaEnv 只处理 env；vi.restoreAllMocks 必须在消费方保留
    restoreSchemaEnv(originalSchemaEnv);
    // 闸门 terminal 会武装真实 15s 兜底硬退 timer——触发 terminal 的测试用 fake timers
    // 包裹，此处还原真实 timers 并丢弃未触发的 fake timer（不残留跨测试的硬退风险）
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("steers on 'called but failed' with the specific validation error + correct schema", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    await pi.emit("turn_end", turnEndPayload());

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = pi.sendUserMessage.mock.calls[0]!;
    expect(msg).toContain("FAILED validation");
    expect(msg).toContain("Schema validation failed: /count must be number");
    // 单参数口径：schema 即工具 parameters，参数即数据，修正参数后重调
    expect(msg).toContain(`The required schema for your result is: ${SCHEMA}`);
    expect(msg).toContain("Fix your arguments to conform to this schema");
    expect(opts).toEqual({ deliverAs: "steer" });
  });

  it("steers on 'never called' with the 'must call' reminder (no validation error)", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    // 没有 tool_execution_end（完全没调），直接 turn_end
    await pi.emit("turn_end", turnEndPayload());

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const msg = pi.sendUserMessage.mock.calls[0]![0] as string;
    expect(msg).toContain("MUST call the structured-output tool");
    expect(msg).not.toContain("FAILED validation");
    // 与 failed 分支对齐：断言 steer 关键文案（参数即数据，单参数口径）
    expect(msg).toContain("Your arguments ARE the data");
    expect(msg).toContain("matching this shape");
  });

  it("steers on 'never called' with the {value} wrapper contract for non-object roots (P6)", async () => {
    // 非 object 根（array）：参数层实际是 {value} 包装（P6）——"arguments ARE the data"
    // 文案会指导模型直传裸值，必被包装层 required:["value"] 拒绝。steer 文案必须与
    // 工具 description / ASP 同语汇告知包装契约与 value. 错误路径前缀。
    const arrayRootSchema = JSON.stringify({ type: "array", items: { type: "string" } });
    const pi = createMockPi();
    await loadExtension(pi, arrayRootSchema);

    await pi.emit("turn_end", turnEndPayload());

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const msg = pi.sendUserMessage.mock.calls[0]![0] as string;
    expect(msg).toContain("MUST call the structured-output tool");
    expect(msg).toContain("{value: <data>}");
    expect(msg).toContain("`value`");
    // object 根专属文案不得出现在非 object 根分支
    expect(msg).not.toContain("Your arguments ARE the data");
  });

  it("does NOT steer when structured-output succeeded", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    await pi.emit("tool_execution_end", SUCCESS_TOOL_END);
    await pi.emit("turn_end", turnEndPayload());

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("stops steering after MAX_HOOK_RETRIES (=2) exhausted", async () => {
    vi.useFakeTimers(); // 第 3 轮失败触发 gate terminal（武装 15s 兜底 timer）——fake 掉避免泄漏
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    // 两次"调了但失败" → 两次 steer；第三次不再 steer
    for (let i = 0; i < 3; i++) {
      await pi.emit("tool_execution_end", FAILED_TOOL_END);
      await pi.emit("turn_end", turnEndPayload());
    }
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("does not steer when stopReason is toolUse (still in tool chain)", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    await pi.emit("turn_end", turnEndPayload("toolUse"));

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});

// ── Tool execute 真实调用测试（executeStructuredOutput，日常分支）──────────
//
// 直接调 src/index.ts 导出的 executeStructuredOutput（不传 authoritativeSchema，
// 走日常防御链），覆盖三类路径：
//   - 合法 schema + data → 成功
//   - 坏 schema（ajv 编译失败）/互换/keyword-less → 抛带纠错文案的错误
//   - data 不匹配 → 抛 Schema validation failed
// 这是防静默腐败的核心保障：互换检测 + keyword-less schema 拒绝。

describe("Tool execute (real call via executeStructuredOutput)", () => {
  it("succeeds on valid object schema + matching data", async () => {
    const result = await executeStructuredOutput({
      schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      data: { name: "Alice" },
    });
    expect(result.content[0]!.text).toContain("recorded successfully");
    expect(result.details).toEqual({ name: "Alice" });
  });

  it("succeeds on primitive number root schema", async () => {
    const result = await executeStructuredOutput({
      schema: { type: "number", minimum: 0, maximum: 100 },
      data: 42,
    });
    expect(result.details).toEqual(42);
  });

  it("succeeds on primitive boolean root schema", async () => {
    const result = await executeStructuredOutput({
      schema: { type: "boolean" },
      data: true,
    });
    expect(result.details).toEqual(true);
  });

  it("succeeds on array root schema", async () => {
    const result = await executeStructuredOutput({
      schema: { type: "array", items: { type: "string" } },
      data: ["a", "b", "c"],
    });
    expect(result.details).toEqual(["a", "b", "c"]);
  });

  it("accepts JSON-string schema/data (normalize path)", async () => {
    const result = await executeStructuredOutput({
      schema: JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } } }),
      data: JSON.stringify({ ok: true }),
    });
    expect(result.details).toEqual({ ok: true });
  });

  it("throws 'Invalid JSON Schema' when ajv cannot compile", async () => {
    await expect(
      executeStructuredOutput({
        schema: { type: "not-a-real-type" },
        data: {},
      }),
    ).rejects.toThrow(/Invalid JSON Schema/);
  });

  it("throws swap detection when data looks like a schema and schema looks like data", async () => {
    // 弱模型把答案塞 schema、把形状塞 data 的典型互换形态
    await expect(
      executeStructuredOutput({
        schema: { name: "Alice", age: 30 }, // 对象但无任何 schema keyword → 像数据
        data: { type: "object", properties: { name: { type: "string" } } }, // 含 keyword → 像 schema
      }),
    ).rejects.toThrow(/swapped/i);
  });

  it("throws 'no recognized keyword' for keyword-less schema (silent-corruption guard)", async () => {
    // {} / {a:1} 会被 ajv strict:false 编译成"接受一切"，必须显式拒绝
    await expect(
      executeStructuredOutput({
        schema: { a: 1 },
        data: { name: "Alice" },
      }),
    ).rejects.toThrow(/recognized keyword/i);
  });

  it("rejects empty schema object {} (keyword-less, silent-corruption guard)", async () => {
    await expect(
      executeStructuredOutput({
        schema: {},
        data: { anything: true },
      }),
    ).rejects.toThrow(/recognized keyword/i);
  });

  it("does NOT flag swap when both schema and data are valid (regression guard)", async () => {
    // schema 有 keyword 且 data 是普通答案 → 不应误判为互换
    await expect(
      executeStructuredOutput({
        schema: { type: "object", properties: { score: { type: "number" } }, required: ["score"] },
        data: { score: 8 },
      }),
    ).resolves.toBeDefined();
  });

  it("throws 'Schema validation failed' when data does not match schema", async () => {
    await expect(
      executeStructuredOutput({
        schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
        data: { count: "not-a-number" },
      }),
    ).rejects.toThrow(/Schema validation failed/);
  });

  it("echoes received schema/data in validation-failure error", async () => {
    await expect(
      executeStructuredOutput({
        schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
        data: { count: "x" },
      }),
    ).rejects.toThrow(/Received schema=/);
  });

  it("echoes received schema/data in swap error", async () => {
    await expect(
      executeStructuredOutput({
        schema: { answer: "hello" },
        data: { type: "string" },
      }),
    ).rejects.toThrow(/Received schema=.*data=/s);
  });

  it("rejects malformed-JSON-string schema (tryParseJson keeps raw → reject)", async () => {
    await expect(
      executeStructuredOutput({ schema: "{invalid", data: {} }),
    ).rejects.toThrow(/Invalid JSON Schema/);
  });

  it("rejects null / undefined / array / number schema", async () => {
    const badSchemas: unknown[] = [null, undefined, [], 42];
    for (const bad of badSchemas) {
      await expect(
        executeStructuredOutput({ schema: bad, data: {} }),
      ).rejects.toThrow(/Invalid JSON Schema/);
    }
  });

  it("accepts boolean root schema (draft-07: true = accept all)", async () => {
    const result = await executeStructuredOutput({ schema: true, data: { ok: 1 } });
    expect(result.details).toEqual({ ok: 1 });
  });
});

// ── workflow 模式透传（D2：pi-ai 参数层是唯一校验权威）──────────────────
//
// U1 改造后 execute 的 workflow 分支不再 ajv 复核：工具 parameters 即权威 schema
// （注册期合成，见 createWorkflowToolDefinition），pi-ai validateToolArguments 在
// execute 之前完成校验+矫正。execute 收到的 data 必然是已校验值，透传即可。
// 直调 executeStructuredOutput 显式传 authoritativeSchema 模拟 env 注入路径。

describe("Authoritative schema (workflow mode) — passthrough (D2)", () => {
  const authoritativeSchema = {
    type: "object",
    properties: {
      channels: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            action: { type: "string", enum: ["add", "remove", "fix"] },
          },
          required: ["name", "action"],
        },
      },
    },
    required: ["channels"],
  };

  it("authoritativeSchema 存在 + data 合规 → 透传成功，details = data", async () => {
    const result = await executeStructuredOutput({
      data: { channels: [{ name: "ch1", action: "add" }] },
      authoritativeSchema,
    });
    expect(result.content[0]!.text).toContain("recorded successfully");
    expect(result.details).toEqual({ channels: [{ name: "ch1", action: "add" }] });
  });

  it("透传：data 不合权威 schema 也成功——校验责任已上移到 pi-ai 参数层（D2 删第二校验）", async () => {
    // 旧实现在此抛 'Schema validation failed (authoritative)'。新形态下 execute 不再
    // 复核：参数层（validateToolArguments，按注册进工具的权威 schema）才是唯一校验
    // 权威；execute 收到的必然是已校验值。此用例锁死「不复活第二校验权威」。
    const result = await executeStructuredOutput({
      data: { channels: "not-an-array" },
      authoritativeSchema,
    });
    expect(result.content[0]!.text).toContain("recorded successfully");
    expect(result.details).toEqual({ channels: "not-an-array" });
  });

  it("08-01 事故形态的反转：LLM 已无 schema 参数可传，自报绕过在结构上不可能", async () => {
    // 旧用例「rejects LLM-rewritten schema even when data matches」防的是「LLM 篡改
    // schema 自洽绕过」。单参数形态下模型根本没有 schema 参数（G3 结构约束），此用例
    // 验证 workflow 分支对 LLM 可能残留传的 schema 字段不做任何校验消费（它只是 data
    // 的一部分，会被参数层 additionalProperties:false 拒绝——那是参数层的职责）。
    const result = await executeStructuredOutput({
      data: {
        schema: { type: "object", properties: { channels: { type: "array", items: { type: "string" } } } },
        channels: ["ch1", "ch2"],
      },
      authoritativeSchema,
    });
    // execute 透传不解读内容；details 原样（真实链路里这份数据已在参数层被拒）
    expect(result.details).toEqual({
      schema: { type: "object", properties: { channels: { type: "array", items: { type: "string" } } } },
      channels: ["ch1", "ch2"],
    });
  });

  it("authoritativeSchema absent → falls through to daily-mode defense (regression guard)", async () => {
    // 不传 authoritativeSchema → 走日常防御链（LLM schema 校验）。
    // 用一个 LLM schema + 合规 data 应通过（证明没误入 workflow 透传分支）。
    const result = await executeStructuredOutput({
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      data: { ok: true },
    });
    expect(result.details).toEqual({ ok: true });
  });

  it("非 object 根 authoritativeSchema → 解包 {value}（P6 对称操作）", async () => {
    const result = await executeStructuredOutput({
      data: { value: ["a", "b", "c"] },
      authoritativeSchema: { type: "array", items: { type: "string" } },
    });
    expect(result.details).toEqual(["a", "b", "c"]);
  });

  it("boolean false 根 → 同走 {value} 解包（draft-07 reject-all；运行时拒绝由参数层承担）", async () => {
    const result = await executeStructuredOutput({
      data: { value: 42 },
      authoritativeSchema: false,
    });
    expect(result.details).toBe(42);
  });
});

// ── createWorkflowToolDefinition：注册期防御 + parameters 合成（验收③）──────────
//
// 覆盖：D4 根级 additionalProperties 注入 / P6 非 object 根包装与解包 /
// 加载期防御 fail-fast（keyword-less、boolean true、非法根）/ description 口径 /
// execute 透传。P5/P6 的代码级预验证（模型可见性留给 U5 实机探针）。

describe("createWorkflowToolDefinition — registration-time defense + parameters synthesis", () => {
  it("object 根未声明 additionalProperties → 注入 false（D4）", () => {
    const def = createWorkflowToolDefinition(JSON.stringify({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    }));
    expect(def.parameters).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("object 根显式声明 additionalProperties: true → 尊重不动（D4）", () => {
    const def = createWorkflowToolDefinition(JSON.stringify({
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: true,
    }));
    expect(def.parameters).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: true,
    });
  });

  it("object 根显式声明 additionalProperties 子 schema → 尊重不动（D4）", () => {
    const apSchema = { type: "string" };
    const def = createWorkflowToolDefinition(JSON.stringify({
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: apSchema,
    }));
    expect(def.parameters).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: apSchema,
    });
  });

  it("嵌套层级 additionalProperties 不注入（D4：嵌套宽严由作者 schema 自治）", () => {
    const nested = { type: "object", properties: { a: { type: "string" } } };
    const def = createWorkflowToolDefinition(JSON.stringify({
      type: "object",
      properties: { nested },
    }));
    // 仅根级注入 false；嵌套对象保持原样（未声明即未注入）
    expect(def.parameters).toEqual({
      type: "object",
      properties: { nested },
      additionalProperties: false,
    });
    expect(def.parameters).not.toEqual({
      type: "object",
      properties: { nested: { ...nested, additionalProperties: false } },
      additionalProperties: false,
    });
  });

  it("非 object 根（array）→ 包装 {value} + required + additionalProperties:false（P6）", () => {
    const arrSchema = { type: "array", items: { type: "string" } };
    const def = createWorkflowToolDefinition(JSON.stringify(arrSchema));
    expect(def.parameters).toEqual({
      type: "object",
      properties: { value: arrSchema },
      required: ["value"],
      additionalProperties: false,
    });
  });

  it("非 object 根（string 枚举）→ 同样包装 {value}", () => {
    const strSchema = { type: "string", enum: ["low", "medium", "high"] };
    const def = createWorkflowToolDefinition(JSON.stringify(strSchema));
    expect(def.parameters).toEqual({
      type: "object",
      properties: { value: strSchema },
      required: ["value"],
      additionalProperties: false,
    });
  });

  it("根类型判定边界：无 type 但有 properties → object 根直传（draft-07 object 关键字）", () => {
    const def = createWorkflowToolDefinition(JSON.stringify({
      properties: { name: { type: "string" } },
      required: ["name"],
    }));
    // 直传（非 {value} 包装）+ 根级注入 additionalProperties:false
    expect(def.parameters).toEqual({
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("根类型判定边界：type 数组含 object → object 根直传 + type 收敛为字符串（C-ext-03）", () => {
    const def = createWorkflowToolDefinition(JSON.stringify({
      type: ["object", "null"],
      properties: { name: { type: "string" } },
    }));
    // type 数组根收敛为字符串 "object"：顶层 type 序列化为数组会被严格 OpenAI 兼容
    // 网关按 C-ext-03 立约动机整会话 400；且 arguments 协议上恒为 object，"null"
    // 成员本就不可达，含 object 成员时收敛语义无损（tool-definition 源码注释同源）。
    expect(def.parameters).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    });
  });

  it("根类型判定边界：组合根（anyOf）可能接受非 object 值 → 包装 {value} 保真", () => {
    const anyOfSchema = {
      anyOf: [{ type: "string" }, { type: "object", properties: { name: { type: "string" } } }],
    };
    const def = createWorkflowToolDefinition(JSON.stringify(anyOfSchema));
    // 包装后 value 可容纳任意成员类型（string 或 object）——直传会丢失非 object 成员可达性
    expect(def.parameters).toEqual({
      type: "object",
      properties: { value: anyOfSchema },
      required: ["value"],
      additionalProperties: false,
    });
  });

  it("keyword-less object 根（{a:1} / {}）→ 注册期 fail-fast：'no recognized keyword'（ERR-3 上移）", () => {
    expect(() => createWorkflowToolDefinition(JSON.stringify({ a: 1 })))
      .toThrow(/no recognized keyword/);
    expect(() => createWorkflowToolDefinition("{}"))
      .toThrow(/no recognized keyword/);
    // 错误指回 workflow 脚本（恢复指引）
    try {
      createWorkflowToolDefinition(JSON.stringify({ a: 1 }));
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("outputSchema");
    }
  });

  it("boolean true → 注册期 fail-fast：accept-all 无形状约束（ERR-7 上移）", () => {
    expect(() => createWorkflowToolDefinition("true")).toThrow(/boolean true/);
    try {
      createWorkflowToolDefinition("true");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("object schema");
    }
  });

  it("非 object/boolean 根（string 'invalid' / JSON 数字）→ 注册期 fail-fast（assertJsonSchemaRoot）", () => {
    expect(() => createWorkflowToolDefinition("invalid"))
      .toThrow(/must be a JSON Schema object or boolean, got string/);
    expect(() => createWorkflowToolDefinition("42"))
      .toThrow(/must be a JSON Schema object or boolean, got number/);
  });

  it("malformed JSON env（'{invalid'）→ tryParseJson 保留原字符串 → 根类型 fail-fast", () => {
    expect(() => createWorkflowToolDefinition("{invalid"))
      .toThrow(/must be a JSON Schema object or boolean, got string/);
  });

  it("description：单参数口径，无 'pass ONLY' 类矛盾文案", () => {
    const def = createWorkflowToolDefinition(JSON.stringify({
      type: "object", properties: { count: { type: "number" } },
    }));
    expect(def.description).toContain("Your arguments ARE the data");
    expect(def.description).not.toMatch(/pass ONLY/i);
    expect(def.description).toMatch(/validation fails/i);
  });

  // 根类型条件化（与 parameters 包装判定同源 isObjectRootSchema）：
  // object 根口径「arguments ARE the data」；非 object 根参数层实际是 {value} 包装，
  // 必须告知包装契约 + value. 错误路径前缀，否则模型按直传口径首调必败。
  it("description object 根：保持 arguments ARE the data，不含 value 包装教学", () => {
    const def = createWorkflowToolDefinition(JSON.stringify({
      type: "object", properties: { count: { type: "number" } },
    }));
    expect(def.description).toContain("Your arguments ARE the data");
    // object 根无包装：不得出现 {value} 契约与 value. 路径前缀说明
    expect(def.description).not.toMatch(/\{value:/);
    expect(def.description).not.toMatch(/`value\./);
  });

  it("description 非 object 根：告知 {value} 包装契约 + value. 路径前缀（审查项#3）", () => {
    const nonObjectRoots = [
      { type: "array", items: { type: "string" } },
      { type: "string", enum: ["low", "high"] },
      { type: "number", minimum: 0 },
      { type: "boolean" },
      { anyOf: [{ type: "string" }, { type: "number" }] },
    ];
    for (const schema of nonObjectRoots) {
      const def = createWorkflowToolDefinition(JSON.stringify(schema));
      // 包装契约：单参数必须是 {value: <data>} 对象
      expect(def.description).toMatch(/must be an object/);
      expect(def.description).toContain("{value:");
      expect(def.description).toContain("must conform to this schema");
      // 错误路径前缀说明（参数层错误无改写通道，指引前置携带）
      expect(def.description).toMatch(/`value\./);
      // 不得再保留 object 根口径（两口径互斥）
      expect(def.description).not.toContain("Your arguments ARE the data");
    }
  });

  it("description 裸 object 警示：{type:'object'} 无属性约束 → 追加 empty-object 警示（审查项#5）", () => {
    const def = createWorkflowToolDefinition(JSON.stringify({ type: "object" }));
    expect(def.description).toMatch(/accepts only an empty object \{\}/);
    expect(def.description).toMatch(/will be rejected/);
  });

  it("description 裸 object 警示不误报：有属性约束/显式 additionalProperties/required/min-max Properties/非 object 根 → 无警示", () => {
    const cases = [
      { type: "object", properties: { a: { type: "string" } } },
      { type: "object", additionalProperties: true },
      { type: "object", patternProperties: { "^a": { type: "string" } } },
      { type: "object", required: ["x"] },
      { type: "array", items: { type: "string" } },
    ];
    for (const schema of cases) {
      const def = createWorkflowToolDefinition(JSON.stringify(schema));
      expect(def.description, JSON.stringify(schema)).not.toMatch(/empty object/);
    }
  });

  // F2：minProperties/maxProperties 也是属性约束——{type:object,minProperties:1}
  // 连空对象都拒绝，警示「只接受空对象」为假，不得出现（同 required 交由参数层
  // 校验错误自然暴露）。
  it("description 裸 object 警示不误报：minProperties/maxProperties 裸形态 → 无 empty-object 假警示（F2）", () => {
    const cases = [
      { type: "object", minProperties: 1 },
      { type: "object", maxProperties: 5 },
      { type: "object", minProperties: 1, maxProperties: 3 },
    ];
    for (const schema of cases) {
      const def = createWorkflowToolDefinition(JSON.stringify(schema));
      expect(def.description, JSON.stringify(schema)).not.toMatch(/empty object/);
      // object 根口径不受影响（minProperties 是 object 特有关键字，仍算 object 根）
      expect(def.description).toContain("Your arguments ARE the data");
    }
  });

  it("execute 透传：object 根 params 即 data，不做第二校验（D2）", async () => {
    const def = createWorkflowToolDefinition(JSON.stringify({
      type: "object", properties: { count: { type: "number" } }, required: ["count"],
    }));
    // 参数层已校验的合规值
    const r1 = await def.execute("call-1", { count: 7 });
    expect(r1.content[0]!.text).toContain("recorded successfully");
    expect(r1.details).toEqual({ count: 7 });
    // 不合 schema 的值也透传（校验责任在参数层——本用例即锁死「不复活 ajv 复核」）
    const r2 = await def.execute("call-2", { wrong: "shape" });
    expect(r2.details).toEqual({ wrong: "shape" });
  });

  it("execute 解包：非 object 根 params.value 即 data（P6 对称）", async () => {
    const def = createWorkflowToolDefinition(JSON.stringify({ type: "array", items: { type: "string" } }));
    const r = await def.execute("call-1", { value: ["a", "b"] });
    expect(r.details).toEqual(["a", "b"]);
  });

  it("execute 解包：string 根（枚举）→ details 为原始字符串", async () => {
    const def = createWorkflowToolDefinition(JSON.stringify({ type: "string", enum: ["low", "high"] }));
    const r = await def.execute("call-1", { value: "high" });
    expect(r.details).toBe("high");
  });
});

// ── schema 体积可见性（SO-DATA-4：SO 侧只提示，硬拒绝在 SW 侧注入点）─────────
//
// schema 经 spawn childEnv 注入子进程，env 块受 ARG_MAX 约束（Linux E2BIG）。
// SW 侧 session-runner 对超 SCHEMA_ENV_MAX_BYTES 的注入 fail-fast；本侧职责是
// 注册期可见性提示（env 通道有上限，建议拆分 schema 或精简），不拒绝注册。
describe("schema size visibility (SO-DATA-4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("常量锁定：SO_SCHEMA_SIZE_WARN_BYTES = 256 KiB（与 SW 侧 SCHEMA_ENV_MAX_BYTES 同值，跨包契约测试锁字节相等）", () => {
    expect(SO_SCHEMA_SIZE_WARN_BYTES).toBe(256 * 1024);
  });

  it("注册时 schema 超阈值 → stderr 提示（不拒绝注册）", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const bigSchema = JSON.stringify({
      type: "object",
      properties: { blob: { type: "string", description: "x".repeat(SO_SCHEMA_SIZE_WARN_BYTES) } },
    });
    expect(() => createWorkflowToolDefinition(bigSchema)).not.toThrow();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("PI_WORKFLOW_SCHEMA is"));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("256"));
  });

  it("阈值内不提示", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    createWorkflowToolDefinition(SCHEMA);
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

// ── index 装配分岔（D1）+ registerTool parameters 断言（验收③第 4 点）──────────
//
// loadExtension 设 env 后动态 import src/index.js 并调 default(mockPi)——
// 覆盖「读 env → 二选一注册」的装配分岔；registerTool spy 捕获工具定义，
// 断言模型可见的 parameters 为注入后的权威 schema（P5 代码级预验证：
// 运行时模型可见性的实机验证留给 U5 的 P5/P6 探针）。

describe("index assembly fork (D1)", () => {
  const originalSchemaEnv = process.env[SCHEMA_ENV_NAME];

  afterEach(() => {
    restoreSchemaEnv(originalSchemaEnv);
    vi.restoreAllMocks();
  });

  it("env 有值（object 根）→ registerTool 收到注入后的权威 schema 作 parameters（P5 代码级）", async () => {
    const pi = createMockPi();
    const authSchema = {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    };
    await loadExtension(pi, JSON.stringify(authSchema));

    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    const toolDef = pi.registerTool.mock.calls[0]![0] as {
      name: string;
      description: string;
      parameters: unknown;
    };
    expect(toolDef.name).toBe("structured-output");
    // 模型可见 parameters = 权威 schema + 根级 additionalProperties 注入（D4）
    expect(toolDef.parameters).toEqual({ ...authSchema, additionalProperties: false });
    // description 为单参数口径（模型首读信息源自洽，G1/G3）
    expect(toolDef.description).toContain("Your arguments ARE the data");
  });

  it("env 有值（非 object 根）→ registerTool parameters 为 {value} 包装（P6 代码级）", async () => {
    const pi = createMockPi();
    const arrSchema = { type: "array", items: { type: "string" } };
    await loadExtension(pi, JSON.stringify(arrSchema));

    const toolDef = pi.registerTool.mock.calls[0]![0] as { parameters: unknown };
    expect(toolDef.parameters).toEqual({
      type: "object",
      properties: { value: arrSchema },
      required: ["value"],
      additionalProperties: false,
    });
  });

  it("env 有值 → 注册 turn_end 强制 hook（workflow 模式）", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    // setupWorkflowHook 注册 tool_execution_end + turn_end 两个 handler
    const registeredEvents = pi.on.mock.calls.map((c) => c[0]);
    expect(registeredEvents).toContain("tool_execution_end");
    expect(registeredEvents).toContain("turn_end");
  });

  it("env 无值 → registerTool 收到日常双参数形态，不注册 hook", async () => {
    const pi = createMockPi();
    await loadExtension(pi, undefined);

    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    const toolDef = pi.registerTool.mock.calls[0]![0] as {
      name: string;
      description: string;
      parameters: unknown;
    };
    expect(toolDef.name).toBe("structured-output");
    // 日常变体：双参数 envelope（mock typebox 的 Type.Object 输出形态）
    expect(toolDef.parameters).toEqual({
      type: "object",
      properties: {
        schema: expect.objectContaining({ type: "unknown" }),
        data: expect.objectContaining({ type: "unknown" }),
      },
    });
    // 日常 description 保留 envelope 教学（G4），workflow 语句已移除（D5）
    expect(toolDef.description).toContain("Correct (full call)");
    expect(toolDef.description).not.toMatch(/pass ONLY/i);
    // 无 hook
    expect(pi.on).not.toHaveBeenCalled();
  });

  it("env 非法 schema（keyword-less）→ 加载期 fail-fast，工具不注册", async () => {
    const pi = createMockPi();
    await expect(loadExtension(pi, JSON.stringify({ a: 1 }))).rejects.toThrow(/no recognized keyword/);
    expect(pi.registerTool).not.toHaveBeenCalled();
  });

  it("env 非法 schema（boolean true）→ 加载期 fail-fast，工具不注册", async () => {
    const pi = createMockPi();
    await expect(loadExtension(pi, "true")).rejects.toThrow(/boolean true/);
    expect(pi.registerTool).not.toHaveBeenCalled();
  });
});

// ── 日常变体 execute 的 env 桥接（createDailyToolDefinition.execute 读 PI_WORKFLOW_SCHEMA）──
//
// 装配分岔下日常变体注册时 env 为空，但 execute 的 env 桥接判定保留
// （ENV_SCHEMA 存在 = workflow 模式）：env 有值时注入 authoritativeSchema
// 走 workflow 透传分支。用真实的 execute（不 mock）覆盖 env 读取 + 注入全链路。

describe("createDailyToolDefinition.execute env bridge (PI_WORKFLOW_SCHEMA → workflow passthrough)", () => {
  const originalSchemaEnv = process.env[SCHEMA_ENV_NAME];

  // 用真实的 execute（不 mock executeStructuredOutput），覆盖 env 读取 + 注入 + 分支选择全链路。
  // createDailyToolDefinition().execute 签名是 (toolCallId, params)；toolCallId 在内部未使用。
  const toolDef = createDailyToolDefinition();
  const exec = (params: { schema?: unknown; data: unknown }) =>
    toolDef.execute("call-id-1", params);

  afterEach(() => {
    if (originalSchemaEnv === undefined) delete process.env[SCHEMA_ENV_NAME];
    else process.env[SCHEMA_ENV_NAME] = originalSchemaEnv;
  });

  const AUTHORITY = JSON.stringify({
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
  });

  it("env set + data 不合权威 schema → 透传成功（D2：权威 ajv 复核已删）", async () => {
    process.env[SCHEMA_ENV_NAME] = AUTHORITY;
    // 旧断言 'Schema validation failed (authoritative)' 已失效：workflow 分支不再校验。
    // 此用例锁死「桥接注入 authoritativeSchema → 透传」的新行为。
    const result = await exec({ schema: { type: "object" }, data: {} });
    expect(result.content[0]!.text).toContain("recorded successfully");
    expect(result.details).toEqual({});
  });

  it("env set + data conformant → passes, details = data", async () => {
    process.env[SCHEMA_ENV_NAME] = AUTHORITY;
    const result = await exec({ schema: undefined, data: { count: 7 } });
    expect(result.content[0]!.text).toContain("recorded successfully");
    expect(result.details).toEqual({ count: 7 });
  });

  it("env set（非 object 根）→ 桥接 + 解包 value", async () => {
    process.env[SCHEMA_ENV_NAME] = JSON.stringify({ type: "array", items: { type: "string" } });
    const result = await exec({ data: { value: ["a", "b"] } });
    expect(result.details).toEqual(["a", "b"]);
  });

  it("env unset → falls through to daily mode (no authoritativeSchema injected)", async () => {
    delete process.env[SCHEMA_ENV_NAME];
    // env 未设 → execute 不注入 authoritativeSchema → 走日常防御链。
    // 用一个合规的 LLM schema + 合规 data 验证它通过（证明没误入 workflow 透传分支）。
    const result = await exec({
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      data: { ok: true },
    });
    expect(result.details).toEqual({ ok: true });
    // 日常防御链仍然生效（keyword-less 拒绝）
    await expect(
      exec({ schema: { a: 1 }, data: { ok: true } }),
    ).rejects.toThrow(/recognized keyword/i);
  });
});
