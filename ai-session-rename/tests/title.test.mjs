import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_TITLE_CHARS,
  buildUserPrompt,
  collectConversation,
  normalizeTitle,
  resolveRoute,
} from '../lib/title.js';

test('normalizeTitle strips quotes, prefixes, fences, and trailing punctuation', () => {
  assert.equal(normalizeTitle('“AI 重命名会话”'), 'AI 重命名会话');
  assert.equal(normalizeTitle('标题：重命名插件。'), '重命名插件');
  assert.equal(normalizeTitle('```\n重命名插件\n```'), '重命名插件');
  assert.equal(normalizeTitle('  "  hello world  "  '), 'hello world');
  assert.equal(normalizeTitle('多行\n标题'), '多行 标题');
  assert.equal(normalizeTitle(''), '');
  assert.equal(normalizeTitle(null), '');
});

test('normalizeTitle caps the title at 12 characters without splitting surrogate pairs', () => {
  assert.equal(Array.from(normalizeTitle('一二三四五六七八九十甲乙丙丁')).length, MAX_TITLE_CHARS);
  assert.equal(normalizeTitle('一二三四五六七八九十甲乙丙丁'), '一二三四五六七八九十甲乙');
  assert.equal(Array.from(normalizeTitle('😀😀😀😀😀😀😀😀😀😀😀😀😀')).length, MAX_TITLE_CHARS);
  assert.equal(normalizeTitle('  短  '), '短');
});

test('collectConversation keeps only text blocks from user and assistant messages', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '帮我改插件' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '不应出现' },
        { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        { type: 'text', text: '可用的回答' },
      ],
    },
    { role: 'tool', content: [{ type: 'text', text: '不应出现' }] },
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
  ];
  const text = collectConversation({ deriveMessages: () => messages });
  assert.equal(text, '用户：帮我改插件\n\n助手：可用的回答\n\n用户：继续');
  assert.ok(!text.includes('不应出现'));
});

test('collectConversation keeps the first exchange and the latest messages on long logs', () => {
  const messages = [];
  for (let index = 0; index < 20; index += 1) {
    messages.push({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `第${index}条` }],
    });
  }
  const text = collectConversation({ deriveMessages: () => messages });
  assert.ok(text.startsWith('用户：第0条'));
  assert.ok(text.includes('第19条'));
  assert.ok(!text.includes('第5条'));
});

test('collectConversation returns empty without usable text', () => {
  assert.equal(collectConversation({ deriveMessages: () => [] }), '');
  assert.equal(collectConversation({ deriveMessages: () => [{ role: 'user', content: [] }] }), '');
  assert.equal(collectConversation({}), '');
});

test('buildUserPrompt states the 12-character bound', () => {
  const prompt = buildUserPrompt('用户：你好');
  assert.ok(prompt.includes('用户：你好'));
  assert.ok(prompt.includes(`${MAX_TITLE_CHARS} 个汉字`));
});

test('resolveRoute prefers the logged request header and falls back to the default model', () => {
  const session = {
    requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash' } }),
  };
  assert.deepEqual(resolveRoute({}, session), { provider: 'deepseek-account', model: 'deepseek-flash' });

  const fallback = resolveRoute(
    { get: (name) => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'local', model: 'm1' }) } : undefined) },
    { requestHeader: () => undefined },
  );
  assert.deepEqual(fallback, { provider: 'local', model: 'm1' });

  assert.equal(resolveRoute({}, { requestHeader: () => undefined }), null);
});
