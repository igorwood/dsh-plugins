window.__ModuleLoader__.load({
  id: '@local/ai-session-rename',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'aiSessionRename';
    /** Host command that generates and applies a title. */
    const COMMAND_NAME = 'ai-rename';
    /** Context-menu icon key owned by this plugin. */
    const ICON_KEY = 'ai.session-rename';
    /** How long a failure notice stays on screen. */
    const NOTICE_DURATION_MS = 6000;

    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      'menu.aiRename': 'AI重命名',
      'notice.aria': 'AI 重命名提示',
      'error.generic': '操作失败',
      'error.commandUnavailable': 'AI 重命名服务不可用，请稍后重试',
      'error.emptyTitle': 'AI 没有生成有效的标题',
    };

    /** English dictionary, complete against the zh key set. */
    const en = {
      'menu.aiRename': 'AI Rename',
      'notice.aria': 'AI rename notice',
      'error.generic': 'Something went wrong',
      'error.commandUnavailable': 'AI rename service is unavailable, please try again later',
      'error.emptyTitle': 'The AI did not produce a valid title',
    };

    /** Minimal observable store shared by a menu action and its overlay notice. */
    function createStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set(next) {
          value = next;
          for (const listener of [...listeners]) listener();
        },
      };
    }

    /** Notice styling: a small transient line at the bottom, host tokens only. */
    const CSS_TEXT = `
.asrn-notice{pointer-events:auto;position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:1200;box-sizing:border-box;max-width:min(560px,calc(100vw - 48px));padding:10px 14px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);border:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px;cursor:pointer}
`;

    /** @returns {string} a human-readable error message. */
    function toMessage(reason) {
      if (reason instanceof Error) return reason.message;
      if (typeof reason === 'string') return reason;
      if (reason !== null && typeof reason === 'object' && typeof reason.message === 'string') return reason.message;
      return String(reason);
    }

    /** Context-menu glyph for the "AI重命名" row. */
    function AiRenameMenuIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M8 1.5l1.35 3.65L13 6.5 9.35 7.85 8 11.5 6.65 7.85 3 6.5l3.65-1.35L8 1.5Z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M12.5 10.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z',
          fill: 'currentColor',
          opacity: '0.75',
        }),
      );
    }

    /** Chat row renderer that hides the internal `/ai-rename` command receipt. */
    function AiRenameCommandRow() {
      return null;
    }

    /** Transient failure notice; nothing renders while no notice is pending. */
    function AiRenameNotice({ useNotice, settleNotice, t }) {
      const notice = useNotice((value) => value);
      React.useEffect(() => {
        if (notice === null) return undefined;
        const timer = setTimeout(settleNotice, NOTICE_DURATION_MS);
        return () => {
          clearTimeout(timer);
        };
      }, [notice, settleNotice]);
      if (notice === null) return null;
      return h(
        'div',
        {
          className: 'asrn-notice',
          role: 'status',
          'aria-live': 'polite',
          'aria-label': t('notice.aria'),
          'data-ai-session-rename-notice': '',
          onClick: settleNotice,
        },
        h('style', null, CSS_TEXT),
        notice.message,
      );
    }

    /** Required client services. */
    const inject = ['contextMenus', 'locale', 'remote', 'remote.commands', 'remoteAccess', 'sessions', 'slots'];

    /**
     * Client plugin body: dictionaries, the session-menu row, its icon, the
     * hidden command receipt, and the failure notice.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      const notice = createStore(null);

      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'ai-session-rename: dictionaries',
      );

      const generateTitle = async (sessionId) => {
        const response = await ctx.remote.commands.execute(sessionId, `/${COMMAND_NAME}`, []);
        if (response === null || typeof response !== 'object') throw new Error(t('error.commandUnavailable'));
        if (response.ok !== true) throw new Error(response.error?.message ?? t('error.commandUnavailable'));
        const execution = response.value;
        if (execution === undefined || execution === null) throw new Error(t('error.commandUnavailable'));
        const outcome = execution.result;
        if (outcome === undefined || outcome === null) throw new Error(t('error.commandUnavailable'));
        if (outcome.kind === 'error') throw new Error(outcome.text === undefined ? t('error.generic') : outcome.text);
        const title = typeof outcome.text === 'string' ? outcome.text.trim() : '';
        if (title === '') throw new Error(t('error.emptyTitle'));
        return title;
      };

      /** Run the AI rename directly; failures surface as a transient notice. */
      const aiRename = async (sessionId) => {
        try {
          await generateTitle(sessionId);
          try {
            await ctx.sessions.refreshProjections(sessionId);
          } catch {
            // The Host already appended `session/title`; the projection frame follows.
          }
        } catch (reason) {
          notice.set({ message: toMessage(reason), at: Date.now() });
        }
      };

      ctx.slots.inject('contextMenu.icon', () => ctx.slots.register(
        { name: 'contextMenu.icon', key: ICON_KEY },
        AiRenameMenuIcon,
      ));

      ctx.effect(() => ctx.contextMenus.register({
        id: 'session.ai-rename',
        target: 'session',
        order: 250,
        observe: ({ sessionId }) => [
          ctx.locale,
          ctx.remoteAccess.source('session', sessionId, 'session/rename'),
        ],
        resolve: (target) => {
          const allowed = ctx.remoteAccess.source('session', target.sessionId, 'session/rename').getSnapshot();
          if (!allowed) return [];
          return [{
            id: 'ai-rename',
            label: t('menu.aiRename'),
            icon: { key: ICON_KEY },
            run: () => {
              void aiRename(target.sessionId);
            },
          }];
        },
      }), 'ai-session-rename: session menu');

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'ai-session-rename-notice',
        locale: NS,
        inject: () => ({
          hooks: { notice },
          settleNotice: () => notice.set(null),
        }),
      }, AiRenameNotice));

      ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register(
        { name: 'conversation.chat.commandview', key: COMMAND_NAME },
        AiRenameCommandRow,
      ));
    }

    return { inject, apply };
  },
});
