/**
 * Workflow Extension — WorkflowScript 实体
 *
 * 一个 workflow 脚本文件的数据 + 操作收敛（domain-models.md §7）。
 *
 * 设计：
 * - 将"脚本源 + meta + validate + toExecutable"收敛为实体。
 * - validate 委托 engine/script-lint.ts 的 lintScript。
 * - toExecutable 只做 strip `export const meta`（纯文本变换）；worker 线程 wrap
 * （注入 agent/parallel/pipeline globals）由 infra/worker-script-builder.ts
 * 的 buildWorkerScript 承担——那是技术资源模板生成，不属于实体职责（D-12：
 * 模型只管数据+不变式）。
 *
 * 层归属：Engine。
 *
 * 参考：domain-models.md §7（字段/操作）、engine/script-lint.ts（lint 实现）。
 */
import { type LintResult,lintScript } from "../script-lint.ts";
// LintFinding/LintResult 类型规范归属 engine/script-lint.ts（canonical 源）。

// WorkflowMeta 规范来源是 shared/resource-meta.ts（m1 DM1，含 parameters/usage/when/notFor）。
// m2：删本地封闭 3 字段 interface，re-export m1 的判别联合。
import type { WorkflowMeta } from "../../shared/resource-meta.ts";
export type { WorkflowMeta };

// ── validate lint memo（IF9/#15，TC9/DM2）─────────────────────

/**
 * 模块级 lint 结果缓存：key = path，命中条件 = sourceCode 与缓存 srcRef 相等
 *（`===`——JS 字符串比较是**值相等**，设计原文的「引用相等」前提在 JS 不可实现，
 * 实测等值异字面量同样命中；lintScript 是 source 的纯函数，值相等 ⟹ 结果必然
 * 相同，故值键 memo 语义严格正确，且是引用键意图的超集：registry 重建实例传等值
 * 内容也命中）。
 *
 * 重复点：registry.getPath/get 每次 new WorkflowScript（workflow-script-registry-impl），
 * launcher.ts runAndWait / executeNestedWorkflow（每 nested call）各 validate 一次，
 * 同脚本 N 次嵌套 = N 次全量正则 lint。失效语义：文件变更 → 内容值不等 → miss →
 * 重 lint 并覆写条目。等长前缀不同的内容比较在 V8 走指针/长度快路径 + memcmp，
 * 成本远低于正则 lint（TC9 alternatives 中「值键成本≈重 lint」的量级判断不成立）。
 */
const lintMemo = new Map<string, { srcRef: string; result: LintResult }>();

/** 清空 validate lint 缓存（config-loader.invalidateCache 追加调用，测试隔离用）。 */
export function clearLintMemo(): void {
  lintMemo.clear();
}

/** 脚本来源：saved（.pi/workflows/ 固定）或 tmp（.pi/workflows/.tmp/ 临时）。 */
export type WorkflowSource = "saved" | "tmp";

/**
 * WorkflowScript 实体。
 *
 * 不变式：
 * - name 非空（meta 提取成功时来自 meta.name，失败时来自文件名 stem）
 * - available=false 时 meta 为空壳（name=stem, description="", phases=[]）
 * - sourceCode 为原始文件内容（含 export）；toExecutable 返回 strip 后的副本
 */
export class WorkflowScript {
  readonly name: string;
  readonly source: WorkflowSource;
  readonly path: string;
  /** 原始文件内容（可编辑）。toExecutable 返回 strip 后的副本，不改本字段。 */
  sourceCode: string;
  readonly meta: WorkflowMeta;
  /** false 当 meta 提取失败（loader 不抛错，标记不可用但仍列出）。 */
  available: boolean;

  constructor(opts: {
    name: string;
    source: WorkflowSource;
    path: string;
    sourceCode: string;
    meta: WorkflowMeta;
    available: boolean;
  }) {
    this.name = opts.name;
    this.source = opts.source;
    this.path = opts.path;
    this.sourceCode = opts.sourceCode;
    this.meta = opts.meta;
    this.available = opts.available;
  }

  /**
 * 静态检查脚本合法性。
 *
 * 委托 engine/script-lint.ts 的 lintScript——检查项含：
 * - 必须含 agent/parallel/pipeline 入口之一
 * - agent 选项 outputSchema → schema
 * - result.output/parsedOutput/content 不存在
 * - 文件传状态警告
 *
 * IF9（#15）：同 path 且 sourceCode 引用相等 → 返回缓存 lint 结果（launcher 嵌套
 * 场景下 registry 重建实例的重复全量 lint 消除）；否则 lint + 覆写条目。
 */
  validate(): LintResult {
    const memoized = lintMemo.get(this.path);
    if (memoized && memoized.srcRef === this.sourceCode) {
      return memoized.result;
    }
    const result = lintScript(this.sourceCode);
    lintMemo.set(this.path, { srcRef: this.sourceCode, result });
    return result;
  }

  /**
 * 返回可执行源。
 *
 * m2：不再 strip `export const meta`——meta 现为 @pi-meta 块注释（合法 JS，
 * worker 天然忽略），无 const meta 变量。toExecutable 返回原文（含块注释）。
 * Worker 线程 wrap（注入 globals）由 infra/worker-script-builder.ts buildWorkerScript 完成。
 */
  toExecutable(): string {
    return this.sourceCode;
  }
}
