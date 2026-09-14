/**
 * PS-27 探针：pi /skill: 展开模板 + frontmatter 剥离行为的静态逐字锚
 * （adversarial-review-fixes §3.3 B1——补 PS-24 动态 golden probe 的 CI 缺口）。
 *
 * 缺口背景：PS-24（xyz 注入器展开 ≡ pi 落盘展开的逐字 golden diff）是动态探针，
 * 需真实 pi 进程 + 模型凭证，CI 设 XYZ_SKIP_REAL_PI=1 恒 skip——pi 升级改展开
 * 格式时漂移静默通过。本探针对 node_modules 实装 dist 的展开模板 / 剥离函数做
 * 静态逐字断言（凭证无关，CI 可跑），覆盖 pi 改模板 / 剥离行为两类漂移面
 * （设计量级判定 ~90%）；全量行为等价仍由 PS-24 动态探针在本地 REAL_PI 环境守卫。
 *
 * 登记条目（docs/pi-semantics.json PS-27，verifiedWith 0.84.4）：
 * - 展开模板（agent-session.js _expandSkillCommand :983-1008，模板 :995）：
 *   `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative
 *   to ${skill.baseDir}.\n\n${body}\n</skill>`，args 有则 block + "\n\n" + args；
 *   body = stripFrontmatter(content).trim()；未命中 skill 原样透传。
 * - 剥离行为（utils/frontmatter.js extractFrontmatter）：BOM 剥除 → CRLF/CR 归一 →
 *   `---` 开界（startsWith）→ `\n---` 闭界（indexOf，偏移 3）→ body = slice(endIndex+4).trim()；
 *   无 frontmatter / 无闭界原文返回；stripFrontmatter = parseFrontmatter().body。
 * - xyz 交叉锚（runtime skill-injector.ts 的 pi 镜像）：block 模板行 / stripFrontmatterPi
 *   关键行与 pi dist 同骨架（变量名差异不影响骨架子串一致）。
 *
 * 断言方式（P-D1 代码形态断言，同 pi-semantics-agent-session 范式）：静态直读 dist
 * 源码，关键片段逐字 includes / 出现次数断言，失真即红。dist 不可达时 skip 不 fail；
 * 不进 REAL_PI_TESTS 分池（静态锚不依赖凭证，CI 无 XYZ_SKIP_REAL_PI 豁免）。
 * pi 升级后红 = PS-27 锚点漂移，先复核锚点（dist 实读）再更新 verifiedWith。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-skill-expansion-static.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { locatePiCodingAgentDist, methodWindow } from './helpers/pi-semantics-probe.js'

/** 定位仓库内相对路径文件（cwd 逐级上溯找 xyz 侧镜像源码）。 */
function locateWorkspaceFile(rel: string): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, rel)
    if (existsSync(candidate)) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

const PI_DIST = locatePiCodingAgentDist()
const SKIP_REASON = PI_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'
if (!PI_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

const SESSION_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'core', 'agent-session.js'), 'utf-8') : ''
const FRONTMATTER_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'utils', 'frontmatter.js'), 'utf-8') : ''

const INJECTOR_PATH = locateWorkspaceFile('packages/runtime/src/services/session/skill-injector.ts')
const INJECTOR_SRC = INJECTOR_PATH ? readFileSync(INJECTOR_PATH, 'utf-8') : ''

const count = (text: string, needle: string): number => text.split(needle).length - 1

