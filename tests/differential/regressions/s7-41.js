console.log("warmup");
Promise.resolve().then(() => {
console.log("L0");

});
queueMicrotask(() => {
console.log("L1");

});
{ let n = 0; const t = setInterval(() => {
console.log("L2");
{ let n = 0; const t = setInterval(() => {
console.log("L3");
console.log("L4");
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L5");
}); }
console.log("L6");
if (++n >= 3) clearInterval(t);
}, 60); t.unref(); }
if (++n >= 3) clearInterval(t);
}, 30); }
