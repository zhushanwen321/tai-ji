import * as fs from "node:fs";
import * as os from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  CONFIG_DIR_NAME,
  getAgentDir,
  loadSkillsFromDir,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";

const logger = getLogger("pi-plan");

/**
 * plan-exec skill 检测（D10 选项集 v2 的 skill 数据源）。
 *
 * 检测语义 = 「向用户提议的执行 skill」，以 pi 本体加载集为基线做意图/信任对齐：
 * - 单根枚举复用 pi 公开导出 loadSkillsFromDir——单根内横切规则（ignore / description
 *   必填门 / name 派生 / 递归遍历 / symlink / node_modules / 隐藏文件）随 pi 升级
 *   自动同步，零漂移面（对照表①③⑥⑦ 的 SKILL.md 目录形态侧）；
 * - 跨根组装自实现（pi 的四根拼装逻辑未导出，对照表②④⑤）：根序四枚按 pi 本体
 *   `package-manager.js addAutoDiscoveredResources`——`.pi/skills` → 祖先链
 *   `.agents/skills`（近→远，git root 级含）→ `<agentDir>/skills` → `~/.agents/skills`
 *   （HOME 直取，dev-flow 等用户级 skill 标准安装位）；untrusted 跳过前两族（④）；
 *   settings overrides 的 `+/-/!` 三级优先级 disable 复刻（②）；同名 first-writer-wins
 *   + realPath 去重（⑤）；
 * - plan-exec marker 过滤 = 对过 description 门的 skill 二次读 frontmatter
 *   （`plan-exec: true`；pi 的 Skill 对象不保留原始 frontmatter）。skill 侧自愿
 *   opt-in，`disable-model-invocation` 与 plan-exec 并存不过滤（用户显式选择是
 *   另一通路，设计 D10 顺手裁决）。
 * - steer 执行走路径读取（read `<skillDir>` = skill 入口文件路径），不依赖 pi skill 注册。
 *
 * 已登记偏差（对照表⑦散 .md 形态）：与 pi auto 源（collectSkillEntries）方向相反——
 * agents 源根级散 .md 检测收而 pi 不收（多提议）、子目录散 .md pi 收而检测不收
 * （漏提议）；`.pi/skills` 源两侧同构。settings npm 源不扫（现无 npm 发布形态
 * plan-exec skill，出现时补第五根）。
 *
 * 降级规格（检测失败最坏后果 = skill 选项空集，绝不允许炸 executeComplete 的
 * 核心交互闭环；pi 对坏 skill 也只产 diagnostics 不中断加载）：每根 existsSync
 * 守卫 + 整根 try/catch（EACCES 等任何 fs 错 → 跳过该根 + warn）；单 skill
 * frontmatter 读/解析失败 → 跳过该项 + warn；settings 读取/解析失败 → 视为
 * 无 overrides。
 */

/** 降级留痕（warn 级）：缺省走 pi-extension-logger，测试注入收集器 */
type LogFn = (msg: string, detail?: object) => void;

function defaultLog(msg: string, detail?: object): void {
  logger.warn(msg, detail);
}

/** pi getHomeDir 同式（package-manager.js:78）：HOME 优先，缺省 os.homedir() */
function defaultHomeDir(): string {
  return process.env.HOME || os.homedir();
}

