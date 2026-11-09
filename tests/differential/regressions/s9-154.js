console.log("warmup");
queueMicrotask(() => {
console.log("L0");
console.log("L1");
});
{ let n = 0; const t = setInterval(() => {
console.log("L2");

if (++n >= 3) clearInterval(t);
}, 60); t.unref(); }
console.log("L3");
{ const t = setTimeout(() => {
console.log("L4");
{ let n = 0; const t = setInterval(() => {
console.log("L5");

if (++n >= 3) clearInterval(t);
}, 60); }
}, 120); }
console.log("L6");
Promise.resolve().then(() => {
console.log("L7");
setImmediate(() => {
console.log("L8");
console.log("L9");
});
});
