console.log("warmup");
setImmediate(() => {
console.log("L0");
setImmediate(() => {
console.log("L1");
console.log("L2");
queueMicrotask(() => {
console.log("L3");

});
});
{ const t = setTimeout(() => {
console.log("L4");

}, 90); }
console.log("L5");
});
Promise.reject(new Error("nope"));
