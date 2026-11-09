console.log("warmup");
setImmediate(() => {
console.log("L0");
console.log("L1");
});
{ let n = 0; const t = setInterval(() => {
console.log("L2");
console.log("L3");
if (++n >= 3) clearInterval(t);
}, 60); t.unref(); }
Promise.reject(new Error("nope"));
