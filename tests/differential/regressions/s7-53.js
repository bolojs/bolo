console.log("warmup");
Promise.resolve().then(() => {
console.log("L0");
console.log("L1");
process.on("exit", (c) => {
console.log("L2");
});
});
{ const t = setTimeout(() => {
console.log("L3");
console.log("L4");
console.log("L5");
{ const t = setTimeout(() => {
console.log("L6");

}, 120); }
}, 120); }
process.on("exit", (c) => {
console.log("L7");
});
Promise.reject(new Error("nope"));
setImmediate(() => {
console.log("L8");
console.log("L9");
console.log("L10");
throw new Error("boom");
});
console.log("L11");
