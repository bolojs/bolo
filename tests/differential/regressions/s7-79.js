console.log("warmup");
console.log("L0");
Promise.reject(new Error("nope"));
console.log("L1");
setImmediate(() => {
console.log("L2");
setImmediate(() => {
console.log("L3");
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L4");
}); }
});
Promise.reject(new Error("nope"));
});
console.log("L5");
