console.log("warmup");
console.log("L0");
console.log("L1");
Promise.reject(new Error("nope"));
console.log("L2");
console.log("L3");
setImmediate(() => {
console.log("L4");
process.nextTick(() => {
console.log("L5");
console.log("L6");
console.log("L7");
});
try { process.exit(1); } catch (e) { console.log("L8"); }
});
