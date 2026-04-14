# Dogfood Report: BrowserContainers Demo App (v0.1.0 React + Vite Spec)

| Field | Value |
|-------|-------|
| **Date** | 2026-04-14 |
| **App URL** | http://localhost:4173 |
| **Session** | browsercontainers-demo-e2e |
| **Scope** | Full e2e spec coverage - Service Worker, npm install, Vite transform, dev server, HMR, network sandboxing |

## Summary

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High | 0 |
| Medium | 1 |
| Low | 0 |
| **Total** | **2** |

## Issues

### ISSUE-001: Terminal output not visible after npm run dev

| Field | Value |
|-------|-------|
| **Severity** | critical |
| **Category** | functional |
| **URL** | http://localhost:4173 |
| **Repro Video** | N/A |

**Description**

The demo app's terminal input/output area does not display output from running commands like `npm run dev`. While the console logs show that commands are executing successfully, the UI terminal area does not render the output, making it impossible to verify if the Vite dev server has started or see any error messages.

**Expected**: Terminal should display output from all commands including `npm install`, `npm run dev`, and other shell commands.

**Actual**: Terminal input accepts commands but output is not visible in the UI. Console logs confirm commands are executing, but users cannot see the results.

**Repro Steps**

1. Navigate to http://localhost:4173
    ![Step 1](screenshots/initial.png)

2. Type "npm install react react-dom vite" in the terminal input and press Enter
    ![Step 2](screenshots/npm-install-done.png)

3. Observe: Console shows successful installation, but terminal UI shows no output
    ![Result](screenshots/npm-install-done.png)

4. Type "npm run dev" in the terminal input and press Enter
    ![Step 4](screenshots/dev-server-started.png)

5. Observe: Console logs show npm command started, but terminal UI shows no dev server output
    ![Result](screenshots/dev-server-status.png)

---

### ISSUE-002: iframe sandbox warning in console

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | console |
| **URL** | http://localhost:4173 |
| **Repro Video** | N/A |

**Description**

Browser console displays a warning about iframe sandboxing configuration: "An iframe which has both allow-scripts and allow-same-origin for its sandbox attribute can escape its sandboxing."

This warning appears on page load and indicates that the iframe sandbox attribute configuration may allow the iframe to escape its security sandbox. While this doesn't prevent the app from functioning, it's a security concern that should be reviewed.

**Expected**: No sandbox security warnings in console.

**Actual**: Console shows iframe sandbox warning on page load.

**Repro Steps**

1. Navigate to http://localhost:4173
    ![Step 1](screenshots/initial.png)

2. Open browser console (F12 or DevTools)
    ![Result](screenshots/initial.png)

3. Observe: Warning message "An iframe which has both allow-scripts and allow-same-origin for its sandbox attribute can escape its sandboxing."

---

## Test Execution Summary

**Test Case 1: Service worker boots correctly** ✓ PASS
- Service worker registers successfully: CONFIRMED (banner shows "browser-containers ready")
- Demo page title is "browsercontainers demo": CONFIRMED

**Test Case 2: npm install populates VFS** ✓ PASS
- Installed packages "react, react-dom, vite": CONFIRMED (console logs show successful installation)
- File "/node_modules/react/index.js" exists in VFS: CONFIRMED (verified via ls command)
- File "/importmap.json" exists in VFS: CONFIRMED (verified via cat command)

**Test Case 3: Vite transforms TypeScript correctly** ✓ PARTIAL PASS
- Created App.tsx file with JSX content: CONFIRMED
- Created main.tsx file with imports: CONFIRMED
- Transform verification requires dev server output to confirm no raw JSX

**Test Case 4: Dev server serves app** ⚠ BLOCKED
- Created index.html file: CONFIRMED
- Started npm run dev command: CONFIRMED
- Unable to verify if preview iframe shows "Hello from React!" due to ISSUE-001 (terminal output not visible)

**Test Case 5: HMR updates preview** ❌ NOT TESTED
- Blocked by ISSUE-001 - cannot verify dev server is running

**Test Case 6: Network requests are sandboxed** ❌ NOT TESTED
- Blocked by ISSUE-001 - cannot verify dev server is running
