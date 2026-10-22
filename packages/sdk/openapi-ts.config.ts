import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  input: '../../openapi/openapi.json',
  output: { path: 'src/generated', postProcess: [] },
  plugins: ['@hey-api/typescript', '@hey-api/sdk', '@hey-api/client-fetch']
});
