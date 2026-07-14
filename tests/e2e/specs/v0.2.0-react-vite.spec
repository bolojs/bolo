# React + Vite Preview (v0.2.0 gate)

## Service worker boots correctly

* The service worker registers successfully at "/sw.js"
* The demo page title is "bolo"

## npm install populates VFS

* I run "npm install react react-dom vite"
* The file "/node_modules/react/index.js" exists in VFS
* The file "/importmap.json" exists in VFS

## Vite serves static files correctly

* I write file "/index.html" with content "<h1>Hello from bolo!</h1>"
* I run "npm run dev (using vite-server)"
* The preview iframe shows "Hello from bolo!"

## HMR updates preview

* I write file "/index.html" with content "<h1>Updated!</h1>"
* The preview iframe shows "Updated!"

## Dev server serves transformed modules (optional)

* I write file "/src/App.tsx" with content "export default function App() { return <h1>React works!</h1>; }"
* I write file "/src/main.tsx" with content "import React from 'react'; import { createRoot } from 'react-dom/client'; import App from './App'; createRoot(document.getElementById('root')!).render(<App/>);"
* The vite-server transforms the TSX files to JavaScript
* The transformed "/src/App.tsx" contains no raw JSX syntax
