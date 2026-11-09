console.log("warmup");
Promise.resolve().then(() => {
console.log("L0");
console.log("L1");
{ const t = setTimeout(() => {
console.log("L2");
{ const t = setTimeout(() => {
console.log("L3");

}, 90); }
}, 90); t.unref(); }
});
process.on("exit", (c) => {
console.log("L4");
});
{ const t = setTimeout(() => {
console.log("L5");

}, 90); }
setImmediate(() => {
console.log("L6");
process.on("exit", (c) => {
console.log("L7");
});
process.on("exit", (c) => {
console.log("L8");
});
console.log("L9");
});
console.log("L10");
