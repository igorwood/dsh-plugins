window.__ModuleLoader__.load({
  id: '@local/kaggle-kernel-status',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'kaggleKernelStatus';
    /** Session projection key registered by the Host half. */
    const PROJECTION_KEY = 'kaggleKernel';
    /** How long the just-returned status stays visible after a call settles. */
    const RESULT_FLASH_MS = 4000;
    /** A pending call older than this is treated as stale and never keeps the entry up. */
    const PENDING_STALE_MS = 30 * 60 * 1000;
    /** Portal panel placement: viewport margin and trigger gap (same as the dock's stat dialog). */
    const PANEL_MARGIN = 12;
    const PANEL_GAP = 8;
    /** Unplaced portal panel: hidden but laid out so the clamp measures real dimensions. */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };

    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      'label': 'Kaggle 内核',
      'calling': '调用中…',
      'fresh': '刚刚',
      'phase.queued': '排队中',
      'phase.running': '运行中',
      'phase.complete': '已完成',
      'phase.error': '出错',
      'phase.cancelled': '已取消',
      'phase.submitted': '已提交',
      'phase.unknown': '未知',
      'field.kernel': '内核',
      'field.phase': '状态',
      'field.op': '最近操作',
      'field.checked': '最近检查',
      'field.outputs': '输出文件',
      'field.detail': '消息',
      'field.tracked': '跟踪中的内核',
      'op.status': '状态查询',
      'op.output': '输出列表',
      'op.push': '推送',
      'op.cancel': '取消',
      'op.create': '创建会话',
      'op.list': '内核列表',
      'op.pull': '拉取代码',
      'hint': '数据来自本会话中观察到的 Kaggle 内核调用。',
    };

    /** English dictionary, complete against the zh key set. */
    const en = {
      'label': 'Kaggle kernel',
      'calling': 'Calling…',
      'fresh': 'just now',
      'phase.queued': 'Queued',
      'phase.running': 'Running',
      'phase.complete': 'Complete',
      'phase.error': 'Error',
      'phase.cancelled': 'Cancelled',
      'phase.submitted': 'Submitted',
      'phase.unknown': 'Unknown',
      'field.kernel': 'Kernel',
      'field.phase': 'Status',
      'field.op': 'Last action',
      'field.checked': 'Last checked',
      'field.outputs': 'Output files',
      'field.detail': 'Message',
      'field.tracked': 'Tracked kernels',
      'op.status': 'Status check',
      'op.output': 'Output list',
      'op.push': 'Push',
      'op.cancel': 'Cancel',
      'op.create': 'Session create',
      'op.list': 'Kernel list',
      'op.pull': 'Pull code',
      'hint': 'Derived from Kaggle kernel calls observed in this session.',
    };

    /**
     * Sibling-matched styles, copied from the dock's own `StatsPills` pill and
     * `stat-dialog` panel of `@deepseek-ai/dsh-client-ui-chat`; only
     * `--dsw-*`/`--dsh-*` theme variables are referenced, so light and dark
     * themes follow the host.
     */
    const CSS_TEXT = `
.kks-anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}
.kks-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}
.kks-pill svg{flex:none;width:14px;height:14px}
.kks-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
@media (hover:hover){.kks-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}
.kks-label{text-overflow:ellipsis;min-width:0;overflow:hidden}
.kks-sep{color:var(--dsw-alias-separator-primary);margin:0 6px}
.kks-panel{z-index:1100;box-sizing:border-box;width:max-content;min-width:min(300px,calc(100vw - 24px),var(--dsh-anchored-max-width,100vw));max-width:min(440px,calc(100vw - 24px),var(--dsh-anchored-max-width,100vw));border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;max-height:var(--dsh-anchored-max-height,none);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border:0;padding:16px;font-size:12px;line-height:18px;position:fixed;overflow:hidden auto}
.kks-title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}
.kks-title-label{align-items:center;gap:6px;min-width:0;display:inline-flex}
.kks-title-label svg{flex:none;width:14px;height:14px}
.kks-title-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}
.kks-title-value{font-variant-numeric:tabular-nums}
.kks-details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}
.kks-details dt,.kks-details dd{min-width:0;margin:0}
.kks-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}
.kks-details dd.kks-wrap{text-align:left;overflow-wrap:anywhere;white-space:pre-wrap}
.kks-hint{color:var(--dsw-alias-label-tertiary);margin:10px 0 0;font-size:11px;line-height:16px}
`;

    /** Format one timestamp as a local wall-clock time. */
    function formatClock(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
      try {
        return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
      } catch {
        return new Date(ms).toISOString().slice(11, 19);
      }
    }

    /**
     * Short freshness text for a check age, e.g. `8s`, `3m`, `2h`.
     * @param {number | null} elapsed - milliseconds since the last check, or null when unknown.
     * @param {(key: string) => string} t - namespace translate seat.
     * @returns {string} display text.
     */
    function freshnessText(elapsed, t) {
      if (typeof elapsed !== 'number' || !Number.isFinite(elapsed)) return '';
      const seconds = Math.max(0, Math.floor(elapsed / 1000));
      if (seconds < 5) return t('fresh');
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h`;
      return `${Math.floor(hours / 24)}d`;
    }

    /** Pill glyph: a kernel sheet, drawn inline with currentColor at the dock's 14px icon slot. */
    function glyph() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false' },
        h('rect', {
          x: 2.5,
          y: 2.5,
          width: 19,
          height: 19,
          rx: 5,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
        }),
        h('path', {
          d: 'M7.5 8.5h9M7.5 12h9M7.5 15.5h5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      );
    }

    /**
     * Collect the still-active pending Kaggle calls of a Session projection.
     * A call that never settled (for example an interrupted tool run) stops
     * counting after PENDING_STALE_MS so the entry cannot stay parked on screen.
     * @param {unknown} projection - `kaggleKernel` wire view, possibly absent.
     * @param {number} now - current client time.
     * @returns {object[]} pending call entries.
     */
    function pendingCallsOf(projection, now) {
      const pending =
        projection && projection.pending && typeof projection.pending === 'object'
          ? projection.pending
          : null;
      if (pending === null) return [];
      const calls = [];
      for (const callId of Object.keys(pending)) {
        const call = pending[callId];
        if (call === null || typeof call !== 'object') continue;
        if (typeof call.at === 'number' && now - call.at > PENDING_STALE_MS) continue;
        calls.push(call);
      }
      return calls;
    }

    /**
     * Dock pill that is visible only while a Kaggle kernel call is in flight
     * (plus a short flash of the returned status), and opens a trigger-anchored
     * details dialog styled like the dock's sibling stat pills. Read from the
     * `kaggleKernel` session projection.
     */
    function KaggleKernelBar({ useProjection, t }) {
      const projection = useProjection(PROJECTION_KEY);
      const [now, setNow] = React.useState(() => Date.now());
      const [open, setOpen] = React.useState(false);
      const [pos, setPos] = React.useState(null);
      const rootRef = React.useRef(null);
      const panelRef = React.useRef(null);

      const pendingCalls = pendingCallsOf(projection, now);
      const lastAt = projection && typeof projection.lastAt === 'number' ? projection.lastAt : null;
      const calling = pendingCalls.length > 0;
      const settledFor = lastAt === null ? null : now - lastAt;
      const justSettled = settledFor !== null && settledFor >= 0 && settledFor < RESULT_FLASH_MS;

      const order = projection && Array.isArray(projection.order) ? projection.order : null;
      const kernels =
        projection && projection.kernels && typeof projection.kernels === 'object'
          ? projection.kernels
          : null;
      const latest = order && kernels && order.length > 0 ? kernels[order[0]] ?? null : null;
      const pendingCall = pendingCalls[0] ?? null;
      const placeholder =
        pendingCall === null
          ? null
          : {
              id: typeof pendingCall.id === 'string' && pendingCall.id !== '' ? pendingCall.id : '—',
              phase: 'unknown',
              detail: null,
              op: typeof pendingCall.op === 'string' ? pendingCall.op : null,
              outputs: null,
              checkedAt: typeof pendingCall.at === 'number' ? pendingCall.at : null,
              updatedAt: typeof pendingCall.at === 'number' ? pendingCall.at : null,
              pending: true,
              pendingOp: typeof pendingCall.op === 'string' ? pendingCall.op : null,
            };
      const primary = latest ?? placeholder;
      const visible = calling || justSettled || (open && primary !== null);

      React.useEffect(
        function tickFreshness() {
          if (!visible) return undefined;
          const handle = setInterval(function () {
            setNow(Date.now());
          }, 1000);
          return function cleanup() {
            clearInterval(handle);
          };
        },
        [visible],
      );

      React.useEffect(
        function dismissOnOutsideGesture() {
          if (!open) return undefined;
          const onKeyDown = function (event) {
            if (event.key === 'Escape') setOpen(false);
          };
          const onClick = function (event) {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (rootRef.current?.contains(target) === true) return;
            if (panelRef.current?.contains(target) === true) return;
            setOpen(false);
          };
          document.addEventListener('keydown', onKeyDown);
          document.addEventListener('click', onClick, true);
          return function cleanup() {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('click', onClick, true);
          };
        },
        [open],
      );

      const pending = calling || primary?.pending === true;
      const phase = primary && typeof primary.phase === 'string' ? primary.phase : 'unknown';
      const phaseText = pending ? t('calling') : t(`phase.${phase}`);
      const checkedAt =
        primary && typeof primary.checkedAt === 'number'
          ? primary.checkedAt
          : primary && typeof primary.updatedAt === 'number'
            ? primary.updatedAt
            : null;
      const detail =
        primary && typeof primary.detail === 'string' && primary.detail.length > 0
          ? primary.detail
          : null;
      const rows = [];
      if (primary !== null) {
        rows.push([t('field.kernel'), primary.id, false]);
        rows.push([t('field.phase'), phaseText, false]);
        rows.push([t('field.op'), primary.op ? t(`op.${primary.op}`) : '—', false]);
        rows.push([
          t('field.checked'),
          checkedAt === null ? '—' : `${formatClock(checkedAt)} · ${freshnessText(now - checkedAt, t)}`,
          false,
        ]);
        rows.push([
          t('field.outputs'),
          typeof primary.outputs === 'number' ? String(primary.outputs) : '—',
          false,
        ]);
        if (detail !== null) rows.push([t('field.detail'), detail, true]);
        if (order !== null && order.length > 1) {
          rows.push([
            t('field.tracked'),
            order
              .map(function (id) {
                const kernel = kernels[id];
                const trackPhase = kernel && typeof kernel.phase === 'string' ? kernel.phase : 'unknown';
                return `${id} — ${t(`phase.${trackPhase}`)}`;
              })
              .join('\n'),
            true,
          ]);
        }
      }
      const fullReading = `${t('label')} · ${phaseText}`;
      const panelKey = `${primary?.id ?? ''}|${phaseText}|${detail ?? ''}|${rows.length}`;

      React.useLayoutEffect(
        function placePanel() {
          if (!open) {
            setPos(null);
            return undefined;
          }
          const update = function () {
            const anchorElement = rootRef.current;
            const panelElement = panelRef.current;
            if (anchorElement === null || panelElement === null) return;
            const anchor = anchorElement.getBoundingClientRect();
            const width = panelElement.offsetWidth;
            const height = panelElement.offsetHeight;
            let left = anchor.left + anchor.width / 2 - width / 2;
            left = Math.max(PANEL_MARGIN, Math.min(left, window.innerWidth - width - PANEL_MARGIN));
            let top = anchor.top - PANEL_GAP - height;
            if (top < PANEL_MARGIN) top = anchor.bottom + PANEL_GAP;
            if (top + height > window.innerHeight - PANEL_MARGIN) {
              top = Math.max(PANEL_MARGIN, window.innerHeight - height - PANEL_MARGIN);
            }
            setPos(function (previous) {
              return previous !== null && previous.left === left && previous.top === top
                ? previous
                : { left, top };
            });
          };
          update();
          window.addEventListener('resize', update);
          window.addEventListener('scroll', update, true);
          return function cleanup() {
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
          };
        },
        [open, panelKey],
      );

      if (!visible || primary === null) return null;

      const details = [];
      rows.forEach(function (row, index) {
        details.push(h('dt', { key: `k${index}` }, row[0]));
        details.push(h('dd', row[2] ? { key: `v${index}`, className: 'kks-wrap' } : { key: `v${index}` }, row[1]));
      });

      return h(
        React.Fragment,
        null,
        h(
          'span',
          { ref: rootRef, className: 'kks-anchor', 'data-kaggle-kernel': '' },
          h('style', null, CSS_TEXT),
          h(
            'button',
            {
              type: 'button',
              className: 'kks-pill',
              'data-kaggle-kernel-pill': '',
              title: fullReading,
              'aria-label': fullReading,
              'aria-haspopup': 'dialog',
              'aria-expanded': open,
              'aria-busy': pending,
              onClick: function toggle() {
                setOpen(function (value) {
                  return !value;
                });
              },
            },
            glyph(),
            h('span', { className: 'kks-label' }, t('label')),
            h('span', { className: 'kks-sep', 'aria-hidden': 'true' }, '·'),
            h('span', { className: 'kks-label' }, phaseText),
          ),
        ),
        open && primary !== null
          ? ReactDOM.createPortal(
              h(
                'div',
                {
                  ref: panelRef,
                  className: 'kks-panel',
                  role: 'dialog',
                  'aria-label': t('label'),
                  style: pos ?? MEASURE_STYLE,
                },
                h(
                  'div',
                  { className: 'kks-title' },
                  h('span', { className: 'kks-title-label' }, glyph(), t('label')),
                  h('span', { className: 'kks-title-value' }, phaseText),
                ),
                h('div', { className: 'kks-title-rule', 'aria-hidden': 'true' }),
                h('dl', { className: 'kks-details' }, details),
                h('p', { className: 'kks-hint' }, t('hint')),
              ),
              document.body,
            )
          : null,
      );
    }

    /** Required services: slot contribution and locale dictionaries. */
    const inject = ['slots', 'locale'];

    /**
     * Client plugin body: register the localized dictionaries and the
     * composer-dock entry.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(
        function dictionaries() {
          return ctx.locale.register(NS, { zh, en });
        },
        'kaggle-kernel-status: dictionaries',
      );
      ctx.slots.inject('conversation.composer.dock', function composerDock() {
        return ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'kaggle-kernel',
            order: 5,
            locale: NS,
          },
          KaggleKernelBar,
        );
      });
    }

    return { inject, apply };
  },
});
