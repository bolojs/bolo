console.log("warmup");
queueMicrotask(() => {
console.log("L0");
queueMicrotask(() => {
console.log("L1");
setImmediate(() => {
console.log("L2");

});
});
});
Promise.reject(new Error("nope"));
{ const t = setTimeout(() => {
console.log("L3");
Promise.resolve().then(() => {
console.log("L4");
queueMicrotask(() => {
console.log("L5");

});
console.log("L6");
});
queueMicrotask(() => {
console.log("L7");
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L8");
}); }
throw new Error("boom");
});
try { process.exit(1); } catch (e) { console.log("L9"); }
}, 60); t.unref(); }
console.log("L10");
