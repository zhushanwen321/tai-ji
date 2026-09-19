/**
 * Markdown 渲染管线净化层（html:true 后的 XSS 主防线，设计 markdown-html-sanitize-render D1-D3）。
 *
 * 分通道机制（D3）：可信 renderer 输出（fence/math/code_inline/md_trusted_inline 的
 * shiki/KaTeX/md-* 契约）在 md.render 期「摘出」进 env 信任槽、以 nonce 哨兵占位；
 * 整串经 DOMPurify 两级白名单净化后「回填」——用户内容构造性拿不到 class/style/data-*
 * （伪造 md-filepath/md-codeblock 交互借用通道不成立），可信输出构造性不过白名单
 * （KaTeX 的 57 class/布局 style、shiki 的 --shiki-* style 不再依赖属性枚举）。
 *
 * 两级白名单 = hast-util-sanitize defaultSchema（GitHub 风格 sanitation）翻译：
 * - 标签 = defaultSchema tagNames（去 input——taiji 管线无 GFM task-list 的
 *   `<input checkbox>` 产出面）；
 * - 属性 = defaultSchema 属性表翻译（全局 '*' 表 + 按标签项合并为 DOMPurify 平面白名单；
 *   className 值级项与 data-* 脚注属性不翻译——class/data-* 构造性全剥是 D1 裁决）；
 * - URI = DOMPurify 默认 ALLOWED_URI_REGEXP，不自定义（R8 裁决）：默认正则的
 *   「无协议头形态（相对 URL）放行」分支是图片重写/相对链接分流的前提，按 D1 协议
 *   清单字面直译正则会剥掉全部相对 URL。
 *
 * 降级契约：sanitize/回填任何异常（含回填完整性断言失败）由 renderMarkdown 的 catch
 * 接住，转义全文为纯文本返回 + console.error 出声——渲染不中断，出声优于静默丢内容。
 */
import DOMPurify from 'dompurify'

/**
 * 信任槽键：模块内 Symbol。不进 MarkdownEnv 公开类型（既有字段全是「调用方输入」，
 * 信任槽是管线内部自产自销，语义方向相反；Symbol 键天然不随类型镜像/序列化泄漏，
 * 也不参与增量轴的 env 签名——否则前缀缓存每帧失效）。
 */
export const TRUST_SLOT = Symbol('taiji.md.trust')

/** 信任槽载荷：store[i] 与哨兵 i 一一对应；nonce 每次 renderMarkdown 调用刷新 */
interface TrustStore {
  store: string[]
  nonce: string
}

/** env 上信任槽的携带形态（内部协议，markdown.ts 收窄用；不并入 MarkdownEnv） */
export type TrustCarrier = { [TRUST_SLOT]?: TrustStore }

/** nonce 的进制基数（base36：[a-z0-9]，与哨兵字符集 [A-Za-z0-9-] 兼容） */
const NONCE_RADIX = 36

/** per-call nonce：crypto 随机 32bit（base36 表示）。用户不可预测 → 哨兵不可伪造 */
function newNonce(): string {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0].toString(NONCE_RADIX)
}

/**
 * 信任槽重置（renderMarkdown 入口无条件调用）。调用方复用同一 env 对象时，
 * 上次调用的 store/nonce 不泄漏进本次；增量轴同 env 多段顺序渲染也依赖此重置
 * ——每段独立 nonce，无跨段哨兵依赖。
 */
export function resetTrustSlot(env: unknown): void {
  ;(env as TrustCarrier)[TRUST_SLOT] = { store: [], nonce: newNonce() }
}

/**
 * 摘出可信 HTML 段，返回哨兵占位（字符集 [A-Za-z0-9-]——纯字母数字文本节点，
 * DOMPurify 原样保留、回填正则无 HTML 特殊字符歧义）。
 * 哨兵 = "TJMD" + nonce + "-" + i + "END"。
 */
export function stashTrusted(env: unknown, html: string): string {
  const carrier = env as TrustCarrier
  let trust = carrier[TRUST_SLOT]
  if (!trust) {
    // 正常路径 renderMarkdown 入口必然已重置；此兜底覆盖绕过入口的直调（哨兵仍可被
    // 后续 sanitizeAndRestore 回填——同一 env 对象上的槽双向一致）
    trust = { store: [], nonce: newNonce() }
    carrier[TRUST_SLOT] = trust
  }
  trust.store.push(html)
  return `TJMD${trust.nonce}-${trust.store.length - 1}END`
}

/**
 * 标签白名单：hast-util-sanitize defaultSchema tagNames 翻译（52 项 = 53 项去 input）。
 * 不含 script/style/link/iframe/form/svg/math/button/input。
 */
const ALLOWED_TAGS = [
  'a', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'ol', 'p',
  'picture', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'source', 'span',
  'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'tt', 'ul', 'var',
]

/**
 * 属性白名单 = defaultSchema 属性表翻译：
 * - 全局 '*' 表（66 项，hast 驼峰属性名转 HTML 连字符小写形式，如 colSpan → colspan）；
 * - 按标签项去 class/data-* 后并入：href（a）、cite（blockquote/del/ins/q）、
 *   itemscope/itemtype（div）、aria 三项（a/dl/img/ol/summary/table/ul 的
 *   ariaDescribedBy/Label/LabelledBy）、longdesc/src（img）、srcset（source）。
 * target/rel 在全局表内（defaultSchema 原生含）——markdown 链接 link_open 注入的非用户
 * 属性经白名单存活。不含 class/style/任意 data-*。
 */
