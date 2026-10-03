/**
 * Workflow DAG 静态解析器（设计 workflow-visualization §3.1-3 / §3.3-D2）
 *
 * scriptSource（record `run-created` 携带的脚本全文）→ WorkflowDag 纯函数。
 * acorn 解析 + 自写 AST 遍历，零 IO 零副作用。
 *
 * 识别规则（与 worker-script-builder 的执行 API 一一对应）：
 * - 节点 = 脚本字面中的 `agent(...)` 调用点（含 parallel 实参子树内、函数体内、
 *   map 回调内的形态）；kind 恒 'agent'（'script-step' 为协议预留值，脚本门禁
 *   步骤无独立调用语法，v1 不产）。
 * - helper 投影：全程序恰含 1 个 `agent()` 调用的**具名**函数（FunctionDeclaration
 *   或 const/let/var 绑定的函数表达式/箭头，参数 ≥1）登记为 agent-helper；其调用点
 *   投影为虚拟 agent 调用点——显示名取第一实参（对象字面量形态优先 description/label
 *   属性表达式，串/模板形态直取），phase 取调用点词法 currentPhase；helper 体内的
 *   agent() 实现点不再按词法位置收口。动因：平台适配层脚本（zsw-skills 单源拼接产物
 *   的 wfAgent/askAgent——zcode 公共体 `agent(name, persona).ask<T>()` 转 pi 签名的
 *   桥接函数）把唯一实现点藏在声明处（词法上先于全部 phase()），旧规则下 DAG 退化为
 *   「唯一节点落缺省分区 + 全部实例未匹配」；投影后每个派发点恢复为带名节点、落对
 *   分区，与运行时实例经 D2 判据正常挂接。
 * - phase 分区 = `phase(name)` 调用序列（首现序）；字面量实参才登记分区，动态
 *   实参（拼接/函数调用）不造伪名——其后的调用点归缺省分区（与 worker 侧
 *   `opts.phase || _currentPhase` 的归属快照语义对齐：静态不可得名即缺省）。
 *   phase 上下文按函数边界作用域化：进入函数继承外层，体内 phase() 只影响体内
 *   节点、退出恢复外层——延迟调用的具名函数（如 retireClosure）体内的 phase()
 *   不得污染声明位置之后的顶层归属（纯词法遍历不模拟执行时刻）。
 * - 模板名（§3.3-D2-①）：调用点 description（或 label）表达式的模板形态——
 *   字面段原样、变量段记 `${…}` 通配段，编译为「字面段精确 + 变量段通配」的
 *   锚定正则（matchPattern，字面段按正则字面量转义）；description 为非静态
 *   表达式（函数调用/标识符等）或缺省时整段记通配（templateName '*'）。
 * - 边：sequence（词法序相邻单元，并行组扇出/扇入）/ dataflow（上游返回值
 *   变量被下游实参引用）/ conditional（if/三元直接环绕的调用点，谓词原文随
 *   边）/ loop-back（循环体回边，loops[] 同时承载循环体节点集）。
 * - 零调用点脚本（纯门禁）→ nodes 空数组（渲染层出空画布 + 居中摘要提示，设计 §3.1-3）。
 * - 不支持语法 fail-fast：acorn 解析失败与遍历期内部异常均返回结构化错误
 *   `{ code: 'parse_failed', message }`——原生异常不得逃出结构化错误边界
 *   （出界会被挂接侧归类为可重试通道错误，而非 parse_failed），不产半个错误 DAG。
 *
 * 已知静态边界（登记，不做模拟执行）：
 * - opts 对象在调用点之外构造、经变量传入 parallel() 的形态（如
 *   execute-full-workflow 的 `subWave.map(...)` → `parallel(subCalls)`）脚本字面
 *   无 agent() 调用点，解析为零调用点；运行时实例经事件流「未匹配实例」分组
 *   兜底（设计 D2 ⑥），不静默丢失。
 * - helper 投影的边界：多 agent() 调用的 helper、零参数 helper（名字无实参入口）、
 *   匿名回调（map 等实参位置的函数——批量回调内的调用点语义保持现状）、helper 体内
 *   再调/嵌套声明其他 helper（外层让位于内层）、同名重复声明（首个录取）均不投影——
 *   相关调用点保持词法位置收口，归属漂移由挂接侧「未匹配实例」分组兜底；helper 体内
 *   对显示名的后处理（replace 等）不在投影语义内，模板取自调用点第一实参原文。
 * - dataflow/conditional 判定为名字级匹配，不做作用域 shadow 分析（同名词法
 *   槽极罕见；误连边的代价是图上多一条提示边，不产生错误结构）。
 * - dataflow 只认 `await agent(...)` / `await parallel(...)` 的直接绑定；helper
 *   返回的 ask 闭包经 `.ask()` 二跳才产生实例，跨跳数据流不追踪（投影节点仍按
 *   词法序连 sequence 边）。
 * - parallel 实参子树内的嵌套 parallel() 调用不展开（collectParallelMembers
 *   短路 return，主遍历亦不进入）：嵌套组成员的调用点不产节点，运行时实例经
 *   事件流「未匹配实例」分组兜底（设计 D2 ⑥），不静默丢失。
 *
 * 类型跟随锚（core 为定义源——本文件是解析器产物类型；shared 的 WorkflowDag 族为
 * u2 协议冻结面（跨包消费契约），core 包不依赖 @taiji/shared、双侧逐字段等值——同
 * RunOutcome 值域跟随先例的「core 定义源 + shared 跟随载体」方向）：
 * packages/shared/src/workflow.ts 的 WorkflowDag 族（u2 冻结）。
 * 扩字段同步链：双侧同 commit 同步。等值锁定实测形态：shared 扩必选字段而 core
 * 未跟 → runtime 赋值点 typecheck 红（workflow-run-events-reader.ts）；core 扩
 * 必选字段 → 本文件构造点 typecheck 红（core 加可选字段方向无编译拦截，靠本注释
 * 的同步义务约束）。
 */

