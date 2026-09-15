/**
 * agentRef / workflowRef 统一路径解析（S2）。
 *
 * 设计（agent-ref-path-redesign D1）：资源引用唯一形态 = 绝对路径。
 * - agentRef    → .md 文件绝对路径（注入段 <available_subagents> 的 <location>）
 * - workflowRef → .js 文件绝对路径（注入段 <available_workflows> 的 <location>）
 * - 支持 `~/` 前缀展开（homedir）；相对路径不认（注入段给绝对路径，模型照抄零歧义）
 *
 * 名字不再是引用——只是注入段展示标签。执行侧拿到引用后一律 normalizeRef →
 * 文件加载（AgentRegistry.loadByPath / WorkflowScriptRegistry.getPath）。
 *
 * `..` 路径段拒绝（sink 设计 ⛔2 声明的安全收紧，agent .md 与 workflow .js 引用
 * 同受此面——两宿主现状均放行，非等值变更）：`/x/../y.md` 形态允许引用逃逸出
 * 注入段声明的目录集（G1 例 2），引用串含 `..` 段一律拒绝。检测在 `~/` 展开前的
 * 原始引用上——join 展开会 normalize 消解 `..` 段（`~/../x` → `<home>/../x` 被解析
 * 成已消解路径），原始串检测使 `~/../x.md` 与 `/x/../y.md` 同判（`..` 逃逸向量与
 * 前缀形态无关）。保留 `.` 段与 `~/` 展开——最小收紧，不伤合法引用。
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** home 目录简写前缀（`~/`），展开为 homedir 绝对路径。 */
const HOME_DIR_PREFIX = "~/";

/**
 * 引用串是否含 `..` 段（`/x/../y`、`x\..\y`、`~/../x` 同判——展开前检测）。
 * 手动 split(/[\\/]) 与 displayAgentName 同款跨平台切分（本模块避免平台分支）。
 */
function hasParentSegment(ref: string): boolean {
  return ref.split(/[\\/]/).includes("..");
}

/**
 * 归一化资源引用：~ 展开 + 绝对路径校验 + `..` 段拒绝（⛔2 安全收紧）。
 *
 * @param ref   原始引用（注入段 location / 工具参数值）
 * @param ext   期望扩展名（如 ".md" / ".js"），不匹配返回 null
 * @returns 归一化绝对路径；非法（空/相对路径/含 `..` 段/扩展名不符）返回 null
 */
export function normalizeRef(ref: string, ext?: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  // ⛔2：`..` 段 = 目录逃逸向量，展开前检测（join 会 normalize 消解 `..`，展开后判会漏）
  if (hasParentSegment(trimmed)) return null;

  const expanded = trimmed.startsWith(HOME_DIR_PREFIX)
    ? join(homedir(), trimmed.slice(HOME_DIR_PREFIX.length))
    : trimmed;
  if (!isAbsolute(expanded)) return null; // 相对路径无基准（注入段给绝对路径）

  if (ext !== undefined && !expanded.endsWith(ext)) return null;
  return expanded;
}

// ── 报错文案工厂（sink 设计 U1）──────────────────────────────

/** invalidAgentRefMessage 的可选注入：宿主的清单段名（缺省 pi 的注入段）。 */
export interface InvalidAgentRefMessageOptions {
  /**
   * 清单指引：宿主注入段名。缺省 `<available_subagents>`（pi 注入段）；第三宿主
   * 注入段名不同（zsw `<available_agents>` 等）时注入替代，文案口径不变。
   */
  howToList?: string;
}

/**
 * agent ref 非法的统一报错文案（消费方唯一文案口径——不各自拼 message）。
 *
 * 基准 = AgentRegistry.loadByPath(require) 的既有 throw 文案
 * （"Invalid agent ref: ... absolute paths to .md files ..."），工厂收敛后该消费点
 * 与后续宿主接线点共用此处。`..` 形态附纠正指引（⛔2 新失败路径——错误必须指向
 * 恢复动作：去掉 `..` 段、改用注入段 location）。
 */
export function invalidAgentRefMessage(
  ref: string,
  opts?: InvalidAgentRefMessageOptions,
): string {
  const howToList = opts?.howToList ?? "<available_subagents>";
  if (hasParentSegment(ref)) {
    return (
      `Invalid agent ref: ${ref}. Agent refs must be absolute paths to .md files ` +
      `without ".." path segments (use <location> from ${howToList}).`
    );
  }
  return (
    `Invalid agent ref: ${ref}. Agent refs must be absolute paths to .md files ` +
    `(use <location> from ${howToList}).`
  );
}

// ── workflow ref 原语（sink 设计 U1 / §2.2 D3 行）────────────

/** normalizeWorkflowRef 的可选注入：宿主已知的 workflow 名清单。 */
export interface NormalizeWorkflowRefOptions {
  /**
   * 宿主注入的已知 workflow 名清单（内置 + 用户级，宿主按自身优先级合并去重——
   * pi 为 config-loader 的 tmp>project>npm>user 去重产物，内置名优先已由该清单
   * 体现）。省略 = 无已知名，全部裸名按 unknown_name 拒绝。
   */
  knownNames?: Iterable<string>;
}

/** workflow ref 名分支的保留字：`.` / `..` 是文件系统相对路径段保留语义，任何域不可作名引用。 */
export const WORKFLOW_REF_RESERVED_NAMES: readonly string[] = [".", ".."];

