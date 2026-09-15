/**
 * Skill path discovery — resolve a skill name to its directory or SKILL.md path.
 *
 * Symmetric to execution/agent-registry.ts (which discovers agents): this module owns
 * the resource-discovery concern for skills across project / user / npm sources.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { getHostServices } from "../core/host-services.ts";

// ── Skill path resolution (with npm dir cache) ─────────────────────

const skillCandidatesCache = new Map<string, string[]>();

/** List npm skill candidate paths — cached per npmSkillsDir. */
function getNpmSkillCandidates(npmSkillsDir: string): string[] {
  const cached = skillCandidatesCache.get(npmSkillsDir);
  if (cached) return cached;

  const candidates: string[] = [];
  try {
    for (const pkg of fs.readdirSync(npmSkillsDir)) {
      candidates.push(path.join(npmSkillsDir, pkg, "skills"));
    }
  } catch { /* npm dir not found — no npm skills available */ void undefined; }
  skillCandidatesCache.set(npmSkillsDir, candidates);
  return candidates;
}

/**
 * Resolve a skill name to its directory or SKILL.md path.
 * Search order:
 * 1. Project-level: .agents/skills/<name>/
 * 2. Global: 宿主注入 skills 根中 source "user-pi" 条目（pi 壳 = <agentDir>/skills，
 *    现取 getAgentDir()——实例隔离：PI_CODING_AGENT_DIR 场景读隔离目录，不碰
 *    ~/.pi/agent；见 pi-host.ts skillRoots 契约）
 * 3. npm packages: 宿主注入 skills 根中 source "npm" 条目下的 <pkg>/skills/<name>/
 *    （pi 壳 = <agentDir>/npm/node_modules）
 *
 * 根来源（u0-data-discovery 注入化）：getAgentDir() 运行时触点收敛为
 * discoveryRoots()?.skills 注入消费。按 source 标签取根是本模块的结构性要求而非
 * 对标签的语义解释——user 根直接解析 <root>/<name>/，npm 根需先枚举 <pkg> 一层，
 * 两类根的消费形状不同，无法像 resource-discovery 那样整体按序扫描；标签字面
 * （user-pi/npm）与 pi 壳 skillRoots 契约一致，core 不新增标签字面量。
 * 未配置宿主（discoveryRoots 缺席）→ 空根列表 → 仅 project 根可命中（生产宿主在
 * 扩展初始化最早处 configureCore，此形态只出现在测试/裸 core 消费方）。
 * Returns the directory path if found, undefined otherwise.
 *
 * IF8(#14)：结果按 skillName 缓存（含未命中 undefined 也缓存，DM3）——调用点
 * agent-opts-resolver 每次 agent({skill}) call 一次，同 skill 名重复的逐候选
 * existsSync 全部消重。缓存生命周期 = session：index.ts 在 session_start 调
 * clearSkillPathCache 失效两级缓存（对齐同包 subagent-list-injector 的 session
 * 生命周期缓存模式）。不做进程级缓存的原因：pi 同一进程可能有多个 session
 * （TUI /new、/fork 同进程换 session），运行中安装的 skill（写入 project/user/npm
 * 任一源）需要对新 session 可见——进程级缓存会让曾 miss 的 skill 名（含缓存了
 * undefined 的未命中条目）在同进程后续 session 中永久不可见。session 内复用是
 * IF8/DM3 的主要收益（同一次 run 内同 skill 名重复调用消重），保持不变。
 */
const skillMemo = new Map<string, string | undefined>();

/**
 * 清空 resolveSkillPath 两级缓存（skillMemo 结果缓存 + npm 候选列表缓存）。
 * 两个消费点：测试隔离（beforeEach）与 index.ts session_start（session 生命周期
 * 失效——npm 源新装包产生的候选目录也要重新可见）。
 */
export function clearSkillPathCache(): void {
  skillMemo.clear();
  skillCandidatesCache.clear();
}

/**
 * 把 skillName 解析到 rootDir 内的候选路径；越界（穿越）返回 undefined。
 *
 * 为什么需要守卫：path.resolve/path.join 会吸收 `..`（"../../x" 落到 skills 根
 * 之外），随后的 existsSync 命中会把 skills 树外的目录当 skill 目录返回——skill 名
 * 是名字不是路径，不该具备树外寻址能力。resolve 后与规范化 skills 根做前缀比较
 * （startsWith(root + sep)；恰好等于根也拒绝——"." 会把根自身当 skill 目录），
 * 越界 = 该候选不存在：全部候选越界时 resolveSkillPath 返回 undefined，调用方
 * （agent-opts-resolver）收到 not found（与 workflow name 拒绝的反馈风格一致）。
 *
 * 根内归一化仍允许（"a/../b" resolve 后在根内——守卫只拒逃逸，不拒归一化）。
 */
function resolveWithinRoot(rootDir: string, skillName: string): string | undefined {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, skillName);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return undefined;
  }
  return resolved;
}

export function resolveSkillPath(skillName: string): string | undefined {
  // has 先行区分「缓存了未命中(undefined)」与「无条目」——未命中也缓存（DM3）
  if (skillMemo.has(skillName)) {
    return skillMemo.get(skillName);
  }

  const candidates: string[] = [];
  const pushCandidate = (dir: string | undefined): void => {
    if (dir !== undefined) candidates.push(dir);
  };
  // Project-level
  pushCandidate(resolveWithinRoot(path.resolve(process.cwd(), ".agents/skills"), skillName));

  // 宿主注入根（每调用现取——与 pi-host 的 getAgentDir 现取语义一致，实例切换即生效）。
  // 可选链从 discoveryRoots 起截断（discoveryRoots 是可选方法，缺席 = 空根列表）。
  const injectedSkillRoots = getHostServices().discoveryRoots?.()?.skills ?? [];

  // Global user skills（source "user-pi" 条目；宿主未提供该标签根时此源缺席）
  const userSkillsRoot = injectedSkillRoots.find((root) => root.source === "user-pi");
  if (userSkillsRoot !== undefined) {
    pushCandidate(resolveWithinRoot(userSkillsRoot.dir, skillName));
  }

  // npm package skills (cached)（source "npm" 条目 = node_modules 基座）
  const npmSkillsRoot = injectedSkillRoots.find((root) => root.source === "npm");
  if (npmSkillsRoot !== undefined) {
    for (const pkgSkillsBase of getNpmSkillCandidates(npmSkillsRoot.dir)) {
      pushCandidate(resolveWithinRoot(pkgSkillsBase, skillName));
    }
  }

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      skillMemo.set(skillName, dir);
      return dir;
    }
  }

  // 未命中也缓存：防止不存在的 skill 名反复全候选 existsSync（DM3）
  skillMemo.set(skillName, undefined);
  return undefined;
}
