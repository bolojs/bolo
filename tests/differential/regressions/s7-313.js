console.log("warmup");
console.log("L0");
Promise.resolve().then(() => {
console.log("L1");
queueMicrotask(() => {
console.log("L2");
{ const t = setTimeout(() => {
console.log("L3");

}, 150); }
});
console.log("L4");
console.log("L5");
});
{ let n = 0; const t = setInterval(() => {
console.log("L6");
queueMicrotask(() => {
console.log("L7");
Promise.resolve().then(() => {
console.log("L8");

});
});
{ const t = setTimeout(() => {
console.log("L9");

}, 30); t.unref(); }
if (++n >= 3) clearInterval(t);
}, 30); t.unref(); }
