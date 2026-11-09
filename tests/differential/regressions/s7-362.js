console.log("warmup");
console.log("L0");
Promise.resolve().then(() => {
console.log("L1");
setImmediate(() => {
console.log("L2");
queueMicrotask(() => {
console.log("L3");

});
{ const t = setTimeout(() => {
console.log("L4");

}, 90); t.unref(); }
throw new Error("boom");
});
});
setImmediate(() => {
console.log("L5");
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L6");
}); }
setImmediate(() => {
console.log("L7");
console.log("L8");
queueMicrotask(() => {
console.log("L9");

});
process.nextTick(() => {
console.log("L10");

});
});
});
Promise.reject(new Error("nope"));
Promise.reject(new Error("nope"));
