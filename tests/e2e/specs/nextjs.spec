# Next.js Pages Router (next-server N1)

Boots a create-next-app Pages tree (inline template from `@bolojs/next-server`)
inside a container and verifies the emulated Next dev server end to end: a
rendered page, a `getStaticProps` route, and a working API route.

## Serve a create-next-app Pages tree

* I boot a container
* I mount the next template files
* I install packages "react,react-dom"
* A request to the sandbox origin "/__next/blog/5" returns "Post #5"
* A request to the sandbox origin "/__next/api/hello" returns "bolo Next API"
* The next preview iframe shows "Welcome to Next.js on bolo"

## Unknown routes return 404

* I boot a container
* I mount the next template files
* A request to the sandbox origin "/__next/no/such/route" returns status "404"
