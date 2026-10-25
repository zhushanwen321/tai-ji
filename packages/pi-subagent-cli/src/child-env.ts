// src/child-env.ts
//
// 孙进程 env 组装（自 spawn-runner 提取——该文件触 max-lines 上限；env 组装是独立
// 变化原因：deny 剥除 / schema 派生注入 / 身份信封写回，与 spawn 编排正交）。
//
// 内容：PI_SUBAGENT_TASK 写入点截断（[M1 D2]）· 身份 env 写回（[§2.7] 链路定位键 +
// 内容键 + [D4] 身份信封）· buildChildEnv（deny 剥除 + [D1] schema 派生注入 + fd3
// 宣告剥除 + 身份写回终态）。语义与原位逐字等价（搬移不改行为）。

import {
  buildOutboundChildEnv,
  PI_SUBAGENT_TASK_MAX_CHARS,
  SUBAGENT_IDENTITY_ENV,
} from "@zhushanwen/subagent-engine-sdk";

import { SCHEMA_ENV_VAR } from "./constants.ts";
import { RAW_MIRROR_ENV_VAR } from "./raw-mirror.ts";
import { applySchemaEnvToChildEnv } from "./spawn-args.ts";
import type { SpawnRunParams } from "./spawn-runner.ts";

export type { SpawnRunParams };

/**
 * [§2.7 身份 env 接通] 把本次 run 的子代理身份写入子进程 env（**必须在
 * `buildOutboundChildEnv` 的 deny 剥除之后调用**——当前 deny 名单不含 PI_SUBAGENT_*，
 * 但按「deny 终态之后显式写回」先例统一处理，防将来 deny 扩展时这些键被静默剥掉）。
 *
 * 值的来源分层（引擎只写它确实知道的；其余不写，读者各自回落）：
 *   - selfRecordId / agent / task：本次 run 参数（recordId / agentName / task 文本）；
 *   - rootSessionId：run 参数优先，回落引擎自身 env（嵌套链贯穿）；
 *   - rootCwd：引擎自身 env（真 ROOT 的 cwd，worktree 场景下≠子进程 cwd）优先，
 *     回落本次 spawn cwd；
 *   - depth：引擎自身 env 的层数 + 1（子进程 = 父进程 + 1）；
 *   - forkDepth：引擎自身 env 原值（root 侧一次设定，链上不变）；
 *   - parentRecordId：引擎自身 env 的 selfRecordId（嵌套时引擎自己也是某个 run 的
 *     子进程，那正是本次子进程的父 record id）；
 *   - mode：继承引擎自身 env（嵌套场景），缺席缺省 "background"（子代理 record 的
 *     常规形态；壳读者对非法值同款兜底）；
 *   - worktree：引擎自身 env 或本次 run 声明任一为真即写 "true"。
 *   - slug / startedAt：引擎无从得知（record 级字段，协议未携带）→ 不写；壳读者
 *     分别按「可选」与「Date.now()」回落。补齐它们需要把 record 身份挂上协议（登记见
 *     已归档设计档案 §2.7 遗留）。
 */
/** 链路定位键写入（applyIdentityEnvToChildEnv 拆出）：root 链 / 深度 / 父 record。
 * 值源分层见主函数注释——run 参数优先、引擎自身 env 回落（嵌套链贯穿）。 */
function applyLinkageIdentityKeys(
  childEnv: Record<string, string>,
  params: Pick<SpawnRunParams, "recordId" | "cwd" | "sessionRootId">,
  parentEnv: NodeJS.ProcessEnv,
): void {
  const key = SUBAGENT_IDENTITY_ENV;
  childEnv[key.selfRecordId] = params.recordId;
  const rootSessionId = params.sessionRootId ?? parentEnv[key.rootSessionId];
  if (rootSessionId !== undefined && rootSessionId !== "") {
    childEnv[key.rootSessionId] = rootSessionId;
  }
  const rootCwd = parentEnv[key.rootCwd];
  childEnv[key.rootCwd] = rootCwd !== undefined && rootCwd !== "" ? rootCwd : params.cwd;
  const parentDepth = Number(parentEnv[key.depth]);
  childEnv[key.depth] = String((Number.isFinite(parentDepth) ? parentDepth : 0) + 1);
  const forkDepth = Number(parentEnv[key.forkDepth]);
  if (Number.isFinite(forkDepth) && forkDepth > 0) childEnv[key.forkDepth] = String(forkDepth);
  const parentRecordId = parentEnv[key.selfRecordId];
  if (parentRecordId !== undefined && parentRecordId !== "") {
    childEnv[key.parentRecordId] = parentRecordId;
  }
}

/**
 * [M1 D2] PI_SUBAGENT_TASK 写入点截断（SDK identity-env 常量单源）：任务正文只取前
 * PI_SUBAGENT_TASK_MAX_CHARS 字符 + 截断标记，使控制面（握手帧）与 execve env 不随
 * 任务正文线性膨胀。全文以 pi session 文件首条 user 消息与父侧 manifest 为准（设计
 * D2 消费方矩阵：截断只影响 manifest 缺席时的重建链/P-fallback 投影，env 读取点
 * appendSubagentIdentityEntry 零改动）。
 *
 * 多字节不劈半：JS 字符串按 UTF-16 码元 slice，BMP 内（含 CJK）天然整字符；补一步
 * 代理对回退——边界恰好劈在 astral 字符（如 emoji，高低代理各占一个码元）时回退
 * 一个码元，保证 env 值无孤立代理（execve 的 UTF-8 编码不产生替换字符）。标记计数
 * 与 `task.length` 同口径（UTF-16 码元）。
 */
