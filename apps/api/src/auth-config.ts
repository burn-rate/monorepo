/** Public deployment inputs only. Secrets are read lazily for authenticated requests. */
export interface AuthEnvironment {
  /** Canonical names shared with the dashboard/main deployment. */
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  DASHBOARD_URL?: string;
  /** Explicit compatibility aliases; canonical values take precedence. */
  AUTH_SECRET?: string;
  AUTH_BASE_URL?: string;
  DASHBOARD_ORIGINS?: string;
  PASSKEY_RP_ID?: string;
  PASSKEY_RP_NAME?: string;
  AUTH_COOKIE_SAME_SITE?: 'lax' | 'strict' | 'none';
}

export class AuthError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthConfig {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  passkeyOrigins: string[];
  rpID: string;
  rpName: string;
  secureCookies: boolean;
  sameSite: 'lax' | 'strict' | 'none';
}

export function readAuthConfig(env: AuthEnvironment): AuthConfig {
  try {
    const secret = env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET;
    const baseURL = env.BETTER_AUTH_URL ?? env.AUTH_BASE_URL;
    if (!secret || secret.length < 32 || !baseURL) throw new Error();
    const api = new URL(baseURL);
    const origins: unknown = env.DASHBOARD_URL !== undefined
      ? [env.DASHBOARD_URL]
      : JSON.parse(env.DASHBOARD_ORIGINS ?? 'null');
    if (!Array.isArray(origins) || origins.length === 0 || origins.some((o) => typeof o !== 'string')) throw new Error();
    const checkedOrigins = (origins as string[]).map((origin) => {
      const url = new URL(origin);
      if (origin !== url.origin || url.username || url.password) throw new Error();
      return url;
    });
    if (baseURL !== api.origin || api.username || api.password) throw new Error();
    const isLocal = (url: URL) => url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if ([api, ...checkedOrigins].some((url) => url.protocol !== 'https:' && !(isLocal(url) && url.protocol === 'http:'))) throw new Error();
    const rpID = env.PASSKEY_RP_ID;
    if (!rpID || rpID.includes('/') || rpID.includes(':') || rpID.startsWith('.') || rpID.endsWith('.')) throw new Error();
    if (checkedOrigins.some((url) => url.hostname !== rpID && !url.hostname.endsWith(`.${rpID}`))) throw new Error();
    const sameSite = env.AUTH_COOKIE_SAME_SITE ?? 'lax';
    if (!['lax', 'strict', 'none'].includes(sameSite) || (sameSite === 'none' && api.protocol !== 'https:')) throw new Error();
    if (!env.PASSKEY_RP_NAME?.trim()) throw new Error();
    return {
      secret,
      baseURL: api.origin,
      trustedOrigins: [...new Set([api.origin, ...checkedOrigins.map((url) => url.origin)])],
      passkeyOrigins: [...new Set(checkedOrigins.map((url) => url.origin))],
      rpID,
      rpName: env.PASSKEY_RP_NAME,
      secureCookies: api.protocol === 'https:',
      sameSite
    };
  } catch {
    throw new AuthError(503, 'AUTH_CONFIGURATION_UNAVAILABLE', 'Authentication is unavailable.');
  }
}

/** Browser mutations require an exact configured Origin, including custom onboarding routes. */
export function assertTrustedMutation(request: Request, config: Pick<AuthConfig, 'trustedOrigins'>): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('Origin');
  if (!origin || !config.trustedOrigins.includes(origin)) {
    throw new AuthError(403, 'UNTRUSTED_ORIGIN', 'The request origin is not allowed.');
  }
}
