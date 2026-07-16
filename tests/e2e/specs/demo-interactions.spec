# Demo Interactions

Covers the interactive demo surface not exercised by alpha-smoke: suggestion
chips that auto-paste and submit commands, disabled chips for unsupported
commands, and arbitrary bash-style commands typed into the terminal. All
driven through the real Terminal/ChipMarquee UI at /e2e/. Boot, basic
`node index.ts` execution, and editor edits are already validated in
alpha-smoke and intentionally not repeated here.

## Suggestion chip runs the preloaded app

* The runtime is ready
* I click the suggestion chip "Run app"
* The terminal output contains "Hello from the bolo API"

## Suggestion chips drive shell-style commands

* The runtime is ready
* I click the suggestion chip "List files"
* The terminal output contains "index.ts"
* I click the suggestion chip "View package.json"
* The terminal output contains "name"

## Arbitrary bash commands run in the terminal

* The runtime is ready
* I run "ls" in the terminal
* The terminal output contains "index.ts"
* I run "cat package.json" in the terminal
* The terminal output contains "name"

## Unsupported commands surface as disabled chips

* The runtime is ready
* The suggestion chip "Git status" is disabled
* The suggestion chip "npm build" is disabled
