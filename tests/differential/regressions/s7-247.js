console.log("warmup");
Promise.resolve().then(() => {
console.log("L0");
{ let n = 0; const t = setInterval(() => {
console.log("L1");
console.log("L2");
{ let n = 0; const t = setInterval(() => {
console.log("L3");

if (++n >= 3) clearInterval(t);
}, 30); }
if (++n >= 2) clearInterval(t);
}, 60); }
console.log("L4");
console.log("L5");
});
{ const t = setTimeout(() => {
console.log("L6");

}, 90); }
process.on("exit", (c) => {
console.log("L7");
});
