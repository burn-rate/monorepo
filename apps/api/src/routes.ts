import { createRoute, OpenAPIHono, z, type RouteConfig, type RouteConfigToTypedResponse } from '@hono/zod-openapi';
import {
  apiErrorSchema, createIngestionTokenResponseSchema, createIngestionTokenSchema,
  currentUserSchema, healthResponseSchema, healthSamplesQuerySchema,
  healthSamplesResponseSchema, hookStorageFailureSchema, hookSuccessSchema,
  ingestionTokensResponseSchema, loanRequestInputSchema, loanRequestResponseSchema,
  metricsResponseSchema, revokeIngestionTokenResponseSchema,
  timeseriesHealthResponseSchema,
  type CreateIngestionTokenInput, type HealthSamplesQuery, type LoanRequestInput
} from '@burn-rate/api-schema';
import type { Context } from 'hono';

export type ApiEnvironment<B extends object> = { Bindings: B; Variables: { requestId: string } };
export interface ApiRequest<B extends object> { request: Request; env: B; requestId: string }

/** Callbacks are evaluated only for a matched request, never during export. */
export interface ApiServices<B extends object> {
  timeseriesHealth(context: ApiRequest<B>): Promise<Response>;
  getCurrentUser(context: ApiRequest<B>): Promise<Response>;
  listMetrics(context: ApiRequest<B>): Promise<Response>;
  listHealthSamples(context: ApiRequest<B>, query: HealthSamplesQuery): Promise<Response>;
  createIngestionToken(context: ApiRequest<B>, input: CreateIngestionTokenInput): Promise<Response>;
  listIngestionTokens(context: ApiRequest<B>): Promise<Response>;
  revokeIngestionToken(context: ApiRequest<B>, id: string): Promise<Response>;
  createLoanRequest(context: ApiRequest<B>, input: LoanRequestInput): Promise<Response>;
  ingest(context: ApiRequest<B>): Promise<Response>;
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description, content: { 'application/json': { schema } }
});
const failure = apiErrorSchema.openapi('ApiError');
const errors = {
  400: json(failure, 'Invalid request or cursor.'),
  401: json(failure, 'A valid session is required.'),
  403: json(failure, 'Trusted origin or fresh passkey verification is required.'),
  429: json(failure, 'Rate limit exceeded; retry later.'),
  503: json(failure, 'Service unavailable; retry later.')
};
const session = [{ sessionCookie: [] }];
const bearer = [{ ingestionBearer: [] }];

