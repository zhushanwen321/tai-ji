// src/validate.ts
import { HEADER_MAX_CHARS, type InputQuestion, OTHER_LABEL, QUESTION_MAX_CHARS } from "./types";

/** 控制字符（含 \n \r \t 等）：question 文本禁止包含，避免 answers key 含不可见字符（spec FR-2） */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/** 错误消息里 question/header 文本预览的截断长度（避免长文本撑爆错误消息）。 */
const ERROR_PREVIEW_CHARS = 20;

/**
 * 校验输入参数。通过返回 null，失败返回错误消息字符串。
 *
 * 入参类型是宽松的 InputQuestion[]（options 元素可能是 string 误用）——见 types.ts
 * InputSchema 注释。Pi 运行时只放宽到让 string options 能进到这里被友好拦截；这里先
 * 预检 string options，再跑原有结构/语义校验。
 *
 * 校验项（spec FR-2）：
 * - options 元素必须是 {label, description} 对象，不能是 string（弱模型高频误用）
 * - question 文本长度上限与无控制字符（保证 answers key 有界、可预测）
 * - question 文本在数组内唯一
 * - option label 不得为保留字 Other（trim 后精确匹配）——Other 自由输入行由 extension
 *   自动追加，LLM 自带会在渲染层产生同名双行（M23）
 * - 同问题内 option label 唯一
 * - 多问题（questions.length > 1）时每个 question 必须有非空 header
 *
 * 错误消息面向 LLM：除描述违规外，附带一句修复指引（如何改），对结构误用附 Correct 正例。
 *
 * 主函数只留编排：逐 question 依序跑「文本 → 唯一性 → option labels」，再跑
 * 多问题 header 校验与 header 长度校验。各阶段提取为独立 helper（?? 链按序短路求值，
 * 与原 early-return 顺序一致）。校验顺序即错误优先级，不可调换。
 */
export function validateInput(questions: InputQuestion[]): string | null {
	const seenQuestions = new Set<string>();

	for (const q of questions) {
		const qt = q.question;
		const perQuestionError =
			checkQuestionText(qt) ??
			checkDuplicateQuestion(qt, seenQuestions) ??
			checkOptionLabels(qt, q.options);
		if (perQuestionError) return perQuestionError;
	}

	return checkMultiQuestionHeaders(questions) ?? checkHeaderLengths(questions);
}

/** 1a. question 文本长度上限（key 有界）；1b. 无控制字符（key 可预测，不影响下游渲染/解析）。 */
function checkQuestionText(qt: string): string | null {
	if (qt.length > QUESTION_MAX_CHARS) {
		return `Question text exceeds ${QUESTION_MAX_CHARS} chars: "${qt.slice(0, ERROR_PREVIEW_CHARS)}...". Shorten it to a single concise decision; move extra context into the context field.`;
	}
	if (CONTROL_CHAR_RE.test(qt)) {
		return `Question text must not contain control characters (incl. newlines): "${qt.slice(0, ERROR_PREVIEW_CHARS)}...". Use plain single-line text; split multi-part questions into separate entries.`;
	}
	return null;
}

/** 1c. question 文本唯一。未重复时登记到 seenQuestions（调用方依赖此副作用）。 */
function checkDuplicateQuestion(qt: string, seenQuestions: Set<string>): string | null {
	if (seenQuestions.has(qt)) {
		return `Duplicate question: "${qt}". Each question text must be unique; merge duplicates or rephrase one to differ.`;
	}
	seenQuestions.add(qt);
	return null;
}

/**
 * 2. option 元素必须是 {label, description} 对象，不能是 string。
 *    弱模型最高频误用："options":["A","B"]。schema 层已放宽让 string 进来，这里友好拦截
 *    （InputQuestion.options 是 (Option | string)[]，typeof 收窄后 opt 为 Option）。
 */
function checkOptionLabels(qt: string, options: InputQuestion["options"]): string | null {
	const seenLabels = new Set<string>();
	for (const opt of options) {
		if (typeof opt === "string") {
			return `Options for question "${qt}" must be an array of {label, description} objects, not strings. Correct: "options":[{"label":"A","description":"..."},{"label":"B","description":"..."}]`;
		}
		// opt 已收窄为 Option
		if (opt.label.trim() === "") {
			return `Option label must not be empty in question "${qt}". Give every option a distinct, descriptive label.`;
		}
		// 保留字 Other（trim 口径：带空白变体与合成 Other 行视觉不可分辨，同样要拦）——
		// 两条渲染路径都会无条件追加合成 Other 自由输入行，LLM 自带的 "Other" 选项会与它
		// 同名并存：一行是普通选项、一行是自由输入，UI 自相矛盾且答案通道歧义（M23）。
		if (opt.label.trim() === OTHER_LABEL) {
			return `Option label "${OTHER_LABEL}" is reserved in question "${qt}" — the Other free-text option is added automatically. Remove it; to offer a catch-all choice, rely on the built-in Other, or rename the option (e.g. "Other database").`;
		}
		if (seenLabels.has(opt.label)) {
			return `Duplicate option label "${opt.label}" in question "${qt}". Options must be mutually exclusive — reword one so each label maps to a distinct choice.`;
		}
		seenLabels.add(opt.label);
	}
	return null;
}

/**
 * 3. 多问题时 header 必填且非空；S3: header 唯一——重复 header 会导致 askUserKey 碰撞，
 * 后一个 question 的 __other 覆盖前一个（协议 helper 用 header 作 answers 读取 key）。
 */
function checkMultiQuestionHeaders(questions: InputQuestion[]): string | null {
	if (questions.length > 1) {
		for (const q of questions) {
			if (!q.header || q.header.trim() === "") {
				return `Question "${q.question}" requires a non-empty header in multi-question mode (it labels the tab). Provide a header of <=12 chars. Correct: {"header":"DB","question":"...","options":[{"label":"...","description":"..."}]}`;
			}
		}

		const seenHeaders = new Set<string>();
		for (const q of questions) {
			const h = q.header!.trim();
			if (seenHeaders.has(h)) {
				return `Duplicate header "${h}" in questions. Headers must be unique in multi-question mode — shared headers cause answer key collisions (one question's Other overwrites another's). Rephrase one header to differ.`;
			}
			seenHeaders.add(h);
		}
	}
	return null;
}

/**
 * 4. header 长度上限（若提供）。单/多问题均校验：超出会在 tab 栏被静默截断，
 * 这里提前拒绝，让 LLM 拿到可修复错误而非残缺 UI（兑现 schema description 的 ≤12 契约）。
 */
function checkHeaderLengths(questions: InputQuestion[]): string | null {
	for (const q of questions) {
		if (q.header !== undefined && q.header.length > HEADER_MAX_CHARS) {
			return `Header exceeds ${HEADER_MAX_CHARS} chars: "${q.header.slice(0, ERROR_PREVIEW_CHARS)}..." in question "${q.question}". Shorten it; longer headers are truncated in the tab bar.`;
		}
	}
	return null;
}
