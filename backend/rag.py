import os
import logging
import threading
from typing import AsyncGenerator
import chromadb
from sentence_transformers import SentenceTransformer
from langchain_openai import ChatOpenAI
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

logger = logging.getLogger(__name__)

CHROMA_DIR = os.path.join(os.path.dirname(__file__), "chroma_db")
COLLECTION_NAME = "vitbot"

_model = None
_model_lock = threading.Lock()


def _get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                _model = SentenceTransformer("all-MiniLM-L6-v2")
    return _model


def _query_chroma(query: str, n_results: int = 6, where: dict | None = None) -> list[dict]:
    """Query ChromaDB with a fresh client each time to avoid Rust binding thread-safety issues."""
    model = _get_model()
    query_embedding = model.encode([query]).tolist()

    client = chromadb.PersistentClient(path=CHROMA_DIR)
    collection = client.get_collection(name=COLLECTION_NAME)

    kwargs = {
        "query_embeddings": query_embedding,
        "n_results": n_results,
        "include": ["documents", "metadatas", "distances"],
    }
    if where:
        kwargs["where"] = where

    results = collection.query(**kwargs)

    chunks = []
    for i in range(len(results["ids"][0])):
        meta = results["metadatas"][0][i]
        chunks.append({
            "text": results["documents"][0][i],
            "metadata": meta,
            "distance": results["distances"][0][i],
        })
    return chunks


def _format_chunks(chunks: list[dict]) -> str:
    """Format chunks as labelled text blocks for the LLM."""
    parts = []
    for chunk in chunks:
        meta = chunk["metadata"]
        source_label = "Official Doc" if meta.get("source_type") == "doc" else "Speech Transcript"
        parts.append(
            f"[{meta.get('title', 'Unknown')} ({source_label}) — Section: {meta.get('section', 'N/A')}]\n"
            f"{chunk['text']}"
        )
    return "\n\n---\n\n".join(parts)


def _extract_sources(chunks: list[dict]) -> list[dict]:
    """Extract deduplicated source metadata from chunks."""
    seen = set()
    sources = []
    for chunk in chunks:
        meta = chunk["metadata"]
        key = (meta.get("title", ""), meta.get("source_type", ""), meta.get("section", ""))
        if key not in seen:
            seen.add(key)
            sources.append({
                "title": meta.get("title", "Unknown"),
                "source_type": meta.get("source_type", "unknown"),
                "section": meta.get("section", "N/A"),
            })
    return sources


@tool
def search_docs(query: str) -> str:
    """Search official Liberland documentation (constitution, laws, regulations, blockchain governance, policies).
    Use this for targeted follow-up searches when the pre-loaded context lacks specific official details."""
    chunks = _query_chroma(query, n_results=4, where={"source_type": "doc"})
    if not chunks:
        return "No official documentation found for this query."
    return _format_chunks(chunks)


@tool
def search_transcripts(query: str) -> str:
    """Search speech and interview transcripts from Vit Jedlicka and related figures.
    Use this for targeted follow-up searches when the pre-loaded context lacks transcript details."""
    chunks = _query_chroma(query, n_results=4, where={"source_type": "transcript"})
    if not chunks:
        return "No speech transcripts found for this query."
    return _format_chunks(chunks)


