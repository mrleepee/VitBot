# Building VitBot: From Simple Chatbot to AI Agent

A practical guide to how we built VitBot — an AI assistant that answers questions about the Free Republic of Liberland using official documents and presidential speech transcripts. This documents the real decisions, mistakes, and fixes we encountered along the way.

## What We Built

VitBot is a web application where users type questions about Liberland and receive streamed, sourced answers. Behind the scenes, an AI **agent** searches a knowledge base, reasons about what it found, and composes a response — citing its sources so users can verify the information.

The key difference from a basic chatbot: VitBot doesn't just generate text. It **decides** which sources to search, **evaluates** whether it has enough information, and can **go back for more** if needed.

## The Architecture at a Glance

```
User's browser (frontend)
    |
    | sends question via HTTP
    v
FastAPI server (backend/server.py)
    |
    | passes question to the agent
    v
LangGraph ReAct Agent (backend/rag.py)
    |
    |-- Pre-fetches relevant documents from ChromaDB
    |-- Sends context + question to the LLM (z.ai GLM-4.7-Flash)
    |-- LLM can call search tools if it needs more info
    |-- Streams the response back token-by-token
    |
    v
User sees the answer appear word-by-word with source citations
```

---

## Step 1: Start With a Simple RAG Pipeline

**What is RAG?** Retrieval-Augmented Generation. Instead of asking the AI to answer from memory (which may be wrong or outdated), you first *retrieve* relevant documents, then ask the AI to answer *based on those documents*.

Our first version was straightforward:

1. User asks a question
2. Backend searches ChromaDB (a vector database) for the 6 most relevant document chunks
3. Those chunks are stuffed into a system prompt: *"Here are the relevant documents, now answer the question"*
4. The LLM (originally Anthropic Claude) generates a response
5. The response streams back to the browser word-by-word

This worked, but had limitations:
- The system always retrieved the same way — no intelligence about *which* sources to search
- If the first retrieval missed something, there was no way to try again
- The LLM had no ability to reason about whether it had enough information

**Key decision:** We started simple and got it working end-to-end before adding complexity. This is important — you want a working baseline before introducing agent behaviour.

## Step 2: Choose Your LLM Provider

We originally used Anthropic's Claude, but the API key expired. Rather than just replacing the key, we decided to switch to **z.ai's GLM models** — a Chinese AI lab (Zhipu AI) that offers an **OpenAI-compatible API**.

**Why this matters:** Because z.ai's API follows the OpenAI format, we can use standard tooling (LangChain's `ChatOpenAI` class) without writing custom integration code. Many AI providers now offer OpenAI-compatible endpoints — this is a huge advantage when choosing a provider.

**Model selection:**

| Model | Cost | Speed | Our Choice |
|-------|------|-------|------------|
| GLM-4.7 | $0.60 / 1M input tokens | Faster | Production |
| GLM-4.7-Flash | Free | ~3.4s to first token | PoC (what we used) |
| GLM-5 | $1.00 / 1M input tokens | Fastest | Premium |

**Key decision:** We started with GLM-4.7 but hit a billing error (insufficient balance). We checked the pricing page, discovered GLM-4.7-Flash was completely free, and switched to that for the proof-of-concept. The free tier has aggressive rate limits (~1 request per minute), but it's perfect for development and demos.

