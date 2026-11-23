import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import yaml from 'js-yaml';
import { seedData, seedEnvironment } from './seed-data.js';
import { applyPolicies } from './apply-policies.js';

const baseUrl = 'http://127.0.0.1:8056';
const schemasDir = '/directus/schemas';
const stateFile = '/directus/schema-state/managed-collections.json';

// Directus system collections that schemas are allowed to relate to (e.g. a
// file field). These never appear in `/schema/snapshot`'s `collections` or
// `fields` (that endpoint only reports custom, user-managed collections), so
// the usual "does the target collection exist" check can't see them, and
// their primary key can't be looked up the normal way either — every
// relation to one of these must set `schema.foreign_key_column` explicitly.
const SYSTEM_RELATION_TARGETS = new Set(['directus_files']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, changes) {
  const result = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    result[key] = isObject(value) && isObject(result[key])
      ? merge(result[key], value)
      : value;
  }
  return result;
}

async function loadDefinitions() {
  const definitions = [];
  const collectionNames = new Set();
  const namespaces = await readdir(schemasDir, { withFileTypes: true });

  for (const namespace of namespaces.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!namespace.isDirectory()) {
      throw new Error(`Expected a namespace directory in ${schemasDir}: ${namespace.name}`);
    }

    const directory = path.join(schemasDir, namespace.name);
    const files = await readdir(directory, { withFileTypes: true });
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || !/\.ya?ml$/i.test(file.name)) {
        throw new Error(`Expected a YAML file in ${directory}: ${file.name}`);
      }

      const filename = path.join(directory, file.name);
      const definition = yaml.load(await readFile(filename, 'utf8'));
      if (!isObject(definition) || typeof definition.collection !== 'string'
        || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(definition.collection)
        || definition.collection.startsWith('directus_')
        || !isObject(definition.schema) || !Array.isArray(definition.fields)
        || !isObject(definition.meta)) {
        throw new Error(`Invalid collection definition: ${filename}`);
      }
      if (Object.keys(definition).some((key) => !['collection', 'schema', 'meta', 'fields', 'relations', 'items'].includes(key))) {
        throw new Error(`Unsupported collection property in ${filename}`);
      }
      if (collectionNames.has(definition.collection)) {
        throw new Error(`Duplicate collection ${definition.collection} in ${filename}`);
      }
      collectionNames.add(definition.collection);

      const fields = new Set();
      for (const field of definition.fields) {
        if (!isObject(field) || typeof field.field !== 'string'
          || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(field.field)
          || typeof field.type !== 'string' || !isObject(field.meta)
          || (field.schema !== undefined && !isObject(field.schema)
            && !(field.type === 'alias' && field.schema === null))) {
          throw new Error(`Invalid field in ${filename}`);
        }
        if (Object.keys(field).some((key) => !['field', 'type', 'schema', 'meta'].includes(key))) {
          throw new Error(`Unsupported field property in ${filename}: ${field.field}`);
        }
        if (fields.has(field.field)) {
          throw new Error(`Duplicate field ${definition.collection}.${field.field} in ${filename}`);
        }
        fields.add(field.field);
      }
      if (!definition.fields.some((field) => field.schema?.is_primary_key === true)) {
        throw new Error(`Collection ${definition.collection} must declare a primary key`);
      }
      if (definition.relations !== undefined) {
        if (!Array.isArray(definition.relations)) {
          throw new Error(`Expected a relations array in ${filename}`);
        }
        const relationFields = new Set();
        for (const relation of definition.relations) {
          if (!isObject(relation) || !fields.has(relation.field)
            || typeof relation.related_collection !== 'string'
            || !isObject(relation.schema) || !isObject(relation.meta)
            || Object.keys(relation).some((key) => !['field', 'related_collection', 'schema', 'meta'].includes(key))
            || relationFields.has(relation.field)) {
            throw new Error(`Invalid or duplicate relation in ${filename}`);
          }
          relationFields.add(relation.field);
        }
      }
      if (definition.items !== undefined) {
        if (!Array.isArray(definition.items)) {
          throw new Error(`Expected an items array in ${filename}`);
        }
        const primary = definition.fields.find((field) => field.schema?.is_primary_key === true).field;
        const keys = new Set();
        for (const item of definition.items) {
          if (!isObject(item) || !['string', 'number'].includes(typeof item[primary])
            || Object.keys(item).some((key) => !fields.has(key)) || keys.has(item[primary])) {
            throw new Error(`Invalid or duplicate seed item in ${filename}`);
          }
          keys.add(item[primary]);
        }
      }
      definitions.push(definition);
    }
  }

  return definitions;
}

