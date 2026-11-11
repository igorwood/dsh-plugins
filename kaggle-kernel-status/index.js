/**
 * Host half of the Kaggle kernel status plugin.
 *
 * Registers one pure session projection (`kaggleKernel`) that folds the
 * Session event log into a compact, client-visible view of the Kaggle kernel
 * operations the agent ran through the `bash` tool. The fold is synchronous,
 * never touches the filesystem or network, and returns the same state
 * reference for every event it does not care about.
 *
 * State is plain JSON (`structuredClone`-safe):
 *
 *   {
 *     order: string[],             // most-recent-first kernel ids
 *     kernels: { [id]: kernel },   // see `baseKernel` for the exact fields
 *     pending: { [callId]: entry },// in-flight Kaggle calls awaiting a result
 *     lastAt: number | null,       // timestamp of the last observed kaggle event
 *   }
 *
 * @module @local/kaggle-kernel-status
 */

/** Required Host service: the session projection registry. */
export const inject = ['sessionProjections'];

/**
 * Register the `kaggleKernel` projection with the Host.
 * @param {object} ctx - owning Cordis plugin context.
 * @returns {Promise<void>} resolves once the projection unit is registered.
 */
export async function apply(ctx) {
  await ctx.sessionProjections.register(createDefinition());
}

/** @returns {object} a fresh, empty projection state. */
function emptyState() {
  return { order: [], kernels: {}, pending: {}, lastAt: null };
}

/** @returns {object} a shallow-copied state safe to advance. */
function cloneState(state) {
  return {
    order: Array.isArray(state.order) ? state.order.slice() : [],
    kernels: state.kernels !== null && typeof state.kernels === 'object' ? { ...state.kernels } : {},
    pending: state.pending !== null && typeof state.pending === 'object' ? { ...state.pending } : {},
    lastAt: typeof state.lastAt === 'number' ? state.lastAt : null,
  };
}

/**
 * Move `id` to the front of a most-recent-first id list.
 * @param {string[]} order - current ordering.
 * @param {string} id - kernel id to promote.
 * @returns {string[]} a new ordering.
 */
function promote(order, id) {
  const next = [id];
  for (const existing of order) {
    if (existing !== id) next.push(existing);
  }
  return next;
}

/**
 * Create one fresh kernel record.
 * @param {string} id - `user/slug`.
 * @param {string | null} user - Kaggle user name when known.
 * @param {string | null} slug - Kaggle kernel slug when known.
 * @param {number | null} at - event timestamp.
 * @returns {object} a plain kernel record.
 */
function baseKernel(id, user, slug, at) {
  return {
    id,
    user: user === undefined ? null : user,
    slug: slug === undefined ? null : slug,
    phase: 'unknown',
    detail: null,
    op: null,
    outputs: null,
    checkedAt: null,
    updatedAt: at,
    pending: false,
    pendingOp: null,
  };
}

/**
 * Apply a patch to a kernel record without introducing `undefined` fields.
 * @param {object} kernel - record to copy.
 * @param {object} patch - fields to set; `undefined` values are skipped.
 * @returns {object} the patched copy.
 */
function applyKernelPatch(kernel, patch) {
  const next = { ...kernel };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value !== undefined) next[key] = value;
  }
  return next;
}

/** @returns {number | null} the event timestamp, or null when unavailable. */
function eventTime(event) {
  return typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : null;
}

/**
 * Trim and cap a detail string for display.
 * @param {string} value - raw detail text.
 * @returns {string} normalized detail.
 */
function truncateDetail(value) {
  const text = String(value).trim();
  return text.length > 500 ? text.slice(0, 500) : text;
}

/**
 * Join the text blocks of a tool result message.
 * @param {unknown} content - `data.message.content`.
 * @returns {string} the joined text; empty when there is none.
 */
