#!/usr/bin/env python3
"""
i18n locale 双侧 key 对齐检查（维度 A）

规则：packages/renderer/src/i18n/locales/zh-CN/*.ts 与 en-US/*.ts 的 key 集合
必须完全一致（含嵌套 key 的完整路径）。

目的：拦截 zh-CN 加了 key 但忘记同步 en-US（或反之）的 desync。i18n-frontend
和 i18n-frontend-p2 两轮均发生过 desync（571 vs 567、panel 漏 116 key）。

实现：调 node 解析 TS locale 文件（TS 对象字面量含注释/单引号/全角字符，
Python ast 解析不可靠；node 原生支持 JS 语法）。

调用方式:
  python3 .githooks/check_i18n_locale_sync.py
  （无参数，自己 glob packages/renderer/src/i18n/locales/）

退出码:
  0 — 通过
  2 — 有 desync
"""

import json
import subprocess
import sys
from pathlib import Path

RED = '\033[0;31m'
GREEN = '\033[0;32m'
YELLOW = '\033[1;33m'
NC = '\033[0m'

LOCALES_DIR = Path('packages/renderer/src/i18n/locales')

# node 脚本：从 stdin 读 JSON 文件列表 → require 解析 → 拍平 key → 输出 JSON
NODE_SCRIPT = r"""
let input = '';
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  const files = JSON.parse(input);
  function flatten(obj, prefix, out) {
    for (const [k, v] of Object.entries(obj)) {
      const full = prefix ? prefix + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        flatten(v, full, out);
      } else {
        out.push(full);
      }
    }
  }
  const results = {};
  for (const f of files) {
    try {
      delete require.cache[require.resolve(f)];
      const mod = require(f);
      const obj = mod.default || mod;
      const keys = [];
      flatten(obj, '', keys);
      results[f] = { ok: true, keys: keys.sort() };
    } catch (e) {
      results[f] = { ok: false, error: e.message };
    }
  }
  console.log(JSON.stringify(results));
});
"""


def flatten_keys_via_node(file_paths: list[str]) -> dict:
    """调 node 解析 locale 文件，stdin 传文件列表 JSON，返回 {file_path: {ok, keys/error}}"""
    try:
        result = subprocess.run(
            ['node', '-e', NODE_SCRIPT],
            input=json.dumps(file_paths),
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return {f: {'ok': False, 'error': f'node 执行失败: {result.stderr[:200]}'} for f in file_paths}
        return json.loads(result.stdout.strip())
    except (subprocess.TimeoutExpired, json.JSONDecodeError) as e:
        return {f: {'ok': False, 'error': f'node 调用异常: {e}'} for f in file_paths}


def main() -> int:
    zh_dir = LOCALES_DIR / 'zh-CN'
    en_dir = LOCALES_DIR / 'en-US'

    if not zh_dir.exists() or not en_dir.exists():
        print(f'{YELLOW}[SKIP] locale 目录不存在{NC}')
        return 0

    zh_files = sorted(zh_dir.glob('*.ts'))
    en_files = sorted(en_dir.glob('*.ts'))

    zh_names = {f.name for f in zh_files}
    en_names = {f.name for f in en_files}

    errors: list[str] = []

    # 检查 1：文件数量一致
    only_zh = zh_names - en_names
    only_en = en_names - zh_names
    if only_zh:
        errors.append(f'仅 zh-CN 有: {sorted(only_zh)}')
    if only_en:
        errors.append(f'仅 en-US 有: {sorted(only_en)}')

    # 检查 2：每个子模块 key 集合一致（用 node 解析）
    common = sorted(zh_names & en_names)
    project_root = Path.cwd()
    all_files = [str((zh_dir / n).resolve()) for n in common] + [str((en_dir / n).resolve()) for n in common]
    parsed = flatten_keys_via_node(all_files)

    for name in common:
        zh_path = str((zh_dir / name).resolve())
        en_path = str((en_dir / name).resolve())
        zh_res = parsed.get(zh_path, {'ok': False, 'error': '未解析'})
        en_res = parsed.get(en_path, {'ok': False, 'error': '未解析'})

        if not zh_res['ok']:
            errors.append(f'{name} (zh-CN) 解析失败: {zh_res.get("error", "")[:100]}')
            continue
        if not en_res['ok']:
            errors.append(f'{name} (en-US) 解析失败: {en_res.get("error", "")[:100]}')
            continue

        zh_keys = set(zh_res['keys'])
        en_keys = set(en_res['keys'])
        missing_in_en = sorted(zh_keys - en_keys)
        extra_in_en = sorted(en_keys - zh_keys)
        if missing_in_en:
            preview = missing_in_en[:5]
            suffix = '...' if len(missing_in_en) > 5 else ''
            errors.append(f'{name} — en-US 缺失 {len(missing_in_en)} key: {preview}{suffix}')
        if extra_in_en:
            preview = extra_in_en[:5]
            suffix = '...' if len(extra_in_en) > 5 else ''
            errors.append(f'{name} — en-US 多余 {len(extra_in_en)} key: {preview}{suffix}')

    if not errors:
        print(f'{GREEN}[OK] i18n locale 双侧 key 对齐（{len(common)} 个子模块，zh-CN === en-US）{NC}')
        return 0

    print(f'{RED}[ERROR] i18n locale 双侧 key 不一致：{NC}')
    print()
    for err in errors:
        print(f'  {RED}{err}{NC}')
    print()
    print(f'{YELLOW}修复方式：{NC}')
    print(f'  在缺失的一侧 locale 文件补充对应 key，保持 zh-CN/en-US 结构完全镜像。')
    print(f'  跑 pnpm --filter @taiji/frontend check:i18n 可用 vitest 验证。')
    print()
    print(f'\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m')
    return 2


if __name__ == '__main__':
    sys.exit(main())
