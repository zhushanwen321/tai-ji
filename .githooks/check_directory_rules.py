#!/usr/bin/env python3
r"""
检查目录规范（pre-commit）：
1. 禁止创建 demos/ 或 impeccable/ 目录（demo 统一放 .tmp/，不入库；原 docs/page-design/ 已于 2026-09-13 退役）
2. 禁止 symlink 指向外部绝对路径（白名单：../ 相对路径 symlink 允许）
3. 禁止 cw v1 工作流临时产物出现在根目录（应归档到 .xyz-harness/）
4. 禁止备份/临时后缀文件进版本管理（*.bak/*.tmp/*.swp/*.orig/*~）
5. 禁止非 ASCII 路径（中文目录名等）进版本管理
6. .pi/ 目录只允许 workflows/ 子目录进 git（防止运行时缓存/会话数据误提交）

设计原则 [HISTORICAL]：所有检查只针对 git staged 文件，不做全项目扫描。
- staged 扫描已能拦截 `git add -f`（强制 add 后文件即 staged），全项目扫描
  会误报磁盘残留（如 .impeccable/ 文件物理留在磁盘靠 .gitignore 兜底，不应报错）。
- 全项目扫描收益低、误报风险高，违反「不过度设计」。
- 事故背景：100 个临时产物（.cw-*.json / wave-* / plan.* / .bak 等）曾被 git add
  进版本管理，.gitignore 兜底后仍有历史遗留。本检查是 .gitignore 之外的防呆层。
"""
import os
import re
import sys
import subprocess

# 禁止出现的目录名
FORBIDDEN_DIR_NAMES = {"demos", "impeccable"}

# symlink 白名单：允许的相对路径前缀
SYMLINK_ALLOWED_PREFIXES = ("../", "./")

# .pi/ 目录白名单：只允许这些子目录进 git。
# .pi/ 整体放开跟踪后（.gitignore 用 .pi/* + !.pi/workflows/），
# 本检查是防呆层——防止 .pi/sessions/ .pi/infinite-context/ 等运行时数据
# 被 git add -f 误提交。workflows/ 是编排源码，extension 相关内容是 npm 包不在 .pi/ 下。
PI_ALLOWED_SUBDIRS = {"workflows"}

# extensions/ 目录 md 白名单（防止临时文件/杂散文档污染包根）。
# [HISTORICAL] .tmp-architecture-review.md / .tmp-competitive-research.md 曾散落
# extensions/ 根目录（认知外临时研究文档）。规范：extensions/ 根禁止任何 md；
# extensions/<pkg>/ 根只允许标准文档，其他 md 应放 docs/ 子目录或项目 docs/。
EXTENSIONS_PKG_ALLOWED_MD = {"README.md", "CHANGELOG.md", "ARCHITECTURE.md", "AGENTS.md"}

# 根目录禁止的 cw v1 工作流临时产物文件名模式（正则，对根目录相对路径匹配）。
# 这些是 cw 跑完的运行时/归档产物，应放 .xyz-harness/，不是源码。
# 注意：.cw/（带尾斜杠）是 tracked 测试脚本目录，不在此列。
ROOT_FORBIDDEN_PATTERNS = [
    re.compile(r"^\.cw-.*\.(json|md)$"),        # .cw-clarify-*.json / .cw-slice*.json 等
    re.compile(r"^wave-.*\.(json|md)$"),         # wave-plan.json / wave-test-2.json 等
    re.compile(r"^(clarify|clarify-.*)\.json$"),
    re.compile(r"^design-review\.json$"),
    re.compile(r"^exec-review\.json$"),
    re.compile(r"^retrospect\.json$"),
    re.compile(r"^closeout\.json$"),
    re.compile(r"^test\.json$"),
    re.compile(r"^plan\.(json|md)$"),            # 根目录散落的 plan.md/plan.json
    re.compile(r"^review-.*\.md$"),               # 根目录散落的审查报告 review-*.md（应归档到 .xyz-harness/）
]