import * as acorn from "acorn";

/** DAG 节点类型（跟随 shared WorkflowDagNodeKind）。 */
export type WorkflowDagNodeKind = "agent" | "script-step"; // oe-exempt:20261002:framework:workflow-viz 协议类型双侧等值跟随（core 为定义源——解析器产物类型；shared 为 u2 协议冻结面、跨包消费契约，core 包不依赖 shared——仓内 SUBAGENT_RECORD_CUSTOM_TYPE 同款先例；改字段须同 commit 双侧同步，等值锁定 = shared 侧扩必选字段而 core 未跟时 runtime 赋值点 typecheck 红（workflow-run-events-reader）+ core 侧构造点受本地接口约束）

/** DAG 节点（跟随 shared WorkflowDagNode——权威源在本包，shared u2 冻结跟随）。 */
export interface WorkflowDagNode { // oe-exempt:20261002:framework:workflow-viz 协议类型双侧等值跟随（core 为定义源——解析器产物类型；shared 为 u2 协议冻结面、跨包消费契约，core 包不依赖 shared——仓内 SUBAGENT_RECORD_CUSTOM_TYPE 同款先例；改字段须同 commit 双侧同步，等值锁定 = shared 侧扩必选字段而 core 未跟时 runtime 赋值点 typecheck 红（workflow-run-events-reader）+ core 侧构造点受本地接口约束）
  /** 节点 id（`agent-L<行号>-N<序>`，图内唯一）。 */
  id: string;
  kind: WorkflowDagNodeKind;
  /** 模板名（字面段原样 + 变量段 `${…}`；非静态表达式整段 `*`）。 */
  templateName: string;
  /** 实例匹配正则源（锚定 `^…$`；new RegExp(matchPattern) 可编译）。 */
  matchPattern: string;
  /** 归属 phase 名（无 phase 归属 = 缺省分区 WORKFLOW_DAG_DEFAULT_PHASE）。 */
  phase: string;
  /** 调用点行号（1-based）。 */
  line: number;
}

/** DAG 边类型（跟随 shared WorkflowDagEdgeKind）。 */
export type WorkflowDagEdgeKind = "sequence" | "dataflow" | "conditional" | "loop-back"; // oe-exempt:20261002:framework:workflow-viz 协议类型双侧等值跟随（core 为定义源——解析器产物类型；shared 为 u2 协议冻结面、跨包消费契约，core 包不依赖 shared——仓内 SUBAGENT_RECORD_CUSTOM_TYPE 同款先例；改字段须同 commit 双侧同步，等值锁定 = shared 侧扩必选字段而 core 未跟时 runtime 赋值点 typecheck 红（workflow-run-events-reader）+ core 侧构造点受本地接口约束）

/** DAG 边（跟随 shared WorkflowDagEdge）。 */
export interface WorkflowDagEdge { // oe-exempt:20261002:framework:workflow-viz 协议类型双侧等值跟随（core 为定义源——解析器产物类型；shared 为 u2 协议冻结面、跨包消费契约，core 包不依赖 shared——仓内 SUBAGENT_RECORD_CUSTOM_TYPE 同款先例；改字段须同 commit 双侧同步，等值锁定 = shared 侧扩必选字段而 core 未跟时 runtime 赋值点 typecheck 红（workflow-run-events-reader）+ core 侧构造点受本地接口约束）
  /** 边 id（`edge-<序>`，图内唯一）。 */
  id: string;
  from: string;
  to: string;
  kind: WorkflowDagEdgeKind;
  /** 条件边触发谓词原文（kind='conditional' 时携带）。 */
  predicate?: string;
}

/** phase 分区（跟随 shared WorkflowDagPhase）。 */
export interface WorkflowDagPhase { // oe-exempt:20261002:framework:workflow-viz 协议类型双侧等值跟随（core 为定义源——解析器产物类型；shared 为 u2 协议冻结面、跨包消费契约，core 包不依赖 shared——仓内 SUBAGENT_RECORD_CUSTOM_TYPE 同款先例；改字段须同 commit 双侧同步，等值锁定 = shared 侧扩必选字段而 core 未跟时 runtime 赋值点 typecheck 红（workflow-run-events-reader）+ core 侧构造点受本地接口约束）
  name: string;
  order: number;
}

/** 并行组（跟随 shared WorkflowDagParallelGroup）。 */
export interface WorkflowDagParallelGroup { // oe-exempt:20261002:framework:workflow-viz 协议类型双侧等值跟随（core 为定义源——解析器产物类型；shared 为 u2 协议冻结面、跨包消费契约，core 包不依赖 shared——仓内 SUBAGENT_RECORD_CUSTOM_TYPE 同款先例；改字段须同 commit 双侧同步，等值锁定 = shared 侧扩必选字段而 core 未跟时 runtime 赋值点 typecheck 红（workflow-run-events-reader）+ core 侧构造点受本地接口约束）
  nodeIds: string[];
}

/** 循环标注（跟随 shared WorkflowDagLoop）。 */
export interface WorkflowDagLoop { // oe-exempt:20261002:framework:workflow-viz 协议类型双侧等值跟随（core 为定义源——解析器产物类型；shared 为 u2 协议冻结面、跨包消费契约，core 包不依赖 shared——仓内 SUBAGENT_RECORD_CUSTOM_TYPE 同款先例；改字段须同 commit 双侧同步，等值锁定 = shared 侧扩必选字段而 core 未跟时 runtime 赋值点 typecheck 红（workflow-run-events-reader）+ core 侧构造点受本地接口约束）
  /** 循环标注 id（`loop-<序>`，图内唯一）。 */
  id: string;
  /** 循环体节点 id 集合（按执行序）。 */
  nodeIds: string[];
  /** 循环回边 id（kind='loop-back' 的边）。 */
  backEdgeId: string;
  /** 循环条件/标签原文（可缺省）。 */
  label?: string;
}