const ALLOWED_ATTR = [
  // ── defaultSchema attributes['*'] ──
  'abbr', 'accept', 'accept-charset', 'accesskey', 'action', 'align', 'alt', 'axis',
  'border', 'cellpadding', 'cellspacing', 'char', 'charoff', 'charset', 'checked',
  'clear', 'colspan', 'color', 'cols', 'compact', 'coords', 'datetime', 'dir',
  'disabled', 'enctype', 'frame', 'hspace', 'headers', 'height', 'hreflang', 'for',
  'id', 'ismap', 'itemprop', 'label', 'lang', 'maxlength', 'media', 'method',
  'multiple', 'name', 'nohref', 'noshade', 'nowrap', 'open', 'prompt', 'readonly',
  'rel', 'rev', 'rowspan', 'rows', 'rules', 'scope', 'selected', 'shape', 'size',
  'span', 'start', 'summary', 'tabindex', 'target', 'title', 'usemap', 'valign',
  'value', 'width',
  // ── defaultSchema 按标签项（class/data-* 不翻译）──
  'cite', 'itemscope', 'itemtype', 'longdesc', 'src', 'srcset', 'href',
  'aria-describedby', 'aria-label', 'aria-labelledby',
]

const SANITIZE_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  // data-* 构造性全剥（D1）。必须显式 false：DOMPurify 的 ALLOW_DATA_ATTR 默认 true 且
  // 判定优先于 ALLOWED_ATTR 白名单（dompurify 3.4.11 _isValidAttribute 实装核实），
  // 不关掉则任意 data-* 越过白名单放行——伪造 data-path/data-code 交互借用通道复活。
  ALLOW_DATA_ATTR: false,
  // aria 面收窄为白名单显式三项（defaultSchema 仅放行 3 个 aria 属性；默认 true 放行全部 aria-*）
  ALLOW_ARIA_ATTR: false,
  // KEEP_CONTENT / SANITIZE_DOM / FORBID_CONTENTS / ALLOWED_URI_REGEXP 均用默认值：
  // - KEEP_CONTENT=true：剥标签留内容（marquee 形态哨兵存活，正常回填）；
  // - SANITIZE_DOM=true：DOM clobbering 防线（id/name 覆写 document 属性拦截）；
  // - FORBID_CONTENTS 默认连删集（xmp/template/noscript/script 等）——哨兵连带销毁
  //   回归测试的对象，不可覆盖；
  // - URI 见文件头注释（默认正则，相对 URL 放行）。
}

// afterSanitizeAttributes 双职责 hook（D4 单点；U1 只落 a 补齐职责，img 相对 src 重写
// 由 U3 的 resourceBaseDir 通道在本 hook 内扩展）：
// a 补齐（R10 覆盖条件收紧）：target 非 _blank 一律覆盖为 _blank+noopener——「无 target
// 才补」会被用户显式 _self/_parent/_top 绕过（同窗导航面正是要消灭的对象，安全优先于
// 排版意图）；统一走 setWindowOpenHandler（http(s) 经 openExternal 开浏览器，其余 deny 惰性）。
// markdown 语法链接（link_open 规则）注入的 target 恒 _blank，不会被覆盖。
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('target') !== '_blank') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener')
  }
})

/**
 * 净化 + 回填 + 完整性断言（renderMarkdown 出口调用，D2：净化点在最终输出整串——
 * mXSS 防御要求用户段整串 DOM 往返，唯一入口覆盖全部消费面）。
 *
 * 完整性断言（D3）：store 全部消费 + 输出无哨兵残留，违反抛错由调用方 catch 降级。
 * 覆盖「哨兵被 sanitize 连带销毁」形态：公式哨兵落进 FORBID_CONTENTS 连删元素
 * （xmp/template/noscript/script）内容内连删，replace 静默不匹配 → 公式静默丢失；
 * 降级出声优于静默丢内容。残留扫描锚定本次 nonce——store 内容（shiki 高亮的代码
 * 文本）可能含哨兵「形态」字符串，宽松形态匹配会把可信文本误判为残留（R5）。
 *
 * @throws 环境缺 DOM API（isSupported=false 时 sanitize 会原样返回脏串——主动拒绝，
 *   走降级而非静默绕过净化）/ 回填完整性断言失败
 */
export function sanitizeAndRestore(html: string, env: unknown): string {
  if (!DOMPurify.isSupported) {
    throw new Error('DOMPurify unsupported (no DOM API) — refusing unsanitized output')
  }
  const trust = (env as TrustCarrier)[TRUST_SLOT]
  const sanitized = DOMPurify.sanitize(html, SANITIZE_CONFIG)
  if (!trust || trust.store.length === 0) return sanitized

  const sentinelRe = new RegExp(`TJMD${trust.nonce}-(\\d+)END`, 'g')
  const consumed = new Set<number>()
  // 函数形态 replace：单遍替换不重扫（store 内容含哨兵形态文本不会被二次替换），
  // 且 replacement 中的 $& 等特殊序列按字面插入
  const restored = sanitized.replace(sentinelRe, (match, digits: string) => {
    const i = Number(digits)
    if (!Number.isInteger(i) || i < 0 || i >= trust.store.length) return match
    consumed.add(i)
    return trust.store[i] ?? match
  })

  const residualRe = new RegExp(`TJMD${trust.nonce}-\\d+END`)
  const residual = residualRe.test(restored)
  if (consumed.size !== trust.store.length || residual) {
    throw new Error(
      `[markdown-sanitize] trusted-fragment backfill incomplete: consumed ${consumed.size}/${trust.store.length}, residual=${residual}. ` +
        'Sentinel likely destroyed by sanitization (content inside removed elements). ' +
        'Recovery: renderMarkdown degrades this message to escaped plain text.',
    )
  }
  return restored
}
