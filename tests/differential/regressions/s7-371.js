console.log("warmup");
setImmediate(() => {
console.log("L0");
process.exit(2);
console.log("L1");
console.log("L2");
});
Promise.resolve().then(() => {
console.log("L3");
console.log("L4");
console.log("L5");
Promise.resolve().then(() => {
console.log("L6");

});
});
Promise.reject(new Error("nope"));
