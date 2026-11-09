console.log("warmup");
Promise.reject(new Error("nope"));
setImmediate(() => {
console.log("L0");
queueMicrotask(() => {
console.log("L1");
setImmediate(() => {
console.log("L2");

});
});
});
Promise.resolve().then(() => {
console.log("L3");
process.on("exit", (c) => {
console.log("L4");
});
});
console.log("L5");
setImmediate(() => {
console.log("L6");
{ let n = 0; const t = setInterval(() => {
console.log("L7");
queueMicrotask(() => {
console.log("L8");

});
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L9");
}); }
process.exitCode = 2;
if (++n >= 2) clearInterval(t);
}, 90); t.unref(); }
console.log("L10");
});
