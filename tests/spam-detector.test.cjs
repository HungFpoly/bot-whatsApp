const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(
  fs.readFileSync('src/moderation/spam-detector.ts', 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }
).outputText;
const api = {};
vm.runInNewContext(source, { exports: api });

test('spam state is isolated by group and sender and duplicate keeps the first message', () => {
  let now = 1_000;
  const detector = new api.SpamDetector(15_000, 2, 5, () => now++);
  const first = { key: { id: 'first' } };
  const repeat = { key: { id: 'repeat' } };
  assert.equal(detector.check('group-a', 'sender-a', 'same long message', first).messagesToDelete.length, 0);
  const result = detector.check('group-a', 'sender-a', 'same long message', repeat);
  assert.equal(result.messagesToDelete.length, 1);
  assert.equal(result.messagesToDelete[0].key.id, 'repeat');
  assert.equal(result.shouldWarn, true);
  assert.equal(detector.check('group-b', 'sender-a', 'same long message', {}).messagesToDelete.length, 0);
});