async function request(endpoint, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${endpoint} failed (${response.status}): ${text}`);
  }
  if (!text) return null;
  return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
}

async function waitForDirectus() {
  const deadline = Date.now() + 120000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await request('/server/ping');
      return;
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  }
  throw new Error(`Directus did not become ready: ${lastError?.message}`);
}

async function readManagedCollections() {
  let content;
  try {
    content = await readFile(stateFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const names = JSON.parse(content);
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
    throw new Error(`Invalid managed collection state: ${stateFile}`);
  }
  return names;
}

async function writeManagedCollections(names) {
  const temporary = `${stateFile}.tmp`;
  await writeFile(temporary, `${JSON.stringify([...new Set(names)].sort(), null, 2)}\n`);
  await rename(temporary, stateFile);
}

function desiredSnapshot(snapshot, definitions, previous) {
  const desiredNames = new Set(definitions.map((definition) => definition.collection));
  const managed = new Set([...previous, ...desiredNames]);
  const removed = new Set([...managed].filter((name) => !desiredNames.has(name)));
  const fieldsByCollection = new Map(
    definitions.map((definition) => [definition.collection, new Set(definition.fields.map((field) => field.field))]),
  );
  const relationsByCollection = new Map(
    definitions.filter((definition) => definition.relations !== undefined)
      .map((definition) => [definition.collection, definition.relations]),
  );
  for (const definition of definitions) {
    for (const relation of definition.relations ?? []) {
      const target = definitions.find((item) => item.collection === relation.related_collection);
      const targetExists = target || SYSTEM_RELATION_TARGETS.has(relation.related_collection)
        || snapshot.collections.some((item) => item.collection === relation.related_collection);
      if (!targetExists || removed.has(relation.related_collection)) {
        throw new Error(`Relation ${definition.collection}.${relation.field} references missing collection ${relation.related_collection}`);
      }
      if (SYSTEM_RELATION_TARGETS.has(relation.related_collection) && !relation.schema?.foreign_key_column) {
        throw new Error(`Relation ${definition.collection}.${relation.field} must set schema.foreign_key_column (target ${relation.related_collection} isn't introspectable)`);
      }
      if (target && relation.meta.one_field
        && !target.fields.some((field) => field.field === relation.meta.one_field && field.type === 'alias')) {
        throw new Error(`Relation ${definition.collection}.${relation.field} references missing alias ${relation.meta.one_field}`);
      }
    }
  }

  for (const relation of snapshot.relations) {
    if (!managed.has(relation.collection) && removed.has(relation.related_collection)) {
      throw new Error(`Cannot delete ${relation.related_collection}: unrelated collection ${relation.collection} references it`);
    }
    if (!managed.has(relation.collection) && desiredNames.has(relation.related_collection)
      && relation.schema?.foreign_key_column
      && !fieldsByCollection.get(relation.related_collection).has(relation.schema.foreign_key_column)) {
      throw new Error(`Cannot delete ${relation.related_collection}.${relation.schema.foreign_key_column}: unrelated collection ${relation.collection} references it`);
    }
  }

  const desired = structuredClone(snapshot);
  desired.collections = snapshot.collections.filter((collection) => !managed.has(collection.collection));
  desired.fields = snapshot.fields.filter((field) => !managed.has(field.collection));
  desired.relations = snapshot.relations.filter((relation) => {
    if (removed.has(relation.collection)) return false;
    if (relationsByCollection.has(relation.collection)) return false;
    if (desiredNames.has(relation.collection)) {
      return fieldsByCollection.get(relation.collection).has(relation.field);
    }
    return true;
  });

  for (const definition of definitions) {
    const name = definition.collection;
    const current = snapshot.collections.find((collection) => collection.collection === name);
    desired.collections.push({
      collection: name,
      schema: merge(current?.schema ?? { name }, definition.schema),
      meta: merge(current?.meta ?? { collection: name }, definition.meta),
    });

    for (const field of definition.fields) {
      const existing = snapshot.fields.find((item) => item.collection === name && item.field === field.field);
      desired.fields.push({
        ...existing,
        ...field,
        collection: name,
        schema: field.type === 'alias'
          ? null
          : merge(existing?.schema ?? { name: field.field, table: name }, field.schema ?? {}),
        meta: merge(existing?.meta ?? { collection: name, field: field.field }, field.meta),
      });
    }
    for (const relation of definition.relations ?? []) {
      const existing = snapshot.relations.find((item) => item.collection === name && item.field === relation.field);
      desired.relations.push({
        ...existing,
        collection: name,
        field: relation.field,
        related_collection: relation.related_collection,
        schema: merge(existing?.schema ?? {
          table: name,
          column: relation.field,
          foreign_key_table: relation.related_collection,
          foreign_key_column: definitions.find((item) => item.collection === relation.related_collection)
            ?.fields.find((field) => field.schema?.is_primary_key === true)?.field
            ?? snapshot.fields.find((field) => field.collection === relation.related_collection
              && field.schema?.is_primary_key === true)?.field,
        }, relation.schema),
        meta: merge(existing?.meta ?? {
          many_collection: name,
          many_field: relation.field,
          one_collection: relation.related_collection,
        }, relation.meta),
      });
    }
  }
  return desired;
}

async function main() {
  const environment = seedEnvironment();
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required for schema synchronization');
  }
  const definitions = await loadDefinitions();
  const previous = await readManagedCollections();
  await waitForDirectus();
  const login = await request('/auth/login', {
    method: 'POST',
    body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
  });
  const token = login.data.access_token;
  const snapshot = (await request('/schema/snapshot', { token })).data;
  const desired = desiredSnapshot(snapshot, definitions, previous);

  const diff = await request('/schema/diff', { method: 'POST', body: desired, token });
  const names = definitions.map((definition) => definition.collection);
  await writeManagedCollections([...previous, ...names]);
  if (diff?.data) {
    await request('/schema/apply', { method: 'POST', body: diff.data, token });
    console.log('Applied schema changes.');
  } else {
    console.log('Schemas are already up to date.');
  }
  await writeManagedCollections(names);
  await seedData(definitions, request, token, { environment });
  await applyPolicies(request, token);
}

main().catch((error) => {
  console.error(`Schema synchronization failed: ${error.message}`);
  process.exitCode = 1;
});