/** Workflow DAG（跟随 shared WorkflowDag——结构与 shared u2 冻结形态逐字段一致）。 */
export interface WorkflowDag { // oe-exempt:20261002:framework:workflow-viz 协议类型双侧等值跟随（core 为定义源——解析器产物类型；shared 为 u2 协议冻结面、跨包消费契约，core 包不依赖 shared——仓内 SUBAGENT_RECORD_CUSTOM_TYPE 同款先例；改字段须同 commit 双侧同步，等值锁定 = shared 侧扩必选字段而 core 未跟时 runtime 赋值点 typecheck 红（workflow-run-events-reader）+ core 侧构造点受本地接口约束）
  nodes: WorkflowDagNode[];
  edges: WorkflowDagEdge[];
  phases: WorkflowDagPhase[];
  parallelGroups: WorkflowDagParallelGroup[];
  loops: WorkflowDagLoop[];
}

/** 未标注 phase 的调用点归入的缺省分区名（shared 未冻结该常量值——展示层直接消费节点.phase）。 */
export const WORKFLOW_DAG_DEFAULT_PHASE = "default";

/** 解析失败结构化错误（session.getWorkflowDag 错误臂的 parse_failed 码源）。 */
export type WorkflowDagParseResult =
  | { ok: true; dag: WorkflowDag }
  | { ok: false; code: "parse_failed"; message: string };

// ── 最小 AST 形态（宽松局部接口——避免引入 @types/estree 依赖）──

interface AstNode { // oe-exempt:20261002:framework:workflow-viz 解析器 AST 帧类型——判别联合成员数据形状，非抽象接口
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number; column: number } };
  [key: string]: unknown;
}

const isNode = (v: unknown): v is AstNode =>
  typeof v === "object" && v !== null && typeof (v as AstNode).type === "string";

/** 按源码序收集直接子节点（child node 按 start 排序——遍历序 = 词法序）。 */
function childNodes(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 字面串提取：StringLiteral，或无表达式的 TemplateLiteral（cooked 值）。 */
function literalStringOf(node: AstNode | undefined): string | undefined {
  if (node == null) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0) {
    const quasi = (node.quasis as AstNode[])[0];
    const cooked = quasi?.value as { cooked?: unknown } | undefined;
    return typeof cooked?.cooked === "string" ? cooked.cooked : undefined;
  }
  return undefined;
}

/** ObjectExpression 中 key 为普通标识符/字符串字面量的属性值节点。 */
function objectPropValue(obj: AstNode, key: string): AstNode | undefined {
  for (const prop of obj.properties as AstNode[]) {
    if (prop.type !== "Property" || (prop.computed as boolean) === true) continue;
    const k = prop.key as AstNode;
    if (k.type === "Identifier" && k.name === key) return prop.value as AstNode;
    if (k.type === "Literal" && k.value === key) return prop.value as AstNode;
  }
  return undefined;
}

/** 正则字面量转义（§3.3-D2-①：防实例名含 `+`/`(` 等字符时误匹配）。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 谓词/循环标签原文切片的截断上限（DAG 边上标注的可读性上界，非语义边界）。 */
const PREDICATE_SNIPPET_MAX_LENGTH = 120;

