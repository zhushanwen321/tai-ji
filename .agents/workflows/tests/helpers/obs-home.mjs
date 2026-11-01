// obs-home.mjs — 测试夹具：把公共观测层与记录命令装进临时 HOME（安装契约形态
// ~/.agents/scripts/<文件>）。源优先级：真实安装位 → zsw 仓源码（homedir() 动态推导，
// 测试文件与产物均不含本机绝对路径字面）。
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const LAYER_NAME = "workflow-observability.shared.ts";
export const CLI_NAME = "workflow-observe.mjs";

function firstExisting(candidates) {
  for (const p of candidates) {
    try {
      statSync(p);
      return p;
    } catch {
      // try next
    }
  }
  return null;
}

/** 把观测层与 CLI 装进 targetHome；返回装夹清单。源缺失时 throw（测试环境装配失败要显性） */
export function installObsScripts(targetHome) {
  const home = homedir();
  const layerSrc = firstExisting([
    join(home, ".agents", "scripts", LAYER_NAME),
    join(home, "Code", "zsw-skills", "skills", "self", "dev-workflow", "workflows", "src", LAYER_NAME),
  ]);
  const cliSrc = firstExisting([
    join(home, ".agents", "scripts", CLI_NAME),
    join(home, "Code", "zsw-skills", "scripts", CLI_NAME),
  ]);
  if (!layerSrc || !cliSrc) {
    throw new Error(
      `测试夹具装配失败：公共观测层或记录命令源缺失（layer=${layerSrc ?? "无"}，cli=${cliSrc ?? "无"}）。` +
      "恢复动作：确认 zsw 技能仓在 ~/Code/zsw-skills（或真实安装位 ~/.agents/scripts/ 已就绪）后重跑测试",
    );
  }
  const dest = join(targetHome, ".agents", "scripts");
  mkdirSync(dest, { recursive: true });
  copyFileSync(layerSrc, join(dest, LAYER_NAME));
  copyFileSync(cliSrc, join(dest, CLI_NAME));
  return { dest, layerSrc, cliSrc };
}
