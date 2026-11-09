console.log("warmup");
Promise.reject(new Error("nope"));
setImmediate(() => {
console.log("L0");
setImmediate(() => {
console.log("L1");
console.log("L2");
console.log("L3");
});
Promise.reject(new Error("nope"));
setImmediate(() => {
console.log("L4");
{ const t = setTimeout(() => {
console.log("L5");

}, 60); t.unref(); }
console.log("L6");
});
});
setImmediate(() => {
console.log("L7");
queueMicrotask(() => {
console.log("L8");

});
});
{ const t = setTimeout(() => {
console.log("L9");

}, 30); }
Promise.resolve().then(() => {
console.log("L10");
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L11");
}); }
console.log("L12");
});