function joinTextBlocks(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Shell-command recognition
// ---------------------------------------------------------------------------

/** A token that begins an environment assignment (`FOO=bar`). */
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A `timeout` duration such as `90`, `1.5`, `30s`. */
const TIMEOUT_DURATION_RE = /^[0-9]+(?:\.[0-9]+)?[smhd]?$/;
/** Python executor basenames (`python`, `python3`, `python3.12`, ...). */
const PYTHON_WORD_RE = /^python[0-9.]*[a-z]*$/i;
/** Shells whose `-c` payload should be inspected recursively. */
const SHELL_WORDS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
/** Basename of the local Kaggle MCP bridge script. */
const MCP_SCRIPT_BASENAME = 'kaggle_mcp.py';

/** MCP subcommand → projected op. */
const MCP_OPS = {
  kernel_session_status: 'status',
  kernel_session_output: 'output',
  kernel_push: 'push',
  kernel_session_cancel: 'cancel',
  kernel_session_create: 'create',
};

/** Kaggle CLI `kernels` subcommand → projected op. */
const CLI_OPS = {
  push: 'push',
  status: 'status',
  output: 'output',
  pull: 'pull',
  list: 'list',
};

/** `make` targets that wrap a Kaggle kernel operation. */
const MAKE_OPS = {
  'kaggle-status': 'status',
  'kaggle-output': 'output',
};

/** A Kaggle `user/slug` token. The first character must be alphanumeric. */
const KERNEL_ID_RE = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)$/;

