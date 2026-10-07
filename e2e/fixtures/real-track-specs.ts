/**
 * real 轨 spec 清单 SSOT（playwright.config 的 electron-real project testMatch 与
 * e2e global-setup 的构建形态判定共用——单一权威清单，两处消费不得各自维护）。
 *
 * 两类形态：文件名带 -real（*-real*.spec.ts）与沿用真实 app 轨但不带 -real 命名的
 * 逐个列明项。登记 SSOT = docs/testing/e2e-map.json REAL/SKILLRELOAD/BTW/MODELS
 * 各 rule 的 assets；新增 real 轨 spec 时两处同批（本清单 + e2e-map.json）。
 */
export const REAL_TRACK_SPECS = [
  '**/*-real*.spec.ts',
  'e2e/btw-turn-isolation.spec.ts',
  'e2e/skill-reload-*.spec.ts',
  'e2e/workflow-disconnect-recovery.spec.ts',
]

/** playwright glob 子集 → RegExp（只需 ** 与 *；字面段原样匹配）。 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`(^|/)${body}$`);
}

/**
 * 路径 → real 轨判定（global-setup 的 argv 消费形态；分隔符归一后匹配）。
 * playwright.config 的 testMatch/testIgnore 消费原始 glob 数组（本清单常量），
 * 本函数是同一清单在非 playwright-runner 进程的判定入口。
 */
export function matchesRealTrackSpec(pathlike: string): boolean {
  const norm = pathlike.replaceAll("\\", "/");
  return REAL_TRACK_SPECS.some((g) => globToRegExp(g).test(norm));
}