The model configuration in code:

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="glm-4.7-flash",
    base_url="https://api.z.ai/api/paas/v4/",
    api_key=os.environ["ZAI_API_KEY"],
    streaming=True,
)
```

## Step 3: Upgrade from RAG to a ReAct Agent

This is the biggest conceptual leap. Instead of a fixed pipeline (retrieve, then generate), we gave the LLM **tools** and let it **decide** how to use them.

### What is a ReAct Agent?

ReAct stands for **Reasoning + Acting**. The agent follows a loop:

1. **Think** — reason about what to do next
2. **Act** — call a tool (e.g., search the knowledge base)
3. **Observe** — look at the results
4. **Repeat** or **Answer** — either search again or compose a final response

This is fundamentally different from simple RAG. The agent can:
- Choose *which* tool to use based on the question
- Decide it needs *more* information and search again
- Determine it has *enough* information and stop searching

### The Tools We Created

We gave the agent three search tools, each targeting different parts of the knowledge base:

| Tool | What It Searches | When the Agent Uses It |
|------|-----------------|----------------------|
| `search_docs` | Official documentation only | Legal questions, constitutional matters, formal policy |
| `search_transcripts` | Speech transcripts only | Opinions, announcements, Vit Jedlicka's vision |
| `search_all` | Everything | General questions, broad topics |

Each tool is a Python function decorated with `@tool` from LangChain:

```python
@tool
def search_docs(query: str) -> str:
    """Search official Liberland documentation..."""
    chunks = _query_chroma(query, n_results=4, where={"source_type": "doc"})
    return "\n\n---\n\n".join(chunks)
```

The docstring is critical — it's what the LLM reads to decide *when* to use each tool.

### Creating the Agent

We used LangGraph's `create_react_agent`, which wires up the ReAct loop automatically:

```python
from langgraph.prebuilt import create_react_agent

agent = create_react_agent(llm, tools, prompt=system_prompt)
```

Three ingredients: the LLM, the tools, and a system prompt that tells the agent who it is and how to behave.

## Step 4: The Hybrid Optimisation

Our first agent implementation was **slow**. We benchmarked each component:

| Component | Time |
|-----------|------|
| Embedding + ChromaDB query | ~0.15s |
| LLM time-to-first-token | ~3.4s |
| LLM generation | ~1 word/sec |

The problem: a pure ReAct agent makes **2-3 LLM calls** per question (think, search, think again, answer). At 3.4 seconds per call, that's 7-10 seconds before the user sees anything.

**Key decision: The hybrid approach.** We pre-fetch relevant documents *before* the agent runs and inject them into the system prompt. This way:

- The agent's **first** LLM call already has context and can often answer immediately (1 call instead of 3)
- The search tools remain available if the agent decides it needs *more specific* information
- Best of both worlds: fast responses for straightforward questions, deeper search capability for complex ones

```python
async def generate_answer(query: str):
    # Pre-fetch BEFORE the agent runs — saves a round-trip
    prefetched = _query_chroma(query, n_results=6)
    context_text = _format_chunks(prefetched)

    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(context=context_text)
    agent = _get_agent(system_prompt)

    # Stream the agent's response
    async for event in agent.astream_events(...):
        ...