# 禁止的备份/临时后缀（全路径匹配，不只根目录）
FORBIDDEN_SUFFIXES = (".bak", ".tmp", ".swp", ".orig", "~")


def get_staged_files():
    """获取 git staged 的文件列表。

    使用 -z（NUL 分隔）避免 git 对非 ASCII 路径的引号转义，
    否则中文路径会变成 '"packages/\\346\\265\\213..."' 导致后续检查失效。
    """
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"],
        capture_output=True, text=True
    )
    return [f for f in result.stdout.split("\0") if f]


def check_forbidden_dirs(staged_files):
    """检查是否创建了禁止的目录。

    对路径段同时匹配原始名和去前导点后的名（.impeccable → impeccable），
    否则 dotfile 目录（如 packages/renderer/src/.impeccable/）会漏检。
    """
    errors = []
    forbidden_dirs_found = set()

    for filepath in staged_files:
        # git 输出的路径恒用正斜杠（跨平台一致），不能用 os.sep（Windows 上为反斜杠会切错）
        parts = filepath.split('/')
        for part in parts:
            if part in FORBIDDEN_DIR_NAMES:
                forbidden_dirs_found.add(part)
            # dotfile 目录：.impeccable / .demos 等，去前导点后匹配
            stripped = part.lstrip(".")
            if stripped in FORBIDDEN_DIR_NAMES and stripped != part:
                forbidden_dirs_found.add(part)

    if forbidden_dirs_found:
        errors.append(
            f"禁止创建目录: {', '.join(sorted(forbidden_dirs_found))}\n"
            f"  所有 demo/HTML 统一放 .tmp/（不入库）"
        )

    return errors


def check_root_temp_artifacts(staged_files):
    """检查 cw v1 工作流临时产物是否出现在根目录。

    这些文件（.cw-*.json / wave-*.json / plan.* 等）是 cw 跑完的运行时产物，
    应归档到 .xyz-harness/。根目录散落会污染项目根，且易被误判为源码。
    只检查根目录（路径不含路径分隔符）的新增/修改文件。
    """
    errors = []
    found = set()
    for filepath in staged_files:
        # 只检查根目录文件（无路径分隔符 = 直接在仓库根）
        # git 输出的路径恒用正斜杠（跨平台一致），不能用 os.sep（Windows 上漏判）
        if '/' in filepath:
            continue
        for pattern in ROOT_FORBIDDEN_PATTERNS:
            if pattern.match(filepath):
                found.add(filepath)
                break
    if found:
        sample = ", ".join(sorted(found)[:5])
        suffix = f" 等 {len(found)} 个" if len(found) > 5 else ""
        errors.append(
            f"根目录禁止 cw v1 工作流临时产物: {sample}{suffix}\n"
            f"  wave-*/.cw-*/plan.*/clarify.json 等应归档到 .xyz-harness/，不应散落项目根"
        )
    return errors


def check_backup_suffixes(staged_files):
    """检查备份/临时后缀文件是否进版本管理。

    *.bak/*.tmp/*.swp/*.orig/*~ 是编辑器/工具的临时产物，不应追踪。
    """
    errors = []
    found = []
    for filepath in staged_files:
        for suffix in FORBIDDEN_SUFFIXES:
            if filepath.endswith(suffix):
                found.append(filepath)
                break
    if found:
        sample = ", ".join(found[:5])
        suffix = f" 等 {len(found)} 个" if len(found) > 5 else ""
        errors.append(
            f"禁止备份/临时后缀文件: {sample}{suffix}\n"
            f"  *.bak/*.tmp/*.swp/*.orig/*~ 是临时产物，不应进版本管理"
        )
    return errors


