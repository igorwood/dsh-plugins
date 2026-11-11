import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefinition } from '../index.js';

const def = createDefinition();

/** Build one `tool/call` Session event for a `bash` invocation. */
function toolCall(callId, command, time = 1000) {
  return {
    type: 'tool/call',
    seq: 10,
    time,
    data: {
      turn: 1,
      step: 1,
      callId,
      name: 'bash',
      arguments: JSON.stringify({ command, description: 'test', timeoutMs: 120000 }),
    },
  };
}

/** Build one `tool/result` Session event for a tool call. */
function toolResult(callId, text, time = 2000) {
  return {
    type: 'tool/result',
    seq: 11,
    time,
    data: {
      turn: 1,
      step: 2,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError: false,
        id: `msg-${callId}`,
      },
      meta: { cwd: '/home/user/projects' },
      sourceEventSeqs: [10],
      surfaceOp: 'append',
    },
  };
}

/** Build an MCP shell command for one kernel operation. */
function mcp(command, payload) {
  return `cd /tmp && timeout 90 .venv/bin/python scripts/kaggle_mcp.py call ${command} --json '${JSON.stringify(payload)}' 2>&1 | head -80; echo "[exit=$?]"`;
}

/** Fold a list of events from a fresh state. */
function fold(events) {
  let state = def.init();
  for (const event of events) state = def.apply(state, event);
  return state;
}

test('init and definition expose the documented projection contract', () => {
  const state = def.init();
  assert.deepEqual(state, { order: [], kernels: {}, pending: {}, lastAt: null });
  assert.equal(def.key, 'kaggleKernel');
  assert.equal(def.stateVersion, 1);
  assert.equal(def.stateSchema.parse(state), state);
  assert.equal(def.wire.view(state), state);
  assert.equal(def.wire.viewSchema.parse(state), state);
  assert.deepEqual(structuredClone(state), state);
});

test('real recorded kaggle_mcp status call + result folds to running', () => {
  const command =
    'cd /home/user/projects/example-kaggle-project && timeout 90 ' +
    ".venv/bin/python scripts/kaggle_mcp.py call kernel_session_status --json " +
    `'{"user_name":"example-user","kernel_slug":"example-kernel"}' 2>&1 | head -80; echo "[exit=$?]"`;
  const call = toolCall('call_status', command, 1000);

  let state = def.init();
  state = def.apply(state, call);

  assert.deepEqual(Object.keys(state.pending), ['call_status']);
  assert.deepEqual(state.pending.call_status, {
    op: 'status',
    id: 'example-user/example-kernel',
    user: 'example-user',
    slug: 'example-kernel',
    at: 1000,
  });
  assert.deepEqual(state.order, ['example-user/example-kernel']);
  const pendingKernel = state.kernels['example-user/example-kernel'];
  assert.equal(pendingKernel.phase, 'unknown');
  assert.equal(pendingKernel.pending, true);
  assert.equal(pendingKernel.pendingOp, 'status');
  assert.equal(pendingKernel.op, 'status');
  assert.equal(pendingKernel.outputs, null);
  assert.equal(pendingKernel.detail, null);
  assert.equal(pendingKernel.checkedAt, null);
  assert.equal(state.lastAt, 1000);

  state = def.apply(state, toolResult('call_status', '**Status**: RUNNING', 2500));

  assert.deepEqual(state.pending, {});
  const kernel = state.kernels['example-user/example-kernel'];
  assert.equal(kernel.phase, 'running');
  assert.equal(kernel.pending, false);
  assert.equal(kernel.pendingOp, null);
  assert.equal(kernel.checkedAt, 2500);
  assert.equal(kernel.updatedAt, 2500);
  assert.equal(kernel.detail, null);
  assert.equal(state.lastAt, 2500);
  assert.deepEqual(structuredClone(state), state);
});

test('status failure message becomes the kernel detail', () => {
  const state = fold([
    toolCall('c1', mcp('kernel_session_status', { user_name: 'example-user', kernel_slug: 'example-kernel' })),
    toolResult('c1', '**Status**: ERROR\n**Failure message**: CUDA out of memory'),
  ]);
  const kernel = state.kernels['example-user/example-kernel'];
  assert.equal(kernel.phase, 'error');
  assert.equal(kernel.detail, 'CUDA out of memory');
  assert.equal(kernel.pending, false);
});

