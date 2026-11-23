import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';

const policyFile = '/directus/policies/apps.yaml';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function same(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export async function applyPolicies(request, token, filename = policyFile) {
  let content;
  try {
    content = await readFile(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const config = yaml.load(content);
  // `folder` is optional: only needed when a policy grants access to files.
  if (!Array.isArray(config?.policies)
    || (config.folder !== undefined && (!config.folder?.id || !config.folder.name))) {
    throw new Error('Invalid application policy configuration');
  }
  const ids = new Set();
  const userIds = new Set();
  for (const policy of config.policies) {
    if (!policy.id || !policy.name || ids.has(policy.id) || !Array.isArray(policy.permissions)
      || !policy.user?.id || !policy.user.first_name || !policy.user.last_name
      || userIds.has(policy.user.id)
      || Object.keys(policy.user).some((key) => !['id', 'first_name', 'last_name'].includes(key))) {
      throw new Error('Invalid or duplicate application policy');
    }
    ids.add(policy.id);
    userIds.add(policy.user.id);
    const collections = new Set();
    for (const permission of policy.permissions) {
      if (!permission.collection || collections.has(permission.collection)
        || !Array.isArray(permission.fields) || permission.fields.length === 0
        || Object.keys(permission).some((key) => !['collection', 'fields', 'permissions'].includes(key))) {
        throw new Error(`Invalid permission in ${policy.name}`);
      }
      collections.add(permission.collection);
    }
  }
  const query = (filter) => new URLSearchParams({ filter: JSON.stringify(filter), limit: '-1' });
  if (config.folder) {
    const folders = (await request(`/folders?${query({ id: { _eq: config.folder.id } })}`, { token })).data;
    if (folders.length === 0) {
      await request('/folders', { method: 'POST', body: { ...config.folder, parent: null }, token });
    } else if (folders.length !== 1 || folders[0].name !== config.folder.name || folders[0].parent !== null) {
      throw new Error('Managed asset folder ID is already in use');
    }
  }

  for (const policy of config.policies) {
    const found = (await request(`/policies?${query({ id: { _eq: policy.id } })}`, { token })).data;
    if (found.length === 0) {
      await request('/policies', {
        method: 'POST', token,
        body: { id: policy.id, name: policy.name, admin_access: false, app_access: false },
      });
    } else if (found.length !== 1 || found[0].name !== policy.name
      || found[0].admin_access || found[0].app_access) {
      throw new Error(`Managed policy ID is already in use: ${policy.id}`);
    }
    const existing = (await request(`/permissions?${query({ policy: { _eq: policy.id } })}`, { token })).data;
    const expected = new Set(policy.permissions.map((item) => item.collection));
    if (existing.some((item) => item.action !== 'read' || !expected.has(item.collection))
      || new Set(existing.map((item) => item.collection)).size !== existing.length) {
      throw new Error(`Unexpected permissions on managed policy ${policy.name}; resolve manually`);
    }
    for (const item of policy.permissions) {
      const desired = {
        policy: policy.id, collection: item.collection, action: 'read',
        permissions: item.permissions ?? null, validation: null, presets: null, fields: item.fields,
      };
      const current = existing.find((row) => row.collection === item.collection);
      if (!current) {
        await request('/permissions', { method: 'POST', token, body: desired });
      } else if (!same(desired, Object.fromEntries(Object.keys(desired).map((key) => [key, current[key] ?? null])))) {
        await request(`/permissions/${current.id}`, { method: 'PATCH', token, body: desired });
      }
    }
    console.log(`Reconciled ${policy.name} (${policy.permissions.length} read permissions).`);
  }

  const userFields = 'id,first_name,last_name,email,status,role';
  const pending = [];
  for (const policy of config.policies) {
    const desired = { ...policy.user, email: null, status: 'active', role: null };
    const users = (await request(`/users?${query({ id: { _eq: desired.id } })}&fields=${userFields}`, { token })).data;
    if (users.length > 1 || (users.length === 1 && !same(users[0], desired))) {
      throw new Error(`Managed user ID is already in use or has unexpected attributes: ${desired.id}`);
    }
    const access = (await request(`/access?${query({ user: { _eq: desired.id } })}&fields=id,user,role,policy`, { token })).data;
    if (access.length > 1 || access.some((link) => link.user !== desired.id
      || link.role !== null || link.policy !== policy.id)) {
      throw new Error(`Unexpected access links for managed user ${desired.id}; resolve manually`);
    }
    pending.push({ desired, policy, exists: users.length === 1, linked: access.length === 1 });
  }
  for (const { desired, policy, exists, linked } of pending) {
    if (!exists) {
      const { email: _email, ...createUser } = desired;
      await request(`/users?fields=${userFields}`, { method: 'POST', token, body: createUser });
    }
    if (!linked) {
      await request('/access?fields=id,user,role,policy', {
        method: 'POST', token, body: { user: desired.id, role: null, policy: policy.id },
      });
    }
    console.log(`Reconciled service user ${desired.id} for ${policy.name}.`);
  }
}