def check_ascii_paths(staged_files):
    """检查路径是否全 ASCII。

    非 ASCII 路径（如中文目录名「重新跑/」）在跨平台/CI 环境易出问题，
    且不符合项目目录命名规范。只对 staged 文件检查，不扫全项目。
    """
    errors = []
    found = []
    for filepath in staged_files:
        try:
            filepath.encode("ascii")
        except UnicodeEncodeError:
            found.append(filepath)
    if found:
        sample = ", ".join(found[:5])
        suffix = f" 等 {len(found)} 个" if len(found) > 5 else ""
        errors.append(
            f"禁止非 ASCII 路径: {sample}{suffix}\n"
            f"  目录/文件名必须全 ASCII（中文目录名跨平台/CI 易出问题）"
        )
    return errors


def check_pi_whitelist(staged_files):
    """检查 .pi/ 目录下只允许 workflows/ 子目录进 git。

    .gitignore 已用 .pi/* + !.pi/workflows/ 放开跟踪，但 git add -f 可绕过 ignore。
    本检查是防呆层：任何 .pi/ 下非 workflows/ 的文件都拒绝（运行时缓存/会话数据
    如 .pi/sessions/ .pi/infinite-context/ 不应进版本管理）。
    """
    errors = []
    found = []
    for filepath in staged_files:
        if not filepath.startswith(".pi/"):
            continue
        # filepath 形如 .pi/workflows/review-fix-loop.js → 第二段是子目录名
        # git 输出的路径恒用正斜杠（跨平台一致），不能用 os.sep（Windows 上为反斜杠会切错）
        parts = filepath.split('/')
        if len(parts) < 2:
            continue
        subdir = parts[1]
        if subdir not in PI_ALLOWED_SUBDIRS:
            found.append(filepath)
    if found:
        sample = ", ".join(sorted(found)[:5])
        suffix = f" 等 {len(found)} 个" if len(found) > 5 else ""
        errors.append(
            f".pi/ 目录只允许 workflows/ 进 git: {sample}{suffix}\n"
            f"  .pi/sessions/ .pi/infinite-context/ 等是运行时数据，不应提交。"
            f"只允许 {sorted(PI_ALLOWED_SUBDIRS)} 子目录"
        )
    return errors


def check_extensions_md_whitelist(staged_files):
    """检查 extensions/ 目录下的 md 文件白名单。

    extensions/ 根目录禁止任何 md（.tmp-* 等临时研究文档曾污染）。
    extensions/<pkg>/ 根目录只允许标准/必要文档（README/CHANGELOG/ARCHITECTURE/AGENTS），
    其他 md 应统一放 extensions/<pkg>/docs/ 子目录或项目 docs/。
    子目录（docs/src 等）内的 md 不受此约束（如 extensions/<pkg>/docs/*.md 允许）。
    """
    errors = []
    root_violations = []
    pkg_violations = []
    for filepath in staged_files:
        if not filepath.endswith(".md"):
            continue
        if not filepath.startswith("extensions/"):
            continue
        # git 输出的路径恒用正斜杠（跨平台一致），不能用 os.sep
        parts = filepath.split("/")
        # extensions/foo.md → 根 md（2 段）：禁止
        if len(parts) == 2:
            root_violations.append(filepath)
        # extensions/<pkg>/foo.md → 子包根 md（3 段）：白名单校验
        elif len(parts) == 3:
            if parts[2] not in EXTENSIONS_PKG_ALLOWED_MD:
                pkg_violations.append(filepath)
        # extensions/<pkg>/<subdir>/... → 子目录 md（docs/ 等），不检查
    if root_violations:
        sample = ", ".join(sorted(root_violations)[:5])
        suffix = f" 等 {len(root_violations)} 个" if len(root_violations) > 5 else ""
        errors.append(
            f"extensions/ 根目录禁止 md 文件: {sample}{suffix}\n"
            f"  临时文件/杂散文档应放 docs/ 子目录或删除（.tmp-* 类研究文档不应散落包根）"
        )
    if pkg_violations:
        sample = ", ".join(sorted(pkg_violations)[:5])
        suffix = f" 等 {len(pkg_violations)} 个" if len(pkg_violations) > 5 else ""
        errors.append(
            f"extensions/<pkg>/ 根目录 md 白名单违规: {sample}{suffix}\n"
            f"  只允许 {sorted(EXTENSIONS_PKG_ALLOWED_MD)}；其他 md 应放 extensions/<pkg>/docs/ 或项目 docs/"
        )
    return errors