export const applicationRoutes = {
  health: createRoute({ method: 'get', path: '/health', operationId: 'getHealth', tags: ['diagnostics'],
    responses: { 200: json(healthResponseSchema.openapi('HealthResponse'), 'Public liveness.') } }),
  timeseriesHealth: createRoute({ method: 'get', path: '/timeseries/health', operationId: 'getTimeseriesHealth',
    security: session, tags: ['diagnostics'], responses: {
      200: json(timeseriesHealthResponseSchema.openapi('TimeseriesHealthResponse'), 'Authenticated database diagnostic.'),
      401: errors[401], 503: errors[503]
    } }),
  getCurrentUser: createRoute({ method: 'get', path: '/api/me', operationId: 'getCurrentUser', security: session,
    tags: ['account'], responses: { 200: json(currentUserSchema.openapi('CurrentUser'), 'Current account.'), ...errors } }),
  listMetrics: createRoute({ method: 'get', path: '/api/metrics', operationId: 'listMetrics', security: session,
    tags: ['health'], responses: { 200: json(metricsResponseSchema.openapi('MetricsResponse'), 'Supported metrics.'), ...errors } }),
  listHealthSamples: createRoute({ method: 'get', path: '/api/health/samples', operationId: 'listHealthSamples',
    security: session, tags: ['health'],
    description: 'Samples owned by the session, ordered by time then ID. The range is [from,to), at most 31 days. Cursors are bound to the owner and filters; concurrent imports do not provide snapshot isolation.',
    request: { query: healthSamplesQuerySchema },
    responses: { 200: json(healthSamplesResponseSchema.openapi('HealthSamplesResponse'), 'Decrypted observations, or an empty items array.'), ...errors } }),
  createIngestionToken: createRoute({ method: 'post', path: '/api/ingestion-tokens', operationId: 'createIngestionToken',
    security: session, tags: ['ingestion credentials'], description: 'Requires passkey verification within five minutes. The secret is disclosed only once.',
    request: { body: { required: true, content: { 'application/json': { schema: createIngestionTokenSchema.openapi('CreateIngestionToken') } } } },
    responses: { 201: json(createIngestionTokenResponseSchema.openapi('CreatedIngestionToken'), 'Created credential and its one-time secret.'), ...errors } }),
  listIngestionTokens: createRoute({ method: 'get', path: '/api/ingestion-tokens', operationId: 'listIngestionTokens',
    security: session, tags: ['ingestion credentials'], responses: { 200: json(ingestionTokensResponseSchema.openapi('IngestionTokensResponse'), 'Owned credentials without secrets.'), ...errors } }),
  revokeIngestionToken: createRoute({ method: 'delete', path: '/api/ingestion-tokens/{id}', operationId: 'revokeIngestionToken',
    security: session, tags: ['ingestion credentials'], description: 'Revocation is idempotent for an already revoked credential owned by the session. Foreign IDs are indistinguishable from missing IDs.',
    request: { params: z.object({ id: z.string().min(1).max(256).openapi({ param: { name: 'id', in: 'path' } }) }) },
    responses: { 200: json(revokeIngestionTokenResponseSchema.openapi('RevokedIngestionToken'), 'Credential revoked.'), 404: json(failure, 'Credential not found.'), ...errors } }),
  createLoanRequest: createRoute({ method: 'post', path: '/loan', operationId: 'createLoanRequest', tags: ['loans'],
    description: 'Stub: validates a treat loan request and echoes the agreed terms. No credit decision, persistence, or session requirement yet.',
    request: { body: { required: true, content: { 'application/json': { schema: loanRequestInputSchema.openapi('CreateLoanRequest') } } } },
    responses: { 201: json(loanRequestResponseSchema.openapi('LoanRequestRecord'), 'Stubbed loan request with computed term and placeholder requirement.'), 400: errors[400] } }),
  hook: createRoute({ method: 'post', path: '/hook', operationId: 'uploadHealthPayload', security: bearer,
    tags: ['exporter'], description: 'Exporter ingestion only. A browser session does not authorize upload. Both supported exporter formats and unknown/non-JSON captures are encrypted before retention.',
    request: { body: { required: true, content: {
      'application/json': { schema: z.unknown() }, 'text/plain': { schema: z.string() }
    } } },
    responses: { 200: json(hookSuccessSchema.openapi('HookSuccess'), 'Durably captured encrypted upload and mapping counters.'),
      401: json(failure, 'A valid ingestion bearer token is required.'),
      405: json(failure, 'Only POST is accepted.'), 413: json(failure, 'Payload exceeds configured byte limit.'),
      429: errors[429], 502: json(hookStorageFailureSchema.openapi('HookStorageFailure'), 'Encrypted dump or sample storage failed; retry upload.'), 503: errors[503] } })
};

const contextFor = <B extends object>(c: Context<ApiEnvironment<B>>): ApiRequest<B> => ({
  request: c.req.raw, env: c.env, requestId: c.get('requestId') || crypto.randomUUID()
});

