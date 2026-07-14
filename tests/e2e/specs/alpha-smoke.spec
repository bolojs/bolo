# Alpha Prototype Smoke Test

## Boot and auto-start

* The service worker registers successfully
* The demo page title is "browsercontainers demo"
* The preview iframe shows "Hello from bolo!"

## Filesystem verification

* The boot file "/package.json" exists
* The boot file "/index.html" exists
* The boot file "/vite.config.js" exists

## Container API works

* I spawn "echo hello" in the container
* The spawn exit code is 0
