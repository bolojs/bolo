# Vibe subsite chat turn

The vibe sandbox chats with a deterministic mock provider that writes a file
and starts the dev server; the preview then shows the written file. Runs
entirely client-side with no network access or API keys.

## Chat turn writes a file and starts a dev server

* I open the subsite page "/vibe/" with the mock provider configured
* The subsite runtime is ready
* The key-stays-local banner is visible
* I send the chat prompt "make it say hi"
* The chat shows a done receipt for "writeFile" on "src/App.jsx"
* The chat shows a done receipt for "runCommand" "npm run dev"
* The assistant reports the dev server is running
* The preview shows the text "Built by the bolo mock provider"
* No service worker errors were recorded
