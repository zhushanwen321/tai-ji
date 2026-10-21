/**
 * tool 提示词 / schema 契约合一（2026-09-27 测试审计组 6：三源并一文件；
 * tool-declaration-slimming D3/U-B1 重写：断言对象随 subagent→三工具、workflow→两工具
 * 拆分重组，锚词清单逐条重新落位）。
 *
 * 断言对象分两类：
 * 1. 源码文本断言（读 .ts 文本非 import——避免 pi-ai/typebox/pi-tui 等值导入的
 *    重 mock 链）：
 *    - subagent_start/manage/message 三工具声明契约（锚词清单 D2 契约拆分后重排）。
 *      agent（LLM）决策时唯一能看到的 tool 元信息就是 description；本组断言锁
 *      调用信号（何时委派）、能力边界（cannot）、反模式密度、注入防御等约束措辞，
 *      防后续重构把约束删掉或弱化。
 *    - workflow_run/workflow_control 两工具 promptGuidelines 契约。
 *      若 promptGuidelines 不提及内置 workflow 与交叉引用，LLM 无法知道有现成
 *      编排工具可用，会倾向自己 generate 脚本或瞎猜 name。
 *    - runtime handler 错误文案 Correct 正例：subagent 侧锚 core 源码（D6② 下沉
 *      后文案权威源在 core subagent-actions-core）；workflow 侧原 grep 条已删，
 *      行为版在 tool-workflow.test.ts 平铺检测 throw 条。
 * 2. schema 数据断言（JSON 往返剥离 typebox 类型包装，只看数据形态）：
 *    collect / conversation 退役契约 + 拆分必填性结构锚。
 *    required 的真实 typebox 锁由 structured-output cross-package-contract.test.ts
 *    承担（本包 vitest 把 typebox alias 到 mocks/typebox.ts，丢 options）。
 *
 * 旧名残留负锚（U-B1 验收条款③的机器化）：全部声明侧源文件的模型可见文案零
 * 旧工具名指引（`subagent` / `workflow` backtick 指引、action:"start" 旧调用形态）。
 *
 * 框架：vitest（禁 node:test）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import {
  SubagentManageParams,
  SubagentMessageParams,
  SubagentStartParams,
} from "../subagent-tool-schema.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 源码文本源（读源码而非 import，避免 mock 链）──

const SUBAGENT_TOOL_SRC = readFileSync(join(__dirname, "../subagent-tool.ts"), "utf-8");
const TOOL_WORKFLOW_SRC = readFileSync(join(__dirname, "../tool-workflow.ts"), "utf-8");
const TOOL_WORKFLOW_SCRIPT_SRC = readFileSync(
  join(__dirname, "../tool-workflow-script.ts"),
  "utf-8",
);
const TOOL_SUBAGENTS_SRC = readFileSync(join(__dirname, "../tool-subagents.ts"), "utf-8");
// 跨工具通用纪律的收敛点（tool-declaration-slimming D1 单源化终态的注入段侧锚源）。
const SUBAGENT_LIST_INJECTOR_SRC = readFileSync(
  join(__dirname, "../../../injectors/subagent-list-injector.ts"),
  "utf-8",
);
const WORKFLOW_LIST_INJECTOR_SRC = readFileSync(
  join(__dirname, "../../../injectors/workflow-list-injector.ts"),
  "utf-8",
);

/** 按工具名分割注册段：registerTool({... name: "<tool>" ...}) 的文本切片映射。 */
function toolSections(src: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of src.split("pi.registerTool({").slice(1)) {
    const m = part.match(/name: "([^"]+)"/);
    if (m) map[m[1]] = part;
  }
  return map;
}

const SUBAGENT_SECTIONS = toolSections(SUBAGENT_TOOL_SRC);
const WORKFLOW_SECTIONS = toolSections(TOOL_WORKFLOW_SRC);

function section(sections: Record<string, string>, name: string): string {
  const s = sections[name];
  if (s === undefined) throw new Error(`tool section not found: ${name}`);
  return s;
}

const START_SECTION = section(SUBAGENT_SECTIONS, "subagent_start");
const MANAGE_SECTION = section(SUBAGENT_SECTIONS, "subagent_manage");
const MESSAGE_SECTION = section(SUBAGENT_SECTIONS, "subagent_message");
const RUN_SECTION = section(WORKFLOW_SECTIONS, "workflow_run");
const CONTROL_SECTION = section(WORKFLOW_SECTIONS, "workflow_control");

/** 提取 section 内 description: `...` 模板字符串的原始内容。 */
function extractDescription(src: string): string {
  const m = src.match(/description:\s*`([\s\S]*?)`,/);
  if (!m) throw new Error("description template literal not found");
  return m[1];
}

