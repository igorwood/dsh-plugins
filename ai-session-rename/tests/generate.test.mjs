import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_TITLE_CHARS, SYSTEM_PROMPT, generateTitle } from '../lib/title.js';

function sessionWith(messages) {
  return {
    deriveMessages: () => messages,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  };
}

function fakeCtx(chunks, reasoning) {
  const calls = {};
  return {
    calls,
    get: () => undefined,
    llm: {
      resolveModelInfo: async () => (reasoning === undefined ? {} : { reasoning: { efforts: [{ id: reasoning }, { id: 'max' }] } }),
      stream(options) {
        calls.options = options;
        return (async function* generate() {
          for (const chunk of chunks) yield chunk;
        })();
      },
    },
  };
}

test('generateTitle sends one auxiliary request and normalizes the streamed title', async () => {
  const ctx = fakeCtx([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '标题：' },
    { type: 'text-delta', index: 0, text: '“AI 重命名会话插件”。' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const title = await generateTitle(ctx, sessionWith([
    { role: 'user', content: [{ type: 'text', text: '给重命名对话框加一个 AI 按钮' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好的，我来实现。' }] },
  ]));
  assert.equal(title, 'AI 重命名会话插件');
  assert.equal(Array.from(title).length <= MAX_TITLE_CHARS, true);
  assert.equal(ctx.calls.options.provider, 'p');
  assert.equal(ctx.calls.options.model, 'm');
  assert.equal(ctx.calls.options.system, SYSTEM_PROMPT);
  assert.equal(ctx.calls.options.maxTokens, 2048);
  assert.equal('reasoningEffort' in ctx.calls.options, false);
  assert.equal(ctx.calls.options.messages.length, 1);
  assert.equal(ctx.calls.options.messages[0].role, 'user');
  assert.ok(ctx.calls.options.messages[0].content[0].text.includes('给重命名对话框加一个 AI 按钮'));
});

test('generateTitle asks reasoning routes for their least reasoning effort', async () => {
  const ctx = fakeCtx([
    { type: 'reasoning-delta', index: 0, text: '想一想' },
    { type: 'text-delta', index: 0, text: '示例知识库' },
    { type: 'finish', reason: { kind: 'stop' } },
  ], 'low');
  const title = await generateTitle(ctx, sessionWith([
    { role: 'user', content: [{ type: 'text', text: '给项目建立知识库' }] },
  ]));
  assert.equal(title, '示例知识库');
  assert.equal(ctx.calls.options.reasoningEffort, 'low');
});

test('generateTitle reports an exhausted reasoning budget instead of an empty title', async () => {
  const ctx = fakeCtx([
    { type: 'reasoning-delta', index: 0, text: '想了很久但没输出' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ], 'max');
  await assert.rejects(
    () => generateTitle(ctx, sessionWith([{ role: 'user', content: [{ type: 'text', text: 'x' }] }])),
    /推理占满了输出预算/,
  );
});

test('generateTitle caps an over-long title at 12 characters', async () => {
  const ctx = fakeCtx([
    { type: 'text-delta', index: 0, text: '一二三四五六七八九十甲乙丙丁戊己' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const title = await generateTitle(ctx, sessionWith([
    { role: 'user', content: [{ type: 'text', text: '随便聊聊' }] },
  ]));
  assert.equal(Array.from(title).length, MAX_TITLE_CHARS);
  assert.equal(title, '一二三四五六七八九十甲乙');
});

test('generateTitle rejects on empty conversations, missing routes, and failed finishes', async () => {
  const empty = fakeCtx([{ type: 'finish', reason: { kind: 'stop' } }]);
  await assert.rejects(
    () => generateTitle(empty, { deriveMessages: () => [], requestHeader: () => undefined }),
    /还没有可用的对话内容/,
  );

  const noRoute = fakeCtx([{ type: 'finish', reason: { kind: 'stop' } }]);
  await assert.rejects(
    () => generateTitle(noRoute, { deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], requestHeader: () => undefined }),
    /无法确定/,
  );

  const failed = fakeCtx([{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } }]);
  await assert.rejects(
    () => generateTitle(failed, sessionWith([{ role: 'user', content: [{ type: 'text', text: 'x' }] }])),
    /生成标题失败：boom/,
  );
});
