console.log("warmup");
Promise.resolve().then(() => {
console.log("L0");
setImmediate(() => {
console.log("L1");
process.on("exit", (c) => {
console.log("L2");
});
console.log("L3");
console.log("L4");
});
{ const t = setTimeout(() => {
console.log("L5");
console.log("L6");
}, 30); t.unref(); }
throw new Error("boom");
});
setImmediate(() => {
console.log("L7");
process.on("exit", (c) => {
console.log("L8");
});
try { process.exit(2); } catch (e) { console.log("L9"); }
console.log("L10");
});
