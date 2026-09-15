#!/usr/bin/env python3
"""Vue 文件规范检查脚本

检查内容：
1. 禁止使用原生 HTML 元素（应使用 shadcn-vue 组件）
2. 禁止使用 Emoji 图标（应使用 lucide-vue-next）
3. 禁止编写自定义 CSS（应使用 Tailwind 工具类）
4. <template> 行数上限 400 行，<script setup> 行数上限 300 行
   （文件头登记 `split-justified: <语义域>` 后 script 上限放行至 500 行，见 MAX_SCRIPT_LINES_JUSTIFIED）
5. 禁止使用 Tab 缩进（仅允许 Space）
6. 组件上优先使用 v-model 而非 :value + @input

用法：
  单文件: python3 vue_rules_checker.py <absolute_path> <relative_path>
  批量:   python3 vue_rules_checker.py --batch <file1> <file2> ...
"""

import re
import sys
from pathlib import Path

# 原生 HTML 元素 → shadcn-vue 组件映射
# 只映射本项目已安装的 shadcn-vue 组件
SHADCN_COMPONENTS_MAP = {
    'button': 'Button',
    'input': 'Input',
    'select': 'Select',
    'dialog': 'Dialog',
    'label': 'Label',
    'table': 'Table',
    'badge': 'Badge',
    'card': 'Card',
    'alert': 'AlertDialog',
    'textarea': 'Textarea',
    'checkbox': 'Checkbox',
}

# 未迁移到 @taiji/ui 组件的文件（渐进式迁移）
# All files have been migrated to design-system components.
# This whitelist is now empty — native HTML checks apply to all files.
# CSS selector checks still use STYLE_SCOPED_WHITELIST for gradual migration.
LEGACY_WHITELIST: list[str] = []

# 允许保留原生 HTML 元素的文件（子串匹配）
NATIVE_ELEM_WHITELIST: list[str] = []

# .vue 文件各区块行数上限
MAX_TEMPLATE_LINES = 400
MAX_SCRIPT_LINES = 300
# [HISTORICAL] split-justified 行数豁免（2026-09-11 renderer 过度设计审计候选 3，用户裁决 1）。
# 行数门禁曾驱动对超 300 行 script 的机械拆分，产出微包装/转发壳模块（如 command-popover
# 三个 ~30 行微文件），拆分本身反而新增间接层——门禁目标（控制单文件复杂度）与手段（强制拆分）倒挂。
# 经裁决改为登记制替代强制拆分：文件头注释块登记 `<!-- split-justified: <语义域> -->`
# （或 script 内 `// split-justified: <语义域>`，语义域须非空）后，该文件 script 上限放行至
# MAX_SCRIPT_LINES_JUSTIFIED（更高的绝对上限，防无限膨胀）。豁免不是静默的：放行时输出 INFO 行。
# 无登记文件行为不变（300 行拦截逻辑与报错文案均保持原样）。
MAX_SCRIPT_LINES_JUSTIFIED = 500
# 豁免标记只在文件头注释块（前 30 行）内有效，防止文件中段的标记造成隐式放行
SPLIT_JUSTIFIED_SCAN_LINES = 30

