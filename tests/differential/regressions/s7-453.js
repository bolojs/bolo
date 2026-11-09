console.log("warmup");
{ const t = setTimeout(() => {
console.log("L0");

}, 120); }
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L1");
}); }
{ let n = 0; const t = setInterval(() => {
console.log("L2");

if (++n >= 3) clearInterval(t);
}, 30); t.unref(); }
console.log("L3");
setImmediate(() => {
console.log("L4");
Promise.resolve().then(() => {
console.log("L5");
setImmediate(() => {
console.log("L6");

});
process.on("exit", (c) => {
console.log("L7");
});
});
process.exitCode = 4;
});
console.log("L8");
