// ponytail: minimal echo server for E2E testing, not production code.
// Prefixes responses with "ECHO:" so terminal output checks don't
// false-match against the command text typed into xterm.
import net from "node:net";

const server = net.createServer((socket) => {
  socket.on("data", (data) => socket.write("ECHO:" + data.toString()));
});

server.listen(8080, () => console.log("echo-server listening on :8080"));
