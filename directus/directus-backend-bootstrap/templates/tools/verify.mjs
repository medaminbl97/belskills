import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadAccess } from '../scripts/apply-policies.js'
import {
  desiredSnapshot,
  loadDefinitions,
  loginAsAdmin,
  request as api,
  waitForDirectus,
} from '../scripts/schema-model.js'
import { loadSeeds } from '../scripts/seed-data.js'

// Live check of a running, freshly started backend. It reads the same YAML
// the image bakes in, so the expectations cannot drift from the schemas.
// Usage: DIRECTUS_URL=http://127.0.0.1:8055 ADMIN_EMAIL=... ADMIN_PASSWORD=... \
//          CMS_ENV=dev node tools/verify.mjs
const baseUrl = (process.env.DIRECTUS_URL ??= 'http://127.0.0.1:8055')
const dir = (name) => fileURLToPath(new URL(`../${name}/`, import.meta.url))

const definitions = await loadDefinitions(dir('schemas'))
const access = await loadAccess(dir('access'), definitions)
const reference = await loadSeeds(dir('seeds'), 'reference', definitions)
const examples = await loadSeeds(dir('seeds'), 'examples', definitions)
const withExamples = process.env.CMS_ENV === 'dev'
// Example rows are drafts unless the container started with SEED_PUBLISH_DEMO.
const seedStatus =
  process.env.SEED_PUBLISH_DEMO === 'true' ? 'published' : 'draft'

await waitForDirectus()
const token = await loginAsAdmin()

async function request(path) {
  const response = await fetch(new URL(path, baseUrl), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  })
  assert.ok(response.ok, `GET ${path.split('?')[0]} failed: ${response.status}`)
  return (await response.json()).data
}

const anonymous = (path, method = 'GET') =>
  fetch(new URL(path, baseUrl), { method, signal: AbortSignal.timeout(30_000) })

// 0. The instance matches the YAML: every revision is applied and none is
// missing. An empty diff comes back as null.
const live = (await api('/schema/snapshot', { token })).data
const pending = await api('/schema/diff', {
  method: 'POST',
  body: desiredSnapshot(live, definitions),
  token,
})
assert.equal(
  pending,
  null,
  'The YAML has changes no revision contains (run make revision)',
)

// 1. Every collection, field and relation exists as defined.
const collections = new Set(
  (await request('/collections')).map((item) => item.collection),
)
const relations = new Map(
  (await request('/relations')).map((item) => [
    `${item.collection}.${item.field}`,
    item,
  ]),
)
let fieldCount = 0
for (const definition of definitions) {
  assert.ok(collections.has(definition.collection), definition.collection)
  for (const field of definition.fields) {
    const live = await request(`/fields/${definition.collection}/${field.field}`)
    const label = `${definition.collection}.${field.field}`
    assert.equal(live.type, field.type, label)
    assert.equal(live.meta?.interface, field.meta?.interface, label)
    if (field.type === 'decimal') {
      assert.equal(live.schema.numeric_scale, field.schema.numeric_scale, label)
    }
    fieldCount++
  }
  for (const expected of definition.relations ?? []) {
    const key = `${definition.collection}.${expected.field}`
    const actual = relations.get(key)
    assert.equal(actual?.related_collection, expected.related_collection, key)
    assert.equal(actual.schema.on_delete, expected.schema.on_delete, key)
  }
}

// 2. Anonymous users read only what the Public policy declares, and never write.
const publicReadable = new Set(
  access
    .filter((doc) => doc.policy === 'public')
    .flatMap((doc) => doc.permissions)
    .filter((grant) => grant.action === 'read')
    .map((grant) => grant.collection),
)
for (const { collection } of definitions) {
  const get = await anonymous(`/items/${collection}?limit=1`)
  if (publicReadable.has(collection)) {
    assert.equal(get.status, 200, `Anonymous GET ${collection}`)
  } else {
    assert.ok(
      [401, 403].includes(get.status),
      `Anonymous GET ${collection} returned ${get.status}`,
    )
  }
  const post = await anonymous(`/items/${collection}`, 'POST')
  assert.ok(
    [401, 403].includes(post.status),
    `Anonymous POST ${collection} returned ${post.status}`,
  )
}

// 3. Every baked-in seed row exists with the YAML values.
let seedCount = 0
async function checkSeeds(seeds, expectedStatus) {
  for (const { collection, key, items } of seeds) {
    const rows = await request(`/items/${collection}?limit=-1&fields=*`)
    for (const item of items) {
      const row = rows.find((candidate) => candidate[key] === item[key])
      assert.ok(row, `${collection} seed ${item[key]} is missing`)
      for (const [name, value] of Object.entries(item)) {
        const expected =
          name === 'status' && value === 'draft' ? expectedStatus : value
        const label = `${collection}.${name} of ${item[key]}`
        // Directus returns decimal columns as strings ("12.50").
        const actual =
          typeof expected === 'number' && typeof row[name] === 'string'
            ? Number(row[name])
            : row[name]
        assert.equal(actual, expected, label)
      }
      seedCount++
    }
  }
}
await checkSeeds(reference, 'published')
if (withExamples) await checkSeeds(examples, seedStatus)

console.log(
  `Verified ${definitions.length} collections, ${fieldCount} fields, public read limited to ${[...publicReadable].join(', ')}, and ${seedCount} seed rows.`,
)
