console.log("warmup");
{ const t = setTimeout(() => {
console.log("L0");
setImmediate(() => {
console.log("L1");

});
}, 150); }
queueMicrotask(() => {
console.log("L2");
setImmediate(() => {
console.log("L3");
process.on("exit", (c) => {
console.log("L4");
});
Promise.resolve().then(() => {
console.log("L5");

});
queueMicrotask(() => {
console.log("L6");

});
});
});
Promise.resolve().then(() => {
console.log("L7");
console.log("L8");
process.on("exit", (c) => {
console.log("L9");
});
{ const t = setTimeout(() => {
console.log("L10");
{ const t = setTimeout(() => {
console.log("L11");

}, 60); t.unref(); }
console.log("L12");
process.nextTick(() => {
console.log("L13");

});
}, 150); t.unref(); }
});
