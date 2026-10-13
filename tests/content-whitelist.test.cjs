const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(
  fs.readFileSync('src/moderation/content-whitelist.ts', 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }
).outputText;
const api = {};
vm.runInNewContext(source, { exports: api, console });

test('recognises the supplied official Laguna Park course identifiers', () => {
  assert.equal(
    api.getProtectedContentCategory('Digital For Life: Learn Digital @ Laguna Park Condo'),
    'official_laguna_park'
  );
  assert.equal(
    api.getProtectedContentCategory('MCST 3271 — 5000C Marine Parade Road'),
    'official_laguna_park'
  );
});

test('recognises genuine maintenance and estate-reporting context', () => {
  assert.equal(
    api.getProtectedContentCategory('Laguna Park lift is out of order; maintenance please inspect it'),
    'estate_report'
  );
  assert.equal(api.moderationThresholdFor('The common area has a water leak'), 1);
});

test('does not whitelist vague advertising or unrelated keyword stuffing', () => {
  assert.equal(api.getProtectedContentCategory('Best digital marketing course on sale now'), null);
  assert.equal(api.getProtectedContentCategory('Maintenance package promotion'), null);
  assert.equal(api.moderationThresholdFor('You are an idiot'), 1);
});

test('allows an AI decision that only identifies a festival greeting', () => {
  assert.equal(
    api.isAllowedFestivalGreetingDecision(
      'The image promotes a religious festival greeting, which contains a religious message.'
    ),
    true
  );
  assert.equal(api.isAllowedFestivalGreetingDecision('A brief festive greeting for Deepavali'), true);
});

test('does not exempt devotional or promotional religious material', () => {
  assert.equal(
    api.isAllowedFestivalGreetingDecision('Festival greeting with an invitation to a worship ceremony'),
    false
  );
  assert.equal(
    api.isAllowedFestivalGreetingDecision('Festival greeting containing a prayer and fundraising request'),
    false
  );
  assert.equal(api.isAllowedFestivalGreetingDecision('Religious sermon'), false);
});
