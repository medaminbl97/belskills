import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { seedData, seedEnvironment } from './seed-data.js';

const field = (name, extra = {}) => ({ field: name, type: 'string', schema: {}, meta: {}, ...extra });
const pk = { field: 'id', type: 'integer', schema: { is_primary_key: true }, meta: {} };
const definitions = [
  { collection: 'languages', schema: {}, meta: {}, fields: [{ ...pk, field: 'code', type: 'string' }, field('name')],
    items: [{ code: 'en', name: 'English' }] },
  { collection: 'articles', schema: {}, meta: {}, fields: [pk, field('title')] },
  { collection: 'settings', schema: {}, meta: { singleton: true }, fields: [pk, field('mode')] },
];

async function makeSeeds() {
  const dir = await mkdtemp(path.join(tmpdir(), 'seeds-'));
  await mkdir(path.join(dir, 'content'));
  await writeFile(path.join(dir, 'content/articles.yaml'),
    'collection: articles\nitems:\n  - title: Example\n');
  await writeFile(path.join(dir, 'content/settings.yaml'),
    'collection: settings\nrequired: true\nitems:\n  - mode: auto\n');
  return dir;
}

function fakeApi() {
  const rows = new Map();
  const writes = [];
  const request = async (endpoint, options = {}) => {
    const url = new URL(endpoint, 'http://localhost');
    const collection = url.pathname.split('/')[2];
    const definition = definitions.find((item) => item.collection === collection);
    const primary = definition.fields.find((f) => f.schema?.is_primary_key).field;
    const stored = rows.get(collection) ?? [];
    if (!options.method) {
      const filter = url.searchParams.get('filter');
      return { data: definition.meta.singleton ? stored[0] ?? {}
        : filter ? stored.filter((row) => row[primary] === JSON.parse(filter)[primary]._eq) : stored };
    }
    writes.push({ collection, method: options.method });
    stored.push({ [primary]: stored.length + 1, ...options.body });
    rows.set(collection, stored);
    return {};
  };
  return { rows, writes, request };
}

test('dev seeds examples, required seeds and inline items; reruns are idempotent', async () => {
  const seedsDir = await makeSeeds();
  const api = fakeApi();
  await seedData(definitions, api.request, 't', { environment: 'dev', seedsDir });
  assert.deepEqual([...new Set(api.writes.map((w) => w.collection))].sort(), ['articles', 'languages', 'settings']);
  const count = api.writes.length;
  await seedData(definitions, api.request, 't', { environment: 'dev', seedsDir });
  assert.equal(api.writes.length, count);
});

test('prod seeds only inline items and seed files marked required', async () => {
  const api = fakeApi();
  await seedData(definitions, api.request, 't', { environment: 'prod', seedsDir: await makeSeeds() });
  assert.deepEqual([...new Set(api.writes.map((w) => w.collection))].sort(), ['languages', 'settings']);
});

test('existing records are never overwritten', async () => {
  const api = fakeApi();
  api.rows.set('languages', [{ code: 'en', name: 'Authored' }]);
  api.rows.set('articles', [{ id: 1, title: 'Authored' }]);
  api.rows.set('settings', [{ id: 7, mode: 'manual' }]);
  await seedData(definitions, api.request, 't', { environment: 'dev', seedsDir: await makeSeeds() });
  assert.deepEqual(api.writes, []);
});

test('missing environment defaults to dev; unknown values fail before any request', async () => {
  const previous = process.env.CMS_ENV;
  delete process.env.CMS_ENV;
  try {
    assert.equal(seedEnvironment(), 'dev');
  } finally {
    if (previous !== undefined) process.env.CMS_ENV = previous;
  }
  for (const environment of ['', 'production', 'invalid']) {
    await assert.rejects(seedData(definitions, () => assert.fail('unexpected request'), 't', { environment }),
      /CMS_ENV must be "dev" or "prod"/);
  }
});

test('rejects seeds for unmanaged collections and unknown keys', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seeds-bad-'));
  await mkdir(path.join(dir, 'x'));
  await writeFile(path.join(dir, 'x/a.yaml'), 'collection: nope\nitems:\n  - a: 1\n');
  await assert.rejects(seedData(definitions, fakeApi().request, 't', { environment: 'dev', seedsDir: dir }), /unmanaged/);
  await writeFile(path.join(dir, 'x/a.yaml'), 'collection: articles\nbogus: 1\nitems:\n  - title: x\n');
  await assert.rejects(seedData(definitions, fakeApi().request, 't', { environment: 'dev', seedsDir: dir }), /Invalid seed file/);
});