```

## Step 5: Streaming Responses to the Browser

Nobody wants to wait 10 seconds staring at a blank screen. We stream the response **token-by-token** using Server-Sent Events (SSE) — a simple HTTP-based protocol where the server pushes data to the browser as it becomes available.

The stream sends three types of events:

```
data: {"type": "token", "content": "Liberland"}     ← one word at a time
data: {"type": "token", "content": " is"}
data: {"type": "token", "content": " a"}
...
data: {"type": "sources", "sources": [...]}          ← cited sources
data: {"type": "done"}                               ← signal to stop
```

The frontend reads these events and appends each token to the message bubble in real-time, giving the "typing" effect users expect from chat interfaces.

**Key decision:** We kept the SSE event format identical to the original Claude implementation. This meant the frontend needed **zero changes** when we switched LLM providers and added the agent — a good example of designing clean interfaces between components.

## Step 6: The Knowledge Base (ChromaDB)

### How Documents Get In

Documents don't automatically appear in the knowledge base. We run an ingestion script (`python ingest.py`) that:

1. Reads all markdown files from `liberland-docs/` (official documentation)
2. Reads all text files from `text/` (speech transcripts)
3. Splits them into chunks (~400-500 words each)
4. Generates an embedding vector for each chunk (using the `all-MiniLM-L6-v2` model)
5. Stores everything in ChromaDB

**What are embeddings?** They're numerical representations of text that capture meaning. Similar texts have similar numbers. When a user asks "How does voting work?", we convert that to numbers and find the stored chunks with the most similar numbers — that's how retrieval works.

### Current scale

- 103 markdown documentation files
- 7 speech transcript files
- 794 total chunks in the database

## Step 7: Crafting the System Prompt

The system prompt is the agent's personality and instruction manual. Getting it right is crucial. Here's what ours covers:

1. **Identity** — "You are VitBot, an AI assistant specialising in Liberland"
2. **Source awareness** — tells the agent about the two types of sources (docs vs. transcripts) and how to treat them differently
3. **Pre-loaded context** — the documents we already retrieved are injected here
4. **Tool guidance** — "Only use your search tools if the pre-loaded context is insufficient"
5. **Citation rules** — "Cite your sources by document title"
6. **Honesty** — "If the context does not contain enough information, say so honestly"
7. **Style** — "Be conversational but accurate"
8. **Signature touch** — "If the context includes a relevant quote from Vit Jedlicka, lead your response with it as an italicised blockquote"

**Key decision:** The quote instruction demonstrates how prompt engineering shapes the agent's personality. By asking it to lead with a relevant presidential quote (only when genuinely relevant), we give VitBot a distinctive voice that connects users to the source material.

## Step 8: Markdown Rendering in the Frontend

The LLM generates responses in Markdown (headings, bold text, bullet points, tables). The browser needs to render this as formatted HTML.

We initially wrote a custom regex-based Markdown renderer (~90 lines of code). It handled basics (bold, lists, headings) but **couldn't render tables** — a significant limitation when the agent produces structured comparisons.

**Key decision:** We replaced the custom renderer with **`marked`** — a battle-tested, 7KB library that handles all of GitHub Flavored Markdown out of the box. Tables, strikethrough, task lists — everything works. The swap was three lines of code:

```javascript
import { marked } from 'marked';
marked.setOptions({ gfm: true, breaks: true });

// Before: MarkdownRenderer.render(text)
// After:  marked.parse(text)
```

**Lesson:** Don't build what you can install. A custom markdown parser is a maintenance burden that will never cover all edge cases.

## Bugs and Gotchas We Encountered

These are the real-world issues that documentation rarely covers.

### 1. ChromaDB's Rust Bindings Are Not Thread-Safe

**The problem:** We stored the ChromaDB client as a module-level singleton (standard practice for database connections). But LangGraph runs tools in a thread pool, and ChromaDB's Rust backend crashed with `'RustBindingsAPI' object has no attribute 'bindings'`.

**First fix (wrong):** Keep the client in a global variable to prevent garbage collection. This fixed one error but not the thread-safety crash.

**Real fix:** Create a fresh `PersistentClient` for each query. ChromaDB's `PersistentClient` is cheap to create (it just opens a SQLite file), so the performance cost is negligible.

**Lesson:** When combining async frameworks (LangGraph) with database libraries (ChromaDB), test under realistic concurrency conditions. Singletons that work in simple scripts can fail in async/threaded environments.

### 2. LangGraph's API Changed Between Versions

We planned to use `create_react_agent(llm, tools, state_modifier=system_prompt)`. The installed version had renamed this parameter to `prompt`. The fix was simple, but it cost debugging time.

**Lesson:** Always check the installed library's actual API signature, not documentation that may be out of date.

### 3. The Free Tier Rate Limit Is Aggressive

z.ai's GLM-4.7-Flash allows roughly 1 request per minute on the free tier. Since a ReAct agent can make multiple LLM calls per user question, we frequently hit rate limits during development.

**Lesson:** Factor rate limits into your model choice. A free tier is great for proving the concept works, but you'll need a paid tier for any interactive use.

### 4. Forgetting to Restart All Services

After making a backend code change, we killed the server for testing but forgot to restart it. The frontend was still running, so the app *looked* fine — until a user sent a message and got a 500 error.

**Lesson:** Create a verification checklist and run it after every change. Ours:
1. Backend health check
2. Frontend health check
3. Send a test message
4. Check server logs for errors
5. Run the E2E test suite

## The Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | Vanilla JS + Tailwind CSS + Vite | Lightweight, no framework overhead |
| Markdown | marked | GFM support including tables, 7KB |
| Backend | Python + FastAPI + Uvicorn | Async-native, simple, fast |
| Agent Framework | LangChain + LangGraph | ReAct agent with tool calling |
| LLM | z.ai GLM-4.7-Flash via OpenAI-compatible API | Free tier for PoC |
| Vector Database | ChromaDB | Local, file-based, no server needed |
| Embeddings | sentence-transformers (all-MiniLM-L6-v2) | Small, fast, runs locally |
| Streaming | Server-Sent Events (SSE) | Simple, HTTP-based, no WebSocket needed |
| Testing | Playwright E2E tests with mock SSE server | Backend-independent, 20 tests |

## Project Structure

```
VitBot/
  backend/
    server.py          ← FastAPI web server, SSE streaming
    rag.py             ← Agent definition, tools, LLM config
    ingest.py          ← Loads documents into ChromaDB
    chroma_db/         ← Vector database (generated)
    .env               ← API keys
    requirements.txt   ← Python dependencies
  frontend/
    src/app.js         ← Chat UI, markdown rendering
    src/style.css      ← Styling (Tailwind + custom)
    index.html         ← Entry point
    tests/e2e/         ← Playwright interaction tests
  liberland-docs/      ← Source markdown documentation
  text/                ← Source speech transcripts
