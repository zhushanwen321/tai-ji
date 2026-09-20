import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
 *    …/@zhushanwen/templates（不存在）→ 打包版 list-template 恒 0、select-template
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

function scanTemplateDir(dir: string): TemplateInfo[] {
  const results: TemplateInfo[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith(".md")) {
      results.push({ name: file.replace(/\.md$/, ""), path: path.join(dir, file) });
    }
  }
  return results;
}

export function listTemplates(): TemplateInfo[] {
  return scanTemplateDir(getBuiltinTemplateDir());
}

export function loadTemplate(name: string): string | null {
  const template = listTemplates().find((t) => t.name === name);
  if (!template) return null;

  try {
    return fs.readFileSync(template.path, "utf-8");
  } catch {
    return null;
  }
}