/** 源码切片（谓词/循环标签原文），超长截断。 */
function sourceSlice(source: string, node: AstNode, max = PREDICATE_SNIPPET_MAX_LENGTH): string {
  const text = source.slice(node.start, node.end);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * description 表达式 → 模板形态（templateName + 锚定 matchPattern）。
 * 字面段原样、变量段 `${…}`（正则 `.*`）、非静态表达式整段 `*`（正则 `.*`）。
 */
function extractNameTemplate(source: string, expr: AstNode | undefined): { template: string; pattern: string } {
  const segments: Array<{ text: string; literal: boolean }> = [];
  const pushLiteral = (text: string): void => {
    segments.push({ text, literal: true });
  };
  const pushWildcard = (): void => {
    const last = segments[segments.length - 1];
    if (last === undefined || last.literal) segments.push({ text: "", literal: false });
  };

  const visit = (node: AstNode): void => {
    const str = literalStringOf(node);
    if (str !== undefined) {
      pushLiteral(str);
      return;
    }
    if (node.type === "TemplateLiteral") {
      const quasis = node.quasis as AstNode[];
      const exprs = node.expressions as AstNode[];
      for (let i = 0; i < quasis.length; i++) {
        const cooked = (quasis[i]?.value as { cooked?: unknown } | undefined)?.cooked;
        if (typeof cooked === "string" && cooked.length > 0) pushLiteral(cooked);
        if (i < exprs.length) pushWildcard();
      }
      return;
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      // 二元拼接链按源码序展平（left 先于 right）
      visit(node.left as AstNode);
      visit(node.right as AstNode);
      return;
    }
    pushWildcard();
  };

  if (expr == null) {
    // description 缺省或非静态可提取 → 整段通配（§3.3-D2-①）；与表达式分支同锚定形态
    return { template: "*", pattern: "^.*$" };
  }
  visit(expr);
  // 相邻通配段已合并（pushWildcard 只在末段为字面或空时追加）；拼接连续字面段保留原样
  let template = "";
  let pattern = "";
  for (const seg of segments) {
    if (seg.literal) {
      template += seg.text;
      pattern += escapeRegExp(seg.text);
    } else {
      template += "${…}";
      pattern += ".*";
    }
  }
  if (!segments.some((s) => s.literal)) template = "*";
  return { template, pattern: `^${pattern}$` };
}

// ── 遍历上下文与收口 ─────────────────────────────────────────

interface IfFrame { // oe-exempt:20261002:framework:workflow-viz 解析器 AST 帧类型——判别联合成员数据形状，非抽象接口
  kind: "if";
  entryBatch: string[];
  predicate: string;
  consumed: boolean;
}

interface LoopFrame { // oe-exempt:20261002:framework:workflow-viz 解析器 AST 帧类型——判别联合成员数据形状，非抽象接口
  kind: "loop";
  entryBatch: string[];
  bodyNodes: string[];
  label: string;
}

type CtrlFrame = IfFrame | LoopFrame;

interface EdgeCandidate { // oe-exempt:20261002:framework:workflow-viz 解析器 AST 帧类型——判别联合成员数据形状，非抽象接口
  from: string;
  to: string;
  kind: WorkflowDagEdgeKind;
  predicate?: string;
}

/** loop-back 回边候选（携带 loopId——回边按 loop 归属配对：嵌套循环共享 (首,末) 节点对时各持独立边，不因 (from,to) 同键覆盖共享同一条）。 */
interface LoopBackEdgeCandidate { // oe-exempt:20261002:framework:workflow-viz 解析器 AST 帧类型——判别联合成员数据形状，非抽象接口
  loopId: string;
  from: string;
  to: string;
}

interface ParseCtx { // oe-exempt:20261002:framework:workflow-viz 解析器 AST 帧类型——判别联合成员数据形状，非抽象接口
  source: string;
  currentPhase: string | undefined;
  phaseOrder: Map<string, number>;
  nodes: WorkflowDagNode[];
  parallelGroups: string[][];
  loops: WorkflowDagLoop[];
  ctrlStack: CtrlFrame[];
  prevBatch: string[];
  /** 最近收口单元的节点 ids（VariableDeclarator binding 登记源）。 */
  lastUnitIds: string[];
  bindings: Map<string, string[]>;
  sequenceEdges: EdgeCandidate[];
  conditionalEdges: EdgeCandidate[];
  dataflowEdges: EdgeCandidate[];
  loopBackEdges: LoopBackEdgeCandidate[];
  nodeSeq: number;
  loopSeq: number;
  /** 具名单 agent 调用 helper 注册表（name → 函数体与内部实现调用点）。 */
  agentHelpers: Map<string, AgentHelperEntry>;
  /** 已登记 helper 体内的 agent() 实现点（主遍历跳过——投影由 helper 调用点承载）。 */
  helperInternalCalls: Set<AstNode>;
}

function registerPhase(ctx: ParseCtx, name: string): void {
  if (!ctx.phaseOrder.has(name)) ctx.phaseOrder.set(name, ctx.phaseOrder.size);
}

function newId(prefix: string, seq: number): string {
  return `${prefix}-${seq}`;
}

/** agent-helper 登记（恰含 1 个 agent() 调用的具名函数——调用点投影为虚拟 agent 调用点）。 */
interface AgentHelperEntry { // oe-exempt:20261002:framework:workflow-viz 解析器 AST 帧类型——判别联合成员数据形状，非抽象接口
  fn: AstNode;
  /** 体内唯一 agent() 调用节点（主遍历跳过的实现点）。 */
  internalCall: AstNode;
}

/** 调用点实参子树的 Identifier 引用扫描（排除 non-computed 成员属性与对象 key）。 */
function collectIdentifierRefs(node: AstNode, out: Set<string>): void {
  for (const child of childNodes(node)) {
    if (child.type === "Identifier") {
      if (typeof child.name === "string") out.add(child.name);
      continue;
    }
    // non-computed 的成员属性/对象 key 是 Identifier 节点但不构成变量引用
    if (
      (child.type === "MemberExpression" && !(child.computed as boolean)) ||
      (child.type === "Property" && !(child.computed as boolean))
    ) {
      for (const grandchild of childNodes(child)) {
        if (grandchild !== child.property && grandchild !== child.key) {
          // 对象侧/value 侧为叶子标识符时必须直接登记——collectIdentifierRefs 只收
          // 子节点，叶子无子节点、递归自身将永久丢失（r1.output 的对象侧引用）
          if (grandchild.type === "Identifier") {
            if (typeof grandchild.name === "string") out.add(grandchild.name);
          } else {
            collectIdentifierRefs(grandchild, out);
          }
        }
      }
      continue;
    }
    collectIdentifierRefs(child, out);
  }
}

/** 提取 agent 调用点的 description/label 表达式与显式 opts.phase。 */
function extractAgentDescription(callNode: AstNode): { descExpr: AstNode | undefined; explicitPhaseExpr: AstNode | undefined } {
  const args = callNode.arguments as AstNode[];
  const first = args[0];
  const second = args[1];
  if (first != null && first.type === "ObjectExpression") {
    return {
      descExpr: objectPropValue(first, "description") ?? objectPropValue(first, "label"),
      explicitPhaseExpr: objectPropValue(first, "phase"),
    };
  }
  // agent("prompt", { label, ... }) 形态：显示名取第二实参 label
  if (second != null && second.type === "ObjectExpression") {
    return { descExpr: objectPropValue(second, "label"), explicitPhaseExpr: undefined };
  }
  // agent(expr)（Object.assign/标识符等）——description 静态不可见
  return { descExpr: undefined, explicitPhaseExpr: undefined };
}

/** 建节点 + 数据流扫描（模板/phase/实参集由调用方解析——直接调用点与 helper 投影共用）。返回节点 id。 */
function pushAgentNode(
  ctx: ParseCtx,
  callNode: AstNode,
  template: string,
  pattern: string,
  phaseName: string,
  argNodes: readonly AstNode[],
): string {
  registerPhase(ctx, phaseName);

  const id = `agent-L${callNode.loc?.start.line ?? 0}-N${ctx.nodeSeq++}`;
  ctx.nodes.push({
    id,
    kind: "agent",
    templateName: template,
    matchPattern: pattern,
    phase: phaseName,
    line: callNode.loc?.start.line ?? 0,
  });

  // 数据流：实参子树引用的上游绑定变量 → dataflow 候选边
  const refs = new Set<string>();
  for (const arg of argNodes) collectIdentifierRefs(arg, refs);
  for (const name of refs) {
    const fromIds = ctx.bindings.get(name);
    if (fromIds !== undefined) {
      for (const from of fromIds) ctx.dataflowEdges.push({ from, to: id, kind: "dataflow" });
    }
  }
  return id;
}

/** 收口单个 agent 调用点：建节点 + 数据流扫描。返回节点 id。 */
function emitAgentCallSite(ctx: ParseCtx, callNode: AstNode): string {
  const { descExpr, explicitPhaseExpr } = extractAgentDescription(callNode);
  const { template, pattern } = extractNameTemplate(ctx.source, descExpr);
  const explicitPhase = literalStringOf(explicitPhaseExpr);
  // worker 侧归属快照 = opts.phase || _currentPhase；静态侧同序回落，均不可得归缺省分区
  const phaseName = explicitPhase ?? ctx.currentPhase ?? WORKFLOW_DAG_DEFAULT_PHASE;
  return pushAgentNode(ctx, callNode, template, pattern, phaseName, callNode.arguments as AstNode[]);
}

/**
 * helper 调用点投影：虚拟 agent 调用点。显示名取第一实参（对象字面量形态优先
 * description/label 属性表达式——对齐 agent 自身 opts 契约，askAgent(callSpec) 形态
 * 据此保留模板名；串/模板形态直取——wfAgent(name) 形态）；phase 取调用点词法
 * currentPhase（helper 调用不携带 phase opts）。
 */
function emitHelperCallSite(ctx: ParseCtx, callNode: AstNode): string {
  const args = callNode.arguments as AstNode[];
  const first = args[0];
  const descExpr =
    first != null && first.type === "ObjectExpression"
      ? (objectPropValue(first, "description") ?? objectPropValue(first, "label"))
      : first;
  const { template, pattern } = extractNameTemplate(ctx.source, descExpr);
  const phaseName = ctx.currentPhase ?? WORKFLOW_DAG_DEFAULT_PHASE;
  return pushAgentNode(ctx, callNode, template, pattern, phaseName, args);
}

/** 收口一个执行单元（单节点或并行组）：条件/顺序边推进 + 循环体记录。 */
function closeUnit(ctx: ParseCtx, ids: string[]): void {
  if (ids.length === 0) return;
  const top = ctx.ctrlStack[ctx.ctrlStack.length - 1];
  let connected = false;
  if (top !== undefined && top.kind === "if" && !top.consumed) {
    // if/三元直接环绕的首单元：conditional 边（谓词随边），不另连 sequence
    for (const entry of top.entryBatch) {
      ctx.conditionalEdges.push({ from: entry, to: ids[0], kind: "conditional", predicate: top.predicate });
    }
    top.consumed = true;
    connected = top.entryBatch.length > 0;
  }
  if (!connected) {
    for (const from of ctx.prevBatch) {
      for (const to of ids) {
        if (from !== to) ctx.sequenceEdges.push({ from, to, kind: "sequence" });
      }
    }
  }
  for (const frame of ctx.ctrlStack) {
    if (frame.kind === "loop") frame.bodyNodes.push(...ids);
  }
  ctx.prevBatch = ids;
  ctx.lastUnitIds = ids;
}

/** CallExpression 是否为指定全局函数的直接调用（callee 为裸 Identifier）。 */
function isGlobalCall(node: AstNode, name: string): boolean {
  return node.type === "CallExpression" && (node.callee as AstNode).type === "Identifier" && (node.callee as AstNode).name === name;
}

function isAwaitOf(node: AstNode, name: string): boolean {
  return node.type === "AwaitExpression" && isGlobalCall(node.argument as AstNode, name);
}

/** VariableDeclarator 的绑定名集合（Identifier 或 ArrayPattern 元素）。 */
function declaratorNames(idNode: AstNode | undefined): { kind: "single"; name: string } | { kind: "array"; names: string[] } | undefined {
  if (idNode == null) return undefined;
  if (idNode.type === "Identifier" && typeof idNode.name === "string") return { kind: "single", name: idNode.name };
  if (idNode.type === "ArrayPattern") {
    const names: string[] = [];
    for (const el of idNode.elements as AstNode[]) {
      if (el !== null && el.type === "Identifier" && typeof el.name === "string") names.push(el.name);
    }
    return { kind: "array", names };
  }
  return undefined;
}

/** parallel 实参子树的成员收集（短路：嵌套 parallel 不深入；helper 调用点投影为成员）。 */
function collectParallelMembers(ctx: ParseCtx, node: AstNode, memberIds: string[]): void {
  if (isGlobalCall(node, "agent")) {
    if (!ctx.helperInternalCalls.has(node)) memberIds.push(emitAgentCallSite(ctx, node));
    return;
  }
  if (helperCallName(ctx, node) !== undefined) {
    memberIds.push(emitHelperCallSite(ctx, node));
    return;
  }
  if (isGlobalCall(node, "phase")) {
    handlePhaseCall(ctx, node);
  }
  if (isGlobalCall(node, "parallel")) return; // 嵌套并行不展开（登记于头注释边界）
  for (const child of childNodes(node)) collectParallelMembers(ctx, child, memberIds);
}

function handlePhaseCall(ctx: ParseCtx, callNode: AstNode): void {
  // 动态实参（拼接/函数调用）不造伪名——currentPhase 置空，后续调用点归缺省分区
  ctx.currentPhase = literalStringOf((callNode.arguments as AstNode[])[0]);
  if (ctx.currentPhase !== undefined) registerPhase(ctx, ctx.currentPhase);
}

/** 主遍历：按词法序收口调用点与控制流上下文（各 case 主体在对应 handler 内）。 */
function visit(ctx: ParseCtx, node: AstNode): void {
  switch (node.type) {
    case "CallExpression":
      // 编排全局（phase/agent/parallel）短路收口（实参子树不再通用遍历）——防止
      // parallel 成员被主遍历二次收口；实参内嵌套编排调用的极端形态登记于头注释静态边界。
      if (handleOrchestrationCall(ctx, node)) return;
      break;
    case "VariableDeclarator":
      visitVariableDeclarator(ctx, node);
      return;
    case "IfStatement":
      // consequent / alternate 各自独立帧：else 分支首单元同样连 conditional 边
      visitBranch(
        ctx,
        node.test as AstNode,
        node.consequent as AstNode,
        node.alternate as AstNode | undefined,
      );
      return;
    case "ConditionalExpression":
      visitBranch(ctx, node.test as AstNode, node.consequent as AstNode, node.alternate as AstNode);
      return;
    case "WhileStatement":
    case "DoWhileStatement":
    case "ForStatement":
    case "ForOfStatement":
    case "ForInStatement":
      visitLoop(ctx, node);
      return;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      visitPhaseScopedFunction(ctx, node);
      return;
    default:
      break;
  }
  for (const child of childNodes(node)) visit(ctx, child);
}

/** CallExpression 是否为已登记 agent-helper 的调用（callee 裸 Identifier 且在注册表）。 */
function helperCallName(ctx: ParseCtx, node: AstNode): string | undefined {
  if (node.type !== "CallExpression") return undefined;
  const callee = node.callee as AstNode;
  const name = callee.type === "Identifier" && typeof callee.name === "string" ? callee.name : undefined;
  return name !== undefined && ctx.agentHelpers.has(name) ? name : undefined;
}

/** 编排全局调用短路收口：返回 true = 已收口（调用方不再通用遍历实参子树）。 */
function handleOrchestrationCall(ctx: ParseCtx, node: AstNode): boolean {
  if (isGlobalCall(node, "phase")) {
    handlePhaseCall(ctx, node);
    return true;
  }
  if (isGlobalCall(node, "agent")) {
    // helper 体内的实现点：投影由 helper 调用点承载，不再按词法位置收口——
    // 消除「adapter 声明在全部 phase 之前 → 唯一节点落缺省分区」的假象
    if (ctx.helperInternalCalls.has(node)) return true;
    closeUnit(ctx, [emitAgentCallSite(ctx, node)]);
    return true;
  }
  if (isGlobalCall(node, "parallel")) {
    closeUnit(ctx, collectParallelGroup(ctx, node));
    return true;
  }
  if (helperCallName(ctx, node) !== undefined) {
    closeUnit(ctx, [emitHelperCallSite(ctx, node)]);
    return true;
  }
  return false;
}

// ── agent-helper 收集（恰含 1 个 agent() 调用的具名函数）──────────────────

interface HelperCandidate { // oe-exempt:20261002:framework:workflow-viz 解析器 AST 帧类型——判别联合成员数据形状，非抽象接口
  name: string;
  fn: AstNode;
  /** 子树内全部 bare `agent()` 调用（含嵌套函数体内——wfAgent 形态的调用在返回对象的方法箭头里）。 */
  calls: AstNode[];
}

/** 函数子树内全部 bare `agent()` 调用收集。 */
function collectSubtreeAgentCalls(node: AstNode, out: AstNode[]): void {
  for (const child of childNodes(node)) {
    if (isGlobalCall(child, "agent")) out.push(child);
    collectSubtreeAgentCalls(child, out);
  }
}

/** 函数子树内对指定名集的 bare 调用收集（复合 helper 检测——内部调其他 helper 者不投影）。 */
function collectCallsToNames(node: AstNode, names: ReadonlySet<string>, out: AstNode[]): void {
  for (const child of childNodes(node)) {
    if (child.type === "CallExpression") {
      const callee = child.callee as AstNode;
      if (callee.type === "Identifier" && typeof callee.name === "string" && names.has(callee.name)) out.push(child);
    }
    collectCallsToNames(child, names, out);
  }
}

/**
 * 具名函数候选收集：FunctionDeclaration / const·let·var 绑定的函数表达式与箭头。
 * 匿名实参位置函数（map 回调等）不是候选——批量回调内的调用点语义保持现状。
 */
function collectHelperCandidates(node: AstNode, out: HelperCandidate[]): void {
  if (node.type === "FunctionDeclaration") {
    const id = node.id as AstNode | undefined;
    if (id != null && id.type === "Identifier" && typeof id.name === "string") {
      const calls: AstNode[] = [];
      collectSubtreeAgentCalls(node, calls);
      out.push({ name: id.name, fn: node, calls });
    }
  } else if (node.type === "VariableDeclarator") {
    const id = node.id as AstNode | undefined;
    const init = node.init as AstNode | undefined;
    if (
      id != null && id.type === "Identifier" && typeof id.name === "string" && init != null &&
      (init.type === "FunctionExpression" || init.type === "ArrowFunctionExpression")
    ) {
      const calls: AstNode[] = [];
      collectSubtreeAgentCalls(init, calls);
      out.push({ name: id.name, fn: init, calls });
    }
  }
  for (const child of childNodes(node)) collectHelperCandidates(child, out);
}

/**
 * helper 注册表构建：恰 1 个 agent() 调用 + 参数 ≥1 + 子树不调/不嵌套其他已录取
 * helper。跨度升序录取（内层先录取，外层按包含/调用关系让位）——双层投影会失真
 * （外层第一实参 ≠ 内层实现实际收到的名字），让位后外层体内对内层的调用点仍按
 * 内层投影（phase 取外层体内词法位置），外层自身的调用点不产节点。
 */
function collectAgentHelpers(program: AstNode): Map<string, AgentHelperEntry> {
  const candidates: HelperCandidate[] = [];
  collectHelperCandidates(program, candidates);
  candidates.sort((a, b) => a.fn.end - a.fn.start - (b.fn.end - b.fn.start));
  const byName = new Map<string, AgentHelperEntry>();
  for (const cand of candidates) {
    if (byName.has(cand.name)) continue; // 同名重复声明：首个录取（hoisting 末者胜为病理形态，登记于头注释边界）
    if (cand.calls.length !== 1) continue;
    if ((cand.fn.params as AstNode[]).length === 0) continue;
    const composedCalls: AstNode[] = [];
    collectCallsToNames(cand.fn, new Set(byName.keys()), composedCalls);
    if (composedCalls.length > 0) continue;
    let containsAccepted = false;
    for (const entry of byName.values()) {
      if (entry.fn !== cand.fn && entry.fn.start >= cand.fn.start && entry.fn.end <= cand.fn.end) {
        containsAccepted = true;
        break;
      }
    }
    if (containsAccepted) continue;
    byName.set(cand.name, { fn: cand.fn, internalCall: cand.calls[0] as AstNode });
  }
  return byName;
}

/** parallel 实参成员收集 + 并行组登记（成员非空时）；返回成员 id 供 closeUnit 收口。空组（变量形态）对顺序链不可见——prevBatch 不变。 */
function collectParallelGroup(ctx: ParseCtx, node: AstNode): string[] {
  const memberIds: string[] = [];
  const arg = (node.arguments as AstNode[])[0];
  if (arg != null) collectParallelMembers(ctx, arg, memberIds);
  if (memberIds.length > 0) ctx.parallelGroups.push(memberIds);
  return memberIds;
}

/** 变量声明：init 子树先遍历，再按绑定形态把 lastUnitIds 登记进 bindings。 */
function visitVariableDeclarator(ctx: ParseCtx, node: AstNode): void {
  const init = node.init as AstNode | undefined;
  if (init == null) return;
  visit(ctx, init);
  const source = ctx.lastUnitIds;
  const binding = declaratorNames(node.id as AstNode | undefined);
  if (binding !== undefined && source.length > 0) recordBinding(ctx, binding, init, source);
}

/** 绑定登记三分支：单名 await agent（单源直登记）/ 单名 await parallel（整批）/ 解构 await parallel（按序对应并行组成员，成员序 = 数组元素序的常见形态）。 */
function recordBinding(
  ctx: ParseCtx,
  binding: { kind: "single"; name: string } | { kind: "array"; names: string[] },
  init: AstNode,
  source: string[],
): void {
  if (binding.kind === "single") {
    if (isAwaitOf(init, "agent") && source.length === 1) ctx.bindings.set(binding.name, source);
    else if (isAwaitOf(init, "parallel")) ctx.bindings.set(binding.name, source);
    return;
  }
  if (binding.kind === "array" && isAwaitOf(init, "parallel")) {
    binding.names.forEach((name, i) => {
      if (source[i] !== undefined) ctx.bindings.set(name, [source[i]]);
    });
  }
}

/** if / 三元分支：两臂各压独立 if 帧（同一 entryBatch + 谓词），臂内首单元连 conditional 边。 */
function visitBranch(ctx: ParseCtx, test: AstNode, consequent: AstNode, alternate: AstNode | undefined): void {
  const entryBatch = ctx.prevBatch;
  const predicate = sourceSlice(ctx.source, test);
  ctx.ctrlStack.push({ kind: "if", entryBatch, predicate, consumed: false });
  visit(ctx, consequent);
  ctx.ctrlStack.pop();
  if (alternate == null) return;
  ctx.ctrlStack.push({ kind: "if", entryBatch, predicate, consumed: false });
  visit(ctx, alternate);
  ctx.ctrlStack.pop();
}

/** 循环体遍历 + 回边闭合：体非空时登记 loop 与 loop-back 边，循环整体参与后续顺序链。 */
function visitLoop(ctx: ParseCtx, node: AstNode): void {
  const test = node.test as AstNode | undefined;
  const left = node.left as AstNode | undefined;
  const right = node.right as AstNode | undefined;
  // 标签三形态：while/do/for(带条件) 取 test；for-of/for-in 取「left … right」；
  // for(;;) 裸形 test/left/right 全缺席（ForStatement 无 left/right 字段）——回退
  // 固定标签，勿对 undefined 取 sourceSlice（原生 TypeError 会逃出结构化错误边界）
  const label =
    test != null
      ? sourceSlice(ctx.source, test)
      : left != null && right != null
        ? `${sourceSlice(ctx.source, left)} … ${sourceSlice(ctx.source, right)}`
        : "loop";
  ctx.ctrlStack.push({ kind: "loop", entryBatch: ctx.prevBatch, bodyNodes: [], label });
  visit(ctx, node.body as AstNode);
  const frame = ctx.ctrlStack.pop() as LoopFrame;
  if (frame.bodyNodes.length === 0) return;
  // 回边闭合循环体（末节点 → 首节点）。
  // 回边独立表收集（携带 loopId 按 loop 归属配对——嵌套循环共享 (首,末) 节点对时
  // 各持独立回边，不因同键覆盖让先压入的回边成孤儿），不与顺序/条件/数据流候选
  // 混表去重（方向天然不同向）。
  const loopId = newId("loop", ctx.loopSeq++);
  ctx.loops.push({ id: loopId, nodeIds: frame.bodyNodes, backEdgeId: `${loopId}-back`, label: frame.label });
  ctx.loopBackEdges.push({
    loopId,
    from: frame.bodyNodes[frame.bodyNodes.length - 1],
    to: frame.bodyNodes[0],
  });
  ctx.prevBatch = frame.bodyNodes;
  ctx.lastUnitIds = frame.bodyNodes;
}

/**
 * 函数体遍历（phase 上下文函数边界作用域化）：进入时继承外层 currentPhase（同步
 * 实参位置的回调——map/parallel 成员——归属语义不变），体内 phase() 只影响体内
 * 节点，退出恢复外层。若无体内 phase() 则行为与旧纯词法遍历完全一致。
 */
function visitPhaseScopedFunction(ctx: ParseCtx, node: AstNode): void {
  const saved = ctx.currentPhase;
  for (const child of childNodes(node)) visit(ctx, child);
  ctx.currentPhase = saved;
}

/** 候选边去重：同一 (from,to) 优先级 dataflow > conditional > sequence。边 id 由调用方统一编号。 */
function dedupeEdges(sequence: EdgeCandidate[], conditional: EdgeCandidate[], dataflow: EdgeCandidate[]): EdgeCandidate[] {
  const byPair = new Map<string, EdgeCandidate>();
  const priority: Record<WorkflowDagEdgeKind, number> = { sequence: 0, conditional: 1, dataflow: 2, "loop-back": 0 };
  const consider = (candidate: EdgeCandidate): void => {
    const key = `${candidate.from}\u0000${candidate.to}`;
    const existing = byPair.get(key);
    if (existing === undefined || priority[candidate.kind] > priority[existing.kind]) byPair.set(key, candidate);
  };
  for (const e of sequence) consider(e);
  for (const e of conditional) consider(e);
  for (const e of dataflow) consider(e);
  return [...byPair.values()];
}

/** 解析产物的循环回边 id 重写（回边按 loopId 配对——edge id 定序后 loops.backEdgeId 指向本 loop 自有边）。 */
function buildDag(source: string, program: AstNode): WorkflowDag {
  // helper 注册先于主遍历（函数声明 hoisting：调用点可先于声明出现）
  const agentHelpers = collectAgentHelpers(program);
  const ctx: ParseCtx = {
    source,
    currentPhase: undefined,
    phaseOrder: new Map(),
    nodes: [],
    parallelGroups: [],
    loops: [],
    ctrlStack: [],
    prevBatch: [],
    lastUnitIds: [],
    bindings: new Map(),
    sequenceEdges: [],
    conditionalEdges: [],
    dataflowEdges: [],
    loopBackEdges: [],
    nodeSeq: 0,
    loopSeq: 0,
    agentHelpers,
    helperInternalCalls: new Set([...agentHelpers.values()].map((entry) => entry.internalCall)),
  };
  visit(ctx, program);

  const forwardEdges = dedupeEdges(ctx.sequenceEdges, ctx.conditionalEdges, ctx.dataflowEdges);
  // 回边独立附加（不参与候选去重——方向与其余边类天然不同向）；loopId → 本 loop
  // 自有回边 id（嵌套循环共享 (首,末) 节点对时两条回边同 (from,to)——按 loopId 配对
  // 各归各，先压入的回边不成孤儿）
  const loopBackEdgeIdByLoop = new Map<string, string>();
  const edges: WorkflowDagEdge[] = [
    ...forwardEdges.map((e, i) => ({ ...e, id: newId("edge", i) })),
    ...ctx.loopBackEdges.map((e, i) => {
      const id = newId("edge", forwardEdges.length + i);
      loopBackEdgeIdByLoop.set(e.loopId, id);
      return { id, from: e.from, to: e.to, kind: "loop-back" as const };
    }),
  ];
  const loops: WorkflowDagLoop[] = ctx.loops.map((loop) => {
    const backEdgeId = loopBackEdgeIdByLoop.get(loop.id);
    if (backEdgeId === undefined) {
      throw new Error(`workflow-dag-parser: loop back edge missing for ${loop.id}`);
    }
    return { ...loop, backEdgeId };
  });

  const phases: WorkflowDagPhase[] = [...ctx.phaseOrder.entries()].map(([name, order]) => ({ name, order }));
  return {
    nodes: ctx.nodes,
    edges,
    phases,
    parallelGroups: ctx.parallelGroups.map((nodeIds) => ({ nodeIds })),
    loops,
  };
}

/**
 * 解析 workflow 脚本为静态 DAG 蓝图（纯函数；解析失败 fail-fast 返回结构化错误）。
 *
 * @param scriptSource 脚本全文（record `run-created` 的 scriptSource / 脚本文件原文）
 */
export function parseWorkflowDag(scriptSource: string): WorkflowDagParseResult {
  try {
    const program = acorn.parse(scriptSource, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      locations: true,
    }) as unknown as AstNode;
    // buildDag 同界包裹：遍历期内部异常不得以原生 throw 逃出结构化错误边界——
    // 逃出会被挂接侧（readDag 裸调无兜底）归类为可重试通道错误，而非 parse_failed
    return { ok: true, dag: buildDag(scriptSource, program) };
  } catch (err) {
    return {
      ok: false,
      code: "parse_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
