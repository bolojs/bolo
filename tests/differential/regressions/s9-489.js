console.log("warmup");
setImmediate(() => {
console.log("L0");
console.log("L1");
setImmediate(() => {
console.log("L2");
setImmediate(() => {
console.log("L3");

});
process.on("exit", (c) => {
console.log("L4");
});
});
});
setImmediate(() => {
console.log("L5");
{ let n = 0; const t = setInterval(() => {
console.log("L6");
queueMicrotask(() => {
console.log("L7");

});
try { process.exit(2); } catch (e) { console.log("L8"); }
if (++n >= 3) clearInterval(t);
}, 60); }
});
{ const t = setTimeout(() => {
console.log("L9");

}, 60); t.unref(); }
