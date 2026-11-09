console.log("warmup");
Promise.resolve().then(() => {
console.log("L0");
console.log("L1");
{ const t = setTimeout(() => {
console.log("L2");
console.log("L3");
Promise.reject(new Error("nope"));
queueMicrotask(() => {
console.log("L4");

});
}, 120); }
process.exitCode = 5;
});
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L5");
}); }
setImmediate(() => {
console.log("L6");
{ let n = 0; const t = setInterval(() => {
console.log("L7");
setImmediate(() => {
console.log("L8");

});
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L9");
}); }
if (++n >= 3) clearInterval(t);
}, 90); }
console.log("L10");
console.log("L11");
});
Promise.reject(new Error("nope"));
