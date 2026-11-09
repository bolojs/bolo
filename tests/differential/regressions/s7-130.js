console.log("warmup");
process.exitCode = 2;
console.log("L0");
{ let n = 0; const t = setInterval(() => {
console.log("L1");
{ const t = setTimeout(() => {
console.log("L2");
Promise.resolve().then(() => {
console.log("L3");

});
Promise.reject(new Error("nope"));
}, 90); t.unref(); }
console.log("L4");
console.log("L5");
if (++n >= 3) clearInterval(t);
}, 30); }
