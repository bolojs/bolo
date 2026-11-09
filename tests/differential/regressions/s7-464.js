console.log("warmup");
queueMicrotask(() => {
console.log("L0");
console.log("L1");
Promise.reject(new Error("nope"));
});
console.log("L2");
console.log("L3");
setImmediate(() => {
console.log("L4");

});
