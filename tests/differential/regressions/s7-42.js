console.log("warmup");
setImmediate(() => {
console.log("L0");

});
{ const t = setTimeout(() => {
console.log("L1");
{ const t = setTimeout(() => {
console.log("L2");
setImmediate(() => {
console.log("L3");

});
}, 120); }
setImmediate(() => {
console.log("L4");
console.log("L5");
process.on("exit", (c) => {
console.log("L6");
});
});
process.exit(5);
}, 150); }
Promise.reject(new Error("nope"));
