import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

const seedsDir = '/directus/seeds';

export function seedEnvironment(environment = process.env.CMS_ENV ?? 'dev') {
  if (!['dev', 'prod'].includes(environment)) {
    throw new Error('CMS_ENV must be "dev" or "prod".');
  }
  return environment;
}

// Seed files marked `required: true` hold reference/configuration data and are
// loaded in every environment. All other seed files are examples (dev only).
function shouldSeed(seed, environment) {
  return environment === 'dev' || seed.required === true;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function loadSeeds(definitions, directoryRoot) {
  let namespaces;
  try {
    namespaces = await readdir(directoryRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const seeds = [];
  const seededCollections = new Set();

  for (const namespace of namespaces.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!namespace.isDirectory()) {
      throw new Error(`Expected a namespace directory in ${directoryRoot}: ${namespace.name}`);
    }

    const directory = path.join(directoryRoot, namespace.name);
    const files = await readdir(directory, { withFileTypes: true });
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || !/\.ya?ml$/i.test(file.name)) {
        throw new Error(`Expected a YAML file in ${directory}: ${file.name}`);
      }

      const filename = path.join(directory, file.name);
      const seed = yaml.load(await readFile(filename, 'utf8'));
      if (!isObject(seed) || typeof seed.collection !== 'string' || !Array.isArray(seed.items)
        || seed.items.length === 0
        || (seed.required !== undefined && typeof seed.required !== 'boolean')
        || Object.keys(seed).some((key) => !['collection', 'items', 'required'].includes(key))) {
        throw new Error(`Invalid seed file: ${filename}`);
      }

      const definition = definitions.find((item) => item.collection === seed.collection);
      if (!definition) {
        throw new Error(`Seed for unmanaged collection ${seed.collection} in ${filename}`);
      }
      if (seededCollections.has(seed.collection)) {
        throw new Error(`Duplicate seed for collection ${seed.collection} in ${filename}`);
      }
      seededCollections.add(seed.collection);

      const fields = new Set(definition.fields.map((field) => field.field));
      for (const item of seed.items) {
        if (!isObject(item) || Object.keys(item).some((key) => !fields.has(key))) {
          throw new Error(`Invalid seed item in ${filename}`);
        }
      }
      if (definition.meta.singleton === true && seed.items.length !== 1) {
        throw new Error(`Singleton ${seed.collection} must have exactly one seed item: ${filename}`);
      }

      seeds.push({ collection: seed.collection, items: seed.items, required: seed.required, definition });
    }
  }

  return seeds;
}

export async function seedData(definitions, request, token, options = {}) {
  const environment = seedEnvironment(options.environment);
  const seeds = await loadSeeds(definitions, options.seedsDir ?? seedsDir);

  // Inline schema `items` are reference data with stable keys: seeded in every
  // environment, never overwriting existing authored records.
  for (const definition of definitions) {
    const primary = definition.fields.find((field) => field.schema?.is_primary_key === true).field;
    for (const item of definition.items ?? []) {
      const query = new URLSearchParams({
        filter: JSON.stringify({ [primary]: { _eq: item[primary] } }),
        fields: primary,
        limit: '1',
      });
      const endpoint = `/items/${definition.collection}`;
      const existing = await request(`${endpoint}?${query}`, { token });
      if (existing.data.length === 0) {
        await request(endpoint, { method: 'POST', body: item, token });
        console.log(`Created seed item ${definition.collection}.${item[primary]}.`);
      }
    }
  }

  for (const { collection, items, definition } of seeds.filter((seed) => shouldSeed(seed, environment))) {
    const primary = definition.fields.find((field) => field.schema?.is_primary_key === true).field;
    const endpoint = `/items/${collection}`;

    if (definition.meta.singleton === true) {
      const existing = await request(`${endpoint}?${new URLSearchParams({ fields: '*' })}`, { token });
      if (existing.data?.[primary] == null) {
        await request(endpoint, { method: 'PATCH', body: items[0], token });
        console.log(`Seeded singleton ${collection}.`);
      }
      continue;
    }

    const existing = await request(`${endpoint}?${new URLSearchParams({ fields: primary, limit: '1' })}`, { token });
    if (existing.data.length === 0) {
      for (const item of items) {
        await request(endpoint, { method: 'POST', body: item, token });
      }
      console.log(`Seeded ${items.length} ${collection} item(s).`);
    }
  }
}
