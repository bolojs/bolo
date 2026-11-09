console.log("warmup");
Promise.resolve().then(() => {
console.log("L0");
Promise.reject(new Error("nope"));
Promise.reject(new Error("nope"));
});
console.log("L1");
Promise.resolve().then(() => {
console.log("L2");
{ let n = 0; const t = setInterval(() => {
console.log("L3");

if (++n >= 1) clearInterval(t);
}, 60); t.unref(); }
queueMicrotask(() => {
console.log("L4");
Promise.resolve().then(() => {
console.log("L5");

});
{ let n = 0; const t = setInterval(() => {
console.log("L6");

if (++n >= 3) clearInterval(t);
}, 30); t.unref(); }
setImmediate(() => {
console.log("L7");

});
});
Promise.reject(new Error("nope"));
});
console.log("L8");
console.log("L9");
