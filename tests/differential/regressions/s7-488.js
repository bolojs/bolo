console.log("warmup");
{ const t = setTimeout(() => {
console.log("L0");
process.exitCode = 3;
Promise.resolve().then(() => {
console.log("L1");
setImmediate(() => {
console.log("L2");

});
throw new Error("boom");
try { process.exit(5); } catch (e) { console.log("L3"); }
});
setImmediate(() => {
console.log("L4");
console.log("L5");
process.exit(1);
});
}, 120); }
{ let n = 0; const t = setInterval(() => {
console.log("L6");
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L7");
}); }
if (++n >= 1) clearInterval(t);
}, 30); }
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L8");
}); }
process.exitCode = 3;
setImmediate(() => {
console.log("L9");
queueMicrotask(() => {
console.log("L10");

});
setImmediate(() => {
console.log("L11");

});
});