# 允许保留 <style scoped> 的文件（子串匹配）
# [HISTORICAL] MainPanel.vue 的 .main-panel { box-shadow: var(--shadow-1), var(--shadow-2) }
# 是 float-panel 双 shadow 叠加（spec §一），Tailwind 单 box-shadow 工具类无法表达多值叠加。
# 属于 AGENTS.md 前端编码规范明确允许的 escape hatch（Tailwind 无法表达的场景），加白名单避免误报。
# [HISTORICAL] UpdateButton.vue 的 release-notes 排版样式（h1/h2/p/ul 的 margin + scrollbar-width）
# 复用 MarkdownRenderer 的核心 markdown 排版，是 Tailwind 无法表达的 :deep() 后代选择器组 +
# Firefox 专有 scrollbar-width 属性。属 AGENTS.md 前端编码规范 escape hatch（与 MarkdownRenderer 同模式）。
# 待后续抽取轻量只读 MarkdownView 组件后再移出白名单。
# [HISTORICAL] SettingsModal.vue 的 .nav-item:focus-visible / .xbtn:focus-visible 双环
# box-shadow `0 0 0 2px var(--accent), 0 0 0 4px rgba(0,0,0,0.4)` 是多值叠加（内环 accent +
# 外环半透明黑），Tailwind 单个 box-shadow 工具类无法表达多值叠加，属 AGENTS.md 前端编码规范 escape
# hatch（与 MainPanel.vue 多值 shadow 同类）。其余 scoped 样式已迁移至 Tailwind 工具类。
# [HISTORICAL] CollapsibleContent.vue 的 .reka-collapsible-transition 是 reka data-state
# 驱动 + @starting-style 的展开淡入过渡。tailwindcss-animate 插件未安装，
# data-[state]:animate-* 死类不生成 CSS；@starting-style + [data-state] 属性选择器
# 是 Tailwind 无法表达的，属 AGENTS.md 前端编码规范 escape hatch（与 MainPanel 多值 shadow 同类）。
# 单组件样式归 scoped（多组件共享原语 popover/dialog/overlay 才进 style.css 全局层，
# 见 check_css_tokens.py ALLOWED_GLOBAL_ANIMATION_CLASSES 判据）。
STYLE_SCOPED_WHITELIST: list[str] = ['shell/MainPanel.vue', 'sidebar/UpdateButton.vue', 'settings/SettingsModal.vue', 'collapsible/CollapsibleContent.vue']

# CSS 选择器检测正则
RE_STYLE_SELECTOR = re.compile(r'^[.\w\-]+[\s,]*\{')

# [HISTORICAL] Vue <Transition> 类选择器（.xxx-enter-active / .xxx-leave-to 等）
# 是项目明确的 escape hatch（CLAUDE.md design-system：Tailwind 无法表达
# enter-from/leave-to 同时变换的状态类）。检测到这类选择器时不算自定义样式。
# 覆盖 enter/leave/appear 三组 × from/active/to 三阶段。命名见 Vue 官方文档
# https://vuejs.org/guide/built-ins/transition.html#css-based-transitions
RE_VUE_TRANSITION_CLASS = re.compile(r'-?(?:enter|leave|appear)-(?:from|active|to)\b')
# [HISTORICAL] 禁止 <Transition mode="out-in">：Vue 3.5.39 调度 bug（leave 完成后 enter 不触发，
# 内容区永久空白死锁）。本仓已 3 处同构踩坑（DrawerPanel 内容区 / Sidebar workflow / SettingsModal）。
# 匹配 <Transition ... mode="out-in" ...>（单/双引号、大小写标签），check_vue_file 检查 8 使用。
RE_TRANSITION_OUT_IN = re.compile(r'<[Tt]ransition\b[^>]*?\bmode\s*=\s*["\']out-in["\']')

# Emoji Unicode 范围
EMOJI_RANGES = [
    (0x1F600, 0x1F64F),   # emoticons
    (0x1F300, 0x1F5FF),   # misc symbols and pictographs
    (0x1F680, 0x1F6FF),   # transport and map
    (0x1F1E0, 0x1F1FF),   # flags
    (0x2600, 0x26FF),     # misc symbols
    (0x2700, 0x27BF),     # dingbats
    (0xFE00, 0xFE0F),     # variation selectors
    (0x1F900, 0x1F9FF),   # supplemental symbols
    (0x1FA00, 0x1FA6F),   # chess symbols
    (0x1FA70, 0x1FAFF),   # symbols extended-A
    (0x231A, 0x231B),     # watch, hourglass
    (0x23E9, 0x23F3),     # media control
    (0x23F8, 0x23FA),     # media control
    (0x25AA, 0x25AB),     # squares
    (0x25B6, 0x25B6),     # play button
    (0x25C0, 0x25C0),     # reverse button
    (0x25FB, 0x25FE),     # squares
    (0x2614, 0x2615),     # umbrella, hot beverage
    (0x2648, 0x2653),     # zodiac
    (0x267F, 0x267F),     # wheelchair
    (0x2693, 0x2693),     # anchor
    (0x26A1, 0x26A1),     # high voltage
    (0x26AA, 0x26AB),     # circles
    (0x26BD, 0x26BE),     # soccer, baseball
    (0x26C4, 0x26C5),     # snowman, sun
    (0x26CE, 0x26CE),     # ophiuchus
    (0x26D4, 0x26D4),     # no entry
    (0x26EA, 0x26EA),     # church
    (0x26F2, 0x26F3),     # fountain, golf
    (0x26F5, 0x26F5),     # sailboat
    (0x26FA, 0x26FA),     # tent
    (0x26FD, 0x26FD),     # fuel pump
    (0x2702, 0x2702),     # scissors
    (0x2705, 0x2705),     # check mark button
    (0x2708, 0x270D),     # airplane, writing
    (0x270F, 0x270F),     # pencil
    (0x2712, 0x2712),     # black nib
    (0x2714, 0x2714),     # check mark
    (0x2716, 0x2716),     # multiplication
    (0x271D, 0x271D),     # latin cross
    (0x2721, 0x2721),     # star of david
    (0x2728, 0x2728),     # sparkles
    (0x2733, 0x2734),     # eight spokes
    (0x2744, 0x2744),     # snowflake
    (0x2747, 0x2747),     # sparkle
    (0x274C, 0x274C),     # cross mark
    (0x274E, 0x274E),     # cross mark
    (0x2753, 0x2755),     # question marks
    (0x2757, 0x2757),     # exclamation mark
    (0x2763, 0x2764),     # heart exclamation, red heart
    (0x2795, 0x2797),     # plus, minus, divide
    (0x2B05, 0x2B07),     # arrows
    (0x2B1B, 0x2B1C),     # squares
    (0x2B50, 0x2B50),     # star
    (0x2B55, 0x2B55),     # circle
]


