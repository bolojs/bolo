console.log("warmup");
console.log("L0");
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L1");
}); }
console.log("L2");
queueMicrotask(() => {
console.log("L3");
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L4");
}); }
{ const t = setTimeout(() => {
console.log("L5");
{ const t = setTimeout(() => {
console.log("L6");

}, 60); }
process.exitCode = 3;
process.on("exit", (c) => {
console.log("L7");
});
}, 60); }
setImmediate(() => {
console.log("L8");
{ let n = 0; const t = setInterval(() => {
console.log("L9");

if (++n >= 1) clearInterval(t);
}, 60); }
});
});
{ const t = setTimeout(() => {
console.log("L10");
{ let n = 0; const t = setInterval(() => {
console.log("L11");
console.log("L12");
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L13");
}); }
if (++n >= 3) clearInterval(t);
}, 30); t.unref(); }
{ const t = setTimeout(() => {
console.log("L14");
{ let n = 0; const t = setInterval(() => {
console.log("L15");

if (++n >= 2) clearInterval(t);
}, 60); t.unref(); }
}, 180); }
}, 60); t.unref(); }
queueMicrotask(() => {
console.log("L16");

});
