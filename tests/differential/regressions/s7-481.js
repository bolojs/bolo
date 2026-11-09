console.log("warmup");
Promise.resolve().then(() => {
console.log("L0");
{ let n = 0; const t = setInterval(() => {
console.log("L1");

if (++n >= 3) clearInterval(t);
}, 30); }
queueMicrotask(() => {
console.log("L2");
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L3");
}); }
});
});
console.log("L4");
{ let n = 0; const t = setInterval(() => {
console.log("L5");
{ let n = 0; const t = setInterval(() => {
console.log("L6");
try { process.exit(2); } catch (e) { console.log("L7"); }
if (++n >= 2) clearInterval(t);
}, 60); t.unref(); }
{ const t = setTimeout(() => {
console.log("L8");

}, 120); t.unref(); }
if (++n >= 3) clearInterval(t);
}, 30); }
