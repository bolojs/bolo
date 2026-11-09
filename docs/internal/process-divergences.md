# Process semantics: known divergences from Node

Differential runner: `tests/differential/run.ts` (Node is the oracle, bolo runs in Chromium). Programs come from the grammar in `tests/differential/process-programs.ts`. Each code below is an inherent limit of running in a browser (or of the oracle itself), not a bug to fix. Grammar exclusions reference these codes.

## BOLO-DIV-001: nextTick and microtask interleaving

Symptom: `process.nextTick` queued from the main script or from inside a promise job runs at a different point than in Node relative to other microtasks.

Cause: Node drains the tick queue between the V8 microtask checkpoints it controls. A browser realm exposes no hook into the engine's microtask queue, so bolo emulates the tick queue with `queueMicrotask`, which interleaves with promise jobs in queue order instead of Node's "ticks first, then promises" rule.

Why unfixable: the engine microtask queue cannot be observed or reordered from script. Ticks queued from macrotask callbacks are fine (the event loop drains them after each callback), so the grammar only generates `nextTick` there.

## BOLO-DIV-002: top-level synchronous throw versus queued promise jobs

Symptom: a synchronous `throw` at the top level of the main script still lets promise jobs queued earlier run before the process dies.

Cause: the module evaluation rejects its promise, and queued microtasks run before the host can react. Node aborts before draining them.

Why unfixable: same as BOLO-DIV-001, the host cannot cut the engine microtask queue short. The grammar does not generate a top-level `throw` (nested throws inside callbacks are covered).

## BOLO-DIV-003: killing a worker stuck in a synchronous loop takes about 2s to free the thread

Symptom: `Process.kill()` on `while (1) {}` resolves `exit` immediately and detaches output and RPC, but the worker thread keeps burning a core for about 2.0s before Chromium removes it. The host main thread is unaffected (heartbeat gap stays under 40ms in `tests/differential/kill.ts`).

Cause: `Worker.terminate()` in Blink requests graceful shutdown and only forcibly terminates script after a fixed 2s delay when the worker never reaches its event loop.

Why unfixable: no web API stops a running worker faster. Loop-guard instrumentation of user code would be required and was rejected as too invasive (it would slow and risk breaking npm packages).

## BOLO-DIV-004: Node's first `console.log` shifts later timers by 7 to 40ms

Symptom: with timers of near-equal deadlines created before and after the first `console.log`, Node orders them differently from run to run, and bolo (whose log is cheap) picks one order.

Cause: Node lazily initializes `process.stdout` on first use (measured 7 to 42ms on a pipe). Timers created afterwards start later by that amount. The cost varies per run and per stdout type, so it cannot be modelled.

Why unfixable: it is nondeterminism in the oracle. The differential grammar renders a `console.log("warmup")` first line, which pays the cost before any program timer exists. The warm-up is not an `L<n>` marker, so it is not compared.

## BOLO-DIV-005: equal-deadline timers separated by a millisecond boundary

Symptom: two timers with the same deadline (for example `setTimeout(a, 60)` and a nested `setInterval(b, 30)` second tick) run in either order across runs in Node itself.

Cause: Node derives each timer start from a real, cached loop clock; two timers created microseconds apart land on the same or adjacent millisecond depending on scheduling. bolo uses a virtual clock with creation-order tie-breaking, which matches Node's common outcome but not its race.

Why unfixable: the oracle is not deterministic here. A residual disagreement is only counted when Node itself is stable across repeated runs.