def check_symlinks(staged_files):
    """检查项目中的 symlink 是否指向外部绝对路径。

    只在 staged files 中包含 symlink 时触发全项目扫描。
    symlink 的增删可能影响非 staged 的目录结构（如创建中间 symlink 目录），
    所以只要检测到 symlink 变更就做全量检查。
    """
    # 快速路径：如果没有 symlink 相关的 staged 文件变更，跳过全项目扫描
    has_symlink_change = False
    for f in staged_files:
        full = os.path.join(os.getcwd(), f)
        if os.path.islink(full):
            has_symlink_change = True
            break
    if not has_symlink_change:
        return []
    errors = []
    project_root = os.getcwd()

    for root, dirs, files in os.walk(project_root):
        # 跳过 node_modules、.git、dist、.bare
        # .agents/.claude：全局 skill/agent 安装目录，symlink 指向 ~/.agents/skills/ 等外部路径
        # 是 AGENTS.md「Skill 安装规范」明确要求的（ln -s /path/to/<name> ~/.agents/skills/<name>），
        # 不属于「打包资源缺失」风险范畴（不进 electron-builder files/extraResources）
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", "dist", ".bare", ".agents", ".claude")]

        for name in dirs + files:
            full_path = os.path.join(root, name)
            if os.path.islink(full_path):
                rel_path = os.path.relpath(full_path, project_root)

                # [HISTORICAL] 跳过 .gitignore 覆盖的 symlink：这些文件不会进仓库，
                # 不存在「打包后目标路径缺失」风险。如 apps/electron/resources/pi/*.wasm
                # 指向 workspace 级 .pi-binary-cache（prepare-pi-resources.sh 创建的
                # pi binary 缓存复用），.gitignore 已忽略 resources/，不会打包。
                ignore_check = subprocess.run(
                    ["git", "check-ignore", "-q", rel_path],
                    capture_output=True,
                )
                if ignore_check.returncode == 0:
                    continue

                target = os.readlink(full_path)

                # 允许 ../ 相对路径 symlink
                if any(target.startswith(prefix) for prefix in SYMLINK_ALLOWED_PREFIXES):
                    continue

                # 允许指向项目内部的相对路径 symlink
                if not os.path.isabs(target):
                    continue

                # 绝对路径指向项目外部 → 禁止
                # 必须用 os.path.realpath 解析 symlink 目标的真实路径
                # os.path.abspath 只返回 symlink 自身路径，永远在 project_root 内，导致漏检
                resolved_target = os.path.realpath(full_path)
                if not resolved_target.startswith(project_root):
                    errors.append(
                        f"禁止外部绝对路径 symlink: {rel_path} -> {target}\n"
                        f"  打包后目标路径不存在，会导致运行时资源缺失"
                    )

    return errors


def main():
    errors = []

    staged_files = get_staged_files()
    errors.extend(check_forbidden_dirs(staged_files))
    errors.extend(check_root_temp_artifacts(staged_files))
    errors.extend(check_backup_suffixes(staged_files))
    errors.extend(check_ascii_paths(staged_files))
    errors.extend(check_pi_whitelist(staged_files))
    errors.extend(check_extensions_md_whitelist(staged_files))
    errors.extend(check_symlinks(staged_files))

    if errors:
        print("\033[0;31m[ERROR] 目录规范检查失败:\033[0m")
        for err in errors:
            print(f"  - {err}")
        print()
        print("\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m")
        sys.exit(2)

    print("\033[0;32m[OK] 目录规范检查通过\033[0m")
    sys.exit(0)


if __name__ == "__main__":
    main()