export function truncateTaskForEnv(task: string): string {
  if (task.length <= PI_SUBAGENT_TASK_MAX_CHARS) return task;
  let keep = PI_SUBAGENT_TASK_MAX_CHARS;
  // 边界恰在代理对中间（高代理 + 低代理）时回退一个码元：regex 以码元区间表达
  // 边界两码元，与逐 charCode 区间比较等价（含孤立代理的畸形输入）。
  if (/^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(task.slice(keep - 1, keep + 1))) keep -= 1;
  return `${task.slice(0, keep)}…[truncated ${task.length - keep} chars]`;
}

/** 身份内容键写入（applyIdentityEnvToChildEnv 拆出）：agent/task 直写 + [D4]
 * 身份信封三键（slug/startedAt/mode）——信封优先（宿主派发权威值），缺席按既有
 * 继承/缺省语义回落。 */
function applyContentIdentityKeys(
  childEnv: Record<string, string>,
  params: Pick<SpawnRunParams, "agentName" | "task"> & {
    identity?: { slug?: string; startedAt?: number; mode?: string };
  },
  parentEnv: NodeJS.ProcessEnv,
): void {
  const key = SUBAGENT_IDENTITY_ENV;
  childEnv[key.agent] = params.agentName;
  childEnv[key.task] = truncateTaskForEnv(params.task);
  // [D4] record 身份信封优先（宿主派发的权威值）；缺席时按既有继承/缺省语义回落。
  const identity = params.identity;
  const slug = identity?.slug ?? parentEnv[key.slug];
  if (slug !== undefined && slug !== "") childEnv[key.slug] = slug;
  const startedAt = identity?.startedAt ?? Number(parentEnv[key.startedAt]);
  if (Number.isFinite(startedAt) && startedAt > 0) childEnv[key.startedAt] = String(startedAt);
  const mode = identity?.mode ?? parentEnv[key.mode];
  childEnv[key.mode] = mode !== undefined && mode !== "" ? mode : "background";
}

export function applyIdentityEnvToChildEnv(
  childEnv: Record<string, string>,
  params: Pick<SpawnRunParams, "recordId" | "agentName" | "task" | "cwd" | "sessionRootId"> & {
    worktree?: boolean;
    /** [D4] record 身份信封：在场时写 slug / startedAt / mode 三键（缺省不写）。 */
    identity?: { slug?: string; startedAt?: number; mode?: string };
  },
  parentEnv: NodeJS.ProcessEnv,
): void {
  applyLinkageIdentityKeys(childEnv, params, parentEnv);
  applyContentIdentityKeys(childEnv, params, parentEnv);
  const worktree = params.worktree === true || parentEnv[SUBAGENT_IDENTITY_ENV.worktree] === "true";
  if (worktree) childEnv[SUBAGENT_IDENTITY_ENV.worktree] = "true";
}

/** 子进程 env 组装（deny 剥除 + PI_WORKFLOW_SCHEMA 派生注入 + 身份 env 写回）。
 *
 * `parentEnv` 缺省 = 进程自身 env（生产路径）；显式传入供 P-15 env 矩阵形状测试
 * 做纯函数断言（不触碰 process.env，避免测试误建 fd3 镜像写入器）。
 */
export function buildChildEnv(
  params: SpawnRunParams,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const extras: Record<string, string | undefined> = {};
  // [D1 schema 传输归位] env 值派生点：schema 本体的唯一 env 消费点就在此处，
  // 按数据流最短路径就地派生（JSON.stringify 本体），注入实现沿用
  // applySchemaEnvToChildEnv（含 E2BIG 上限校验）。
  applySchemaEnvToChildEnv(
    extras,
    params.schema !== undefined ? JSON.stringify(params.schema) : undefined,
  );
  // [D1 补强] PI_WORKFLOW_SCHEMA 是派生注入键，唯一合法来源 = task.schema 派生
  // （上一行 extras）：引擎自身 env 的 ambient 值不透传——schema-less run 的孙进程
  // 绝不携带幽灵 schema env（structured-output 扩展会按幽灵 schema 校验无 schema
  // 任务）。实测泄漏源：workflow 驱动的宿主会话内跑测时，父 env 携带本 run 自己的
  // schema（run-spawn-once 集成测试「无 schema run 不注入」用例红）。
  const baseEnv: NodeJS.ProcessEnv = { ...parentEnv };
  delete baseEnv[SCHEMA_ENV_VAR];
  const childEnv = buildOutboundChildEnv({ parentEnv: baseEnv, extras });
  // [P-15 / A-U-1 / C-U2] fd3 raw mirror 宣告只给引擎进程（设计 D4 env 矩阵 task pi
  // 行 ❌）。引擎→task pi 的 spawn 走 SDK buildOutboundChildEnv（deny =
  // ENGINE_ENV_DENY_LIST，刻意不含本键——引擎自身要读 fd 3），shared 的出站 deny
  // 清单没有 task pi 路径消费者，故必须在此显式剥除；否则 task pi（顶层与嵌套）
  // 继承该键，local/嵌套回退场景的 raw-mirror 代码被误武装。
  delete childEnv[RAW_MIRROR_ENV_VAR];
  // [§2.7] 身份 env 写回（deny 终态之后——见函数头分层说明）
  applyIdentityEnvToChildEnv(childEnv, params, parentEnv);
  return childEnv;
}
