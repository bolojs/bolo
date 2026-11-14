# Sandbox Subsite

Terminal-first Node playground in the justbash.dev style: one full-height
terminal, a Script/REPL tab bar, and a chip row of example commands. The
spec drives the real UI (chips, tab bar, xterm input) and asserts every
flow is observable in the terminal.

## A script runs from the chip row

* I open the subsite page "/sandbox/"
* The subsite runtime is ready
* I click the example chip "Run index.js"
* The terminal output contains "Hello from the bolo sandbox"

## The REPL tab evaluates a multiline continuation

* I open the subsite page "/sandbox/"
* The subsite runtime is ready
* I switch to the REPL tab
* I click the example chip "REPL: open a function"
* The terminal output contains "..."
* I run "return n * 2" in the terminal
* I run "}" in the terminal
* I run "twice(21)" in the terminal
* The terminal output contains "42"

## npm install works in the sandbox

* I open the subsite page "/sandbox/"
* The subsite runtime is ready
* I click the example chip "Install chalk"
* The terminal output contains "exit 0"
* I click the example chip "Try chalk"
* The terminal output contains "chalk says"

## The HTTP server chip starts a reachable server

* I open the subsite page "/sandbox/"
* The subsite runtime is ready
* I click the example chip "Start HTTP server"
* The terminal output contains "sandbox server listening on 3000"
* A preview is shown for the sandbox server
