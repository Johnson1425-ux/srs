const API_BASE = `${import.meta.env.VITE_API_URL ?? ''}/api/v1`;

const ACCESS_KEY = 'sms.accessToken';
const REFRESH_KEY = 'sms.refreshToken';

const SCHOOL_KEY = 'sms.activeSchoolId';

export const tokenStore = {
  access: (): string | null => localStorage.getItem(ACCESS_KEY),
  refresh: (): string | null => localStorage.getItem(REFRESH_KEY),
  set(accessToken: string, refreshToken?: string): void {
    localStorage.setItem(ACCESS_KEY, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  },
  clear(): void {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

/**
 * The school a super admin is currently working in.
 *
 * Platform staff belong to no school, so school-scoped routes have no tenant to
 * infer. Sending it as `X-School-Id` lets them work inside a chosen tenant. The
 * server only honours the header for SUPER_ADMIN, so a stale value in any other
 * account's storage is inert.
 */
export const schoolContext = {
  get: (): string | null => localStorage.getItem(SCHOOL_KEY),
  set(schoolId: string): void {
    localStorage.setItem(SCHOOL_KEY, schoolId);
  },
  clear(): void {
    localStorage.removeItem(SCHOOL_KEY);
  },
};

export interface FieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /**
   * Whatever the endpoint attached. Validation failures send a list of field
   * errors; others send an object of their own (a 402 carries the token that
   * leads back to an unpaid registration), so this stays `unknown` and callers
   * narrow it with the helpers below.
   */
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The per-field messages from a validation failure, or an empty list. */
export function fieldErrors(error: unknown): FieldError[] {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return [];
  return error.details.filter(
    (d): d is FieldError =>
      !!d && typeof d === 'object' && typeof (d as FieldError).field === 'string',
  );
}

/** A detail object an endpoint attached, e.g. `{ claimToken }` on a 402. */
export function errorDetail<T extends object>(error: unknown): T | null {
  if (!(error instanceof ApiError)) return null;
  const { details } = error;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  return details as T;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Set when the caller wants the raw Response (CSV downloads). */
  raw?: boolean;
}

/** Serialises one in-flight refresh so a burst of 401s doesn't stampede. */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = tokenStore.refresh();
  if (!refreshToken) return false;

  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { accessToken: string; refreshToken: string };
      tokenStore.set(data.accessToken, data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      // Allow the next 401 to trigger a fresh attempt.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();

  return refreshInFlight;
}

async function toError(res: Response): Promise<ApiError> {
  let code = 'UNKNOWN';
  let message = res.statusText || 'Request failed';
  let details;
  try {
    const body = await res.json();
    code = body?.error?.code ?? code;
    message = body?.error?.message ?? message;
    details = body?.error?.details;
  } catch {
    // non-JSON error body — keep the status text
  }
  return new ApiError(res.status, code, message, details);
}

async function send(path: string, options: RequestOptions, retry = true): Promise<Response> {
  const token = tokenStore.access();
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const activeSchool = schoolContext.get();
  if (activeSchool) headers.set('X-School-Id', activeSchool);
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    // FormData goes as it is: the browser has to set its own multipart
    // Content-Type with the boundary, and serialising it would send the string
    // "[object FormData]" instead of the file.
    body:
      options.body === undefined
        ? undefined
        : options.body instanceof FormData
          ? options.body
          : JSON.stringify(options.body),
  });

  // An expired access token gets one transparent refresh-and-retry.
  if (res.status === 401 && retry && tokenStore.refresh()) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return send(path, options, false);
    tokenStore.clear();
    window.dispatchEvent(new Event('sms:signed-out'));
  }

  return res;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await send(path, options);
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const get = <T,>(path: string) => api<T>(path);
export const post = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });
export const patch = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });
/** A body is optional, and used where a delete must be confirmed explicitly. */
export const del = <T,>(path: string, body?: unknown) =>
  api<T>(path, { method: 'DELETE', body });

/**
 * Uploads a file to an endpoint that takes multipart form data.
 *
 * `fields` carry the metadata alongside it — the server validates them from
 * the same request, so a file never arrives without the record it belongs to.
 */
export async function upload<T>(
  path: string,
  file: File,
  fields: Record<string, string | undefined> = {},
): Promise<T> {
  const form = new FormData();
  // The file goes last so that the server has parsed every field by the time
  // it reads the stream, which is what lets it reject one without buffering
  // the whole upload.
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== '') form.append(key, value);
  }
  form.append('file', file);

  return api<T>(path, { method: 'POST', body: form });
}

/** Triggers a browser download for the CSV export endpoints. */
export async function download(path: string, filename: string): Promise<void> {
  const res = await send(path, {});
  if (!res.ok) throw await toError(res);

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Builds a query string, dropping empty values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}