describe.skipIf(!PI_DIST)(
  `PS-27 探针：_expandSkillCommand 展开模板逐字锚（0.84.4 :983-1008${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('方法存在 + /skill: 前缀判定 + name/args 解析形态', () => {
      const win = methodWindow(SESSION_SRC, '_expandSkillCommand(text) {')
      expect(win, 'PS-27 漂移：_expandSkillCommand 方法消失/改签名——复核 PS-27 锚点 dist/core/agent-session.js').not.toBe('')
      expect(
        win.includes('if (!text.startsWith("/skill:"))'),
        'PS-27 漂移：/skill: 前缀判定形态消失——命令识别改形，复核 PS-27',
      ).toBe(true)
      expect(
        win.includes('const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);'),
        'PS-27 漂移：skill 名解析形态变化（首空格切分）——复核 PS-27',
      ).toBe(true)
      expect(
        win.includes('const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();'),
        'PS-27 漂移：args 解析形态变化（trim 语义）——复核 PS-27',
      ).toBe(true)
    })

    it('核心锚：skill block 模板字符串逐字（tag 结构 / References 行 / 空行分隔 / 闭合）', () => {
      const win = methodWindow(SESSION_SRC, '_expandSkillCommand(text) {')
      // dist 源码中模板字符串的换行是字面 `\n` 转义（单行模板），断言用源码文本形态。
      // xyz 注入器 skill-injector.ts 的镜像模板必须与此逐字同构（仅变量名不同）。
      expect(
        win.includes(
          'const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\\nReferences are relative to ${skill.baseDir}.\\n\\n${body}\\n</skill>`;',
        ),
        'PS-27 漂移：skill block 模板字符串变化（tag 属性 / References 行 / 分隔空行 / 闭合标签任一改形）——xyz 镜像 skill-injector 的展开将与 pi 原生不一致，复核 PS-24/PS-27 与 skill-injector.ts 的镜像模板',
      ).toBe(true)
      expect(
        win.includes('return args ? `${skillBlock}\\n\\n${args}` : skillBlock;'),
        'PS-27 漂移：args 拼接形态变化（block 与 args 间 \\n\\n 分隔）——复核 PS-27',
      ).toBe(true)
    })

    it('body 剥离 + 读取形态：readFileSync utf-8 + stripFrontmatter 双 trim', () => {
      const win = methodWindow(SESSION_SRC, '_expandSkillCommand(text) {')
      expect(
        win.includes('const content = readFileSync(skill.filePath, "utf-8");'),
        'PS-27 漂移：SKILL.md 读取形态变化——复核 PS-27',
      ).toBe(true)
      expect(
        win.includes('const body = stripFrontmatter(content).trim();'),
        'PS-27 漂移：body = stripFrontmatter(content).trim() 双 trim 形态消失——xyz 镜像 stripFrontmatterPi 依赖该语义，复核 PS-27',
      ).toBe(true)
      expect(
        SESSION_SRC.includes('import { stripFrontmatter } from "../utils/frontmatter.js";'),
        'PS-27 漂移：stripFrontmatter 导入源变化（不再从 utils/frontmatter.js 引入？）——复核 PS-27 的 frontmatter 锚点路径',
      ).toBe(true)
    })

    it('skill 查找 + 未命中透传：getSkills 映射按裸名精确匹配', () => {
      const win = methodWindow(SESSION_SRC, '_expandSkillCommand(text) {')
      expect(
        win.includes('this.resourceLoader.getSkills().skills.find((s) => s.name === skillName)'),
        'PS-27 漂移：skill 映射查找形态变化（source/resolver 改形）——复核 PS-27 与 xyz get_commands 映射（PS-24 前缀断言）',
      ).toBe(true)
      expect(
        count(win, 'if (!skill)') === 1 && win.includes('return text;'),
        'PS-27 漂移：未命中 skill 的原样透传分支消失/变多——xyz 失效透传（D8）对齐 pi 该行为，复核 PS-27',
      ).toBe(true)
    })
  },
)

