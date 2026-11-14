# Catalog Subsites Smoke Test

Each catalog subsite route renders the shared shell with its panels and
boots a container scoped to its own service worker, with no SW errors.

## IDE subsite boots

* I open the subsite page "/ide/"
* The subsite service worker at "/ide/sw.js" controls the page
* The subsite shell shows the panels "file-tree editor preview terminal"
* The subsite runtime is ready
* No service worker errors were recorded

## Sandbox subsite boots

* I open the subsite page "/sandbox/"
* The subsite service worker at "/sandbox/sw.js" controls the page
* The subsite shell shows the panels "terminal"
* The subsite runtime is ready
* No service worker errors were recorded

## App subsite boots

* I open the subsite page "/app/"
* The subsite service worker at "/app/sw.js" controls the page
* The subsite shell shows the panels "routes editor request response"
* The subsite runtime is ready
* No service worker errors were recorded

## Vibe subsite boots

* I open the subsite page "/vibe/"
* The subsite service worker at "/vibe/sw.js" controls the page
* The subsite shell shows the panels "chat preview terminal"
* The subsite runtime is ready
* No service worker errors were recorded
