console.log("warmup");
{ const t = setTimeout(() => {
console.log("L0");
Promise.resolve().then(() => {
console.log("L1");
console.log("L2");
throw new Error("boom");
});
}, 90); }
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L3");
}); }
{ const t = setTimeout(() => {
console.log("L4");
console.log("L5");
{ let once = false; process.on("beforeExit", () => {
if (once) return; once = true;
console.log("L6");
}); }
console.log("L7");
}, 90); }
