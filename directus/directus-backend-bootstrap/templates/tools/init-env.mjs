import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const value = () => randomBytes(32).toString('hex')
const file = new URL('../.env', import.meta.url)

const keyOf = (line) => line.match(/^([A-Z0-9_]+)=/)?.[1]

let current = ''
try {
  current = await readFile(file, 'utf8')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

// Adds missing keys only; existing values are never changed or printed.
const present = new Set(current.split('\n').map(keyOf))
const entries = [
  ['DIRECTUS_PORT', '8055'],
  ['ADMIN_EMAIL', 'admin@example.com'],
  ['ADMIN_PASSWORD', value()],
  ['DB_PASSWORD', value()],
  ['SECRET', value()],
  ['CMS_ENV', 'dev'],
].filter(([key]) => !present.has(key))

if (entries.length) {
  const prefix = current && !current.endsWith('\n') ? '\n' : ''
  const lines = entries.map(([key, entryValue]) => `${key}=${entryValue}`)
  await writeFile(file, `${current}${prefix}${lines.join('\n')}\n`, {
    mode: 0o600,
  })
}
console.log(
  `.env: ${entries.length ? `added ${entries.map(([key]) => key).join(', ')}` : 'complete'}\nExisting values were not changed.`,
)
