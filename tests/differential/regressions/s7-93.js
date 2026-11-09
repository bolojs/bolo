console.log("warmup");
console.log("L0");
Promise.reject(new Error("nope"));
{ const t = setTimeout(() => {
console.log("L1");
process.nextTick(() => {
console.log("L2");
console.log("L3");
});
try { process.exit(1); } catch (e) { console.log("L4"); }
{ let n = 0; const t = setInterval(() => {
console.log("L5");

if (++n >= 1) clearInterval(t);
}, 30); t.unref(); }
}, 180); t.unref(); }
setImmediate(() => {
console.log("L6");
{ const t = setTimeout(() => {
console.log("L7");
{ let n = 0; const t = setInterval(() => {
console.log("L8");

if (++n >= 3) clearInterval(t);
}, 60); }
{ const t = setTimeout(() => {
console.log("L9");

}, 120); t.unref(); }
}, 180); t.unref(); }
});
console.log("L10");
{ const t = setTimeout(() => {
console.log("L11");
throw new Error("boom");
setImmediate(() => {
console.log("L12");
console.log("L13");
console.log("L14");
});
{ let n = 0; const t = setInterval(() => {
console.log("L15");
process.on("exit", (c) => {
console.log("L16");
});
{ let n = 0; const t = setInterval(() => {
console.log("L17");

if (++n >= 2) clearInterval(t);
}, 60); t.unref(); }
queueMicrotask(() => {
console.log("L18");

});
if (++n >= 3) clearInterval(t);
}, 90); t.unref(); }
}, 30); t.unref(); }