SYSTEM_PROMPT_TEMPLATE = """You are VitBot, an AI assistant specialising in knowledge about the Free Republic of Liberland. You were created to help people learn about Liberland's governance, blockchain system, laws, regulations, and vision.

You have access to two types of source material:
1. **Official documentation** — formal documents covering Liberland's constitution, laws, regulations, blockchain governance, and policies
2. **Speech/interview transcripts** — transcriptions of talks and interviews by Vit Jedlicka (founder and president of Liberland) and related figures

Relevant context has already been retrieved for you below. Use it to answer the question directly. Only use your search tools if the pre-loaded context is insufficient and you need more specific information.

CRITICAL — NEVER FABRICATE INFORMATION:
- NEVER, NEVER, NEVER invent, extrapolate, or assume information that is not explicitly stated in the provided context documents.
- If a detail, mechanism, process, or claim is not directly present in the source material, DO NOT include it in your answer — no matter how plausible it sounds.
- If the context only partially covers a topic, answer ONLY with what the sources explicitly say and clearly state what is NOT covered.
- If the context does not contain enough information to answer the question, say so honestly: "The available sources do not cover this topic."
- Getting something wrong by making it up is FAR worse than admitting the sources don't have the answer.
- It is completely OK to say "I don't have information about that in my sources" — this is a GOOD answer when the sources genuinely don't cover the topic. A partial, honest answer is always better than a complete, fabricated one.

When answering questions:
- Base your answers EXCLUSIVELY on the provided context documents — treat them as your only source of truth
- Cite your sources by document title so the user can verify information
- When information comes from a speech transcript, note that it reflects what was said in that particular talk (opinions, announcements, or informal statements) as distinct from official policy documents
- Be conversational but accurate — prioritise correctness over chattiness
- If multiple sources give complementary information, synthesise them — but never add details that aren't in any source
- If the context includes a relevant quote from Vít Jedlička (from speech transcripts), lead your response with it as an italicised blockquote, attributed to him and the talk it came from. Only include a quote if it is genuinely relevant to the question — do not force one in. Format: `> *"The quote..."* — Vít Jedlička, Talk Title`

--- PRE-LOADED CONTEXT ---

{context}"""

_tools = [search_docs, search_transcripts]

_llm = None


def _get_agent(system_prompt: str):
    """Create agent with the given system prompt (includes pre-loaded context)."""
    global _llm
    if _llm is None:
        _llm = ChatOpenAI(
            model="glm-4.7-flash",
            base_url="https://api.z.ai/api/paas/v4/",
            api_key=os.environ["ZAI_API_KEY"],
            streaming=True,
        )
    return create_react_agent(_llm, _tools, prompt=system_prompt)


async def generate_answer(query: str) -> AsyncGenerator[dict, None]:
    """Pre-fetch context, then stream the agent's response as token and source events."""
    # Pre-fetch broad context before the agent runs — saves an LLM round-trip
    prefetched = _query_chroma(query, n_results=6)
    context_text = _format_chunks(prefetched) if prefetched else "No documents found."
    sources_collected = _extract_sources(prefetched)

    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(context=context_text)
    agent = _get_agent(system_prompt)

    async for event in agent.astream_events(
        {"messages": [{"role": "user", "content": query}]},
        version="v2",
    ):
        kind = event["event"]

        # Stream LLM tokens as they arrive
        if kind == "on_chat_model_stream":
            chunk = event["data"]["chunk"]
            if chunk.content and isinstance(chunk.content, str):
                yield {"type": "token", "content": chunk.content}

        # Collect additional sources from follow-up tool calls
        elif kind == "on_tool_end":
            output = event["data"].get("output", "")
            if isinstance(output, str):
                for line in output.split("\n"):
                    if line.startswith("[") and "]" in line:
                        bracket_content = line[1:line.index("]")]
                        parts = bracket_content.split(" — Section: ")
                        title_part = parts[0] if parts else bracket_content
                        section = parts[1] if len(parts) > 1 else "N/A"

                        if "(Official Doc)" in title_part:
                            title = title_part.replace(" (Official Doc)", "")
                            source_type = "doc"
                        elif "(Speech Transcript)" in title_part:
                            title = title_part.replace(" (Speech Transcript)", "")
                            source_type = "transcript"
                        else:
                            title = title_part
                            source_type = "unknown"

                        source = {
                            "title": title,
                            "source_type": source_type,
                            "section": section,
                        }
                        if source not in sources_collected:
                            sources_collected.append(source)

    if sources_collected:
        yield {"type": "sources", "sources": sources_collected}