```

## Running It Yourself

### Prerequisites
- Python 3.11+
- Node.js 18+
- A z.ai API key (free at z.ai)

### Setup
```bash
# Backend
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
echo "ZAI_API_KEY=your_key_here" > .env

# Ingest documents
python ingest.py

# Frontend
cd ../frontend
npm install
```

### Running
```bash
# Terminal 1: Backend
cd backend && source venv/bin/activate
uvicorn server:app --port 8000

# Terminal 2: Frontend
cd frontend
npx vite --port 5173
```

Open `http://localhost:5173` and ask a question.

### Running Tests
```bash
# Both servers must be running for live tests
# E2E tests use a mock server, so they work without the backend:
cd VitBot
node --input-type=commonjs < frontend/tests/e2e/interaction.spec.js
```

## Step 9: Catching the Agent Lying — Hallucination in Practice

This is possibly the most important lesson from the entire build.

A user asked VitBot about Liberland's judiciary system. The response included a confident, well-structured section titled **"AI-Assisted Resolution"** claiming:

> *"The first round of dispute resolution uses AI to suggest resolutions; if parties don't accept them, human judges become involved."*

This sounded entirely plausible — Liberland is technology-forward, uses blockchain for governance, and smart contracts for enforcement. AI-powered dispute resolution fits the narrative perfectly.

**It was completely fabricated.**

We searched every source document — all 103 documentation files, the laws repository, the constitution, and all 7 speech transcripts. **Not a single document mentions AI being used in dispute resolution.** The judiciary proposal (`liberland-docs/blockchain/judiciary/initial_proposal.md`) describes human judges, optional juries, smart contracts, and blockchain court records — but never AI.

### What the agent actually said

The agent didn't just mention AI in passing — it presented an **AI Judge** as the first step in Liberland's legal process. It structured the judiciary as a pipeline where disputes first go through AI-powered resolution, and only escalate to human judges if the parties reject the AI's suggestion. This was presented as established fact, with the same confident formatting and source citations as the rest of the response.

The reality in the source documents: the judiciary system starts with human judges, with optional juries, enforced through smart contracts on the blockchain. No AI anywhere in the pipeline.

### Why this is particularly interesting

There's a delicious irony here: **an LLM hallucinated that an AI would be the first judge in a legal system.** The model essentially imagined a world where AI plays a central role in justice — and presented it as fact. It's a small window into how these models process and project patterns. The training data is full of articles about "AI disrupting X" and "AI-first approaches to Y," so when the context mentions a tech-forward legal system, the model pattern-matches to what it's seen countless times: AI as the obvious first step.