test('every documented status value maps to its phase', () => {
  const cases = [
    ['**Status**: QUEUED', 'queued'],
    ['**Status**: RUNNING', 'running'],
    ['**Status**: COMPLETE', 'complete'],
    ['**Status**: COMPLETED', 'complete'],
    ['**Status**: ERROR', 'error'],
    ['**Status**: FAILED', 'error'],
    ['**Status**: CANCEL_REQUESTED', 'cancelled'],
    ['**Status**: CANCEL_ACKNOWLEDGED', 'cancelled'],
    ['**Status**: KernelWorkerStatus.RUNNING', 'running'],
  ];
  for (const [text, phase] of cases) {
    const state = fold([
      toolCall('c', mcp('kernel_session_status', { user_name: 'u', kernel_slug: 'k' })),
      toolResult('c', text),
    ]);
    assert.equal(state.kernels['u/k'].phase, phase, text);
  }
});

test('output result with no files sets outputs to 0', () => {
  const state = fold([
    toolCall('c1', mcp('kernel_session_output', { user_name: 'example-user', kernel_slug: 'example-kernel' })),
    toolResult('c1', 'No output files found.'),
  ]);
  assert.deepEqual(state.pending, {});
  assert.equal(state.kernels['example-user/example-kernel'].outputs, 0);
  assert.equal(state.kernels['example-user/example-kernel'].phase, 'unknown');
});

test('output bullets are counted and the id resolves from the result text', () => {
  const outputText = [
    '**Output files** for `example-user/example-kernel`:',
    '- `submission.csv` — https://www.kaggle.com/api/v1/kernels/output/example-user/example-kernel/submission.csv',
    '- `log.txt` — https://www.kaggle.com/api/v1/kernels/output/example-user/example-kernel/log.txt',
  ].join('\n');

  let state = def.init();
  state = def.apply(state, toolCall('c1', mcp('kernel_session_output', {})));
  assert.equal(state.pending.c1.id, null);
  assert.deepEqual(state.kernels, {});

  state = def.apply(state, toolResult('c1', outputText));
  assert.deepEqual(state.pending, {});
  assert.deepEqual(state.order, ['example-user/example-kernel']);
  const kernel = state.kernels['example-user/example-kernel'];
  assert.equal(kernel.outputs, 2);
  assert.equal(kernel.user, 'example-user');
  assert.equal(kernel.slug, 'example-kernel');
  assert.equal(kernel.op, 'output');
  assert.equal(kernel.pending, false);
});

test('kaggle CLI status text maps COMPLETE to complete', () => {
  const state = fold([
    toolCall('c1', 'timeout 60 kaggle kernels status example-user/example-kernel'),
    toolResult('c1', 'example-user/example-kernel has status "KernelWorkerStatus.COMPLETE"'),
  ]);
  assert.deepEqual(state.pending, {});
  assert.equal(state.kernels['example-user/example-kernel'].phase, 'complete');
  assert.equal(state.kernels['example-user/example-kernel'].op, 'status');
});

test('CLI push success and MCP push ref resolve the kernel id', () => {
  const cli = fold([
    toolCall('c1', 'kaggle kernels push -p /tmp/kernel'),
    toolResult('c1', 'Kernel version 3 successfully pushed.'),
  ]);
  assert.deepEqual(cli.pending, {});
  assert.deepEqual(cli.kernels, {});

  const mcpPush = fold([
    toolCall('c2', mcp('kernel_push', { title: 'My Kernel' })),
    toolResult('c2', "{'ref': 'example-user/my-kernel', 'version': 2}"),
  ]);
  assert.deepEqual(mcpPush.pending, {});
  assert.deepEqual(mcpPush.order, ['example-user/my-kernel']);
  const kernel = mcpPush.kernels['example-user/my-kernel'];
  assert.equal(kernel.phase, 'submitted');
  assert.equal(kernel.user, 'example-user');
  assert.equal(kernel.slug, 'my-kernel');
});

