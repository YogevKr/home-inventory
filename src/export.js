import { Zip, ZipPassThrough, strToU8 } from 'fflate';

export async function exportArchive({ read, onProgress }) {
  const records = await read('/api/export');
  const total = records.attachments.reduce((sum, file) => sum + file.size, 0);
  if (total > 300 * 1024 * 1024) throw new Error('This export exceeds 300 MB. Use the agent export command for a full backup.');
  const chunks = [];
  let failure;
  const archive = new Zip((error, data) => { if (error) failure = error; else chunks.push(data); });
  const metadata = new ZipPassThrough('inventory.json');
  archive.add(metadata);
  metadata.push(strToU8(JSON.stringify(records, null, 2)), true);
  for (let index = 0; index < records.attachments.length; index++) {
    const file = records.attachments[index];
    onProgress(`Preparing file ${index + 1} of ${records.attachments.length}…`);
    const response = await fetch(`/api/files/${encodeURIComponent(file.id)}`);
    if (!response.ok || !response.body) throw new Error(`Could not export ${file.filename}. Please sign in and try again.`);
    const entry = new ZipPassThrough(`files/${file.id}/${file.filename.replace(/[^\p{L}\p{N}._ -]/gu, '_')}`);
    archive.add(entry);
    const reader = response.body.getReader();
    for (;;) { const { value, done } = await reader.read(); if (done) break; entry.push(value); }
    entry.push(new Uint8Array(), true);
  }
  archive.end();
  if (failure) throw failure;
  const url = URL.createObjectURL(new Blob(chunks, { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `kriger-home-${new Date().toISOString().slice(0, 10)}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
