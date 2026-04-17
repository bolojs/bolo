# Dogfood Report — v0.2.0 React + Vite Spec

**Date:** 2025-04-17  
**Spec:** `tests/e2e/specs/v0.2.0-react-vite.spec`  
**Runner:** Gauge + gauge-ts (automated execution)

## Execution Evidence

```
Specifications:	1 executed	1 passed	0 failed	0 skipped
Scenarios:	5 executed	5 passed	0 failed	0 skipped
Total time taken: 7.988s
```

**HTML Report:** `tests/e2e/reports/html-report/index.html`

## Scenarios Verified

1. **Service worker boots correctly** ✅
   - SW registers successfully at `/sw.js`
   - Page title is `browser-containers`

2. **npm install populates VFS** ✅
   - `npm install react react-dom vite` executes successfully
   - `/node_modules/react/index.js` exists in VFS
   - `/importmap.json` exists in VFS

3. **Vite serves static files correctly** ✅
   - File `/index.html` written with `"Hello from browser-containers!"`
   - `npm run dev (using vite-server)` executes successfully
   - Preview iframe shows `"Hello from browser-containers!"`

4. **HMR updates preview** ✅
   - File `/index.html` updated with `"Updated!"`
   - Preview iframe reflects the update within 15s

5. **Dev server serves transformed modules** ✅
   - `/src/App.tsx` and `/src/main.tsx` written to VFS
   - Vite-server transforms TSX files to JavaScript
   - Transformed `/src/App.tsx` contains no raw JSX syntax

## Summary

All previously identified issues have been resolved. The v0.2.0-react-vite.spec now executes end-to-end via the Gauge E2E runner with **zero failures**.
