#!/usr/bin/env python3
"""
Renderer 依赖完整性检查

规则：packages/renderer/src/ 下所有 .ts/.vue 源码 import 的 npm 包，
必须在 packages/renderer/package.json 的 dependencies/devDependencies 中声明。

目的：防止 shadcn-vue 等 codegen 工具生成代码后 import 了未声明的包
（v3 重建 FG0 曾发生：components/ui/button/index.ts import cva，但
package.json 未声明 class-variance-authority，开发机靠 hoist 假绿，
干净 CI 必败 Cannot find module）。

豁免：
  - 相对路径 import（./ ../）
  - @/ alias（项目内部）
  - node 内置（path/fs/crypto 等，由 tsup/electron 处理）
  - @taiji/shared（workspace 包）
  - vue/vite 系虚拟模块（vue、*.vue、vitest 等）

运行方式:
  python3 .githooks/check_renderer_deps.py

退出码:
  0 — 通过
  2 — 有未声明的 import
"""

import json
import re
import sys
from pathlib import Path

RED = '\033[0;31m'
GREEN = '\033[0;32m'
YELLOW = '\033[1;33m'
NC = '\033[0m'

RENDERER_ROOT = Path('packages/renderer')
RENDERER_SRC = RENDERER_ROOT / 'src'
PACKAGE_JSON = RENDERER_ROOT / 'package.json'

# 豁免的 import（无需在 package.json 声明）
BUILTIN_EXEMPT = {
    # node 内置（tsup/electron external）
    'path', 'fs', 'crypto', 'os', 'url', 'util', 'events', 'stream',
    'http', 'https', 'net', 'tls', 'zlib', 'buffer', 'child_process',
    'worker_threads', 'module', 'process',
    # workspace 内部包
    '@taiji/shared',
}
# 前端框架/构建工具虚拟模块（由 vite/vue 处理，通常在根或父级 package.json）
VITE_VIRTUAL_RE = re.compile(r'^(/?@?vitest|@vitejs|virtual:|^vue$|^.*\.vue$)')


def extract_bare_spec(spec: str) -> str:
    """从 import 说明符提取包名（去子路径/alias）。
    @scope/pkg/sub -> @scope/pkg
    pkg/sub -> pkg
    node:fs -> fs（node: 前缀的 Node 内置模块统一剥前缀匹配 BUILTIN_EXEMPT）

    [HISTORICAL] 2026-07-14：测试文件用 `import { readFileSync } from 'node:fs'`，
    但 BUILTIN_EXEMPT 只含 'fs' 不含 'node:fs'，导致 pre-commit hook 误报未声明 import。
    node: 前缀是 Node.js 标准 builtin 模块标识，剥前缀后统一匹配。
    """
    spec = spec.strip().strip("'\"")
    # node: 前缀的内置模块（node:fs / node:path / node:crypto 等）剥前缀
    if spec.startswith('node:'):
        spec = spec[len('node:'):]
    if spec.startswith('@'):
        parts = spec.split('/')
        return '/'.join(parts[:2]) if len(parts) >= 2 else spec
    return spec.split('/')[0]


def get_declared_deps() -> set[str]:
    if not PACKAGE_JSON.exists():
        return set()
    data = json.loads(PACKAGE_JSON.read_text(encoding='utf-8'))
    deps = set()
    for key in ('dependencies', 'devDependencies', 'peerDependencies'):
        deps.update(data.get(key, {}).keys())
    return deps


def scan_imports() -> dict[str, set[str]]:
    """返回 {文件路径: {未豁免的 import 包名}}"""
    results: dict[str, set[str]] = {}
    import_re = re.compile(
        r'''^\s*import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]''',
        re.MULTILINE,
    )
    dynamic_import_re = re.compile(r'''import\s*\(\s*['"]([^'"]+)['"]\s*\)''')

    for src_file in RENDERER_SRC.rglob('*'):
        if src_file.suffix not in ('.ts', '.vue', '.tsx'):
            continue
        text = src_file.read_text(encoding='utf-8', errors='ignore')
        specs = set(import_re.findall(text)) | set(dynamic_import_re.findall(text))
        bare = set()
        for spec in specs:
            if spec.startswith('.') or spec.startswith('@/'):
                continue
            name = extract_bare_spec(spec)
            if name in BUILTIN_EXEMPT:
                continue
            if VITE_VIRTUAL_RE.match(name):
                continue
            bare.add(name)
        if bare:
            results[str(src_file)] = bare
    return results


def main() -> int:
    if not RENDERER_SRC.exists():
        print(f"{YELLOW}[SKIP] {RENDERER_SRC} 不存在{NC}")
        return 0
    if not PACKAGE_JSON.exists():
        print(f"{YELLOW}[SKIP] {PACKAGE_JSON} 不存在{NC}")
        return 0

    declared = get_declared_deps()
    imports = scan_imports()

    undeclared: dict[str, set[str]] = {}
    for file, specs in imports.items():
        missing = specs - declared
        if missing:
            undeclared[file] = missing

    if not undeclared:
        total = sum(len(s) for s in imports.values())
        print(f"{GREEN}[OK] renderer 源码 {total} 个 import 全部在 package.json 声明{NC}")
        return 0

    print(f"{RED}[ERROR] {len(undeclared)} 个文件含未声明的 import：{NC}")
    print()
    for file in sorted(undeclared):
        rel = Path(file).relative_to(Path.cwd()) if file.startswith(str(Path.cwd())) else file
        print(f"  {rel}:")
        for spec in sorted(undeclared[file]):
            print(f"    {RED}{spec}{NC}")
    print()
    print(f"{YELLOW}修复方式：{NC}")
    print(f"  cd packages/renderer && pnpm add <缺失的包>")
    print(f"  （shadcn-vue add 生成的组件常漏 class-variance-authority / reka-ui 等）")
    print()
    print(f"\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m")
    return 2


if __name__ == '__main__':
    sys.exit(main())
