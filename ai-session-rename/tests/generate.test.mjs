import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_TITLE_CHARS,
  SUMMARY_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  generateTitle,
  summarizeConversation,
} from '../lib/title.js';

function sessionWith(messages) {
  return {
    deriveMessages: () => messages,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  };
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

function exhaustedChunks() {
  return [
    { type: 'reasoning-delta', index: 0, text: '想了很久但没有输出' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ];
}

function fakeCtx(responses, reasoning) {
  const calls = [];
  let index = 0;
  return {
    calls,
    get: () => undefined,
    llm: {
      resolveModelInfo: async () => (reasoning === undefined ? {} : { reasoning: { efforts: [{ id: reasoning }, { id: 'max' }] } }),
      stream(options) {
        calls.push(options);
        const chunks = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return (async function* generate() {
          for (const chunk of chunks) yield chunk;
        })();
      },
    },
  };
}

test('generateTitle summarizes the conversation first, then names it from the summary', async () => {
  const ctx = fakeCtx([
    textChunks('用户想给会话加 AI 重命名，已完成插件与测试。'),
    textChunks('标题：“AI 重命名会话插件”。'),
  ]);
  const title = await generateTitle(ctx, sessionWith([
    { role: 'user', content: [{ type: 'text', text: '给重命名对话框加一个 AI 按钮' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好的，我来实现。' }] },
  ]));

  assert.equal(title, 'AI 重命名会话插件');
  assert.equal(calls(ctx).length, 2, 'two auxiliary requests: summary then title');

  const [summaryCall, titleCall] = calls(ctx);
  assert.equal(summaryCall.provider, 'p');
  assert.equal(summaryCall.model, 'm');
  assert.equal(summaryCall.system, SUMMARY_SYSTEM_PROMPT);
  assert.equal(summaryCall.maxTokens, 1024);
  assert.ok(summaryCall.messages[0].content[0].text.includes('给重命名对话框加一个 AI 按钮'));

  assert.equal(titleCall.system, SYSTEM_PROMPT);
  assert.equal(titleCall.maxTokens, 2048);
  assert.ok(titleCall.messages[0].content[0].text.includes('用户想给会话加 AI 重命名'));
  assert.ok(!titleCall.messages[0].content[0].text.includes('给重命名对话框加一个 AI 按钮'));
});

function calls(ctx) {
  return ctx.calls;
}

test('generateTitle asks reasoning routes for their least reasoning effort on both calls', async () => {
  const ctx = fakeCtx([
    textChunks('用户要求建立知识库。'),
    textChunks('示例知识库'),
  ], 'low');
  const title = await generateTitle(ctx, sessionWith([
    { role: 'user', content: [{ type: 'text', text: '给项目建立知识库' }] },
  ]));
  assert.equal(title, '示例知识库');
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[0].reasoningEffort, 'low');
  assert.equal(ctx.calls[1].reasoningEffort, 'low');
});

test('summarizeConversation returns the summary and reports an exhausted reasoning budget', async () => {
  const ok = fakeCtx([textChunks('总结正文')]);
  const summary = await summarizeConversation(ok, sessionWith([
    { role: 'user', content: [{ type: 'text', text: 'x' }] },
  ]));
  assert.equal(summary, '总结正文');
  assert.equal(ok.calls[0].system, SUMMARY_SYSTEM_PROMPT);

  const exhausted = fakeCtx([exhaustedChunks()], 'max');
  await assert.rejects(
    () => summarizeConversation(exhausted, sessionWith([{ role: 'user', content: [{ type: 'text', text: 'x' }] }])),
    /推理占满了输出预算/,
  );
});

test('generateTitle reports an exhausted budget on the title call', async () => {
  const ctx = fakeCtx([textChunks('有效总结'), exhaustedChunks()], 'max');
  await assert.rejects(
    () => generateTitle(ctx, sessionWith([{ role: 'user', content: [{ type: 'text', text: 'x' }] }])),
    /推理占满了输出预算/,
  );
});

test('generateTitle rejects on empty conversations and missing routes before any call', async () => {
  const empty = fakeCtx([textChunks('总结')]);
  await assert.rejects(
    () => generateTitle(empty, { deriveMessages: () => [], requestHeader: () => undefined }),
    /还没有可用的对话内容/,
  );
  assert.equal(empty.calls.length, 0);

  const noRoute = fakeCtx([textChunks('总结')]);
  await assert.rejects(
    () => generateTitle(noRoute, {
      deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      requestHeader: () => undefined,
    }),
    /无法确定/,
  );
  assert.equal(noRoute.calls.length, 0);
});

test('generateTitle caps an over-long title at 12 characters', async () => {
  const ctx = fakeCtx([
    textChunks('总结'),
    textChunks('一二三四五六七八九十甲乙丙丁戊己'),
  ]);
  const title = await generateTitle(ctx, sessionWith([
    { role: 'user', content: [{ type: 'text', text: '随便聊聊' }] },
  ]));
  assert.equal(Array.from(title).length, MAX_TITLE_CHARS);
  assert.equal(title, '一二三四五六七八九十甲乙');
});
