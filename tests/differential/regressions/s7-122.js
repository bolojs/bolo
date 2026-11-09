console.log("warmup");
{ let n = 0; const t = setInterval(() => {
console.log("L0");
{ let n = 0; const t = setInterval(() => {
console.log("L1");
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L2");
}); }
if (++n >= 3) clearInterval(t);
}, 90); }
if (++n >= 3) clearInterval(t);
}, 60); t.unref(); }
console.log("L3");
console.log("L4");
queueMicrotask(() => {
console.log("L5");
Promise.resolve().then(() => {
console.log("L6");
setImmediate(() => {
console.log("L7");

});
console.log("L8");
console.log("L9");
});
console.log("L10");
});
console.log("L11");
{ const t = setTimeout(() => {
console.log("L12");
process.on("exit", (c) => {
console.log("L13");
});
}, 180); }