describe.skipIf(!PI_DIST)(
  `PS-27 探针：frontmatter 剥离行为逐字锚（utils/frontmatter.js${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('extractFrontmatter 关键行逐字：BOM/换行归一 → 开界 → 闭界搜索 → 切片 trim', () => {
      // xyz 镜像 stripFrontmatterPi（skill-injector.ts）逐字依赖以下行为——任一行改形
      // 都意味着剥离语义漂移，golden diff（PS-24）与 xyz 镜像须同批复核。
      expect(
        FRONTMATTER_SRC.includes(
          'const normalizeNewlines = (value) => value.replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n");',
        ),
        'PS-27 漂移：换行归一形态变化（CRLF/CR → LF）——复核 stripFrontmatterPi 镜像',
      ).toBe(true)
      expect(
        FRONTMATTER_SRC.includes('const normalized = normalizeNewlines(stripBom(content));'),
        'PS-27 漂移：BOM 剥除 + 归一的组合顺序变化——复核 stripFrontmatterPi 镜像（stripBomPi）',
      ).toBe(true)
      expect(
        FRONTMATTER_SRC.includes('if (!normalized.startsWith("---")) {'),
        'PS-27 漂移：frontmatter 开界判定形态变化——复核 PS-27',
      ).toBe(true)
      expect(
        FRONTMATTER_SRC.includes('const endIndex = normalized.indexOf("\\n---", 3);'),
        'PS-27 漂移：闭界搜索形态变化（\\n--- 从偏移 3 起 indexOf）——复核 PS-27 与镜像的 FRONTMATTER_DELIM_LEN',
      ).toBe(true)
      expect(
        FRONTMATTER_SRC.includes('if (endIndex === -1) {'),
        'PS-27 漂移：闭界缺失分支（原文返回）消失——复核 PS-27',
      ).toBe(true)
      expect(
        FRONTMATTER_SRC.includes('yamlString: normalized.slice(4, endIndex),'),
        'PS-27 漂移：yaml 提取切片偏移变化（slice(4, endIndex)）——复核 PS-27',
      ).toBe(true)
      expect(
        FRONTMATTER_SRC.includes('body: normalized.slice(endIndex + 4).trim(),'),
        'PS-27 漂移：body 提取切片偏移或 trim 变化（slice(endIndex + 4).trim()）——xyz 镜像 FRONTMATTER_CLOSED_DELIM_LEN = 4 直接承重，复核 PS-27',
      ).toBe(true)
    })

    it('stripFrontmatter 导出形态：parseFrontmatter(content).body（body 直通，无额外变换）', () => {
      expect(
        FRONTMATTER_SRC.includes(
          'export const stripFrontmatter = (content) => parseFrontmatter(content).body;',
        ),
        'PS-27 漂移：stripFrontmatter 不再是 parseFrontmatter().body 直通——展开阶段的剥离语义改形，复核 PS-27 与 xyz 镜像',
      ).toBe(true)
    })
  },
)

describe.skipIf(!PI_DIST || !INJECTOR_SRC)(
  `PS-27 交叉锚：xyz skill-injector 镜像模板与 pi dist 同骨架${!PI_DIST && !INJECTOR_SRC ? '｜skip：dist 与镜像源码均不可达' : !PI_DIST ? `｜skip：${SKIP_REASON}` : !INJECTOR_SRC ? '｜skip：skill-injector.ts 不可达' : ''}`,
  () => {
    it('xyz block 模板行与 pi 模板同骨架（tag / References 行 / 分隔 / 闭合逐子串一致）', () => {
      // xyz 镜像（skill-injector.ts resolveSingleMarker）的模板变量名与 pi 不同
      //（skillName/path/baseDir/body vs skill.name/skill.filePath/skill.baseDir/body），
      // 骨架子串（结构定值部分）必须逐字一致——pi 改模板而 xyz 未跟时，本断言与
      // PS-27 dist 锚分别红（双侧锚定，单侧改动无处遁形）。
      expect(
        INJECTOR_SRC.includes(
          'const block = `<skill name="${skillName}" location="${path}">\\nReferences are relative to ${baseDir}.\\n\\n${body}\\n</skill>`',
        ),
        'PS-27 漂移：xyz 镜像 block 模板行改形（与 pi dist :995 骨架脱钩）——复核 skill-injector.ts 与 pi 实装模板的一致性（PS-24 golden diff 本地全量验证）',
      ).toBe(true)
    })

    it('xyz stripFrontmatterPi 关键行与 pi frontmatter.js 行为镜像（闭界搜索偏移 + body trim）', () => {
      expect(
        INJECTOR_SRC.includes("const endIndex = normalized.indexOf('\\n---', FRONTMATTER_DELIM_LEN)"),
        'PS-27 漂移：xyz 镜像闭界搜索改形——复核 stripFrontmatterPi 与 pi extractFrontmatter 的一致性',
      ).toBe(true)
      expect(
        INJECTOR_SRC.includes('return normalized.slice(endIndex + FRONTMATTER_CLOSED_DELIM_LEN).trim()'),
        'PS-27 漂移：xyz 镜像 body 切片/trim 改形——复核 stripFrontmatterPi 与 pi extractFrontmatter 的一致性',
      ).toBe(true)
      expect(
        INJECTOR_SRC.includes('const body = stripFrontmatterPi(readFileSync(path, \'utf-8\')).trim()'),
        'PS-27 漂移：xyz 展开处双 trim 形态消失（pi 侧 stripFrontmatter(content).trim() 的镜像）——复核 PS-27',
      ).toBe(true)
    })
  },
)
