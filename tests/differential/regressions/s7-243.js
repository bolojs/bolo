console.log("warmup");
setImmediate(() => {
console.log("L0");
queueMicrotask(() => {
console.log("L1");
console.log("L2");
});
setImmediate(() => {
console.log("L3");
process.on("exit", (c) => {
console.log("L4");
});
Promise.resolve().then(() => {
console.log("L5");

});
Promise.reject(new Error("nope"));
});
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L6");
}); }
});
Promise.resolve().then(() => {
console.log("L7");
console.log("L8");
queueMicrotask(() => {
console.log("L9");
console.log("L10");
});
});
console.log("L11");
console.log("L12");
Promise.reject(new Error("nope"));
