console.log("warmup");
Promise.reject(new Error("nope"));
setImmediate(() => {
console.log("L0");
setImmediate(() => {
console.log("L1");
queueMicrotask(() => {
console.log("L2");

});
console.log("L3");
});
});
