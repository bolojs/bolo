console.log("warmup");
{ let n = 0; const t = setInterval(() => {
console.log("L0");
Promise.resolve().then(() => {
console.log("L1");
Promise.resolve().then(() => {
console.log("L2");

});
});
if (++n >= 2) clearInterval(t);
}, 30); t.unref(); }
queueMicrotask(() => {
console.log("L3");
queueMicrotask(() => {
console.log("L4");
console.log("L5");
setImmediate(() => {
console.log("L6");

});
});
process.exitCode = 5;
queueMicrotask(() => {
console.log("L7");
console.log("L8");
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L9");
}); }
Promise.reject(new Error("nope"));
});
});
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L10");
}); }
