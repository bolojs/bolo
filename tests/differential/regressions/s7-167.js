console.log("warmup");
{ const t = setTimeout(() => {
console.log("L0");
setImmediate(() => {
console.log("L1");
queueMicrotask(() => {
console.log("L2");

});
});
Promise.reject(new Error("nope"));
}, 60); t.unref(); }
setImmediate(() => {
console.log("L3");
queueMicrotask(() => {
console.log("L4");
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L5");
}); }
Promise.reject(new Error("nope"));
{ const t = setTimeout(() => {
console.log("L6");

}, 30); t.unref(); }
});
});
{ let n = 0; const t = setInterval(() => {
console.log("L7");
Promise.resolve().then(() => {
console.log("L8");

});
Promise.reject(new Error("nope"));
try { process.exit(1); } catch (e) { console.log("L9"); }
if (++n >= 1) clearInterval(t);
}, 30); t.unref(); }
queueMicrotask(() => {
console.log("L10");
console.log("L11");
{ const t = setTimeout(() => {
console.log("L12");
setImmediate(() => {
console.log("L13");

});
}, 30); }
});
Promise.reject(new Error("nope"));
