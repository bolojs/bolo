console.log("warmup");
{ let n = 0; const t = setInterval(() => {
console.log("L0");
{ let n = 0; const t = setInterval(() => {
console.log("L1");
process.exitCode = 5;
{ const t = setTimeout(() => {
console.log("L2");

}, 60); t.unref(); }
if (++n >= 1) clearInterval(t);
}, 60); }
queueMicrotask(() => {
console.log("L3");
console.log("L4");
});
if (++n >= 2) clearInterval(t);
}, 90); }
setImmediate(() => {
console.log("L5");
try { process.exit(2); } catch (e) { console.log("L6"); }
{ const t = setTimeout(() => {
console.log("L7");
setImmediate(() => {
console.log("L8");

});
throw new Error("boom");
}, 60); t.unref(); }
console.log("L9");
});
console.log("L10");
queueMicrotask(() => {
console.log("L11");
console.log("L12");
});
Promise.resolve().then(() => {
console.log("L13");
Promise.resolve().then(() => {
console.log("L14");
{ const t = setTimeout(() => {
console.log("L15");

}, 90); t.unref(); }
console.log("L16");
{ const t = setTimeout(() => {
console.log("L17");

}, 120); t.unref(); }
});
});
