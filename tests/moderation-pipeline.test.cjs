const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(
  fs.readFileSync('src/moderation/moderation-pipeline.ts', 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }
).outputText;
const api = {};
vm.runInNewContext(source, { exports: api });

test('pipeline preserves order and stops at the first terminal rule', async () => {
  const calls = [];
  const rule = (name, stop = false) => ({
    name,
    execute: async context => {
      calls.push(`${name}:${context.id}`);
      return stop;
    },
  });
  await api.runModerationPipeline(
    [rule('quiet'), rule('sticker', true), rule('media')],
    { id: 'message-1' }
  );
  assert.deepEqual(calls, ['quiet:message-1', 'sticker:message-1']);
});