const START_DESCRIPTION = extractDescription(START_SECTION);

/** 截取 promptGuidelines 数组文本——防 KNOWN_ARG_KEYS 等注释/代码中的裸词污染断言。
 * 数到数组封口（跳过字符串字面量内的括号，exec-review F9：'],' 序列静默截断）。 */
function promptGuidelinesText(src: string): string {
  const start = src.indexOf("promptGuidelines: [");
  if (start < 0) return "";
  let depth = 0;
  let inStr = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

// ── schema 数据源（原 subagent-schema-collect.test.ts）──

/** 运行时检查（不用裸类型断言：extensions taste/no-unsafe-cast 规范）。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** schema 的可检视图：经 JSON 往返剥离 typebox 类型包装，只看数据形态。 */
function schemaData(schema: unknown, label: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(JSON.stringify(schema));
  if (!isRecord(raw)) throw new Error(`${label} is not an object schema`);
  return raw;
}

function startProperties(): Record<string, unknown> {
  const props = schemaData(SubagentStartParams, "SubagentStartParams").properties;
  if (!isRecord(props)) throw new Error("SubagentStartParams has no properties");
  return props;
}

// ══════════════════════════════════════════════════════════════
// 旧名残留负锚（U-B1 验收条款③）：全部声明侧源文件零旧工具名指引
// ══════════════════════════════════════════════════════════════

describe("旧名残留负锚（U-B1）：声明侧源文件零旧工具名指引", () => {
  // 负锚形态界定：backtick 精确包裹旧名（`subagent` / `workflow`）= 模型可见的
  // 工具名指引；代码标识符（registerSubagentTool）、两键控集合保留的旧名、历史注释
  // 不在声明侧（验收条款③除外项）。旧调用形态 action:"start" 同属拆分前结构指引。
  const DECLARATION_SOURCES: Array<[string, string]> = [
    ["subagent-tool.ts", SUBAGENT_TOOL_SRC],
    ["tool-workflow.ts", TOOL_WORKFLOW_SRC],
    ["tool-subagents.ts", TOOL_SUBAGENTS_SRC],
    ["tool-workflow-script.ts", TOOL_WORKFLOW_SCRIPT_SRC],
    ["subagent-list-injector.ts", SUBAGENT_LIST_INJECTOR_SRC],
    ["workflow-list-injector.ts", WORKFLOW_LIST_INJECTOR_SRC],
  ];

  for (const [file, src] of DECLARATION_SOURCES) {
    it(`${file}: 零 backtick 旧名指引与旧调用形态`, () => {
      expect(src, `${file} 含 backtick 旧名 \`subagent\``).not.toContain("`subagent`");
      expect(src, `${file} 含 backtick 旧名 \`workflow\``).not.toContain("`workflow`");
    });
  }

  it("subagent-tool.ts: 零拆分前 action:\"start\" 旧调用形态（start 工具无 action 字段）", () => {
    expect(SUBAGENT_TOOL_SRC).not.toContain('action:"start"');
    expect(SUBAGENT_TOOL_SRC).not.toContain('\\"action\\":\\"start\\"');
  });
});

// ══════════════════════════════════════════════════════════════
// subagent_start 声明（tool-declaration-slimming D1 三层分工终态 + D2 锚词清单拆分重排）
// ══════════════════════════════════════════════════════════════

/**
 * 【锚词保留清单 — subagent_start】（tool-declaration-slimming D2：压缩后的契约 = 逐锚词
 * grep，替代原逐字断言。每个锚词是一个弱模型回补点，删除前须确认有替代承载；
 * D3 拆分后原 A1-A17 逐条重新落位）：
 *
 * description 层（是什么 + 边界 + 唯一正例）：
 *  A1  CRITICAL + sequential + SAME message —— 同消息多调用串行执行语义
 *  A2  Nested spawning + "Depth: N/10" —— 递归允许 + 深度上限（防错误拒绝嵌套）
 *  A3  TREE-SHAPED / SELF-CONTAINED / acceptance criteria / safety rail —— 递归判据
 *  A4  You cannot —— 能力边界（无同步结果 / 无流式输出）
 *  A5  {"task":" —— 唯一正例的平铺形态；action 键与 "startParam" 必须不存在
 *  A7  "agent":"/….md" —— agent ref 绝对路径形态（禁裸名示例）
 * promptGuidelines 层（使用纪律单点）：
 *  A6  `subagent_manage` list 先行 + `subagent_message` 续聊指路（原 A11 nested 不对称
 *      说明随拆分消亡——不同工具不同结构，结构信号由 schema 承载）
 *  A8  session_read {"action":"result" —— 长结果截断取回指针（指向 defer 名单工具的
 *      交叉引用，D1 范围裁决②：保留原文）
 *  A9  Delegate FIRST —— 何时委派（原 description「When to delegate」段的承载点）
 *  A10 untrusted —— 注入防御（completion 即确认 + 不可信数据）
 *  A12 `subagents` tool —— 批量入口交叉引用
 * schema 层（功能语义；required/enum/pattern/maxLength 由 structured-output
 * cross-package-contract 以真实 typebox 锁定）：
 *  A13 task description "Throws if missing or whitespace-only"（原 REQUIRED for
 *      action:'start' 文本锚——拆分后必填性由 schema required 表达，运行时语义锚保留）
 *  A14 model CASE-SENSITIVE + Resolution order（三层优先级链是功能语义）
 *  A15 idleTimeoutMs 缺省 300000 + TAIJI_SUBAGENT_IDLE_TIMEOUT_MS env 覆盖链
 *  A16 messageParam.interrupt "Deprecated, no effect" —— 退役参数兼容语义锚
 *      （存量调用防 schema 报错；manage/message schema 兼容语义锚用例承载）
 * 单源化负锚（D1：跨工具通用纪律只在注入段说一次）：
 *  A17 description/guidelines 零 poll/bash sleep/busy-wait；注入段含规则
 * subagent_message / subagent_manage 侧新增锚：
 *  B1  message/manage description 含 {"action":"message","messageParam" 与
 *      {"action":"cancel","cancelParam" 调用正例（原单工具 description Actions 一览的
 *      落位点，"subagentId":"sa- id 格式锚随之迁移）
 *  B2  manage/message promptGuidelines 使用纪律锚：manage 含 "Never guess" + list 先行
 *      调用形状（subagent_start 侧 A6 的本工具落点）；message 含 session tree 归属
 *      纪律（nested 经其 parent——归属检查 record-access 直接父校验的模型可见范围）
 *  B3  schema subagentId 说明含打断/复活副作用（"interrupts its in-flight round" /
 *      "starts a new round"）——必填字段说明是模型填参必读内容，打断语义不依赖
 *      deprecated interrupt 字段（interrupt 只声明 no-op 本身）
 */
describe("subagent_start description — 锚词保留清单（D2/D3 契约）", () => {
  it("体量上界：description ≤ 2400 字符（D2 目标区间 subagent 组 ≤8500 的分维护栏）", () => {
    // description 只承载「是什么 + 边界 + 唯一正例」；使用纪律在
    // promptGuidelines（见 A6/A8-A12），参数功能语义在 schema（A13-A15）。
    // 逼近上界时先砍正文冗余，不得砍锚词（A1-A7）。
    expect(START_DESCRIPTION.length).toBeLessThanOrEqual(2400);
  });

  it("执行语义锚（A1）+ 递归锚（A2/A3）+ 能力边界锚（A4）", () => {
    expect(START_DESCRIPTION).toMatch(/CRITICAL/i);
    expect(START_DESCRIPTION).toMatch(/sequential/);
    expect(START_DESCRIPTION).toMatch(/SAME message/i);
    expect(START_DESCRIPTION).toMatch(/Nested spawning/);
    expect(START_DESCRIPTION).toMatch(/Depth: N\/10/);
    const lower = START_DESCRIPTION.toLowerCase();
    expect(lower).toContain("tree-shaped");
    expect(lower).toContain("self-contained");
    expect(lower).toContain("acceptance criteria");
    expect(lower).toContain("safety rail");
    expect(START_DESCRIPTION).toMatch(/You cannot/);
    expect(START_DESCRIPTION.toLowerCase()).toContain("cannot");
  });

  it("正例锚（A5/A7）：平铺形态唯一正例 + agent 绝对路径，反例形态零残留", () => {
    expect(START_DESCRIPTION).toContain('{"task":"');
    // 拆分后 start 无 action 键：正例与正文中不得复活旧调用结构
    expect(START_DESCRIPTION).not.toContain('"action"');
    expect(START_DESCRIPTION).not.toContain('"startParam"');
    // agent ref 硬检查拒绝裸名——示例必须教绝对路径 .md 形态（<available_subagents>
    // 注入的 <location> 形态）。
    expect(START_DESCRIPTION).not.toMatch(/"agent":"(?!\/)[^"]*"/);
    expect(START_DESCRIPTION).toMatch(/"agent":"\/[^"]*\.md"/);
  });

  it("promptGuidelines 承载使用纪律（A6/A8-A12）：何时委派 / list 先行 / 注入防御 / 截断指针 / 批量入口", () => {
    const guidelines = promptGuidelinesText(START_SECTION);
    expect(guidelines).toContain("Delegate FIRST");
    expect(guidelines).toContain("untrusted");
    expect(guidelines).toContain("`subagent_manage`");
    // guidelines 源码内 JSON 是转义形态（\"action\"）
    expect(guidelines).toContain('{\\"action\\":\\"list\\"}');
    expect(guidelines).toContain("Never guess an id");
    // A8：defer 名单工具交叉引用保留原文（D1 范围裁决②；源码内是转义形态）
    expect(START_SECTION).toContain('session_read {\\"action\\":\\"result\\"');
    expect(guidelines).toContain("`subagents` tool");
  });

  it("agent 字段通用化（防漂移）：description 不写死 agent 名，指向 <available_subagents>", () => {
    // agent 枚举随 agents/*.md 动态变化，防漏职责由每 turn 注入的 <available_subagents>
    // 列表承担；工具声明只保留通用指引。
    expect(SUBAGENT_TOOL_SRC).toContain("available_subagents");
    expect(START_DESCRIPTION).not.toMatch(/orchestrator|code-reviewer|context-builder|worker/);
  });

  it("schema 功能语义锚（A13-A15）", () => {
    // 拒绝条件清单不进 schema 说明（core handler 运行时错误已带恢复动作，D1）；
    // 必填性 / 优先级链 / 缺省值是 schema 侧唯一文本锚。A13 随拆分改形态：
    // required 结构锚由 cross-package-contract 锁，此处锁运行时语义句。
    const schemaSrc = readFileSync(join(__dirname, "../subagent-tool-schema.ts"), "utf-8");
    expect(schemaSrc).toContain("Throws if missing or whitespace-only");
    expect(schemaSrc).toContain("CASE-SENSITIVE");
    expect(schemaSrc).toContain("Resolution order");
    expect(schemaSrc).toContain("TAIJI_SUBAGENT_IDLE_TIMEOUT_MS");
  });

  it("勿等待纪律单源化（A17）：description/guidelines 零 poll 措辞，规则只在注入段说一次（D1）", () => {
    // 「结果自动通知送达、勿 bash sleep/busy-wait/poll 等待」是 subagent 组/
    // subagents/workflow 组共享的调度纪律，收敛到 <available_subagents> 注入段说一次。
    // completion 即确认的 subagent 特有语义由 A10 锚（untrusted）承接。
    expect(START_DESCRIPTION).not.toMatch(/bash sleep|busy-wait|bash-sleeping|polling/i);
    expect(SUBAGENT_LIST_INJECTOR_SRC).toContain("busy-wait, or poll");
    expect(SUBAGENT_LIST_INJECTOR_SRC).toContain("SUBAGENT_DISPATCH_SHARED_RULES");
  });

  it("注入段工具名清单随拆分更新（D1 收敛点覆盖新名全集）", () => {
    expect(SUBAGENT_LIST_INJECTOR_SRC).toContain(
      "(subagent_start, subagent_manage, subagent_message, subagents, workflow_run, workflow_control tools)",
    );
  });

  it("空态也承载调度纪律：工厂 emptyGuide 接 SUBAGENT_DISPATCH_SHARED_RULES（零 agent 环境纪律不消失）", () => {
    // formatAgentList 空列表返回空串、空态段由工厂 formatEmptyResourceList 接管——
    // 工厂配置不传 emptyGuide 时 SUBAGENT_DISPATCH_SHARED_RULES 在零 agent 环境
    // 零承载（D1 单源化被击穿：勿 poll 等待/预算纪律随清单一起消失）。
    // 锚生产 config 的接线形态；空态段行为级断言在 injectors 域
    // workflow-list-injector.test.ts（agent 空态注入含纪律关键词）。
    expect(SUBAGENT_LIST_INJECTOR_SRC).toContain("emptyGuide: SUBAGENT_DISPATCH_SHARED_RULES");
  });
});

// ══════════════════════════════════════════════════════════════
// subagent_manage / subagent_message 声明（B1 锚：call shapes + sa- id 格式锚落位）
// ══════════════════════════════════════════════════════════════

describe("subagent_manage / subagent_message description — call shapes 与 id 格式锚（B1）", () => {
  it("manage description：三动作 call shapes 正例（list/cancel/close）+ sa- id 格式锚", () => {
    const description = extractDescription(MANAGE_SECTION);
    expect(description).toContain('{"action":"list"');
    expect(description).toContain('{"action":"cancel","cancelParam":{"subagentId":"sa-');
    expect(description).toContain('{"action":"close","closeParam":{"subagentId":"sa-');
    // A6 id 格式锚落位：sa-<uuid> 连字符（弱模型照抄示例，sa_ 下划线永远匹配不到真实 record）
    expect(description).toContain('"subagentId":"sa-');
    expect(description).not.toContain('"sa_');
  });

  it("message description：两动作 call shapes 正例（message/fork-from）", () => {
    const description = extractDescription(MESSAGE_SECTION);
    expect(description).toContain('{"action":"message","messageParam":{"subagentId":"sa-');
    expect(description).toContain('{"action":"fork-from","forkFromParam":{"sourceSubagentId":"sa-');
    expect(description).not.toContain('"sa_');
  });

  it("manage/message schema 兼容语义锚（A16）：interrupt deprecated no-op 保留", () => {
    const schemaSrc = readFileSync(join(__dirname, "../subagent-tool-schema.ts"), "utf-8");
    expect(schemaSrc).toContain("Deprecated, no effect");
  });

  it("manage/message promptGuidelines 使用纪律锚（B2）：list 先行 + session tree 归属", () => {
    const manageGuidelines = promptGuidelinesText(MANAGE_SECTION);
    expect(manageGuidelines).toContain("Never guess");
    // guidelines 源码内 JSON 是转义形态（\"action\"）
    expect(manageGuidelines).toContain('{\\"action\\":\\"list\\"}');
    expect(manageGuidelines).toContain("compaction can swallow ids");
    const messageGuidelines = promptGuidelinesText(MESSAGE_SECTION);
    expect(messageGuidelines).toContain("Only message subagents you started in this session tree");
    expect(messageGuidelines).toContain("through its parent");
  });

  it("message 打断/复活语义锚（B3）：subagentId 必填字段说明承载副作用，interrupt 只声明 no-op", () => {
    const schemaSrc = readFileSync(join(__dirname, "../subagent-tool-schema.ts"), "utf-8");
    // 只切 messageParam 块（cancel/close 处有同名 subagentId 声明，不在断言范围）
    const start = schemaSrc.indexOf("messageParam:");
    const end = schemaSrc.indexOf("forkFromParam:");
    if (start < 0 || end < 0 || end <= start) throw new Error("messageParam block not found");
    const block = schemaSrc.slice(start, end);
    expect(block).toContain("interrupts its in-flight round");
    expect(block).toContain("starts a new round");
    expect(block).toContain("revives on the same id");
    // 单源负锚：语义句不残留在 deprecated interrupt 字段说明里（interrupt 是块内
    // 最后一个声明，切到块尾即其声明全体）
    const interruptDecl = block.slice(block.indexOf("interrupt:"));
    expect(interruptDecl).toContain("Deprecated, no effect");
    expect(interruptDecl).not.toContain("interrupts its in-flight round");
  });

  it("manage/message description 零 poll 措辞（A17 单源化）", () => {
    const manageDescription = extractDescription(MANAGE_SECTION);
    const messageDescription = extractDescription(MESSAGE_SECTION);
    expect(manageDescription).not.toMatch(/bash sleep|busy-wait|polling/i);
    expect(messageDescription).not.toMatch(/bash sleep|busy-wait|polling/i);
  });
});

// ══════════════════════════════════════════════════════════════
// subagent start 运行时检查（原「handler 错误文案 Correct 正例」组）
// ══════════════════════════════════════════════════════════════

describe("subagent runtime handler — 错误文案含纠正正例", () => {
  // 读源码文本断言 startHandler throw 含 Correct 正例，
  // 让弱模型撞错后第二次能直接照抄正确形态。
  // 拍平后：startParam envelope 删除，平铺 task/slug 是合法形态；
  // 平铺检测 guard（hasFlattenedStartFields）已删除，源码不应再含此表达式。
  it("startHandler throw 含 Correct 纠正正例（平铺形态）", () => {
    // [D6②] startHandler 内核（含 Correct 文案）已下沉 core subagent-actions-core，
    // 断言目标跟随文案权威源。锚点用 ./workflows/* 子入口（exports 映射包根真实目录，
    // 随源码走不依赖 dist 构建——require 条件下 workspace 包 dist 未构建时
    // resolve 直接 MODULE_NOT_FOUND）。
    const coreRoot = join(
      dirname(
        createRequire(import.meta.url).resolve("@zhushanwen/subagent-core/workflows/README.md"),
      ),
      "..",
    );
    const actionsSrc = readFileSync(
      join(coreRoot, "src/execution/assembly/subagent-actions-core.ts"),
      "utf-8",
    );
    // 四处 throw（input 缺失 / task 空白 / slug 空白 / slug 超长）都应含 Correct 正例。
    // 用 occurrences 计数——至少 3 处。
    const occurrences = (actionsSrc.match(/Correct: \{"action":"start"/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });

  it("平铺检测 guard（hasFlattenedStartFields）已从 subagent-tool.ts 删除", () => {
    expect(SUBAGENT_TOOL_SRC).not.toContain('params.action === "start" && !params.startParam');
    expect(SUBAGENT_TOOL_SRC).not.toContain("hasFlattenedStartFields");
  });
});

// ══════════════════════════════════════════════════════════════
// subagents 批量声明契约（subagent-tool-interface-refactor §3.1.2 成员对象 / §3.1.4
// 启动文案 / §3.3.4 常驻 / §3.3.5 无条件停下）——行为版断言在 tool-subagents.test.ts，
// 本组锁源码文本锚（与 subagent_start 锚词做法同构：agent 决策时唯一可见的就是这些文案）。
// 工具名保持 `subagents` 不变（改名属第二目标，附录 B）——零改名断言。
// ══════════════════════════════════════════════════════════════

describe("subagents 批量声明契约（成员对象 + 启动文案锚 + 常驻）", () => {
  it("成员对象调用正例：tasks 元素是对象（task + 可选 agent/model/thinkingLevel）", () => {
    expect(TOOL_SUBAGENTS_SRC).toContain('{"tasks":[{"task":"<task 1>","agent":"/abs/a.md"},{"task":"<task 2>"}]');
    expect(TOOL_SUBAGENTS_SRC).toContain("member object");
  });

  it("旧 agents/aggregate 形状零残留：声明面无 JSON 键形态教唆（迁移指引只在运行时错误）", () => {
    // JSON 键值对形态（"agents":）= 模型可照抄的旧正例教唆；迁移检查代码里的
    // `"agents" in params` 与 anti-patterns 行的 'agents' 单引号反例说明不在禁令内
    // （前者是检查本体，后者是有意保留的迁移提示）。
    expect(TOOL_SUBAGENTS_SRC).not.toContain('"agents":');
    expect(TOOL_SUBAGENTS_SRC).not.toContain('"aggregate":');
    expect(TOOL_SUBAGENTS_SRC).not.toContain("Comma-separated");
  });

  it("启动文案锚词（§3.1.4）：一条通知 + 成员一次性 + make ONE query（then stop again）+ abort 指引", () => {
    expect(TOOL_SUBAGENTS_SRC).toContain("Results arrive as ONE notification when the run settles. Members are one-shot;");
    expect(TOOL_SUBAGENTS_SRC).toContain("make ONE query: workflow_control");
    expect(TOOL_SUBAGENTS_SRC).toContain("(then stop again)");
    expect(TOOL_SUBAGENTS_SRC).toContain('To abort: workflow_control {"action":"abort","runId":"${runId}"}');
    // 无条件停下为默认（§3.3.5）：「做有用工作 / 超时才查」的旧措辞零残留
    expect(TOOL_SUBAGENTS_SRC).not.toContain("useful non-overlapping work");
    expect(TOOL_SUBAGENTS_SRC).not.toContain("well past the expected duration");
    expect(TOOL_SUBAGENTS_SRC).not.toContain("Do NOT poll");
  });

  it("常驻 + 工具名不变（§3.3.4 / 附录 B 边界）", () => {
    expect(TOOL_SUBAGENTS_SRC).not.toContain('exposure: "deferred"');
    expect(TOOL_SUBAGENTS_SRC).toContain('name: "subagents"');
    // 零改名断言：第二目标（subagent_batch）不在主干出现任何条件形态
    expect(TOOL_SUBAGENTS_SRC).not.toContain("subagent_batch");
  });

  it("schema 叶子承载成员对象形状权威（跨包契约 import 点）", () => {
    const schemaSrc = readFileSync(join(__dirname, "../subagent-tool-schema.ts"), "utf-8");
    expect(schemaSrc).toContain("SubagentsParams");
    expect(schemaSrc).toContain("SubagentsMember");
    expect(schemaSrc).toContain("minItems: 1");
    expect(schemaSrc).toContain("minLength: 1");
  });
});

// ══════════════════════════════════════════════════════════════
// workflow_run / workflow_control promptGuidelines（原 workflow-tool-prompt.test.ts）
// ══════════════════════════════════════════════════════════════

describe("workflow_run promptGuidelines 契约（U1/TC4 拆分重排）", () => {
  it("TC4a: promptGuidelines 不含具体内置 args 枚举（m4 瘦身——参数知识在 read location）", () => {
    // m4：BUILT-IN 枚举删除，发现职责转移给 <available_workflows> 注入段 + read location。
    // 截取 promptGuidelines 段断言（"batch1..batchN" 等在 KNOWN_ARG_KEYS 注释中出现）。
    const guidelines = promptGuidelinesText(RUN_SECTION);
    expect(guidelines).not.toContain("chain (sequential");
    expect(guidelines).not.toContain("args: task");
    expect(guidelines).not.toContain("batch1..batchN");
    expect(guidelines).not.toContain("chain/parallel/scatter-gather/map-reduce");
  });

  it("TC4b: promptGuidelines 引导 read location 获取参数细节（info 已砍，ADR-0003 D5）", () => {
    const guidelines = promptGuidelinesText(RUN_SECTION);
    expect(guidelines).toContain("read the <location>");
    expect(guidelines).toContain("script file");
    // info action 已砍，引导语不再含 workflow info
    expect(guidelines).not.toContain("workflow info");
  });

  it("workflow_run promptGuidelines 含 workflow-script 交叉引用（发现路径反向锚）", () => {
    // LLM 需要知道"先 list 再 run"的发现路径——两个 tool 之间必须有交叉引用。
    // 「action:list 先行」的教学落点在 workflow-script 侧 guidelines（拆分后 run 侧
    // 无 list 语义）；run 侧锁 generate 禁令交叉引用。
    expect(RUN_SECTION).toContain("workflow-script");
  });

  it("workflow_run promptGuidelines 含 run 正例（无 action 键的拆分形态）", () => {
    // 给出 run 调用的 JSON 示例，LLM 才知道参数格式（name/args 嵌套）。
    // guidelines 源码内 JSON 是转义形态（\"name\"）。
    expect(promptGuidelinesText(RUN_SECTION)).toContain('{\\"name\\":\\"<script>\\"');
    // 拆分后 run 无 action 字段：正例与正文零 action:"run" 旧结构
    expect(RUN_SECTION).not.toContain('action:"run"');
    expect(RUN_SECTION).not.toContain('\\"action\\":\\"run\\"');
  });

  it("promptGuidelines 含参数结构反例（args 平铺到顶层）", () => {
    // 显式说明 args 子字段不能平铺到顶层，必须嵌在 args 里。
    expect(promptGuidelinesText(RUN_SECTION)).toContain("args");
    expect(promptGuidelinesText(RUN_SECTION)).toContain("Anti-patterns");
    expect(promptGuidelinesText(RUN_SECTION)).toContain("top level");
  });

  it("workflow_control promptGuidelines 含 status/abort/resume call shapes 与 resume 语义", () => {
    const guidelines = promptGuidelinesText(CONTROL_SECTION);
    // guidelines 源码内 JSON 是转义形态（\"action\"）
    expect(guidelines).toContain('{\\"action\\":\\"status\\"}');
    expect(guidelines).toContain('{\\"action\\":\\"abort\\",\\"runId\\":\\"<id>\\"}');
    expect(guidelines).toContain('{\\"action\\":\\"resume\\",\\"runId\\":\\"<id>\\"');
    expect(guidelines).toContain("ONLY for interrupted runs");
    expect(guidelines).toContain("zero token cost");
    // 跨工具指路：新 run 用 workflow_run
    expect(guidelines).toContain("`workflow_run`");
  });

  it("KNOWN_ARG_KEYS 退役检查（参数知识源 = schema 动态集 argKeysFromMeta，静态枚举不得复活）", () => {
    // 原「runtime handler 错误文案含 Correct 正例 + 平铺检测」grep 条已删：
    // 行为版（Correct 文案 / findFlattenedArgKeys / argKeysFromMeta 真实触发）
    // 在 tool-workflow.test.ts 平铺检测 throw 条与 TC3i 接线条锁定。
    // 退役负向检查保留：KNOWN_ARG_KEYS 曾是静态已知键枚举，m6 后数据源为动态
    // argKeysFromMeta（schema 即 SSOT）——静态枚举不得复活。
    expect(TOOL_WORKFLOW_SRC).not.toMatch(/const\s+KNOWN_ARG_KEYS/);
  });

  it("tool-workflow-script.ts list action 的 promptGuidelines 含 workflow_run 交叉引用", () => {
    // 反向交叉引用：list 的指引里要提到用 workflow_run 启动脚本。
    expect(TOOL_WORKFLOW_SCRIPT_SRC).toContain("`workflow_run`");
  });

  it("workflow_run promptGuidelines 强化 anti-generate（直接 run，不要 generate）", () => {
    // session 证据：弱模型看到 workflow list 后倾向 workflow-script generate 而非直接 run。
    // 提示词必须显式禁止对内置编排使用 generate。
    expect(TOOL_WORKFLOW_SRC).toContain("NEVER use workflow-script action:generate");
  });

  it("tool-workflow-script.ts promptGuidelines 强化 anti-generate（CRITICAL ANTI-PATTERN）", () => {
    expect(TOOL_WORKFLOW_SCRIPT_SRC).toContain("CRITICAL ANTI-PATTERN");
    expect(TOOL_WORKFLOW_SCRIPT_SRC).toContain("NEVER generate");
  });

  it("跨工具预算/模型/勿等待纪律单源化：工具文案零残留，规则只在注入段说一次（D1）", () => {
    // tool-declaration-slimming D1 信息单源化：tokens/time「仅用户明确要求才设」、
    // model/thinkingLevel「缺省继承主 agent」与「勿 poll/bash sleep 等待」原在本工具
    // promptGuidelines 与 schema 说明重复陈述，现收敛到 <available_subagents> 注入段
    // （subagent-list-injector.ts SUBAGENT_DISPATCH_SHARED_RULES）说一次——工具声明
    // 文案零残留 + 注入段含规则。call shape 示例里的 tokens/time 字段展示保留（参数
    // 存在性由 schema 承载，何时设由注入段纪律约束）。
    const runGuidelines = promptGuidelinesText(RUN_SECTION);
    const controlGuidelines = promptGuidelinesText(CONTROL_SECTION);
    expect(runGuidelines).not.toContain("Do NOT set tokens/time unless the user explicitly requests");
    expect(TOOL_WORKFLOW_SRC).not.toContain("omit = unlimited (default)");
    expect(TOOL_WORKFLOW_SRC).not.toContain("Omit to inherit the main agent's model");
    expect(runGuidelines).not.toContain("bash sleep or poll status");
    expect(controlGuidelines).not.toContain("bash sleep or poll status");
    expect(SUBAGENT_LIST_INJECTOR_SRC).toContain("busy-wait, or poll");
    expect(SUBAGENT_LIST_INJECTOR_SRC).toContain("explicitly requests a limit");
    expect(SUBAGENT_LIST_INJECTOR_SRC).toContain("inherit the main agent's model");
  });

  it("model/thinkingLevel 字段说明承载脚本同名参数双通道指引（§3.3.7 残留风险处置说明腿）", () => {
    // 顶层 model/thinkingLevel 是 run 级覆盖、不进脚本；脚本把同名参数声明为可选时
    // 工具不报错（脚本静默走自己的缺省值）——schema 字段说明是该歧义唯一的结构性
    // 提示层（错误腿 = reservedKeyChannelError，只覆盖 required 缺参形态，行为版在
    // tool-workflow.test.ts 保留键双通道条）。两处字段说明须保留同一锚句。
    expect(TOOL_WORKFLOW_SRC).toContain("a script's own same-named parameter must be passed inside 'args'");
  });

  it("workflow 注入段指路 workflow_run（D3 新名）", () => {
    expect(WORKFLOW_LIST_INJECTOR_SRC).toContain("run directly via the workflow_run tool");
  });
});

// ══════════════════════════════════════════════════════════════
// subagent start schema 退役契约（原 subagent-schema-collect.test.ts）
// ══════════════════════════════════════════════════════════════

describe("subagent start schema: collect param retired (批量入口 = subagents tool)", () => {
  it("collect 字段已删（schema 层不可再自报：批量编排唯一入口是 `subagents` tool）", () => {
    const start = schemaData(SubagentStartParams, "SubagentStartParams");
    const manage = schemaData(SubagentManageParams, "SubagentManageParams");
    const message = schemaData(SubagentMessageParams, "SubagentMessageParams");
    expect(Object.keys(start.properties as Record<string, unknown>)).not.toContain("collect");
    // 数据全量断言（描述文本里的 collect 措辞随之删除）：三个拆分 schema 序列化后零残留。
    expect(JSON.stringify(start)).not.toContain("collect");
    expect(JSON.stringify(manage)).not.toContain("collect");
    expect(JSON.stringify(message)).not.toContain("collect");
  });

  it("sits flattened at top level beside task/slug/engine (拍平契约不变，D3 必填性真实化)", () => {
    const props = Object.keys(startProperties());
    for (const sibling of ["task", "slug", "engine"]) {
      expect(props).toContain(sibling);
    }
    // 拆分结构负锚：start schema 无 action 字段（action 只在 manage/message）
    expect(props).not.toContain("action");
    expect(props).not.toContain("listParam");
    expect(props).not.toContain("cancelParam");
    expect(props).not.toContain("messageParam");
    expect(props).not.toContain("closeParam");
    expect(props).not.toContain("forkFromParam");
  });

  it("conversation param is deleted (modeless 波5：模式消亡，schema 层不可再自报)", () => {
    expect(Object.keys(startProperties())).not.toContain("conversation");
  });
});
