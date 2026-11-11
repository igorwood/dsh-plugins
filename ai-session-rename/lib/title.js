/**
 * Pure title helpers plus the two-step LLM pipeline shared by the `ai-rename`
 * command and the `ai_rename_session` tool:
 *
 * 1. summarize the session conversation with one auxiliary model call;
 * 2. name the session with a second auxiliary call that sees only that summary.
 *
 * Nothing here touches the filesystem; the only Host services used are
 * `ctx.llm` (auxiliary model calls) and `ctx.agentDefaultModel` as a route
 * fallback.
 *
 * @module @local/ai-session-rename/title
 */

/** Hard cap for an AI-generated title, in Unicode code points (汉字). */
export const MAX_TITLE_CHARS = 12;
/** Cap for the conversation excerpt sent to the summarizer. */
export const MAX_INPUT_CHARS = 6000;
/** Output budget for the summary call. */
export const SUMMARY_OUTPUT_TOKENS = 1024;
/** Output budget for the title call. */
export const MAX_OUTPUT_TOKENS = 2048;
/** Cap for the stored summary text before it feeds the title call. */
export const MAX_SUMMARY_CHARS = 800;

/** Model-facing instructions for the summary request. */
export const SUMMARY_SYSTEM_PROMPT = [
  '你是一个会话总结助手。',
  '根据用户提供的会话内容，用简洁、准确的中文总结这段会话。',
  '总结需要包含：用户想做什么、已经完成或得出的关键结论与产出、当前进行到什么状态。',
  '要求：不超过 200 个汉字；只输出总结正文，不要标题、序号、前缀或解释。',
].join('\n');

/** Model-facing instructions for the title request. */
export const SYSTEM_PROMPT = [
  '你是一个会话标题生成器。',
  '根据用户提供的会话总结，生成一个简洁、准确、有辨识度的中文标题。',
  '要求：',
  '1. 标题最多 12 个汉字，尽量在 6 到 12 个汉字之间；',
  '2. 只输出标题本身，不要引号、标点、序号、前缀、解释或换行；',
  '3. 不要使用“会话”“对话”“聊天”等空泛词汇，除非内容确实如此；',
  '4. 用具体的任务、对象或主题命名，例如“Kaggle 内核状态插件”。',
].join('\n');

/**
 * Strip decoration the model may add and enforce the 12-character cap.
 * @param {unknown} raw - raw model output or an explicit title.
 * @returns {string} the normalized title, possibly empty.
 */
