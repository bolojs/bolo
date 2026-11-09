console.log("warmup");
{ const t = setTimeout(() => {
console.log("L0");

}, 60); }
console.log("L1");
{ const t = setTimeout(() => {
console.log("L2");
{ const t = setTimeout(() => {
console.log("L3");
{ const t = setTimeout(() => {
console.log("L4");

}, 60); t.unref(); }
Promise.resolve().then(() => {
console.log("L5");

});
try { process.exit(4); } catch (e) { console.log("L6"); }
}, 150); }
Promise.resolve().then(() => {
console.log("L7");

});
process.on("exit", (c) => {
console.log("L8");
});
}, 60); t.unref(); }
