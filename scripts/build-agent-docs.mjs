import { copyFile } from 'node:fs/promises';

await copyFile(new URL('../docs/API.md', import.meta.url), new URL('../public/llms-full.txt', import.meta.url));