/** pi canonicalizePath 同式：realpath 失败回退原路径 */
function canonicalizePath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function toPosixPath(p: string): string {
  // 与 pi toPosixPath 同构：Windows 分隔符归一（POSIX 上恒等）
  return sep === "\\" ? p.split("\\").join("/") : p;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** pi findGitRepoRoot 同式：.git 目录或 .git 文件（worktree）均算 root；无 git 推到文件系统根 */
function findGitRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (fs.existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** pi collectAncestorAgentsSkillDirs 同式：startDir 起每级 `.agents/skills`，近→远，git root 级含 */
function collectAncestorAgentsSkillDirs(startDir: string): string[] {
  const skillDirs: string[] = [];
  const resolvedStartDir = resolve(startDir);
  const gitRepoRoot = findGitRepoRoot(resolvedStartDir);
  let dir = resolvedStartDir;
  while (true) {
    skillDirs.push(join(dir, ".agents", "skills"));
    if (gitRepoRoot && dir === gitRepoRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return skillDirs;
}

/** BOM 剥离（pi stripBom 同构）：带 BOM 的 settings.json 直接 JSON.parse 会 throw */
function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, "");
}

/**
 * 读 settings.json 的 skills overrides（`+/-/!` pattern 数组）。
 * 读取/解析失败 → [] + warn（pi tryLoadFromStorage 同折叠：错误不中断加载）。
 * pi 旧形态 skills 为对象（customDirectories）——其条目无 `+/-/!` 前缀，对 override
 * 匹配等价于无，此处按非数组折叠为 [] 即可。
 */
function readSkillsOverrides(settingsPath: string, log: LogFn): string[] {
  try {
    if (!fs.existsSync(settingsPath)) return [];
    const parsed: unknown = JSON.parse(stripBom(fs.readFileSync(settingsPath, "utf-8")));
    if (!isRecord(parsed)) return [];
    const skills: unknown = parsed.skills;
    if (!Array.isArray(skills)) return [];
    return skills.filter((p): p is string => typeof p === "string");
  } catch (error) {
    log("plan: exec-skill settings parse failed (treated as no overrides)", {
      path: settingsPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * minimatch 子集 glob → RegExp：`**`（跨目录，段间匹配零段）/ `*`（段内任意）/ `?`
 * （单字符，不跨 /）/ `[...]` 字符类；不支持 brace 展开等高级语法。已登记偏差：
 * 极端 disable pattern（brace 等）可能与 pi 求值不一致——常用形态（裸名 / `x-*` /
 * `dir/**`）语义一致。
 */
function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i++;
        // 段间 `**/` 允许零段（minimatch globstar 语义），其余 `**` 跨目录任意
        if (source.endsWith("/") && pattern[i + 1] === "/") {
          source = `${source.slice(0, -1)}(?:.*/)?`;
          i++;
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        source += "\\[";
      } else {
        let cls = pattern.slice(i + 1, end);
        if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
        source += `[${cls}]`;
        i = end;
      }
    } else {
      source += ch.replace(/[\\^$.+(){}|]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

/** pi normalizeExactPattern 同式：剥前导 `./`（+/- 精确匹配形态归一，只剥一次） */
function normalizeExactPattern(pattern: string): string {
  return toPosixPath(pattern.replace(/^\.\/|^\.\\/, ""));
}

/**
 * pi matchesAnyPattern 同构（`!` 排除侧的 glob 匹配）：rel / 文件名 / 绝对路径，
 * SKILL.md 再加父目录的 rel / 名 / 绝对路径三形态——`!dev-flow` 即靠父目录名命中。
 */
function matchesAnyGlobPattern(filePath: string, patterns: string[], baseDir: string): boolean {
  if (patterns.length === 0) return false;
  const regexes = patterns.map(globToRegExp);
  const candidates = globMatchCandidates(filePath, baseDir);
  return candidates.some((candidate) => regexes.some((re) => re.test(candidate)));
}

/** 匹配候选形态（glob 侧 6 形态 / 精确侧 4 形态的公共部分按需取用） */
function globMatchCandidates(filePath: string, baseDir: string): string[] {
  const rel = toPosixPath(relative(baseDir, filePath));
  const name = basename(filePath);
  const filePathPosix = toPosixPath(filePath);
  const isSkillFile = name === "SKILL.md";
  if (!isSkillFile) return [rel, name, filePathPosix];
  const parentDir = dirname(filePath);
  return [
    rel,
    name,
    filePathPosix,
    toPosixPath(relative(baseDir, parentDir)),
    basename(parentDir),
    toPosixPath(parentDir),
  ];
}

/** pi matchesAnyExactPattern 同构（`+`/`-` 精确侧）：rel / 绝对路径 + SKILL.md 父目录两形态，无 glob */
function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
  if (patterns.length === 0) return false;
  const rel = toPosixPath(relative(baseDir, filePath));
  const filePathPosix = toPosixPath(filePath);
  const isSkillFile = basename(filePath) === "SKILL.md";
  const parentDir = isSkillFile ? dirname(filePath) : undefined;
  const parentRel = parentDir !== undefined ? toPosixPath(relative(baseDir, parentDir)) : undefined;
  const parentDirPosix = parentDir !== undefined ? toPosixPath(parentDir) : undefined;
  return patterns.some((pattern) => {
    const normalized = normalizeExactPattern(pattern);
    if (normalized === rel || normalized === filePathPosix) return true;
    return (parentRel !== undefined && normalized === parentRel)
      || (parentDirPosix !== undefined && normalized === parentDirPosix);
  });
}

/** pi isEnabledByOverrides 同构：三级优先级 `-` > `+` > `!` > 默认启用（横切全部根） */
export function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
  const overrides = patterns.filter((p) => p.startsWith("!") || p.startsWith("+") || p.startsWith("-"));
  const excludes = overrides.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  const forceIncludes = overrides.filter((p) => p.startsWith("+")).map((p) => p.slice(1));
  const forceExcludes = overrides.filter((p) => p.startsWith("-")).map((p) => p.slice(1));
  let enabled = true;
  if (excludes.length > 0 && matchesAnyGlobPattern(filePath, excludes, baseDir)) {
    enabled = false;
  }
  if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
    enabled = true;
  }
  if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) {
    enabled = false;
  }
  return enabled;
}

/** plan-exec marker 的 frontmatter 键（skill 侧自愿 opt-in：SKILL.md 加一行 `plan-exec: true`） */
const PLAN_EXEC_MARKER_FIELD = "plan-exec";

/**
 * 二次读 frontmatter 判 plan-exec marker（pi 的 Skill 对象不保留原始 frontmatter；
 * pi 加载器对未知字段忽略不拒，marker 字段约定可行）。读/解析失败 → false + warn
 * （降级：跳过该项）。严格 `=== true`：字符串 "true" 等 YAML 形态不误判。
 */
export function hasPlanExecMarker(skillFilePath: string, log: LogFn = defaultLog): boolean {
  try {
    const { frontmatter } = parseFrontmatter(fs.readFileSync(skillFilePath, "utf-8"));
    return frontmatter[PLAN_EXEC_MARKER_FIELD] === true;
  } catch (error) {
    log("plan: exec-skill frontmatter read failed (skill skipped)", {
      path: skillFilePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** 检测产物：一个可提议为执行方式的 skill（name 与 pi prompt 列表一致，⑥） */
export interface ExecSkill {
  name: string;
  description: string;
  /** skill 入口文件路径（标准形态 = SKILL.md 路径，散 .md 形态 = 文件本身；steer 指引 read 该路径，两种形态统一无分支） */
  skillDir: string;
  skillPath: string;
}

export interface DetectExecSkillsOptions {
  /** 项目目录（`<CONFIG_DIR_NAME>/skills` 根 + 祖先链起点，目录名跟 pi CONFIG_DIR_NAME 导出）。生产调用传 ctx.cwd */
  cwd: string;
  /** 项目信任态（untrusted 跳过 `.pi/skills` 与祖先链两族，④）。生产调用传 ctx.isProjectTrusted() */
  trusted: boolean;
  /** pi agentDir（`<agentDir>/skills` 根 + 全局 settings 位置）。缺省 pi getAgentDir()（读 PI_CODING_AGENT_DIR）；测试注入 */
  agentDir?: string;
  /** 用户 home（`~/.agents/skills` 根）。缺省 `process.env.HOME || os.homedir()`（pi getHomeDir 同式）；测试注入 */
  homeDir?: string;
  /** 降级留痕（warn 级），缺省 pi-extension-logger */
  log?: LogFn;
}

/** 检测的单根描述：目录 + overrides 求值 baseDir（pi 按根挂各自 baseDir）+ 该根适用的 overrides */
interface SkillRoot {
  dir: string;
  baseDir: string;
  overrides: string[];
}

/**
 * 检测入口：枚举 pi 本体加载集的四根，返回带 plan-exec marker 的 skill 清单
 * （root 序去重后）。complete 时现扫、无缓存（低频路径 + 技能热装可见性）。
 * 永不 throw（降级规格）。
 */
export function detectExecSkills(options: DetectExecSkillsOptions): ExecSkill[] {
  const log: LogFn = options.log ?? defaultLog;
  try {
    return detectExecSkillsInternal(options, log);
  } catch (error) {
    log("plan: exec-skill detection failed (degraded to empty option set)", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function detectExecSkillsInternal(options: DetectExecSkillsOptions, log: LogFn): ExecSkill[] {
  const cwd = resolve(options.cwd);
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const homeDir = resolve(options.homeDir ?? defaultHomeDir());

  const userOverrides = readSkillsOverrides(join(agentDir, "settings.json"), log);
  // project settings 仅 trusted 时参与（pi loadFromStorage 对 untrusted 的 project 恒 {}）
  const projectOverrides = options.trusted
    ? readSkillsOverrides(join(cwd, CONFIG_DIR_NAME, "settings.json"), log)
    : [];

  const roots: SkillRoot[] = [];
  if (options.trusted) {
    roots.push({ dir: join(cwd, CONFIG_DIR_NAME, "skills"), baseDir: join(cwd, CONFIG_DIR_NAME), overrides: projectOverrides });
    // 祖先链（④trusted 门内）：每根 baseDir = 各自的 `.agents` 目录；与 `~/.agents/skills`
    // 同路径的项滤掉（pi :1979 同款——cwd 在 HOME 下时防与第四根重复）
    const userAgentsSkillsDir = join(homeDir, ".agents", "skills");
    for (const dir of collectAncestorAgentsSkillDirs(cwd)) {
      if (resolve(dir) === resolve(userAgentsSkillsDir)) continue;
      roots.push({ dir, baseDir: dirname(dir), overrides: projectOverrides });
    }
  }
  roots.push({ dir: join(agentDir, "skills"), baseDir: agentDir, overrides: userOverrides });
  roots.push({ dir: join(homeDir, ".agents", "skills"), baseDir: join(homeDir, ".agents"), overrides: userOverrides });

  const seenNames = new Set<string>();
  const seenRealPaths = new Set<string>();
  const found: ExecSkill[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue; // 合法缺省（~/.agents/skills 不存在是常态主路径）
    let skills: Skill[];
    try {
      skills = loadSkillsFromDir({ dir: root.dir, source: "detect" }).skills;
    } catch (error) {
      log("plan: exec-skill root scan failed (root skipped)", {
        dir: root.dir,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const skill of skills) {
      // ② 用户显式 disable 的 skill 不提议（意图对齐）
      if (!isEnabledByOverrides(skill.filePath, root.overrides, root.baseDir)) continue;
      // ⑤ first-writer-wins（含非 marker skill 占名——pi 的 collision 语义以加载集为准，
      // 后根同名不因 marker 缺席而让位）
      const realPath = canonicalizePath(skill.filePath);
      if (seenRealPaths.has(realPath) || seenNames.has(skill.name)) continue;
      seenRealPaths.add(realPath);
      seenNames.add(skill.name);
      if (!hasPlanExecMarker(skill.filePath, log)) continue;
      found.push({
        name: skill.name,
        description: skill.description,
        // 入口文件路径两种形态统一：标准形态 filePath 即 SKILL.md 路径、散 .md 形态即
        // 文件本身——接收端（steer 文案）直接 read 该值，不再拼 SKILL.md（散 .md 形态
        // 拼接会得到不存在的 `<skills根>/SKILL.md` 悬空指引）
        skillDir: skill.filePath,
        skillPath: skill.filePath,
      });
    }
  }
  return found;
}
