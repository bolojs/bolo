console.log("warmup");
Promise.resolve().then(() => {
console.log("L0");
Promise.reject(new Error("nope"));
console.log("L1");
});
console.log("L2");
console.log("L3");
Promise.resolve().then(() => {
console.log("L4");
console.log("L5");
{ const t = setTimeout(() => {
console.log("L6");
console.log("L7");
throw new Error("boom");
queueMicrotask(() => {
console.log("L8");

});
}, 90); t.unref(); }
setImmediate(() => {
console.log("L9");

});
});
{ const t = setTimeout(() => {
console.log("L10");
{ let n = 0; const t = setInterval(() => {
console.log("L11");

if (++n >= 3) clearInterval(t);
}, 90); }
{ const t = setTimeout(() => {
console.log("L12");

}, 30); }
{ let n = 0; const t = setInterval(() => {
console.log("L13");
{ const t = setTimeout(() => {
console.log("L14");

}, 150); }
Promise.resolve().then(() => {
console.log("L15");

});
if (++n >= 2) clearInterval(t);
}, 90); }
}, 120); t.unref(); }