export function normalizeTitle(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u0000/g, '')
    .trim();
  // Drop a fenced code block wrapper when the model wrapped the title.
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced !== null) text = fenced[1];
  // Drop an explicit "标题：" / "Title:" prefix.
  text = text.replace(/^\s*(?:会话)?标题\s*[:：]\s*/u, '');
  text = text.replace(/^\s*title\s*[:：]\s*/i, '');
  // Drop wrapping quotes/brackets.
  text = text
    .replace(/^["'“”‘’「」『』《》〈〉]+/u, '')
    .replace(/["'“”‘’「」『』《》〈〉]+$/u, '');
  // Peel wrapping quotes and trailing punctuation in any nesting order.
  for (let pass = 0; pass < 3; pass += 1) {
    text = text.replace(/[。．.!！?？,，;；:：、·…~～]+$/u, '').trim();
    const before = text;
    text = text
      .replace(/^["'“”‘’「」『』《》〈〉]+/u, '')
      .replace(/["'“”‘’「」『』《》〈〉]+$/u, '')
      .trim();
    if (text === before) break;
  }
  // Collapse all whitespace runs (including newlines) to one space.
  text = text.replace(/\s+/gu, ' ').trim();
  // Enforce the code-point cap without splitting a surrogate pair.
  let chars = Array.from(text);
  if (chars.length > MAX_TITLE_CHARS) chars = chars.slice(0, MAX_TITLE_CHARS);
  text = chars.join('').replace(/\s+$/u, '').replace(/[。．.!！?？,，;；:：、·…~～]+$/u, '').trim();
  return text;
}

/**
 * Clean and bound a model-produced summary.
 * @param {unknown} raw - raw model output.
 * @returns {string} the normalized summary, possibly empty.
 */
export function normalizeSummary(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u0000/g, '')
    .trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced !== null) text = fenced[1];
  text = text.replace(/^\s*(?:会话)?总结\s*[:：]\s*/u, '').trim();
  text = text.replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim();
  const chars = Array.from(text);
  return chars.length > MAX_SUMMARY_CHARS ? chars.slice(0, MAX_SUMMARY_CHARS).join('').trim() : text;
}

/**
 * Read one message's plain text, dropping reasoning, tool-call, and image blocks.
 * @param {unknown} message - derived Session message.
 * @returns {string} the message text.
 */
function messageText(message) {
  if (message === null || typeof message !== 'object') return '';
  const content = Array.isArray(message.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/**
 * Build a bounded transcript excerpt from a Session's derived messages.
 * @param {object} session - live Session with `deriveMessages()`.
 * @param {number} maxChars - excerpt character cap.
 * @returns {string} `用户：…` / `助手：…` lines, or an empty string.
 */
export function collectConversation(session, maxChars = MAX_INPUT_CHARS) {
  const messages = session !== null && typeof session === 'object' && typeof session.deriveMessages === 'function'
    ? session.deriveMessages()
    : [];
  const parts = [];
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = messageText(message);
    if (text === '') continue;
    parts.push(`${message.role === 'user' ? '用户' : '助手'}：${text}`);
  }
  if (parts.length === 0) return '';
  const selected = parts.length <= 8 ? parts : [parts[0], ...parts.slice(-6)];
  let joined = selected.join('\n\n');
  if (joined.length > maxChars) joined = Array.from(joined).slice(0, maxChars).join('');
  return joined;
}

/**
 * Frame the transcript excerpt as the summarizer's user message.
 * @param {string} conversation - excerpt from {@link collectConversation}.
 * @returns {string} the prepared user input.
 */
export function buildSummaryPrompt(conversation) {
  return [
    '下面是会话内容（节选）：',
    '',
    conversation,
    '',
    '请用简洁的中文总结这段会话：用户想做什么、关键结论或产出、当前状态。只输出总结正文。',
  ].join('\n');
}

/**
 * Frame the summary as the title request's user message.
 * @param {string} summary - normalized conversation summary.
 * @returns {string} the prepared user input.
 */
export function buildUserPrompt(summary) {
  return [
    '下面是这段会话的总结：',
    '',
    summary,
    '',
    `请据此生成一个不超过 ${MAX_TITLE_CHARS} 个汉字的标题，只输出标题。`,
  ].join('\n');
}

/**
 * Resolve the provider/model route used for the auxiliary requests.
 * @param {object} ctx - Host plugin context.
 * @param {object} session - live Session whose logged request header is preferred.
 * @returns {{ provider: string, model: string } | null} the route, or null.
 */
export function resolveRoute(ctx, session) {
  const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined;
  const config = header?.config;
  if (config !== null && typeof config === 'object'
    && typeof config.provider === 'string' && config.provider !== ''
    && typeof config.model === 'string' && config.model !== '') {
    return { provider: config.provider, model: config.model };
  }
  const fallback = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined;
  const selection = typeof fallback?.currentSelection === 'function' ? fallback.currentSelection() : undefined;
  if (selection !== null && typeof selection === 'object'
    && typeof selection.provider === 'string' && selection.provider !== ''
    && typeof selection.model === 'string' && selection.model !== '') {
    return { provider: selection.provider, model: selection.model };
  }
  return null;
}

/** @returns {string} a human-readable failure message. */
export function describeError(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message;
  return String(error);
}

/**
 * Read route metadata without failing the whole call when lookup fails.
 * @param {object} ctx - Host plugin context.
 * @param {{ provider: string, model: string }} route - resolved route.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object | undefined>} resolved model info, or undefined.
 */
async function resolveModelInfoSafe(ctx, route, signal) {
  const llm = ctx?.llm;
  if (typeof llm?.resolveModelInfo !== 'function') return undefined;
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model, signal);
    return info !== null && typeof info === 'object' ? info : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run one auxiliary model call and assemble its text.
 * @param {object} ctx - Host plugin context with `llm`.
 * @param {{ provider: string, model: string }} route - resolved route.
 * @param {string | undefined} reasoningEffort - least supported effort id.
 * @param {string} system - provider-owned system instruction.
 * @param {string} input - prepared user input.
 * @param {number} maxTokens - output budget.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<{ output: string, reasoning: string, finish: object | undefined }>} assembled result.
 */
async function runAuxiliaryCall(ctx, route, reasoningEffort, system, input, maxTokens, signal) {
  let output = '';
  let reasoning = '';
  let finish;
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
    maxTokens,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
    ...signal === undefined ? {} : { signal },
  });
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text;
    else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text;
    else if (chunk.type === 'finish') finish = chunk.reason;
  }
  if (finish !== undefined && finish !== null) {
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new Error(`生成失败：${describeError(finish.failure?.message ?? finish.kind)}`);
    }
    if (finish.kind !== 'stop' && finish.kind !== 'max-tokens') {
      throw new Error(`生成意外结束：${String(finish.kind)}`);
    }
  }
  return { output, reasoning, finish };
}

/**
 * Summarize the Session's conversation with one auxiliary model call.
 * Reasoning routes are asked with their least reasoning effort.
 * @param {object} ctx - Host plugin context with `llm`.
 * @param {object} session - live Session.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<string>} the normalized summary.
 */
export async function summarizeConversation(ctx, session, signal) {
  const conversation = collectConversation(session);
  if (conversation === '') throw new Error('这个会话还没有可用的对话内容，无法生成标题');
  const route = resolveRoute(ctx, session);
  if (route === null) throw new Error('无法确定用于生成标题的模型');
  const modelInfo = await resolveModelInfoSafe(ctx, route, signal);
  const reasoningEffort = modelInfo?.reasoning?.efforts?.[0]?.id;
  const result = await runAuxiliaryCall(
    ctx,
    route,
    reasoningEffort,
    SUMMARY_SYSTEM_PROMPT,
    buildSummaryPrompt(conversation),
    SUMMARY_OUTPUT_TOKENS,
    signal,
  );
  const summary = normalizeSummary(result.output);
  if (summary === '') {
    if (result.reasoning !== '' && result.finish?.kind === 'max-tokens') {
      throw new Error('AI 没有生成有效的会话总结（推理占满了输出预算，请重试）');
    }
    throw new Error('AI 没有生成有效的会话总结');
  }
  return summary;
}

/**
 * Generate one title from the Session's conversation: summarize first, then
 * name the session from that summary.
 * @param {object} ctx - Host plugin context with `llm`.
 * @param {object} session - live Session.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<string>} the normalized title.
 */
export async function generateTitle(ctx, session, signal) {
  const summary = await summarizeConversation(ctx, session, signal);
  const route = resolveRoute(ctx, session);
  if (route === null) throw new Error('无法确定用于生成标题的模型');
  const modelInfo = await resolveModelInfoSafe(ctx, route, signal);
  const reasoningEffort = modelInfo?.reasoning?.efforts?.[0]?.id;
  const result = await runAuxiliaryCall(
    ctx,
    route,
    reasoningEffort,
    SYSTEM_PROMPT,
    buildUserPrompt(summary),
    MAX_OUTPUT_TOKENS,
    signal,
  );
  const title = normalizeTitle(result.output);
  if (title === '') {
    if (result.reasoning !== '' && result.finish?.kind === 'max-tokens') {
      throw new Error('AI 没有生成有效的标题（推理占满了输出预算，请重试）');
    }
    throw new Error('AI 没有生成有效的标题');
  }
  return title;
}
