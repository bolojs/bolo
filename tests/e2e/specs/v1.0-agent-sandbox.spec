# v1.0 Agent Sandbox

## Agent installs and boots

* I install packages "@bolojs/runtime"
* I write file "/agent/index.js" with content "export async function agent() { console.log('Agent booted'); return { status: 'ready' }; }"
* I run "runtime run /agent/index.js"
* The agent output contains "Agent booted"

## Agent runs in QuickJS tier

* I write file "/quickjs-script.js" with content "console.log('QuickJS execution');"
* I run "runtime quickjs /quickjs-script.js"
* The runtime tier for the last run is "quickjs"
* The agent output contains "QuickJS execution"

## Sandbox policy blocks network

* I write file "/agent-with-network.js" with content "export async function agent() { try { await fetch('https://example.com'); return { status: 'failed' }; } catch (e) { return { status: 'blocked', error: e.message }; } }"
* I run "runtime run --policy restricted /agent-with-network.js"
* The agent output contains "blocked"

## Memory and CPU caps are enforced

* I write file "/heavy-allocation.js" with content "export async function agent() { const arr = new Array(10000000).fill(0); return { status: 'allocated' }; }"
* I run "runtime run --policy memory-limited /heavy-allocation.js"
* The agent output contains "memory limit" or "exceeded"

## RAM under 200MB

* I run "runtime run /agent/index.js"
* Total runtime RAM usage is under 200MB