Beyond the irony, this is a textbook example of why hallucination is so dangerous in RAG applications. LLMs don't "know" things — they predict plausible next tokens. When the context discusses blockchain governance and tech-forward legal systems, "AI-assisted dispute resolution" is a highly probable sequence. The model isn't lying intentionally; it's generating what *sounds right* given the surrounding context.

This is called **hallucination** or **confabulation**, and it's the single biggest risk when building RAG applications. The irony: the more domain-relevant context you provide, the more plausible the hallucinations become, because the model has better material to riff on.

### How we mitigated it

We added an aggressive anti-hallucination instruction to the system prompt, and — critically — we explicitly told the agent that saying "I don't know" is a *good* answer:

```
CRITICAL — NEVER FABRICATE INFORMATION:
- NEVER, NEVER, NEVER invent, extrapolate, or assume information
  that is not explicitly stated in the provided context documents.
- If a detail, mechanism, process, or claim is not directly present
  in the source material, DO NOT include it in your answer —
  no matter how plausible it sounds.
- If the context only partially covers a topic, answer ONLY with
  what the sources explicitly say and clearly state what is NOT covered.
- Getting something wrong by making it up is FAR worse than admitting
  the sources don't have the answer.
- It is completely OK to say "I don't have information about that in
  my sources" — this is a GOOD answer when the sources genuinely
  don't cover the topic.
```

That last line matters more than it looks. LLMs are trained to be helpful, which means they treat "I don't know" as a failure state to avoid. By positively reinforcing partial or absent answers, we're pushing against the model's default behaviour of filling gaps with plausible-sounding content.

In our case, the *correct* response to "How does AI-assisted dispute resolution work in Liberland?" would have been something like:

> *"The available sources describe Liberland's judiciary system in detail — including judges, juries, smart contracts for enforcement, and blockchain-based court records — but they don't mention AI being used in dispute resolution. This may be a planned feature not yet documented, or it may not be part of the current system."*

That answer is honest, still useful (it tells the user what the judiciary system *does* include), and doesn't fabricate a single detail. It's a better answer than the confident, well-formatted lie we got before.

### Does this fully solve it?

**No.** Prompt instructions reduce hallucination frequency but cannot eliminate it. The model can still generate plausible-sounding claims that aren't in the sources. More robust approaches include:

1. **Post-generation verification** — a second LLM call that checks each claim against the source documents
2. **Constrained generation** — forcing the model to include inline citations for every factual claim, making unsupported claims more obvious
3. **User education** — making it clear to users that AI responses should be verified against the cited sources
4. **Confidence scoring** — flagging responses where the retrieval similarity scores are low (meaning the sources are a weak match for the question)

For a proof-of-concept, the strong prompt instruction is a pragmatic first step. For production, you'd want at least post-generation verification.

### The deeper lesson

**Trust but verify — and build verification into the system, not just the process.** When a VitBot user reads "AI-Assisted Resolution" with proper formatting, source citations, and confident language, they have no reason to doubt it. The fact that it was entirely made up highlights why RAG applications need guardrails beyond "tell the model to be honest."

## Key Takeaways

1. **Start simple, then add intelligence.** Get basic RAG working before introducing agent behaviour.
2. **The hybrid approach wins.** Pre-fetching context before the agent runs gives you fast responses *and* the option for deeper search.
3. **OpenAI-compatible APIs give you flexibility.** Switching LLM providers was painless because we used standard tooling.
4. **Prompt engineering is product design.** The system prompt defines your agent's personality, accuracy, and user experience.
5. **Don't build what you can install.** Swapping a custom markdown renderer for `marked` saved maintenance burden and fixed table rendering instantly.
6. **Test with mocks, verify with real calls.** Our E2E tests use a mock SSE server, making them fast and reliable regardless of LLM availability.
7. **Async + databases = watch for thread safety.** This was our biggest bug. Test under realistic conditions, not just simple scripts.
8. **LLMs will confidently fabricate plausible details.** Hallucination is the #1 risk in RAG applications. Strong prompt guardrails help but cannot eliminate it — build verification into the system, not just the instructions.