/** `**Output files** for `user/slug`:` MCP output-result header. */
const OUTPUT_HEADER_RE = /\*\*Output files\*\*\s+for\s+\x60?([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)\x60?\s*:/;
/** One `- `name` — url` output bullet line. */
const OUTPUT_BULLET_RE = /^\s*-\s+\x60[^\x60]+\x60/;

/** @returns {string} the last path segment of a shell word. */
function baseName(word) {
  if (typeof word !== 'string') return '';
  const slash = word.lastIndexOf('/');
  return slash === -1 ? word : word.slice(slash + 1);
}

/** @returns {boolean} whether `word` is a Python interpreter. */
function isPythonCommand(word) {
  return PYTHON_WORD_RE.test(word);
}

/** @returns {boolean} whether `object` owns `key`. */
function hasOwn(object, key) {
  return Object.hasOwn(object, key);
}

/**
 * Split one shell command line into simple-command token lists.
 *
 * This is a deliberately small lexer: it understands the quoting and the
 * separators that decide which word is the command word (`;`, `&&`, `||`,
 * `|`, newline, background `&`), so a search pattern quoted inside `grep`,
 * `echo`, `cat`, `git`, `sed`, `awk` or `find` can never look like a real
 * invocation.
 *
 * @param {string} command - raw shell command.
 * @returns {string[][]} one token list per simple command.
 */
function splitShellSegments(command) {
  const segments = [];
  let tokens = [];
  let current = '';
  let started = false;
  let i = 0;

  const flushToken = () => {
    if (started) {
      tokens.push(current);
      current = '';
      started = false;
    }
  };
  const flushSegment = () => {
    flushToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  while (i < command.length) {
    const ch = command[i];

    if (ch === "'") {
      started = true;
      i += 1;
      while (i < command.length && command[i] !== "'") {
        current += command[i];
        i += 1;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      started = true;
      i += 1;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) {
          const escaped = command[i + 1];
          if (escaped === '"' || escaped === '\\' || escaped === '$' || escaped === '`') {
            current += escaped;
            i += 2;
            continue;
          }
        }
        current += command[i];
        i += 1;
      }
      i += 1;
      continue;
    }

    if (ch === '\\') {
      started = true;
      if (i + 1 < command.length) {
        current += command[i + 1];
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flushToken();
      i += 1;
      continue;
    }

    if (ch === '\n' || ch === ';') {
      flushSegment();
      i += 1;
      continue;
    }

    if (ch === '|') {
      flushSegment();
      i += command[i + 1] === '|' ? 2 : 1;
      if (command[i] === '&') i += 1;
      continue;
    }

    if (ch === '&') {
      if (command[i + 1] === '&') {
        flushSegment();
        i += 2;
        continue;
      }
      // `2>&1` / `>&2`: the ampersand is part of a redirection word.
      if (current.endsWith('>')) {
        current += ch;
        started = true;
        i += 1;
        continue;
      }
      // `&>file`: still a separator, followed by a redirect word.
      flushSegment();
      i += 1;
      continue;
    }

    if (ch === '(' || ch === ')') {
      flushSegment();
      i += 1;
      continue;
    }

    current += ch;
    started = true;
    i += 1;
  }

  flushSegment();
  return segments;
}

/**
 * Skip options and environment assignments, as used after a wrapper word.
 * @param {string[]} tokens - segment tokens.
 * @param {number} index - first token to consider.
 * @param {Set<string>} optionsWithArgument - options that consume the next token.
 * @returns {number} the first non-option, non-assignment token index.
 */
function skipOptionsAndAssignments(tokens, index, optionsWithArgument = null) {
  let i = index;
  while (i < tokens.length) {
    const token = tokens[i];
    if (ASSIGNMENT_RE.test(token)) {
      i += 1;
      continue;
    }
    if (typeof token !== 'string' || !token.startsWith('-')) break;
    const equals = token.indexOf('=');
    const name = equals === -1 ? token : token.slice(0, equals);
    i += equals === -1 && optionsWithArgument !== null && optionsWithArgument.has(name) ? 2 : 1;
  }
  return i;
}

/**
 * Skip a `timeout` word and its own options and duration.
 * @param {string[]} tokens - segment tokens.
 * @param {number} index - token after the `timeout` word.
 * @returns {number} the wrapped command's word index.
 */
function skipTimeout(tokens, index) {
  let i = skipOptionsAndAssignments(
    tokens,
    index,
    new Set(['-s', '--signal', '-k', '--kill-after']),
  );
  if (i < tokens.length && TIMEOUT_DURATION_RE.test(tokens[i])) i += 1;
  return i;
}

/**
 * Find the command word of one simple command, looking through the common
 * wrappers (`timeout`, `env`, `time`, `command`, `exec`, `nohup`, `nice`,
 * `sudo`) and leading environment assignments.
 * @param {string[]} tokens - segment tokens.
 * @returns {number} the command word index, or -1 when the segment is empty.
 */
function commandWordIndex(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (ASSIGNMENT_RE.test(token)) {
      i += 1;
      continue;
    }
    const word = baseName(token);
    if (word === 'timeout') {
      i = skipTimeout(tokens, i + 1);
      continue;
    }
    if (word === 'env' || word === 'time' || word === 'command' || word === 'exec' || word === 'nohup' || word === 'builtin') {
      i = skipOptionsAndAssignments(tokens, i + 1);
      continue;
    }
    if (word === 'nice') {
      i = skipOptionsAndAssignments(tokens, i + 1, new Set(['-n', '--adjustment']));
      continue;
    }
    if (word === 'sudo') {
      i = skipOptionsAndAssignments(tokens, i + 1, new Set(['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-T', '-U']));
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * Find the `--json` payload of an MCP invocation.
 * @param {string[]} tokens - segment tokens.
 * @param {number} from - index to start scanning at.
 * @returns {string | null} the JSON text when present.
 */
function findJsonArgument(tokens, from) {
  for (let i = from; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--json' || token === '-j') {
      if (typeof tokens[i + 1] === 'string') return tokens[i + 1];
      continue;
    }
    if (token.startsWith('--json=')) return token.slice('--json='.length);
    if (token.startsWith('-j=')) return token.slice('-j='.length);
    if (token.startsWith('{') && token.endsWith('}')) return token;
  }
  return null;
}

/**
 * Read `user_name`, `kernel_slug` and `title` out of an MCP payload. A tolerant
 * regex is used (rather than `JSON.parse`) so a JSON-ish Python dict or a
 * shell-escaped double-quoted payload still resolves.
 * @param {string | null} jsonText - `--json` payload, when one was found.
 * @param {string} command - full raw command, used as a fallback.
 * @returns {{ user: string | null, slug: string | null, title: string | null }} parsed fields.
 */
function extractMcpFields(jsonText, command) {
  const candidates = [];
  if (typeof jsonText === 'string' && jsonText.length > 0) candidates.push(jsonText);
  candidates.push(command.replace(/\\(["'])/g, '$1'));

  let user = null;
  let slug = null;
  let title = null;
  for (const candidate of candidates) {
    if (user === null) {
      const match = /["'](?:user_name|userName)["']\s*:\s*["']([^"']*)["']/.exec(candidate);
      if (match !== null && match[1] !== '') user = match[1];
    }
    if (slug === null) {
      const match = /["'](?:kernel_slug|kernelSlug)["']\s*:\s*["']([^"']*)["']/.exec(candidate);
      if (match !== null && match[1] !== '') slug = match[1];
    }
    if (title === null) {
      const match = /["']title["']\s*:\s*["']([^"']*)["']/.exec(candidate);
      if (match !== null && match[1] !== '') title = match[1];
    }
  }
  return { user, slug, title };
}

/**
 * Slugify a kernel title for the push fallback.
 * @param {string | null} title - kernel title from an MCP payload.
 * @returns {string | null} a best-effort kernel slug.
 */
function slugifyTitle(title) {
  if (typeof title !== 'string') return null;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? null : slug;
}

/**
 * @returns {{ user: string, slug: string, id: string }} a resolved kernel identity.
 */
function idParts(user, slug) {
  return { user, slug, id: `${user}/${slug}` };
}

/**
 * Recognize an MCP `kaggle_mcp.py call <op> --json '{...}'` invocation.
 * @param {string[]} tokens - segment tokens.
 * @param {number} start - command word index.
 * @param {string} command - full raw command.
 * @returns {object | null} detected operation, or null.
 */
function detectMcpInvocation(tokens, start, command) {
  for (let i = start + 1; i < tokens.length; i += 1) {
    if (baseName(tokens[i]) !== MCP_SCRIPT_BASENAME) continue;
    if (tokens[i + 1] !== 'call') continue;
    const opToken = tokens[i + 2];
    if (typeof opToken !== 'string' || !hasOwn(MCP_OPS, opToken)) continue;

    const op = MCP_OPS[opToken];
    const fields = extractMcpFields(findJsonArgument(tokens, i + 3), command);
    let user = fields.user;
    let slug = fields.slug;
    if (slug === null && op === 'push') slug = slugifyTitle(fields.title);
    const id = user !== null && slug !== null ? `${user}/${slug}` : null;
    return { op, user, slug, id };
  }
  return null;
}

/**
 * Recognize a `kaggle kernels <subcommand> ...` CLI invocation.
 * @param {string[]} tokens - segment tokens.
 * @param {number} start - command word index.
 * @returns {object | null} detected operation, or null.
 */
function detectKaggleCli(tokens, start) {
  if (tokens[start + 1] !== 'kernels') return null;
  const subcommand = tokens[start + 2];
  if (typeof subcommand !== 'string' || !hasOwn(CLI_OPS, subcommand)) return null;

  let user = null;
  let slug = null;
  for (let i = start + 3; i < tokens.length; i += 1) {
    const match = KERNEL_ID_RE.exec(tokens[i]);
    if (match !== null) {
      user = match[1];
      slug = match[2];
      break;
    }
  }
  return { op: CLI_OPS[subcommand], user, slug, id: user !== null && slug !== null ? `${user}/${slug}` : null };
}

/**
 * Recognize a `make kaggle-status` / `make kaggle-output` invocation.
 * @param {string[]} tokens - segment tokens.
 * @param {number} start - command word index.
 * @returns {object | null} detected operation, or null.
 */
function detectMakeTarget(tokens, start) {
  for (let i = start + 1; i < tokens.length; i += 1) {
    if (hasOwn(MAKE_OPS, tokens[i])) {
      return { op: MAKE_OPS[tokens[i]], user: null, slug: null, id: null };
    }
  }
  return null;
}

/**
 * Detect one Kaggle kernel operation in a token list.
 * @param {string[]} tokens - one simple command.
 * @param {string} command - full raw command (for the MCP JSON fallback).
 * @param {number} depth - `bash -c` recursion depth.
 * @returns {object | null} detected operation, or null.
 */
function detectInTokens(tokens, command, depth) {
  const start = commandWordIndex(tokens);
  if (start === -1) return null;
  const word = baseName(tokens[start]);

  if (isPythonCommand(word)) return detectMcpInvocation(tokens, start, command);
  if (word === 'kaggle') return detectKaggleCli(tokens, start);
  if (word === 'make') return detectMakeTarget(tokens, start);

  if (depth < 4 && SHELL_WORDS.has(word)) {
    for (let i = start + 1; i < tokens.length; i += 1) {
      if (!/^-[a-zA-Z]*c[a-zA-Z]*$/.test(tokens[i])) continue;
      const script = tokens[i + 1];
      if (typeof script !== 'string') continue;
      const nested = detectKernelOperation(script, depth + 1);
      if (nested !== null) return nested;
    }
  }
  return null;
}

/**
 * Detect a real Kaggle kernel operation in a raw shell command. Mentions that
 * merely appear inside the arguments of `grep`, `echo`, `cat`, `git`, `sed`,
 * `awk`, `find`, ... are never detected: only a segment whose command word is
 * an actual kaggle invocation counts.
 * @param {string} command - raw shell command.
 * @param {number} depth - `bash -c` recursion depth.
 * @returns {object | null} detected operation, or null.
 */
function detectKernelOperation(command, depth = 0) {
  if (typeof command !== 'string' || command.trim() === '') return null;
  for (const tokens of splitShellSegments(command)) {
    const detected = detectInTokens(tokens, command, depth);
    if (detected !== null) return detected;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool-result parsing
// ---------------------------------------------------------------------------

/**
 * Map one Kaggle worker status value to a projected phase.
 * @param {string} raw - status value, with or without the `KernelWorkerStatus.` prefix.
 * @returns {string} projected phase.
 */
function mapStatus(raw) {
  const value = String(raw)
    .replace(/^KernelWorkerStatus\./i, '')
    .trim()
    .toUpperCase();
  if (value === 'QUEUED' || value === 'NEW' || value === 'PENDING') return 'queued';
  if (value === 'RUNNING') return 'running';
  if (value === 'COMPLETE' || value === 'COMPLETED') return 'complete';
  if (value === 'ERROR' || value === 'FAILED') return 'error';
  if (value.startsWith('CANCEL')) return 'cancelled';
  return 'unknown';
}

/**
 * Extract the projected outcome from a tool result's joined text.
 *
 * @param {string} text - joined text blocks of the tool result.
 * @returns {{
 *   id: { user: string, slug: string, id: string } | null,
 *   phase: string | undefined,
 *   detail: string | null | undefined,
 *   outputs: number | undefined,
 * }} parsed outcome; `undefined` means "leave this field alone".
 */
function parseResultText(text) {
  /** @type {{ id: { user: string, slug: string, id: string } | null, phase: string | undefined, detail: string | null | undefined, outputs: number | undefined }} */
  const parsed = { id: null, phase: undefined, detail: undefined, outputs: undefined };
  if (typeof text !== 'string' || text.length === 0) return parsed;

  const failureMessage = () => {
    const match = /\*\*Failure message\s*:?\s*\*\*\s*:?\s*([\s\S]*?)(?=\r?\n\s*\*\*|$)/.exec(text);
    if (match === null) return null;
    const detail = truncateDetail(match[1]);
    return detail === '' ? null : detail;
  };

  const statusMatch = /\*\*Status\s*:?\s*\*\*\s*:?\s*["']?([A-Za-z0-9_.]+)["']?/.exec(text);
  if (statusMatch !== null) {
    parsed.phase = mapStatus(statusMatch[1]);
    parsed.detail = failureMessage();
  } else {
    const cliStatus = /([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)\s+has status\s+["']?([A-Za-z0-9_.]+)["']?/i.exec(text);
    if (cliStatus !== null) {
      parsed.phase = mapStatus(cliStatus[3]);
      parsed.detail = failureMessage();
      parsed.id = idParts(cliStatus[1], cliStatus[2]);
    }
  }

  const errorMatch = /Error\s+(?:fetching session status|listing session output|creating kernel session)\s*:\s*([\s\S]*)/i.exec(text);
  if (errorMatch !== null) {
    parsed.phase = 'error';
    parsed.detail = truncateDetail(errorMatch[1]);
  }

  const outputHeader = OUTPUT_HEADER_RE.exec(text);
  if (outputHeader !== null) {
    parsed.id = idParts(outputHeader[1], outputHeader[2]);
    parsed.outputs = text.split(/\r?\n/).filter((line) => OUTPUT_BULLET_RE.test(line)).length;
  } else if (/No output files found\.?/i.test(text)) {
    parsed.outputs = 0;
  }

  const pushRef = /["']ref["']\s*:\s*["']([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)["']/.exec(text);
  const pushed = /successfully pushed/i.test(text);
  if (pushed || pushRef !== null) {
    parsed.phase = 'submitted';
    if (pushRef !== null) parsed.id = idParts(pushRef[1], pushRef[2]);
  }

  if (/Session cancelled\.?/i.test(text)) parsed.phase = 'cancelled';

  return parsed;
}

// ---------------------------------------------------------------------------
// Event folding
// ---------------------------------------------------------------------------

/**
 * Fold one `tool/call` event.
 * @param {object} state - current projection state.
 * @param {object} event - Session event.
 * @returns {object} the same state for ignored events, otherwise a new state.
 */
function foldToolCall(state, event) {
  const data = event.data;
  if (data === null || typeof data !== 'object' || data.name !== 'bash') return state;
  const callId = typeof data.callId === 'string' && data.callId !== '' ? data.callId : null;
  if (callId === null) return state;

  let args;
  if (typeof data.arguments === 'string') {
    try {
      args = JSON.parse(data.arguments);
    } catch {
      return state;
    }
  } else if (data.arguments !== null && typeof data.arguments === 'object') {
    // Tolerate a pre-parsed arguments object (the recorded log always stores a string).
    args = data.arguments;
  } else {
    return state;
  }
  if (args === null || typeof args !== 'object' || typeof args.command !== 'string') return state;

  const detected = detectKernelOperation(args.command);
  if (detected === null) return state;

  const at = eventTime(event);
  const next = cloneState(state);
  next.lastAt = at;
  const entry = {
    op: detected.op,
    id: detected.id === undefined ? null : detected.id,
    user: detected.user === undefined ? null : detected.user,
    slug: detected.slug === undefined ? null : detected.slug,
    at,
  };
  next.pending[callId] = entry;

  if (entry.id !== null) {
    const kernel = next.kernels[entry.id] ?? baseKernel(entry.id, entry.user, entry.slug, at);
    next.kernels[entry.id] = applyKernelPatch(kernel, {
      user: kernel.user === null ? entry.user : undefined,
      slug: kernel.slug === null ? entry.slug : undefined,
      op: entry.op,
      pending: true,
      pendingOp: entry.op,
      updatedAt: at,
    });
    next.order = promote(next.order, entry.id);
  }
  return next;
}

/**
 * Fold one `tool/result` event.
 * @param {object} state - current projection state.
 * @param {object} event - Session event.
 * @returns {object} the same state when the call was not a Kaggle call.
 */
function foldToolResult(state, event) {
  const data = event.data;
  if (data === null || typeof data !== 'object') return state;
  const message = data.message;
  if (message === null || typeof message !== 'object') return state;
  const callId =
    typeof message.toolCallId === 'string'
      ? message.toolCallId
      : typeof data.toolCallId === 'string'
        ? data.toolCallId
        : null;
  if (callId === null) return state;

  const pendingEntry = state.pending[callId];
  if (pendingEntry === undefined) return state;

  const at = eventTime(event);
  const parsed = parseResultText(joinTextBlocks(message.content));

  const next = cloneState(state);
  delete next.pending[callId];
  next.lastAt = at;

  let id = pendingEntry.id === undefined ? null : pendingEntry.id;
  let user = pendingEntry.user === undefined ? null : pendingEntry.user;
  let slug = pendingEntry.slug === undefined ? null : pendingEntry.slug;
  const entryOp = pendingEntry.op === undefined ? null : pendingEntry.op;

  if (parsed.id !== null) {
    const resolves = id === null || entryOp === 'push';
    if (resolves) {
      const previousId = id;
      id = parsed.id.id;
      user = parsed.id.user;
      slug = parsed.id.slug;
      if (previousId !== null && previousId !== id) {
        // A title-derived push guess the result corrected: drop the placeholder.
        const stale = next.kernels[previousId];
        if (
          stale !== undefined &&
          stale.phase === 'unknown' &&
          stale.outputs === null &&
          stale.checkedAt === null
        ) {
          delete next.kernels[previousId];
          next.order = next.order.filter((existing) => existing !== previousId);
        }
      }
    }
  }

  if (id === null) return next;

  const kernel = next.kernels[id] ?? baseKernel(id, user, slug, at);
  const patch = {
    user: kernel.user === null ? user : undefined,
    slug: kernel.slug === null ? slug : undefined,
    op: entryOp === undefined ? null : entryOp,
    pending: false,
    pendingOp: null,
    checkedAt: at,
    updatedAt: at,
  };
  if (parsed.phase !== undefined) patch.phase = parsed.phase;
  if (parsed.detail !== undefined) patch.detail = parsed.detail;
  if (parsed.outputs !== undefined) patch.outputs = parsed.outputs;

  next.kernels[id] = applyKernelPatch(kernel, patch);
  next.order = promote(next.order, id);
  return next;
}

/**
 * The pure session-projection fold.
 * @param {object} state - current `kaggleKernel` state.
 * @param {object} event - one committed Session event.
 * @returns {object} the same state reference for ignored events.
 */
function foldEvent(state, event) {
  if (event === null || typeof event !== 'object') return state;
  if (event.type === 'tool/call') return foldToolCall(state, event);
  if (event.type === 'tool/result') return foldToolResult(state, event);
  return state;
}

/**
 * The `kaggleKernel` projection definition.
 * @returns {object} a projection definition accepted by `ctx.sessionProjections.register`.
 */
export function createDefinition() {
  return {
    key: 'kaggleKernel',
    stateVersion: 1,
    stateSchema: { parse: (value) => value },
    init: () => emptyState(),
    apply: foldEvent,
    wire: {
      viewSchema: { parse: (value) => value },
      view: (state) => state,
    },
  };
}
