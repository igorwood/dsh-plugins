/**
 * Host half of the AI session rename plugin.
 *
 * Exposes one operation — "generate a session title from the conversation with
 * AI and optionally apply it" — to two callers:
 *
 * - the client `ai-rename` command, which the rename dialog executes through
 *   `ctx.remote.commands.execute()` and whose result returns the new title;
 * - the `ai_rename_session` agent tool, which lets the model do the same.
 *
 * Both callers share {@link generateTitle} and `ctx.sessionTitle.rename()`, so
 * there is no second operation path.
 *
 * @module @local/ai-session-rename
 */

import { describeError, generateTitle, summarizeConversation } from './lib/title.js';

/** Required Host services. */
export const inject = ['agents', 'commands', 'llm', 'sessionTitle', 'tools'];

/** Slash command the rename dialog executes. */
const COMMAND_NAME = 'ai-rename';
/** Agent tool name. */
const TOOL_NAME = 'ai_rename_session';

/** Localized, model-facing command description. */
const COMMAND_DESCRIPTION = 'AI 重命名会话：根据当前对话内容生成不超过 12 个汉字的标题并应用。';

/** Model-facing tool description. */
const TOOL_DESCRIPTION = [
  'Summarize a session conversation with AI, then generate a title from that summary and optionally apply it.',
  'action=summarize returns the conversation summary;',
  'action=generate returns the generated title without renaming;',
  'action=apply generates a title and renames the current session;',
  'action=set renames the current session with the given title;',
  'action=current returns the current title.',
  'session_id targets another live session; omit it for the current session.',
  'AI titles are at most 12 Chinese characters.',
].join(' ');

/** Parameter schema for {@link TOOL_NAME}. */
const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['generate', 'apply', 'set', 'current', 'summarize'],
      description: 'Operation to perform.',
    },
    title: {
      type: 'string',
      description: 'Explicit title for action=set.',
    },
    session_id: {
      type: 'string',
      description: 'Target live session id; defaults to the current session.',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

/**
 * Install the shared command and tool.
 * @param {object} ctx - owning Cordis plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.commands.register({
      name: COMMAND_NAME,
      description: COMMAND_DESCRIPTION,
      handler: async (invocation) => {
        const session = invocation?.agent?.session;
        if (session === undefined || session === null) {
          return { kind: 'error', text: '无法获取当前会话' };
        }
        try {
          const title = await generateTitle(ctx, session, invocation.signal);
          ctx.sessionTitle.rename(session, title);
          return { kind: 'success', text: title };
        } catch (error) {
          return { kind: 'error', text: describeError(error) };
        }
      },
    }),
    'ai-session-rename: ai-rename command',
  );

  ctx.effect(
    () => ctx.tools.register({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: TOOL_PARAMETERS,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const targetId = typeof args?.session_id === 'string' && args.session_id !== '' ? args.session_id : undefined;
        const session = targetId === undefined
          ? (exec?.agent?.session ?? ctx.agents.currentInitiator()?.session)
          : ctx.agents.get(targetId)?.session;
        if (session === undefined || session === null) {
          throw new Error(targetId === undefined ? '当前没有可用的会话' : `会话 ${targetId} 未打开或不存在`);
        }
        const action = typeof args?.action === 'string' ? args.action : 'generate';

        if (action === 'summarize') {
          const summary = await summarizeConversation(ctx, session, exec?.signal);
          return `会话总结：${summary}`;
        }

        if (action === 'current') {
          const snapshot = ctx.sessionTitle.get(session);
          return snapshot === undefined ? '（会话还没有标题）' : snapshot.title;
        }

        if (action === 'set') {
          // An explicit user title is not an AI-generated one, so it keeps its
          // full length; the title service owns the byte cap.
          const title = typeof args?.title === 'string' ? args.title.trim() : '';
          if (title === '') throw new Error('title 为空或不是有效的标题');
          ctx.sessionTitle.rename(session, title);
          return `已重命名为「${title}」`;
        }

        const title = await generateTitle(ctx, session, exec?.signal);
        if (action === 'generate') return `AI 生成的标题：${title}`;
        if (action === 'apply') {
          ctx.sessionTitle.rename(session, title);
          return `已用 AI 重命名为「${title}」`;
        }
        throw new Error(`未知 action：${String(action)}`);
      },
    }),
    'ai-session-rename: ai_rename_session tool',
  );
}