def check_emoji_in_line(line: str) -> bool:
    """检查行中是否包含 Emoji 字符"""
    for char in line:
        cp = ord(char)
        for start, end in EMOJI_RANGES:
            if start <= cp <= end:
                return True
    return False


def check_vue_component_usage(content: str, relative_path: str) -> tuple[int, list[str]]:
    """检查是否使用了原生 HTML 元素而应该使用 shadcn-vue 组件"""
    issues: list[str] = []
    exit_code = 0

    if 'node_modules' in relative_path or '.claude' in relative_path:
        return 0, []

    # shadcn-vue 组件自身可以使用原生元素
    if '/components/ui/' in relative_path or relative_path.startswith('components/ui/'):
        return 0, []

    # 白名单文件
    if any(w in relative_path for w in NATIVE_ELEM_WHITELIST):
        return 0, []

    # 渐进式迁移白名单
    if any(w in relative_path for w in LEGACY_WHITELIST):
        return 0, []

    lines = content.split('\n')
    in_template = False

    for i, line in enumerate(lines, 1):
        if '<template' in line:
            in_template = True
            continue
        if '</template>' in line:
            in_template = False
            continue

        if not in_template:
            continue

        stripped = line.strip()
        if not stripped or stripped.startswith('<!--'):
            continue

        for native_elem, shadcn_component in SHADCN_COMPONENTS_MAP.items():
            # <input type="checkbox"> 是标准做法，shadcn-vue 没有替代
            if native_elem == 'input' and 'type="checkbox"' in line:
                continue
            # <form> 在 Vue 中是标准做法
            if native_elem == 'form':
                continue

            pattern = re.compile(rf'<{native_elem}(?![a-z])')
            if pattern.search(line):
                issues.append(f"  [第{i}行] 禁止使用原生 <{native_elem}> 元素")
                issues.append(f"    请使用 shadcn-vue <{shadcn_component} /> 组件替代")
                exit_code = 2

    return exit_code, issues


def find_split_justified_domain(content: str) -> str | None:
    """提取文件头登记的 split-justified 豁免语义域；未登记或登记无效返回 None。

    认可的登记形态（均须在注释语境内、位于文件头前 SPLIT_JUSTIFIED_SCAN_LINES 行）：
      <!-- split-justified: <语义域> -->   （SFC 文件头 HTML 注释，须同行闭合）
      // split-justified: <语义域>         （script 内行注释；/* 块注释与 * 续行同样接受）
    标记存在但语义域为空（`split-justified:` / 纯空白）视为未登记；首个标记定性，
    不向后继续扫描（防止堆叠多个标记直到某个通过）。
    """
    for line in content.split('\n')[:SPLIT_JUSTIFIED_SCAN_LINES]:
        if 'split-justified:' not in line:
            continue
        stripped = line.strip()
        if not (stripped.startswith('<!--') or stripped.startswith('//')
                or stripped.startswith('/*') or stripped.startswith('*')):
            continue  # 标记必须出现在注释语境，正文/字符串中的文字不算登记
        text = stripped
        if text.startswith('<!--'):
            m = re.match(r'<!--(.*)-->\s*$', text)
            if not m:
                continue  # 跨行 HTML 注释首行（未同行闭合）不认，登记须单行自足
            text = m.group(1)
        else:
            text = re.sub(r'^(?:/{2}|/\*|\*)\s*', '', text)
        m = re.search(r'split-justified:\s*(\S.*?)\s*$', text)
        if m:
            domain = m.group(1).strip()
            if domain:
                return domain
        return None  # 找到标记但语义域为空：显式视为未登记
    return None


