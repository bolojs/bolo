# Demo Smoke Test (console-hello scenario)

Validate the bolo sandbox through the real demo: boot, VFS, terminal execution,
and an in-place edit, all driven through the actual Editor/Terminal/Preview UI.

## Boot and auto-start

* The service worker registers successfully at "/sw.js"
* The demo page title is "bolo"
* The runtime is ready

## Filesystem verification

* I select the scenario "console-hello"
* The runtime is ready
* The file "/home/web/package.json" exists in VFS
* The file "/home/web/index.ts" exists in VFS

## Terminal runs the scenario

* I run "node index.ts" in the terminal
* The terminal output contains "Hello from the bolo API"

## Editing in the Editor changes terminal output

* I replace the editor content with "console.log(\"Edited output!\");"
* I run "node index.ts" in the terminal
* The terminal output contains "Edited output!"
