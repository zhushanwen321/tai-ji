import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getLogger } from "@zhushanwen/pi-extension-logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const logger = getLogger("pi-plan");

export interface TemplateInfo {
  name: string;
  path: string;
}

/**
 * 内置模板目录双形态探测：本文件在两种布局下被加载，templates/ 相对位置不同——
 *  - 源码形态（npm 安装 / dev jiti 直接加载 src/templates.ts）：__dirname = <pkg>/src，
 *    模板在 `../templates`（包根 templates/，随 files 白名单发布）。
 *  - bundle 形态（staged 打包内置，esbuild 把本文件 inline 进包根 index.js）：
 *    __dirname = …/extensions/@zhushanwen/pi-plan，模板由 bundle-extensions.mjs
 *    专项拷贝到同级 `templates/`。若仍按 `../templates` 推导会错位一级解析到
 *    …/@zhushanwen/templates（不存在）→ 打包版模板发现恒空、select-template
 *    恒 null（scanTemplateDir 的 existsSync 防御不崩溃但静默失效）。
 * 探测先 bundle 形态后源码形态：两形态目录互斥（staged 无 src/；源码布局 src/ 下
 * 无 templates/），existsSync 判别即可定位；均缺失时回退源码形态路径，由
 * scanTemplateDir 的存在性防御兜底（保持既有静默语义，不抛错）。
 */
export function getBuiltinTemplateDir(): string {
  const bundleForm = path.resolve(__dirname, "templates");
  if (fs.existsSync(bundleForm)) return bundleForm;
  return path.resolve(__dirname, "..", "templates");
}

/**
 * 单源目录扫描：纯 readdir 枚举 .md 文件，不读内容。existsSync 通过后 readdir
 * 仍可能失败（权限 / TOCTOU 竞态）——此处属发现/注入增强面，降级为已扫到的
 * 清单（空/部分）+ warn 不向上抛（U3）：命令层进入顺序 persist → setActiveTools
 * → buildPlanModePrompt（内含本扫描），throw 会留下「entry 已写、工具已限、
 * 提示词未注入」半进入态；与 --template 直传 readFileSync 的 fail-fast（用户
 * 显式输入，R3）形成对称降级边界——显式输入 fail-fast，增强面降级。
 */
function scanTemplateDir(dir: string): TemplateInfo[] {
  const results: TemplateInfo[] = [];
  if (!fs.existsSync(dir)) return results;
  try {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(".md")) {
        results.push({ name: file.replace(/\.md$/, ""), path: path.join(dir, file) });
      }
    }
  } catch (error) {
    logger.warn("plan: template source scan failed — source degraded to empty, entering plan mode continues", {
      dir,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return results;
}

/**
 * 三源目录参数（D2/D4）——测试隔离注入点：默认路径会读运行机真实
 * ~/.agents/plans 与项目根，「恰 N 条」类全集断言必须注入 tmp 目录才确定。
 */
export interface TemplateSources {
  /** 内置源目录；缺省 getBuiltinTemplateDir()（双形态探测，本函数零改动沿用） */
  builtinDir?: string;
  /** 用户级源目录；缺省 ~/.agents/plans（os.homedir() 内部推导，G2 个人级投放点） */
  userPlansDir?: string;
  /** 项目根；给出则扫描 <projectRoot>/.agents/plans（项目级源锚点 = 调用方 ctx.cwd，G2 项目级投放点） */
  projectRoot?: string;
}

/**
 * 三源合并发现器（D2/D4）：内置 → 用户级 → 项目级逐源扫描，同名
 * last-writer-wins（项目 > 用户 > 内置，<location> 指向胜者路径——注入段里
 * 同名只出现一条，模型不会选到被遮蔽版本）。纯 readdir 不读文件内容（D6
 * 砍 description 的连带收益：frontmatter 解析与坏文件防御整面不存在）。
 * 内置源扫描为空时经 pi-extension-logger 落 warn——不是不可达态，是 bundle
 * 布局错位的事故信号（staged 错位曾致打包版模板恒 0，见 getBuiltinTemplateDir
 * 注释）；即使外部源有模板遮蔽该信号也照落（内置丢失本身就该被看见）。
 */
export function listTemplates(sources?: TemplateSources): TemplateInfo[] {
  const builtinDir = sources?.builtinDir ?? getBuiltinTemplateDir();
  const userPlansDir = sources?.userPlansDir ?? path.join(os.homedir(), ".agents", "plans");
  const projectPlansDir = sources?.projectRoot !== undefined
    ? path.join(sources.projectRoot, ".agents", "plans")
    : undefined;

  const builtin = scanTemplateDir(builtinDir);
  if (builtin.length === 0) {
    logger.warn("plan: builtin template source resolved empty — bundle layout mismatch? templates/ missing next to the extension", { builtinDir });
  }

  const merged = new Map<string, TemplateInfo>();
  for (const template of builtin) merged.set(template.name, template);
  for (const template of scanTemplateDir(userPlansDir)) merged.set(template.name, template);
  if (projectPlansDir !== undefined) {
    for (const template of scanTemplateDir(projectPlansDir)) merged.set(template.name, template);
  }
  return [...merged.values()];
}

/**
 * 按名解析模板内容（发现视图的读取侧）。sources 透传给 listTemplates——
 * 测试与后续合并视图消费方（select-template）注入目录用；缺省走默认路径。
 */
export function loadTemplate(name: string, sources?: TemplateSources): string | null {
  const template = listTemplates(sources).find((t) => t.name === name);
  if (!template) return null;

  try {
    return fs.readFileSync(template.path, "utf-8");
  } catch {
    return null;
  }
}

// ── <available-plans> 段拼装（D6） ─────────────────────────────────

/** XML 特殊字符转义：注入段进 LLM 上下文，字段含 < > & 等会破坏 XML 结构（自写，不引 subagent-core——plan 是轻量 universal 包） */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 码点序比较（禁 localeCompare——宿主 locale 差异会破坏跨环境字节一致） */
function compareByCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 段内 guide 行（选型主体 = 模型自选，D8：名字自解释，一次选中；用户可对话覆盖） */
const AVAILABLE_PLANS_GUIDE =
  "Pick a template from this list, then call plan(action='select-template', templateName='<name>').";

/**
 * <available-plans> 段拼装纯函数（D6）：条目 <plan><name/><location/></plan>
 * 两字段必有（不含 description——name 是 select-template 唯一键，location 是
 * 绝对路径）；全字段 escapeXml；name 码点序排序（与 readdir 枚举序解耦）；
 * 空清单返回空串——调用方据此不注入段（防御分支，空发现另有 warn 信号）。
 */
export function formatAvailablePlans(templates: TemplateInfo[]): string {
  if (templates.length === 0) return "";
  const items = [...templates]
    .sort((a, b) => compareByCodepoint(a.name, b.name))
    .map((t) => `  <plan><name>${escapeXml(t.name)}</name><location>${escapeXml(t.path)}</location></plan>`);
  return [
    "<available-plans>",
    AVAILABLE_PLANS_GUIDE,
    ...items,
    "</available-plans>",
  ].join("\n");
}
