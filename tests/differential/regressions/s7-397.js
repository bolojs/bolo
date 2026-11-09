console.log("warmup");
{ let n = 0; const t = setInterval(() => {
console.log("L0");
console.log("L1");
try { process.exit(3); } catch (e) { console.log("L2"); }
if (++n >= 1) clearInterval(t);
}, 90); t.unref(); }
setImmediate(() => {
console.log("L3");
console.log("L4");
Promise.reject(new Error("nope"));
});
setImmediate(() => {
console.log("L5");
{ const t = setTimeout(() => {
console.log("L6");

}, 180); t.unref(); }
console.log("L7");
});
Promise.resolve().then(() => {
console.log("L8");
queueMicrotask(() => {
console.log("L9");
process.exitCode = 5;
});
});
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L10");
}); }
