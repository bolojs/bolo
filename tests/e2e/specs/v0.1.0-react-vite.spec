# React + Vite Preview (v0.1.0 gate)

Tags: wip

## Service worker boots correctly

* The service worker registers successfully
* The demo page title is "browsercontainers demo"

## npm install populates VFS

* I install packages "react, react-dom, vite"
* The file "/node_modules/react/index.js" exists in VFS
* The file "/importmap.json" exists in VFS

## Vite transforms TypeScript correctly

* I write file "/src/App.tsx" with content "export default function App() { return <h1>Hello from React!</h1>; }"
* I write file "/src/main.tsx" with content "import React from 'react'; import { createRoot } from 'react-dom/client'; import App from './App'; createRoot(document.getElementById('root')!).render(<App/>);"
* The transform of "/src/App.tsx" contains no raw JSX

## Dev server serves the app

* I run "npm run dev"
* The preview iframe shows "Hello from React!"

## HMR updates the preview

* I write file "/src/App.tsx" with content "export default function App() { return <h1>Updated!</h1>; }"
* The preview iframe shows "Updated!"

## Network requests are sandboxed

* The network request to "https://evil.example.com" is blocked
