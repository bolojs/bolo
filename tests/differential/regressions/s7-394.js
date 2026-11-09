console.log("warmup");
Promise.reject(new Error("nope"));
setImmediate(() => {
console.log("L0");
queueMicrotask(() => {
console.log("L1");
try { process.exit(2); } catch (e) { console.log("L2"); }
});
});
console.log("L3");
setImmediate(() => {
console.log("L4");
console.log("L5");
console.log("L6");
});
{ let n = 0; const t = setInterval(() => {
console.log("L7");

if (++n >= 2) clearInterval(t);
}, 30); t.unref(); }
