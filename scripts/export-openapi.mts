import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createOfflineContractApp, getOpenApiDocument } from '../apps/api/src/routes';

const destination = new URL('../openapi/openapi.json', import.meta.url);
await mkdir(fileURLToPath(new URL('.', destination)), { recursive: true });
await writeFile(destination, `${JSON.stringify(getOpenApiDocument(createOfflineContractApp()), null, 2)}\n`);
