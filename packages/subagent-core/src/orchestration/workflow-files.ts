/**
 * Workflow 文件持久化操作（save / delete）。
 *
 * 历史：saveWorkflow 曾有两套实现——commands.ts 用 renameSync 仅 project scope，
 * WorkflowsView.ts 用 copyFileSync 支持 user scope。本次统一为 rename + 仅 project
 * scope（决策 2）：tmp 文件保存后自动消失，保存位置缺省 DEFAULT_WORKFLOW_SAVED_DIR
 * （pi 布局；W4/D-6 参数化后宿主经 WorkflowDirOptions 注入自有布局）。
 *
 * 代价：TUI 失去 user scope Tab 切换（功能倒退，已接受）；
 * Windows/跨设备 rename 可能失败（已知风险，接受）。
 */

import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

// ── 目录参数化（D-6：.pi 硬编码 → 宿主注入）──────────────────

/**
 * 缺省目录（pi 生态布局）。相对路径，调用时 resolve（相对当前 cwd）——与 pi
 * 宿主现行为一致；宿主注入绝对目录（如 zsw 的自有 workflows 布局）即脱离
 * pi 目录。全文件唯一的 .pi 路径来源即这两个缺省常量。
 */
export const DEFAULT_WORKFLOW_TMP_DIR = ".pi/workflows/.tmp";
export const DEFAULT_WORKFLOW_SAVED_DIR = ".pi/workflows";

/** 落盘目录注入参数：宿主覆盖缺省 pi 布局（两目录独立可选注入）。 */
export interface WorkflowDirOptions {
  /** 临时脚本目录（generate 产物落盘处）；缺省 DEFAULT_WORKFLOW_TMP_DIR */
  tmpDir?: string;
  /** 固化脚本目录（save 目标）；缺省 DEFAULT_WORKFLOW_SAVED_DIR */
  savedDir?: string;
}

// ── Path helpers (computed at call time to respect cwd changes in tests) ──

function getTmpDir(options?: WorkflowDirOptions): string {
  return resolve(options?.tmpDir ?? DEFAULT_WORKFLOW_TMP_DIR);
}

function getSavedDir(options?: WorkflowDirOptions): string {
  return resolve(options?.savedDir ?? DEFAULT_WORKFLOW_SAVED_DIR);
}

// ── Save ──────────────────────────────────────────────────────

/**
 * 保存临时 workflow：{tmpDir}/{tmpName}.js → {savedDir}/{newName||tmpName}.js
 * 用 rename（tmp 文件保存后消失）。仅 project scope。
 *
 * 直接按路径查找 tmp 文件，不调 config-loader 全扫——save 只需知道 tmp 文件
 * 的路径，不需要 meta 提取或跨目录去重。
 *
 * @param options 目录注入（缺省 pi 布局；pi 现两参调用形态行为不变，W4 向后兼容）
 * @throws 若 tmp workflow 不存在、目标已存在、或 rename 失败
 */
export async function saveWorkflow(
  tmpName: string,
  newName?: string,
  options?: WorkflowDirOptions,
): Promise<string> {
  const srcPath = resolve(getTmpDir(options), `${tmpName}.js`);
  if (!existsSync(srcPath)) {
    throw new Error(`Temporary workflow '${tmpName}' not found`);
  }

  const destName = newName ?? tmpName;
  const savedDir = getSavedDir(options);
  const destPath = resolve(savedDir, `${destName}.js`);

  if (existsSync(destPath)) {
    throw new Error(`'${destName}' already exists in saved workflows. Use a different name.`);
  }

  mkdirSync(savedDir, { recursive: true });
  renameSync(srcPath, destPath);
  return `Saved '${tmpName}' → '${destName}' (${destPath})`;
}

// ── Delete ────────────────────────────────────────────────────

/**
 * 删除 workflow 脚本文件（tmp 或 saved）。
 * @param isRunning 回调，判断某 name 是否正在运行（运行中拒绝删除）
 * @param options 目录注入（缺省 pi 布局；pi 现两参调用形态行为不变，W4 向后兼容）
 * @throws 若正在运行、或文件不存在
 */
export function deleteWorkflow(
  name: string,
  isRunning: (name: string) => boolean,
  options?: WorkflowDirOptions,
): string {
  if (isRunning(name)) {
    throw new Error(`Cannot delete '${name}': workflow is currently running. Abort it first.`);
  }

  const tmpDir = getTmpDir(options);
  const savedDir = getSavedDir(options);
  const candidates = [
    resolve(tmpDir, `${name}.js`),
    resolve(savedDir, `${name}.js`),
  ];

  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return `Deleted workflow '${name}' (${filePath})`;
    }
  }

  throw new Error(`Workflow file '${name}' not found`);
}