def check_vue_file(content: str, relative_path: str) -> tuple[int, list[str]]:
    """检查 Vue 文件的代码规范"""
    issues: list[str] = []
    exit_code = 0

    lines = content.split('\n')
    is_legacy = any(w in relative_path for w in LEGACY_WHITELIST)

    # 检查 1: 禁止 Emoji
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        if not stripped or stripped.startswith('//') or stripped.startswith('*'):
            continue
        if check_emoji_in_line(line):
            issues.append(f"  [第{i}行] 禁止使用 Emoji 图标")
            issues.append("    请使用 lucide-vue-next 图标组件替代")
            exit_code = 2

    # 检查 2: 禁止 Tab 缩进
    for i, line in enumerate(lines, 1):
        if line != line.expandtabs():
            issues.append(f"  [第{i}行] 禁止使用 Tab 缩进")
            issues.append("    请使用 Space（2 空格）缩进替代")
            exit_code = 2

    # 检查 3: 禁止自定义 CSS（style scoped 内部）
    is_style_whitelisted = any(w in relative_path for w in STYLE_SCOPED_WHITELIST)
    in_style_section = False
    in_style_tag = False

    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        # [HISTORICAL] 用行首精确匹配（stripped.startswith('<style'）而非裸子串 '<style' in line。
        # 裸子串会被注释里提到 "<style scoped>" 的文字误判为 style 块开始，导致后续所有
        # `import {` 语句被 RE_STYLE_SELECTOR 误匹配报「禁止编写自定义 CSS」。
        # 合法 SFC 的 <style> 标签总是独占一行（无内联），行首匹配既准确又不放松真检查。
        # 同理 </style> 也用行首匹配，避免注释里的 "</style>" 文字误重置状态。
        if stripped.startswith('<style'):
            in_style_tag = True
            if 'scoped' in line:
                in_style_section = True
            continue

        if in_style_tag and stripped.startswith('</style>'):
            in_style_tag = False
            in_style_section = False
            continue

        if not in_style_section:
            continue

        if is_style_whitelisted:
            continue

        if is_legacy:
            continue

        stripped = line.strip()
        if not stripped:
            continue

        if stripped.startswith('@apply'):
            continue

        if RE_STYLE_SELECTOR.search(line):
            if i < len(lines):
                next_lines = '\n'.join(lines[i:min(i + 3, len(lines))])
                if '@apply' in next_lines:
                    continue
            # [HISTORICAL] Vue <Transition> 类（含逗号续行的选择器组）是合法
            # escape hatch，不算自定义样式。回看 6 行（含当前）覆盖典型多行选择器组。
            selector_group = '\n'.join(lines[max(0, i - 6):i])
            if RE_VUE_TRANSITION_CLASS.search(selector_group):
                continue
            # [HISTORICAL] pseudo-element 选择器（::before/::after/::placeholder 等）是合法
            # escape hatch——Tailwind 无法表达 ::after { content: ... }。符合 AGENTS.md
            # 三层结构的 escape hatch 定义。
            if '::' in line:
                continue
            issues.append(f"  [第{i}行] 禁止编写自定义 CSS（特殊动画除外）")
            issues.append("    请使用 Tailwind 工具类替代")
            exit_code = 2
            continue

        if (stripped.startswith('/*') or
            stripped.startswith('//') or
            stripped.startswith('@keyframes') or
            stripped.startswith('@import') or
            'animation' in stripped or
            'transition' in stripped):
            continue

    # 检查 5: 优先使用 v-model 而非 :value + @input
    if not is_legacy:
        in_template = False
        for i, line in enumerate(lines, 1):
            if '<template' in line:
                in_template = True
                continue
            if '</template>' in line:
                in_template = False
                continue
            if not in_template:
                continue
            stripped = line.strip()
            if not stripped or stripped.startswith('<!--'):
                continue
            if ':value=' in stripped and 'v-model' not in stripped:
                # 提取行内所有 PascalCase 开标签
                tag_matches = re.findall(r'<([A-Z][A-Za-z0-9]*)', stripped)
                # [HISTORICAL] 排除 Item/Option 后缀子组件：reka-ui 的 SelectItem /
                # ComboboxItem / RadioGroupItem 等的 :value 是「该选项的值」语义，
                # 由父级 Root 用 v-model 收集，子组件不支持 v-model，不应报警。
                if tag_matches and all(re.search(r'(?:Item|Option)$', t) for t in tag_matches):
                    continue
                if tag_matches:
                    issues.append(f"  [第{i}行] 组件上使用 :value 绑定 — 请优先使用 v-model")
                    issues.append('    示例: <Input v-model="value" /> 而非 <Input :value="value" @input="handler" />')
                    exit_code = 2

    # 检查 8: 禁止 <Transition mode="out-in">（Vue 3.5.39 调度 bug 死锁）
    # [HISTORICAL] Transition out-in 的 leave 完成后 enter 不触发，内容区永久空白死锁
    # （dev app 实测 DrawerPanel 8/8 复现）。跳过 HTML 注释（<!-- -->，含跨行）：
    # SettingsModal.vue / DrawerPanel.vue 的注释里提及该写法属说明文字，非真实用法误报。
    in_template = False
    in_html_comment = False
    for i, line in enumerate(lines, 1):
        if '<template' in line and '</template>' not in line:
            in_template = True
            in_html_comment = False
            continue
        if '</template>' in line:
            in_template = False
            continue
        if not in_template:
            continue
        # 切出本行非注释段（处理跨行 <!-- --> + 行内 <!-- -->），注释内文字不检查
        segments = []
        pos = 0
        if in_html_comment:
            end = line.find('-->', pos)
            if end == -1:
                continue
            in_html_comment = False
            pos = end + 3
        while pos < len(line):
            start = line.find('<!--', pos)
            if start == -1:
                segments.append(line[pos:])
                break
            segments.append(line[pos:start])
            end = line.find('-->', start + 4)
            if end == -1:
                in_html_comment = True
                break
            pos = end + 3
        if RE_TRANSITION_OUT_IN.search('\n'.join(segments)):
            issues.append(f'  [第{i}行] 禁止 <Transition mode="out-in">')
            issues.append('    Vue 3.5.39 调度 bug：leave 完成后 enter 不触发，内容区永久空白死锁')
            issues.append('    请改用 v-if/v-else 瞬时切换（无动画）。已知踩坑：DrawerPanel/Sidebar/SettingsModal')
            exit_code = 2

    # 检查 6: <template> / <script setup> 行数上限
    template_lines = 0
    script_lines = 0
    in_template = False
    in_script = False

    for line in lines:
        if '<template' in line and '</template>' not in line:
            in_template = True
            continue
        if '</template>' in line:
            in_template = False
            continue
        if in_template:
            template_lines += 1
            continue

        if '<script' in line and 'setup' in line and '</script>' not in line:
            in_script = True
            continue
        if '</script>' in line:
            in_script = False
            continue
        if in_script:
            script_lines += 1

    if template_lines > MAX_TEMPLATE_LINES:
        issues.append(
            f"  <template> 共 {template_lines} 行，"
            f"超出上限 {MAX_TEMPLATE_LINES} 行"
        )
        issues.append("    请提取子组件拆分模板")
        exit_code = 2

    if script_lines > MAX_SCRIPT_LINES:
        justified_domain = find_split_justified_domain(content)
        if justified_domain is None:
            # 无登记（或登记无效）：拦截行为与报错文案保持原样
            issues.append(
                f"  <script setup> 共 {script_lines} 行，"
                f"超出上限 {MAX_SCRIPT_LINES} 行"
            )
            issues.append("    请提取 composable 或子组件拆分逻辑")
            exit_code = 2
        elif script_lines > MAX_SCRIPT_LINES_JUSTIFIED:
            # 已登记但超绝对上限：豁免不无限膨胀
            issues.append(
                f"  <script setup> 共 {script_lines} 行，"
                f"超出豁免上限 {MAX_SCRIPT_LINES_JUSTIFIED} 行（split-justified: {justified_domain}）"
            )
            issues.append("    请提取 composable 或子组件拆分逻辑")
            exit_code = 2
        else:
            # 已登记且在绝对上限内：放行，但豁免不是静默的，输出 INFO 留痕
            print(
                f"  [INFO] {relative_path}: <script setup> 共 {script_lines} 行，"
                f"split-justified 豁免生效（登记域: {justified_domain}），"
                f"上限 {MAX_SCRIPT_LINES_JUSTIFIED} 行",
                file=sys.stderr,
            )

    # 检查 7: 组件使用规范
    comp_exit, comp_issues = check_vue_component_usage(content, relative_path)
    if comp_exit > exit_code:
        exit_code = comp_exit
    issues.extend(comp_issues)

    return exit_code, issues


