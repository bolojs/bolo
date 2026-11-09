console.log("warmup");
Promise.reject(new Error("nope"));
setImmediate(() => {
console.log("L0");
process.exit(0);
Promise.reject(new Error("nope"));
{ let n = 0; const t = setInterval(() => {
console.log("L1");

if (++n >= 1) clearInterval(t);
}, 90); t.unref(); }
});
