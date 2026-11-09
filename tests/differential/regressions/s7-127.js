console.log("warmup");
{ const t = setTimeout(() => {
console.log("L0");

}, 90); t.unref(); }
console.log("L1");
{ let n = 0; const t = setInterval(() => {
console.log("L2");
queueMicrotask(() => {
console.log("L3");
Promise.reject(new Error("nope"));
setImmediate(() => {
console.log("L4");

});
});
setImmediate(() => {
console.log("L5");

});
{ const t = setTimeout(() => {
console.log("L6");
{ const t = setTimeout(() => {
console.log("L7");

}, 180); t.unref(); }
setImmediate(() => {
console.log("L8");

});
}, 120); t.unref(); }
if (++n >= 2) clearInterval(t);
}, 60); }
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L9");
}); }