def check_ts_file(content: str, relative_path: str) -> tuple[int, list[str]]:
    """检查 TypeScript 文件的 Emoji 使用"""
    issues: list[str] = []
    exit_code = 0

    if '/components/ui/' in relative_path:
        return 0, []

    for i, line in enumerate(content.split('\n'), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith('//') or stripped.startswith('*'):
            continue
        if check_emoji_in_line(line):
            issues.append(f"  [第{i}行] 禁止使用 Emoji 图标")
            issues.append("    请使用 lucide-vue-next 图标组件替代")
            exit_code = 2

    return exit_code, issues


def run_all_checks(file_paths: list[str]) -> tuple[int, list[str]]:
    """批量检查多个文件"""
    all_issues: list[str] = []
    exit_code = 0

    for file_path_str in file_paths:
        file_path = Path(file_path_str)
        if not file_path.exists():
            continue
        try:
            content = file_path.read_text(encoding='utf-8')
        except (OSError, UnicodeDecodeError):
            continue

        try:
            cwd = Path.cwd()
            rel_path = str(file_path.relative_to(cwd))
        except ValueError:
            rel_path = file_path.name

        file_exit = 0
        file_issues: list[str] = []

        if rel_path.endswith('.vue'):
            file_exit, file_issues = check_vue_file(content, rel_path)
        elif rel_path.endswith('.ts') and 'src/src/' in rel_path:
            file_exit, file_issues = check_ts_file(content, rel_path)

        if file_exit > exit_code:
            exit_code = file_exit
        if file_issues:
            all_issues.append(f"\n代码规范检查失败: {rel_path}")
            all_issues.extend(file_issues)

    return exit_code, all_issues


def main():
    if len(sys.argv) < 3:
        print("用法: python3 vue_rules_checker.py <absolute_path> <relative_path>", file=sys.stderr)
        sys.exit(0)

    absolute_path = sys.argv[1]
    relative_path = sys.argv[2]

    file_path = Path(absolute_path)
    if not file_path.exists():
        sys.exit(0)

    try:
        content = file_path.read_text(encoding='utf-8')
    except (OSError, UnicodeDecodeError):
        sys.exit(0)

    exit_code = 0
    issues: list[str] = []

    if relative_path.endswith('.vue'):
        exit_code, issues = check_vue_file(content, relative_path)
    elif relative_path.endswith('.ts') and 'src/src/' in relative_path:
        exit_code, issues = check_ts_file(content, relative_path)

    if issues:
        print(f"代码规范检查失败: {relative_path}", file=sys.stderr)
        for issue in issues:
            print(issue, file=sys.stderr)
        print()
        if exit_code == 2:
            print("检查失败：请修复上述问题后重试。", file=sys.stderr)
            print("\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m", file=sys.stderr)

    sys.exit(exit_code)


if __name__ == '__main__':
    if len(sys.argv) >= 2 and sys.argv[1] == '--batch':
        if len(sys.argv) < 3:
            print("用法: python3 vue_rules_checker.py --batch <file1> <file2> ...", file=sys.stderr)
            sys.exit(0)

        exit_code, issues = run_all_checks(sys.argv[2:])
        if issues:
            for issue in issues:
                print(issue, file=sys.stderr)
            print()
            if exit_code == 2:
                print("检查失败：请修复上述问题后重试。", file=sys.stderr)
                print("\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m", file=sys.stderr)
        sys.exit(exit_code)
    else:
        main()
