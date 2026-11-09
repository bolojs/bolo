console.log("warmup");
Promise.reject(new Error("nope"));
queueMicrotask(() => {
console.log("L0");
queueMicrotask(() => {
console.log("L1");
console.log("L2");
});
setImmediate(() => {
console.log("L3");

});
setImmediate(() => {
console.log("L4");
try { process.exit(1); } catch (e) { console.log("L5"); }
});
});
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L6");
}); }
console.log("L7");
process.on("exit", (c) => {
console.log("L8");
});
{ const t = setTimeout(() => {
console.log("L9");

}, 180); }
