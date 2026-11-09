console.log("warmup");
{ let n = 0; const t = setInterval(() => {
console.log("L0");
process.nextTick(() => {
console.log("L1");
console.log("L2");
queueMicrotask(() => {
console.log("L3");

});
});
setImmediate(() => {
console.log("L4");

});
if (++n >= 3) clearInterval(t);
}, 30); }
setImmediate(() => {
console.log("L5");

});
{ const t = setTimeout(() => {
console.log("L6");
Promise.resolve().then(() => {
console.log("L7");

});
process.exitCode = 2;
setImmediate(() => {
console.log("L8");
setImmediate(() => {
console.log("L9");

});
});
}, 60); t.unref(); }
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L10");
}); }
console.log("L11");
