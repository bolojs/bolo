console.log("warmup");
queueMicrotask(() => {
console.log("L0");
queueMicrotask(() => {
console.log("L1");
Promise.reject(new Error("nope"));
});
});
console.log("L2");
setImmediate(() => {
console.log("L3");
throw new Error("boom");
process.on("exit", (c) => {
console.log("L4");
});
});
Promise.resolve().then(() => {
console.log("L5");

});