export function registerApiRoutes<B extends object>(app: OpenAPIHono<ApiEnvironment<B>>, services: ApiServices<B>) {
  app.openAPIRegistry.registerComponent('securitySchemes', 'sessionCookie', {
    type: 'apiKey', in: 'cookie', name: 'better-auth.session_token',
    description: 'Better Auth HttpOnly session cookie; production uses its Secure-prefixed variant. Set credentials: include in browser Fetch. WebAuthn ceremonies use Better Auth passkeyClient.'
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'ingestionBearer', {
    type: 'http', scheme: 'bearer', description: 'Per-user revocable exporter credential. Never authorizes account or health reads.'
  });
  app.openapi(applicationRoutes.health, (c) => c.json({ status: 'ok' as const, service: 'burn-rate-api' as const }));
  app.openapi(applicationRoutes.timeseriesHealth, (c) => contractResponse(applicationRoutes.timeseriesHealth, services.timeseriesHealth(contextFor(c))));
  app.openapi(applicationRoutes.getCurrentUser, (c) => contractResponse(applicationRoutes.getCurrentUser, services.getCurrentUser(contextFor(c))));
  app.openapi(applicationRoutes.listMetrics, (c) => contractResponse(applicationRoutes.listMetrics, services.listMetrics(contextFor(c))));
  app.openapi(applicationRoutes.listHealthSamples, (c) => contractResponse(applicationRoutes.listHealthSamples, services.listHealthSamples(contextFor(c), c.req.valid('query'))), validationError);
  app.openapi(applicationRoutes.createIngestionToken, (c) => contractResponse(applicationRoutes.createIngestionToken, services.createIngestionToken(contextFor(c), c.req.valid('json'))), validationError);
  app.openapi(applicationRoutes.listIngestionTokens, (c) => contractResponse(applicationRoutes.listIngestionTokens, services.listIngestionTokens(contextFor(c))));
  app.openapi(applicationRoutes.revokeIngestionToken, (c) => contractResponse(applicationRoutes.revokeIngestionToken, services.revokeIngestionToken(contextFor(c), c.req.valid('param').id)), validationError);
  app.openapi(applicationRoutes.createLoanRequest, (c) => contractResponse(applicationRoutes.createLoanRequest, services.createLoanRequest(contextFor(c), c.req.valid('json'))), validationError);
  // Register the body contract without a validator: ingestion must authenticate
  // and enforce its byte limit before parsing or retaining any request body.
  app.openAPIRegistry.registerPath(applicationRoutes.hook);
  app.post('/hook', (c) => services.ingest(contextFor(c)));
  app.get('/openapi.json', (c) => c.json(getOpenApiDocument(app)));
}

/** Validate lazy service output against the very schema published in OpenAPI. */
async function contractResponse<R extends RouteConfig>(route: R, pending: Promise<Response>): Promise<RouteConfigToTypedResponse<R>> {
  const response = await pending;
  const declaration = route.responses[response.status];
  const media = declaration && 'content' in declaration && declaration.content?.['application/json'];
  const schema = media && 'schema' in media && media.schema;
  if (!(schema instanceof z.ZodType)) throw new Error('Undocumented service response');
  const data = schema.parse(await response.json());
  // Runtime status selection cannot be represented by TypeScript's mapped
  // status union; both status and body have now been checked against that union.
  return Response.json(data, { status: response.status, headers: response.headers }) as Response & RouteConfigToTypedResponse<R>;
}

function validationError<B extends object>(result: { success: boolean }, c: Context<ApiEnvironment<B>>) {
  if (!result.success) {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: { code: 'invalid-request', message: 'Invalid request parameters.', requestId: contextFor(c).requestId } }, 400);
  }
}

export function getOpenApiDocument<B extends object>(app: OpenAPIHono<ApiEnvironment<B>>) {
  return app.getOpenAPI31Document({
    openapi: '3.1.0', info: {
      title: 'Burn Rate API', version: '1.0.0',
      description: 'Application contracts. Better Auth endpoints at /api/auth/* use Better Auth and passkeyClient contracts and are intentionally not duplicated here.'
    }
  });
}

/** Export only: constructing the registry cannot instantiate runtime services. */
export function createOfflineContractApp() {
  const unavailable = async () => Response.json({ error: { code: 'unavailable', message: 'Runtime services are not configured.', requestId: 'offline' } }, { status: 503 });
  const app = new OpenAPIHono<ApiEnvironment<Record<string, never>>>();
  registerApiRoutes(app, {
    timeseriesHealth: unavailable, getCurrentUser: unavailable, listMetrics: unavailable,
    listHealthSamples: unavailable, createIngestionToken: unavailable,
    listIngestionTokens: unavailable, revokeIngestionToken: unavailable,
    createLoanRequest: unavailable, ingest: unavailable
  });
  return app;
}