test('MCP kernel_session_cancel folds to cancelled', () => {
  const state = fold([
    toolCall('c1', mcp('kernel_session_cancel', { user_name: 'example-user', kernel_slug: 'example-kernel' })),
    toolResult('c1', 'Session cancelled.'),
  ]);
  assert.equal(state.kernels['example-user/example-kernel'].phase, 'cancelled');
});

test('MCP kernel_session_create errors fold to an error phase with a capped detail', () => {
  const longReason = 'quota exceeded '.repeat(60);
  const state = fold([
    toolCall('c1', mcp('kernel_session_create', { user_name: 'example-user', kernel_slug: 'example-kernel' })),
    toolResult('c1', `Error creating kernel session: ${longReason}`),
  ]);
  const kernel = state.kernels['example-user/example-kernel'];
  assert.equal(kernel.phase, 'error');
  assert.equal(kernel.detail.length, 500);
  assert.ok(kernel.detail.startsWith('quota exceeded'));
});

test('grep/echo/cat/git/sed/awk/find mentions are never detected', () => {
  const commands = [
    'grep -q "kaggle_mcp.py call kernel_session_status" file',
    'echo "kaggle kernels status example-user/example-kernel"',
    'cat scripts/kaggle_mcp.py',
    'git log --grep "kaggle_mcp.py call kernel_session_status"',
    'sed -n "s/kaggle_mcp.py call kernel_session_status/x/p" file',
    "awk '{print \"kaggle kernels status u/k\"}' file",
    'find . -name kaggle_mcp.py',
    'head -40 scripts/kaggle_mcp.py',
  ];
  for (const command of commands) {
    const state = def.init();
    assert.equal(def.apply(state, toolCall('c', command)), state, command);
    assert.deepEqual(state.pending, {});
    assert.deepEqual(state.kernels, {});
  }
});

test('unrelated bash calls, other tool calls and non-bash events return the same state', () => {
  const state = def.init();
  const unrelated = [
    toolCall('c1', 'ls -la'),
    toolCall('c2', 'python -m pytest tests/'),
    toolCall('c3', 'kaggle competitions list'),
    { type: 'tool/call', seq: 12, time: 1, data: { callId: 'c4', name: 'read', arguments: '{"file_path":"x"}' } },
    { type: 'assistant/message', seq: 13, time: 1, data: {} },
    toolResult('never-pending', '**Status**: RUNNING'),
  ];
  for (const event of unrelated) {
    assert.equal(def.apply(state, event), state);
  }
});

test('a result that resolves no kernel id clears pending without inventing a kernel', () => {
  let state = def.init();
  state = def.apply(state, toolCall('c1', mcp('kernel_session_create', {}), 1000));
  assert.deepEqual(state.kernels, {});
  assert.equal(state.pending.c1.op, 'create');

  const next = def.apply(state, toolResult('c1', 'Session created.', 3000));
  assert.notEqual(next, state);
  assert.deepEqual(next.pending, {});
  assert.deepEqual(next.kernels, {});
  assert.deepEqual(next.order, []);
  assert.equal(next.lastAt, 3000);
});

test('make targets are recognized and resolve the id from the result text', () => {
  let state = def.init();
  state = def.apply(state, toolCall('c1', 'cd /tmp && make kaggle-status'));
  assert.equal(state.pending.c1.op, 'status');

  state = def.apply(
    state,
    toolResult('c1', 'example-user/example-kernel has status "KernelWorkerStatus.RUNNING"'),
  );
  assert.deepEqual(state.order, ['example-user/example-kernel']);
  assert.equal(state.kernels['example-user/example-kernel'].phase, 'running');
});

test('order keeps the most recently touched kernel first', () => {
  let state = def.init();
  state = def.apply(state, toolCall('a', mcp('kernel_session_status', { user_name: 'u', kernel_slug: 'one' })));
  state = def.apply(state, toolCall('b', mcp('kernel_session_status', { user_name: 'u', kernel_slug: 'two' })));
  assert.deepEqual(state.order, ['u/two', 'u/one']);
  state = def.apply(state, toolResult('a', '**Status**: RUNNING'));
  assert.deepEqual(state.order, ['u/one', 'u/two']);
  assert.deepEqual(structuredClone(state), state);
  assert.doesNotThrow(() => JSON.stringify(state));
});
