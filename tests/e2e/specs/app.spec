# Full-stack app subsite

The /app subsite runs a backend (route files in the container VFS) and a
request builder in one tab. Editing a route applies live through the service
worker with no restart.

## Edit a route and see the new response

* I open the subsite page "/app/"
* The subsite service worker at "/app/sw.js" controls the page
* The subsite runtime is ready
* I reset the backend routes to the starters
* I select the backend route file "hello.js"
* I send the request
* The response status is "200"
* The response body contains "hello from the bolo backend"
* I change the hello handler message to "edited live, no restart"
* I send the request
* The response body contains "edited live, no restart"
* No service worker errors were recorded