/** normalizeWorkflowRef 拒绝原因（结构化裁决——文案留宿主，与 knownNames 宿主注入哲学一致）。 */
export type WorkflowRefInvalidReason =
  | "empty" // 空引用
  | "reserved" // 名分支命中保留字（保留字裁决优先于 knownNames）
  | "unknown_name" // 裸名未命中 knownNames
  | "not_absolute" // 路径分支：相对路径无基准
  | "parent_segment" // 路径分支：含 `..` 段（⛔2 同面）
  | "bad_ext"; // 路径分支：非 .js

/**
 * normalizeWorkflowRef 的三分裁决结果：
 * - name    → 裸名命中 knownNames，按名引用（内置名优先已由宿主清单体现）
 * - path    → 路径形态经 normalizeRef 全套校验（~/ 展开、绝对路径、.js、`..` 拒绝）
 * - invalid → 拒绝（reason 给精确裁决原因，消费方出恢复指引）
 */
export type NormalizedWorkflowRef =
  | { kind: "name"; name: string }
  | { kind: "path"; path: string }
  | { kind: "invalid"; ref: string; reason: WorkflowRefInvalidReason };

/**
 * workflow 引用统一原语（名/路径二分 + 保留字裁决 + 内置名优先，三层口径单源化——
 * pi「收裸名+路径」、zsw「入口拒裸名/内层宽松」的统一替代）。
 *
 * 二分判据：含 `/`、`\` 分隔符或 `~` 前缀 → 路径分支；否则 → 裸名分支。对齐 pi
 * 现行为「名字是简单标识符，路径串不会撞 workflow 名」（tool-workflow actionRun：
 * get(name) 先于 getPath——名命中即用，不猜路径，内置名优先由此成立）。
 *
 * 裁决顺序（裸名分支）：保留字 > knownNames > unknown——保留字命中即拒，即便宿主
 * 清单异常含保留字也不放行（`..` 若被当名接受会绕过路径域的 ⛔2 收紧）。
 *
 * 路径分支复用 normalizeRef(WORKFLOW_REF_EXT)：`..` 段拒绝、~/ 展开、扩展名校验
 * 与 agent 域同面（G1：同一校验语义）。
 */
export function normalizeWorkflowRef(
  ref: string,
  opts?: NormalizeWorkflowRefOptions,
): NormalizedWorkflowRef {
  const trimmed = ref.trim();
  if (!trimmed) return { kind: "invalid", ref, reason: "empty" };

  const looksLikePath = trimmed.includes("/") || trimmed.includes("\\") || trimmed.startsWith("~");
  if (looksLikePath) {
    const path = normalizeRef(trimmed, WORKFLOW_REF_EXT);
    if (path !== null) return { kind: "path", path };
    // 失败原因细分（normalizeRef 返回 null 不带原因——此处按同一判据重放；重放
    // 顺序与 normalizeRef 判序逐位对齐：parent_segment 先于 not_absolute，否则
    // `a/../b.js` 类「相对路径 + 含 .. 段」被误归因 not_absolute，指引改绝对路径
    // 后仍被 .. 段拒绝——两步误导。`..` 段对原始串检测，与展开前判位一致）
    const expanded = trimmed.startsWith(HOME_DIR_PREFIX)
      ? join(homedir(), trimmed.slice(HOME_DIR_PREFIX.length))
      : trimmed;
    const reason: WorkflowRefInvalidReason = hasParentSegment(trimmed)
      ? "parent_segment"
      : !isAbsolute(expanded)
        ? "not_absolute"
        : "bad_ext";
    return { kind: "invalid", ref, reason };
  }

  // 裸名分支：保留字 > knownNames > unknown
  if (WORKFLOW_REF_RESERVED_NAMES.includes(trimmed)) {
    return { kind: "invalid", ref, reason: "reserved" };
  }
  const known = opts?.knownNames;
  if (known !== undefined) {
    for (const name of known) {
      if (name === trimmed) return { kind: "name", name: trimmed };
    }
  }
  return { kind: "invalid", ref, reason: "unknown_name" };
}

/** agentRef 扩展名。 */
export const AGENT_REF_EXT = ".md";
/** workflowRef 扩展名。 */
export const WORKFLOW_REF_EXT = ".js";

/**
 * agent ref 的显示名：basename + 去 .md 扩展名（`/a/b/worker.md` → `worker`）。
 *
 * agentRef 是绝对路径，UI 显示层（TUI tool block 标题 / list / 完成通知、GUI list item /
 * pending 通知 name）统一经本函数取短名，避免长路径挤占显示宽度。数据层不动——
 * record.agent / env 注入（PI_SUBAGENT_AGENT）/ 持久化 / LLM 通知文本保持完整路径。
 *
 * 非路径值（DEFAULT_AGENT_NAME "general-purpose"）与无 .md 后缀的值原样返回。
 * 手动 split(/[\\/]) 而非 path.basename：跨平台统一（macOS 的 path.basename
 * 不切 Windows `\` 分隔符，反之类推），且本模块避免引入平台分支。
 */
export function displayAgentName(ref: string): string {
  const base = ref.split(/[\\/]/).pop() ?? ref;
  return base.endsWith(AGENT_REF_EXT) ? base.slice(0, -AGENT_REF_EXT.length) : base;
}
