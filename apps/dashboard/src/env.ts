import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
  /** Origin of the API (the Better Auth server the client talks to). */
  API_URL: {
    public: true,
    description: 'Origin of the burn-rate API (Better Auth server).',
    schema: (value) => value ?? 'http://localhost:8787'
  }
});
