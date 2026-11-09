console.log("warmup");
Promise.reject(new Error("nope"));
setImmediate(() => {
console.log("L0");
try { process.exit(1); } catch (e) { console.log("L1"); }
{ let n = 0; const t = setInterval(() => {
console.log("L2");

if (++n >= 3) clearInterval(t);
}, 30); t.unref(); }
});
{ const t = setTimeout(() => {
console.log("L3");

}, 90); }
console.log("L4");
