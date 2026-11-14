import { VIRTUAL_BASE } from "./backend";

/**
 * The one fetch client for /app traffic, in dits' contract-first shape: all
 * frontend-to-backend calls go through here, so the virtual origin, the
 * versioned prefix, and header conventions live in a single module.
 */

export interface ApiRequest {
  method: string;
  /** Either a contract path ("/api/v1/items") or a full virtual path. */
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export const toVirtualPath = (path: string): string =>
  path.startsWith("/__virtual__/")
    ? path
    : `${VIRTUAL_BASE}${path.startsWith("/") ? path : `/${path}`}`;

export const apiFetch = ({ method, path, headers, body }: ApiRequest): Promise<Response> =>
  fetch(toVirtualPath(path), {
    method,
    headers,
    ...(body && method !== "GET" ? { body } : {}),
  });
