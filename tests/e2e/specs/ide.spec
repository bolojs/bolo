# IDE subsite end to end

Tags: ide

The /ide workbench (file tree + editor | preview, terminal drawer) runs a
Vite+React project and a Next.js Pages project end to end.

## Vite and React project runs and live-updates

* I open the subsite page "/ide/"
* The subsite shell shows the panels "file-tree editor preview terminal"
* I pick the IDE template "vite-react"
* The IDE file tree lists "/home/web/src/App.tsx"
* The IDE terminal output contains "npm run dev"
* The IDE preview shows "Hello from React + Vite on bolo!"
* I edit the IDE file "/home/web/src/App.tsx" to render the heading "Edited in the IDE"
* The IDE preview shows "Edited in the IDE"

## Next.js project shows a page and an API route

* I open the subsite page "/ide/"
* I pick the IDE template "next-pages"
* The IDE file tree lists "/home/web/pages/index.tsx"
* The IDE preview shows "Welcome to Next.js on bolo"
* The IDE preview origin returns "bolo Next API" for "/__next/api/hello"
