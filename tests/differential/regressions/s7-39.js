console.log("warmup");
{ const t = setTimeout(() => {
console.log("L0");

}, 60); }
Promise.resolve().then(() => {
console.log("L1");
Promise.resolve().then(() => {
console.log("L2");

});
console.log("L3");
});
Promise.resolve().then(() => {
console.log("L4");
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L5");
}); }
process.on("exit", (c) => {
console.log("L6");
});
});
{ const t = setTimeout(() => {
console.log("L7");

}, 30); t.unref(); }
console.log("L8");
{ let n = 0; const t = setInterval(() => {
console.log("L9");
try { process.exit(4); } catch (e) { console.log("L10"); }
process.on("exit", (c) => {
console.log("L11");
});
if (++n >= 2) clearInterval(t);
}, 60); t.unref(); }
