import { readFile, mkdir, open, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [command, id, extra] = process.argv.slice(2);
const origin = process.env.INVENTORY_URL;
if (!origin) throw new Error('Set INVENTORY_URL to your inventory HTTPS origin, or localhost for development.');
const url = new URL(origin);
const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
if ((!local && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
  throw new Error('INVENTORY_URL must be an HTTPS origin or local HTTP origin, without credentials, paths, or queries.');
}
const headers = new Headers();
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  headers.set('CF-Access-Client-Id', process.env.CF_ACCESS_CLIENT_ID);
  headers.set('CF-Access-Client-Secret', process.env.CF_ACCESS_CLIENT_SECRET);
} else if (url.protocol === 'https:') {
  throw new Error('Inject CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET through your secret manager.');
}
async function request(path, options = {}) {
  const response = await fetch(new URL(path, origin), { ...options, redirect: 'manual', headers: new Headers([...headers, ...new Headers(options.headers)]) });
  if (!response.ok) throw new Error(`Inventory returned HTTP ${response.status}. Check Access and the request.`);
  return response;
}
async function stdin() { let raw = ''; for await (const chunk of process.stdin) raw += chunk; return JSON.parse(raw); }
const output = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const jsonRequest = async (path, method, data) => (await request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).json();
const validId = value => { if (!/^[0-9a-f-]{36}$/i.test(value || '')) throw new Error('Supply an item UUID.'); return value; };

try {
  switch (command) {
    case 'list': output(await (await request(`/api/items?${new URLSearchParams({ q: id || '', limit: '200' })}`)).json()); break;
    case 'wishlist': output(await (await request(`/api/items?${new URLSearchParams({ status: 'wishlist', q: id || '', limit: '200' })}`)).json()); break;
    case 'get': output(await (await request(`/api/items/${validId(id)}`)).json()); break;
    case 'places': output((await (await request('/api/bootstrap')).json()).locations); break;
    case 'create': output(await jsonRequest('/api/items', 'POST', await stdin())); break;
    case 'update': output(await jsonRequest(`/api/items/${validId(id)}`, 'PUT', await stdin())); break;
    case 'share-status': output(await (await request(`/api/items/${validId(id)}/share`)).json()); break;
    case 'revoke-share': output(await jsonRequest(`/api/items/${validId(id)}/share`, 'DELETE', await stdin())); break;
    case 'share': {
      validId(id); const data = await stdin();
      if (extra) {
        const form = new FormData(); form.set('data', JSON.stringify(data));
        const jpeg = /\.jpe?g$/i.test(extra);
        form.set('photo', new File([await readFile(extra)], jpeg ? 'shared-photo.jpg' : 'shared-photo.webp', { type: jpeg ? 'image/jpeg' : 'image/webp' }));
        output(await (await request(`/api/items/${id}/share`, { method: 'POST', body: form })).json());
      } else output(await jsonRequest(`/api/items/${id}/share`, 'POST', data));
      break;
    }
    case 'delete': output(await jsonRequest(`/api/items/${validId(id)}`, 'DELETE', await stdin())); break;
    case 'comment': output(await jsonRequest(`/api/items/${validId(id)}/comments`, 'POST', await stdin())); break;
    case 'place': output(await jsonRequest('/api/locations', 'POST', await stdin())); break;
    case 'attach': {
      validId(id); if (!extra) throw new Error('Supply a file path.');
      const kind = process.argv[5] || 'photo';
      const extension = extra.split('.').pop().toLowerCase();
      const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', pdf: 'application/pdf', txt: 'text/plain' }[extension];
      if (!type) throw new Error('Unsupported attachment format.');
      const form = new FormData(); form.set('kind', kind); form.set('file', new File([await readFile(extra)], basename(extra), { type }));
      output(await (await request(`/api/items/${id}/attachments`, { method: 'POST', body: form })).json()); break;
    }
    case 'remove-file':
    case 'restore-file': {
      validId(id); validId(extra);
      const restore = command === 'restore-file';
      output(await (await request(`/api/items/${id}/attachments/${extra}${restore ? '/restore' : ''}`, { method: restore ? 'POST' : 'DELETE' })).json());
      break;
    }
    case 'export': {
      if (!id) throw new Error('Supply a new export directory.');
      await mkdir(id, { mode: 0o700 });
      const records = await (await request('/api/export')).json();
      await writeFile(join(id, 'inventory.json'), JSON.stringify(records, null, 2), { flag: 'wx', mode: 0o600 });
      await mkdir(join(id, 'files'), { mode: 0o700 });
      for (const file of records.attachments) {
        if (!/^[0-9a-f-]{36}$/i.test(file.id)) throw new Error('Invalid attachment ID.');
        const response = await request(`/api/files/${file.id}`);
        const outputFile = await open(join(id, 'files', file.id), 'wx', 0o600);
        await pipeline(Readable.fromWeb(response.body), outputFile.createWriteStream());
      }
      output({ directory: id, items: records.items.length, files: records.attachments.length }); break;
    }
    default: process.stdout.write('Usage: inventory.mjs list [query] | wishlist [query] | get ID | places | create < JSON | update ID < JSON | delete ID < JSON | share ID [PHOTO_PATH] < JSON | share-status ID | revoke-share ID < JSON | comment ID < JSON | place < JSON | attach ID PATH [kind] | remove-file ITEM_ID FILE_ID | restore-file ITEM_ID FILE_ID | export NEW_DIRECTORY\n');
  }
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
