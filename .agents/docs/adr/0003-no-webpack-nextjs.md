# ADR-0003: No Webpack or Next.js Support

## Status

Accepted

## Context

The project is a client-side Node.js runtime for the browser. Webpack and Next.js are the two most popular bundler/framework combinations in the Node.js ecosystem, but both are poor fits:

- **Webpack** is itself a bundler. Running a bundler inside our browser runtime (which already uses Vite for dev serving) creates a bundler-in-a-bundler problem. Webpack also has heavy native dependencies and complex loader/plugin APIs that would require extensive shimming.
- **Next.js** is a React framework tightly coupled to its own server runtime, routing system, and SSR pipeline. It assumes a real Node.js process for server components, ISR, and API routes. None of these work in a browser-only context.

## Decision

Explicitly exclude Webpack and Next.js from v1 scope. Users who need Webpack or Next.js should use a traditional Node.js environment or a serverless platform.

Our runtime targets workloads that run on Cloudflare Workers, Deno Deploy, or edge runtimes — plus our added advantage of `node:fs` and `node:stream` support. This covers Hono, Express, Fastify, Elysia, Vercel AI SDK, and most AI agent frameworks.

Vite is the only bundler we support, and it runs as our dev server (`@bolojs/vite-server`). This avoids the complexity of supporting competing build systems while covering the vast majority of modern frontend and full-stack TypeScript workloads.
