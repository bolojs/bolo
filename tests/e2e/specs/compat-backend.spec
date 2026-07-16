# Backend Framework Compatibility

Tags: wip

## Hono serves a route

* I install packages "hono"
* I write a Hono server at "/src/server.ts" with route "GET /hello"
* I run "runtime run /src/server.ts"
* I wait for the server to be ready
* A request to the sandbox origin "/hello" returns "Hello from Hono"

## Express serves a route

* I install packages "express @types/express"
* I write an Express server at "/src/server.ts" with route "GET /hello"
* I run "runtime run /src/server.ts"
* I wait for the server to be ready
* A request to the sandbox origin "/hello" returns status 200
