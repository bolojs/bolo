console.log("warmup");
setImmediate(() => {
console.log("L0");
Promise.reject(new Error("nope"));
Promise.reject(new Error("nope"));
});
queueMicrotask(() => {
console.log("L1");
console.log("L2");
});
{ const t = setTimeout(() => {
console.log("L3");

}, 90); t.unref(); }
setImmediate(() => {
console.log("L4");
console.log("L5");
});
console.log("L6");
console.log("L7");
