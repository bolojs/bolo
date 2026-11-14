import * as v from "valibot";

/**
 * The /app contract, in dits' contract-first shape: routes are versioned
 * under a single prefix, schemas are defined once here and consumed by both
 * sides (the backend route handlers receive them through the route context,
 * the request/response UI validates payloads against them), and all traffic
 * goes through one fetch client (client.ts).
 */

export const API_PREFIX = "/api/v1";

export const itemSchema = v.object({
  id: v.number(),
  name: v.string(),
  done: v.boolean(),
});
export type Item = v.InferOutput<typeof itemSchema>;

export const createItemSchema = v.object({
  name: v.string(),
});
export type CreateItem = v.InferOutput<typeof createItemSchema>;

/** Expected response envelopes, keyed by route path. */
export const responseSchemas = {
  "/api/v1/hello": v.object({ message: v.string() }),
  "/api/v1/items": v.object({ items: v.array(itemSchema) }),
} as const;

export const schemaForPath = (path: string) =>
  (responseSchemas as Record<string, v.GenericSchema>)[path];

/** Schemas handed to backend route handlers at runtime. */
export const schemas = { itemSchema, createItemSchema };

export interface RouteContext {
  params: Record<string, string>;
  schemas: typeof schemas;
}

export type RouteHandler = (req: Request, ctx: RouteContext) => Promise<Response> | Response;

export interface RouteModule {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Must start with {@link API_PREFIX}; supports `:param` segments. */
  path: string;
  handler: RouteHandler;
}
