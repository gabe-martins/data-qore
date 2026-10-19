import type { components } from "./api-schema";
export type Model<K extends keyof components["schemas"]> =
  components["schemas"][K];
export type Page<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};
export type User = {
  id: string;
  email: string;
  display_name: string;
  role: string;
};
let accessToken: string | null = null;
let refreshPromise: Promise<User | null> | null = null;
let onExpired: () => void = () => {};
export function onSessionExpired(fn: () => void) {
  onExpired = fn;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
  ) {
    super(message);
  }
}
async function read(response: Response) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      "invalid_response",
      "Unable to read the server response.",
    );
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.code ?? "request_failed",
      data.message ?? "Request failed.",
      data.request_id,
    );
  return data;
}
export async function refresh(): Promise<User | null> {
  if (!refreshPromise)
    refreshPromise = (async () => {
      try {
        const data = await read(
          await fetch("/api/v1/auth/refresh", {
            method: "POST",
            credentials: "same-origin",
          }),
        );
        accessToken = data.access_token;
        return data.user;
      } catch {
        accessToken = null;
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
  return refreshPromise;
}
export async function login(email: string, password: string): Promise<User> {
  const r = await read(
    await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  accessToken = r.access_token;
  return r.user;
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/v1" + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
        ...(accessToken ? { Authorization: "Bearer " + accessToken } : {}),
      },
    });
  } catch {
    throw new ApiError(
      0,
      "network_error",
      "The controller is unavailable. Check the local processes.",
    );
  }
  if (response.status === 401 && retry) {
    if (await refresh()) return api(path, options, false);
    accessToken = null;
    onExpired();
  }
  return read(response);
}
export const post = <T = any>(path: string, body: unknown = {}, key?: string) =>
  api<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: key ? { "Idempotency-Key": key } : {},
  });
export const patch = <T = any>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export async function logout() {
  try {
    await post("/auth/logout");
  } finally {
    accessToken = null;
  }
}
// Select controls collect the paginated catalog without silently truncating it.
export async function allPages<T>(path: string): Promise<Page<T>> {
  const items: T[] = [];
  let total = 0;
  do {
    const page = await api<Page<T>>(
      `${path}${path.includes("?") ? "&" : "?"}limit=200&offset=${items.length}`,
    );
    total = page.total;
    items.push(...page.items);
    if (!page.items.length) break;
  } while (items.length < total);
  return { items, total, limit: items.length, offset: 0 };
}
