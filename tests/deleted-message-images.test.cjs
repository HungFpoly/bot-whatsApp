const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const sharp = require('sharp');
function loadTs(file, mocks) {
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => mocks[name] || require(name), console: { log() {}, warn() {}, error() {} }, Buffer, AbortSignal, URL });
  return exports;
}
const message = content => ({ key: { id: 'id', participant: '0123@s.whatsapp.net' }, pushName: 'Sender', message: content });
function harness({ configured = true, storeFails = false, resizeFails = false } = {}) {
  const appended = [], dimensions = [];
  let row = 2;
  const config = { google: { sheetId: 'sheet' }, imageLog: { publicUrl: configured ? 'http://192.0.2.1:8080' : '' } };
  const sheets = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { title: 'Deleted Messages', sheetId: 0 } }] } }),
    batchUpdate: async args => { dimensions.push(args.requestBody.requests); if (resizeFails) throw Error('resize'); },
    values: { get: async () => ({ data: { values: [] } }), update: async () => {},
      append: async args => {
        const ownRow = row++; appended.push({ row: ownRow, args, values: args.requestBody.values[0] });
        await new Promise(resolve => setTimeout(resolve, ownRow % 2 ? 1 : 10));
        return { data: { updates: { updatedRange: `'Deleted Messages'!A${ownRow}:G${ownRow}` } } };
      },
    },
  } };
  return { appended, dimensions, ...loadTs('src/deleted-message-log.ts', {
    './config': { config },
    './image-log-store': { saveLogImage: async image => { if (storeFails) throw Error('disk full'); return `${config.imageLog.publicUrl}/images/${image.toString()}.jpg`; } },
    googleapis: { google: { auth: { GoogleAuth: class {} }, sheets: () => sheets } },
  }) };
}
test('text preserves literal content/phone; video and sticker remain excluded', async () => {
  const h = harness();
  await h.logDeletedMessage(message({ conversation: '=IMPORTXML("bad")' }), 'reason');
  await h.logDeletedMessage(message({ videoMessage: {} }), 'reason');
  await h.logDeletedMessage(message({ stickerMessage: {} }), 'reason');
  assert.equal(h.appended.length, 1);
  assert.equal(h.appended[0].values[2], "'0123");
  assert.equal(h.appended[0].values[4], "'=IMPORTXML(\"bad\")");
  assert.equal(h.appended[0].values[6], '');
});
test('concurrent images append matching captions and formulas in one request', async () => {
  const h = harness();
  await Promise.all(Array.from({ length: 8 }, (_, n) => h.logDeletedMessage(message({ imageMessage: { caption: `caption ${n}` } }), 'reason', Buffer.from(String(n)))));
  for (const entry of h.appended) {
    const n = entry.values[4].split(' ')[1];
    assert.equal(entry.args.valueInputOption, 'USER_ENTERED');
    assert.equal(entry.values[6], `=IMAGE("http://192.0.2.1:8080/images/${n}.jpg")`);
    assert.ok(h.dimensions.some(requests => requests[0].updateDimensionProperties.range.startIndex === entry.row - 1));
  }
  assert.equal(h.appended.length, 8);
});
test('missing setup, download and disk failure retain image log', async () => {
  for (const [options, buffer] of [[{ configured: false }, Buffer.from('x')], [{}, undefined], [{ storeFails: true }, Buffer.from('x')]]) {
    const h = harness(options);
    await h.logDeletedMessage(message({ imageMessage: {} }), 'reason', buffer);
    assert.equal(h.appended.length, 1);
    assert.equal(h.appended[0].values[4], "'[Image without caption]");
    assert.match(h.appended[0].values[6], /^Image unavailable:/);
  }
});
test('resize failure retains formula without duplicate row', async () => {
  const h = harness({ resizeFails: true });
  await h.logDeletedMessage(message({ imageMessage: {} }), 'reason', Buffer.from('x'));
  assert.equal(h.appended.length, 1);
  assert.match(h.appended[0].values[6], /^=IMAGE/);
});
test('real storage/HTTP serves only log images and survives restart', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-image-test-'));
  let server;
  const config = { imageLog: { publicUrl: 'http://192.0.2.1:8080', directory, port: 8080 } };
  const http = require('node:http');
  const store = loadTs('src/image-log-store.ts', { './config': { config }, 'node:http': {
    createServer: handler => { const s = http.createServer(handler); const listen = s.listen.bind(s); s.listen = (port, host, cb) => listen(0, '127.0.0.1', cb); return s; },
  } });
  try {
    const source = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: 'red' } }).png().toBuffer();
    const urls = await Promise.all([store.saveLogImage(source), store.saveLogImage(source)]);
    assert.notEqual(urls[0], urls[1]);
    assert.match(urls[0], /\/images\/[a-f0-9]{48}\.jpg$/);
    await assert.rejects(store.saveLogImage(Buffer.from('invalid')));
    for (let restart = 0; restart < 2; restart++) {
      server = await store.startImageLogServer();
      const origin = `http://127.0.0.1:${server.address().port}`;
      const imagePath = new URL(urls[0]).pathname;
      const response = await fetch(origin + imagePath);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/jpeg');
      assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).width, 1600);
      assert.equal((await fetch(origin + imagePath, { method: 'HEAD' })).status, 200);
      assert.equal((await fetch(origin + imagePath, { method: 'POST' })).status, 405);
      for (const target of ['/', '/images/', '/.env', '/session/creds.json', '/images/%2e%2e%2f.env', `/images/${'a'.repeat(48)}.jpg`]) assert.equal((await fetch(origin + target)).status, 404);
      await new Promise(resolve => server.close(resolve)); server = undefined;
    }
    config.imageLog.publicUrl = 'file:///tmp';
    await assert.rejects(store.startImageLogServer());
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
test('capture precedes deletion; download failure still logs; failed deletion does not log', async () => {
  for (const failure of ['', 'download', 'delete']) {
    const events = [], buffer = Buffer.from('image');
    const api = loadTs('src/moderation.ts', {
      './config': { config: { quietHours: { enabled: false }, bot: { minMessageLength: 5 } } },
      './ai': { analyzeMessage: async () => ({ isToxic: true, confidence: 1, reason: 'reason' }) },
      './deleted-message-log': { imageLoggingEnabled: () => true, logDeletedMessage: async (msg, reason, image) => { events.push('log'); assert.equal(image, failure === 'download' ? undefined : buffer); } },
      '@whiskeysockets/baileys': { downloadMediaMessage: async () => { events.push('download'); if (failure === 'download') throw Error('download'); return buffer; } },
    });
    await api.moderateMessage({ sendMessage: async (jid, content) => { events.push(content.delete ? 'delete' : 'notice'); if (failure === 'delete') throw Error('delete'); } }, 'group@g.us', message({ imageMessage: { caption: 'bad caption' } }));
    assert.deepEqual(events, failure === 'delete' ? ['download', 'delete'] : ['download', 'delete', 'notice', 'log']);
  }
});
