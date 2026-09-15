import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TemplateInfo {
  name: string;
  path: string;
}

export function getBuiltinTemplateDir(): string {
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
