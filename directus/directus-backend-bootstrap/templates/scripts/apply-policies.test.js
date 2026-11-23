import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyPolicies } from './apply-policies.js';

const config = `
policies:
  - id: p1
    name: Website read-only
    user: { id: u1, first_name: Website, last_name: API Service }
    permissions:
      - { collection: articles, fields: ['*'], permissions: { status: { _eq: published } } }
`;

async function configFile(text) {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'policies-')), 'apps.yaml');
  await writeFile(file, text);
  return file;
}

function fakeApi() {
  const rows = { folders: [], policies: [], permissions: [], users: [], access: [] };
  let writes = 0;
  const request = async (endpoint, options = {}) => {
    const url = new URL(endpoint, 'http://localhost');
    const collection = url.pathname.split('/')[1];
    const method = options.method ?? 'GET';
    if (method === 'GET') {
      const [field, condition] = Object.entries(JSON.parse(url.searchParams.get('filter')))[0];
      return { data: rows[collection].filter((row) => row[field] === condition._eq).map((row) => ({ ...row })) };
    }
    writes++;
    const row = { ...options.body };
    if (collection === 'users') row.email = null;
    if (collection === 'permissions') row.id = rows.permissions.length + 1;
    if (collection === 'access') row.id = `access-${rows.access.length + 1}`;
    rows[collection].push(row);
    return { data: row };
  };
  return { rows, request, get writes() { return writes; } };
}

test('missing policy file is a no-op', async () => {
  const api = fakeApi();
  await applyPolicies(api.request, 't', '/nonexistent/apps.yaml');
  assert.equal(api.writes, 0);
});

test('reconciles a read-only policy and service user idempotently', async () => {
  const file = await configFile(config);
  const api = fakeApi();
  await applyPolicies(api.request, 't', file);
  assert.equal(api.rows.policies.length, 1);
  assert.ok(api.rows.policies.every((p) => !p.admin_access && !p.app_access));
  assert.ok(api.rows.permissions.every((p) => p.action === 'read'));
  assert.equal(api.rows.folders.length, 0);
  assert.deepEqual(api.rows.access.map(({ user, role, policy }) => ({ user, role, policy })),
    [{ user: 'u1', role: null, policy: 'p1' }]);
  const count = api.writes;
  await applyPolicies(api.request, 't', file);
  assert.equal(api.writes, count);
});

test('refuses to take over conflicting policies or unexpected permissions', async () => {
  const file = await configFile(config);
  const api = fakeApi();
  await applyPolicies(api.request, 't', file);
  api.rows.permissions.push({ policy: 'p1', collection: 'articles', action: 'update' });
  await assert.rejects(applyPolicies(api.request, 't', file), /Unexpected permissions/);
  api.rows.permissions.pop();
  api.rows.policies[0].admin_access = true;
  await assert.rejects(applyPolicies(api.request, 't', file), /already in use/);
});
