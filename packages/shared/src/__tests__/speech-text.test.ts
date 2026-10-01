/**
 * cleanTextForSpeech 规则集单测（TTS 设计 D7，实施计划 u1 验收条款 1）。
 *
 * 覆盖 D7 封闭清单十条 + 幂等不变量（clean(x) === clean(clean(x))，runtime 幂等重洗兜底的前提）。
 * 运行：cd packages/shared && pnpm vitest run src/__tests__/speech-text.test.ts
 */
import { describe, it, expect } from 'vitest'
import { cleanTextForSpeech } from '../speech-text'

/** 幂等断言（每条规则共用）：清洗一遍与两遍结果全等。 */
function expectIdempotent(raw: string, expected: string): void {
  const once = cleanTextForSpeech(raw)
  expect(once).toBe(expected)
  expect(cleanTextForSpeech(once)).toBe(once)
}

describe('cleanTextForSpeech 规则集（D7）', () => {
  it('围栏代码块整块删除（含语言标注行与多行内容）', () => {
    expectIdempotent(
      '前文\n```ts\nconst a = 1\nconsole.log(a)\n```\n后文',
      '前文 后文',
    )
  })

  it('波浪线围栏代码块删除；未闭合围栏删至文末', () => {
    expectIdempotent('前文\n~~~\nraw block\n~~~\n中', '前文 中')
    expectIdempotent('前文\n```\n未闭合内容一直到底', '前文')
  })

  it('行内代码整段删除（含反引号）', () => {
    expectIdempotent('调用 `pkg.fn(arg)` 完成初始化', '调用 完成初始化')
  })

  it('GFM 表格整块删除（表头 + 分隔行 + 数据行）', () => {
    expectIdempotent(
      '结论如下\n\n| 名称 | 值 |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n\n表格之后正文',
      '结论如下 表格之后正文',
    )
  })

  it('孤立竖线行不误删（无分隔行配对不成表）', () => {
    expectIdempotent('管道符号 | 在正文中保留', '管道符号 | 在正文中保留')
  })

  it('图片保 alt 文本去 URL', () => {
    expectIdempotent('架构图 ![系统架构图](https://example.com/a.png) 如上', '架构图 系统架构图 如上')
  })

  it('链接保显示文本去 URL（inline 与引用式）', () => {
    expectIdempotent('详见 [官方文档](https://example.com/docs) 与 [镜像][ref]', '详见 官方文档 与 镜像')
  })

  it('链接包图片两步归一到 alt（[![alt](img)](link) 形态）', () => {
    expectIdempotent('[![封面图](https://e.com/c.png)](https://e.com/post)', '封面图')
  })

  it('HTML 标签删标记保内容；注释整段删除', () => {
    expectIdempotent('这是 <b>加粗</b> 与 <a href="https://e.com">链接文字</a>', '这是 加粗 与 链接文字')
    expectIdempotent('前<!-- 注释内容 -->后', '前后')
  })

  it('标题/列表/引用标记删除保内容（ATX 标题、无序/有序列表、嵌套引用）', () => {
    expectIdempotent('# 一级标题\n## 二级标题', '一级标题 二级标题')
    expectIdempotent('- 项目一\n* 项目二\n+ 项目三\n1. 第一步\n2) 第二步', '项目一 项目二 项目三 第一步 第二步')
    expectIdempotent('> 引用一句\n>> 嵌套引用', '引用一句 嵌套引用')
  })

  it('正文行首数字 + 点号非列表标记不误删（3.14 保留）', () => {
    expectIdempotent('圆周率 3.14 是近似值', '圆周率 3.14 是近似值')
  })

  it('LaTeX 段删除（$$ 块级含跨行、\\( \\) 与 \\[ \\] 定界）', () => {
    expectIdempotent('质能方程 $$E = mc^2$$ 如上', '质能方程 如上')
    expectIdempotent('块级公式\n$$\na^2 + b^2 = c^2\n$$\n结束', '块级公式 结束')
    expectIdempotent('行内 \\(x^2\\) 与显示 \\[y^2\\] 公式', '行内 与显示 公式')
  })

  it('emoji 删除（含变体选择符与零宽连接符不残留）', () => {
    const out = cleanTextForSpeech('任务完成 ✅ 请查看 👍‍👍 详情')
    expect(out).toBe('任务完成 请查看 详情')
    expectIdempotent('状态 ✅️ 更新', '状态 更新')
  })

  it('连续空白压缩为单空格并去首尾（换行/制表/多空格）', () => {
    expectIdempotent('  第一段\n\n\n第二段\t\t续  ', '第一段 第二段 续')
  })

  it('整条回复只有代码块 → 空串（tts_empty_text 判定依据）', () => {
    expectIdempotent('```bash\nls -la\n```', '')
  })

  it('混合输入端到端（标题 + 段落 + 行内代码 + 表格 + 链接 + emoji）', () => {
    expectIdempotent(
      [
        '# 部署结论',
        '',
        '服务已上线 `v2` 版本 🎉',
        '',
        '| 指标 | 值 |',
        '| --- | --- |',
        '| QPS | 120 |',
        '',
        '详见 [运行手册](https://e.com/run)，注意 `kubectl` 命令。',
      ].join('\n'),
      '部署结论 服务已上线 版本 详见 运行手册，注意 命令。',
    )
  })
})
