import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const localDatabaseId = '00000000-0000-4000-8000-000000000002';
const resourceName = z.string().regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/).max(63);
const deployment = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/).refine(value => !/^0+$/.test(value)),
  workerName: resourceName,
  databaseName: z.string().trim().min(1).max(64),
  databaseId: z.uuid().refine(value => value !== localDatabaseId),
  bucketName: resourceName.min(3),
  hostname: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)
    .refine(value => !value.endsWith('.example.com') && value !== 'example.com'),
  accessIssuer: z.string().regex(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/),
  accessAudience: z.string().regex(/^[a-f0-9]{64}$/).refine(value => !/^0+$/.test(value)),
}).strict();

export function loadDeployment(mode: string | undefined, directory = process.cwd()) {
  if (mode === 'development') return {
    accountId: undefined,
    workerName: 'home-inventory-local',
    databaseName: 'home-inventory-local',
    databaseId: localDatabaseId,
    bucketName: 'home-inventory-files-local',
    hostname: '',
    accessIssuer: 'https://local.cloudflareaccess.com',
    accessAudience: 'local-only',
  };
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(join(directory, 'deployment.local.json'), 'utf8'));
  } catch {
    throw new Error('Create deployment.local.json from deployment.example.json. See docs/DEPLOY.md.');
  }
  const parsed = deployment.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'configuration'))];
    throw new Error(`Invalid deployment.local.json fields: ${fields.join(', ')}. See docs/DEPLOY.md.`);
  }
  return parsed.data;
}
