# AI Compatibility

## pi-agent LLM call gated by policy

* I install packages "@browser-containers/pi-agent"
* I write file "/llm-agent.js" with content "import { llm } from '@browser-containers/pi-agent'; export async function agent() { const response = await llm.completion('test prompt'); return response; }"
* I run "runtime run --policy no-ai /llm-agent.js"
* The agent output contains "policy" or "blocked" or "denied"

## Vercel AI SDK streaming

* I install packages "@ai-sdk/openai ai"
* I write file "/streaming-agent.js" with content "import { streamText } from '@ai-sdk/openai'; export async function agent() { const stream = await streamText({ model: 'gpt-4', prompt: 'Say hello' }); for await (const chunk of stream.textStream) { console.log(chunk); } return { status: 'streamed' }; }"
* I mock AI API responses
* I run "runtime run /streaming-agent.js"
* The agent output contains "hello" or "Hello"

## LangChain file loader via VfsBus

* I install packages "@langchain/core @langchain/community"
* I write file "/data.txt" with content "This is test data for LangChain"
* I write file "/langchain-agent.js" with content "import { TextLoader } from '@langchain/community/document_loaders/fs/text'; export async function agent() { const loader = new TextLoader('/data.txt'); const docs = await loader.load(); return { count: docs.length, content: docs[0]?.pageContent }; }"
* I run "runtime run /langchain-agent.js"
* The agent output contains "This is test data"
