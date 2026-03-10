import os
import re
import glob
import chromadb
from sentence_transformers import SentenceTransformer

DOCS_DIR = os.path.join(os.path.dirname(__file__), "..", "liberland-docs")
LAWS_DIR = os.path.join(os.path.dirname(__file__), "..", "liberland-laws")
CONSTITUTION_DIR = os.path.join(os.path.dirname(__file__), "..", "liberland-constitution")
TEXT_DIR = os.path.join(os.path.dirname(__file__), "..", "text")
CHROMA_DIR = os.path.join(os.path.dirname(__file__), "chroma_db")
COLLECTION_NAME = "vitbot"


def chunk_markdown(filepath: str, base_dir: str = None, source_type: str = "doc") -> list[dict]:
    if base_dir is None:
        base_dir = DOCS_DIR

    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    title = os.path.splitext(os.path.basename(filepath))[0]
    rel_path = os.path.relpath(filepath, base_dir)
    chunks = []

    sections = re.split(r"(^#{1,3}\s+.+$)", content, flags=re.MULTILINE)

    current_heading = title
    current_text = ""

    for part in sections:
        if re.match(r"^#{1,3}\s+", part):
            if current_text.strip():
                chunks.extend(
                    _split_long_section(current_text.strip(), title, rel_path, current_heading, source_type)
                )
            current_heading = part.strip().lstrip("#").strip()
            current_text = part + "\n"
        else:
            current_text += part

    if current_text.strip():
        chunks.extend(
            _split_long_section(current_text.strip(), title, rel_path, current_heading, source_type)
        )

    return chunks


def _split_long_section(text: str, title: str, source_path: str, section: str, source_type: str = "doc") -> list[dict]:
    words = text.split()
    if len(words) <= 500:
        return [_make_chunk(text, title, source_path, source_type, section)]

    paragraphs = re.split(r"\n\s*\n", text)
    result = []
    current_block = ""

    for para in paragraphs:
        if len((current_block + "\n\n" + para).split()) > 500 and current_block.strip():
            result.append(_make_chunk(current_block.strip(), title, source_path, source_type, section))
            current_block = para
        else:
            current_block = current_block + "\n\n" + para if current_block else para

    if current_block.strip():
        result.append(_make_chunk(current_block.strip(), title, source_path, source_type, section))

    return result


def chunk_transcript(filepath: str) -> list[dict]:
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    title = os.path.splitext(os.path.basename(filepath))[0]
    rel_path = os.path.relpath(filepath, os.path.join(os.path.dirname(__file__), ".."))
    chunks = []

    separator_idx = content.find("\n---\n")
    if separator_idx != -1:
        summary_block = content[:separator_idx].strip()
        body = content[separator_idx + 5:].strip()
        chunks.append(
            _make_chunk(summary_block, title, rel_path, "transcript", "summary", priority="high")
        )
    else:
        body = content.strip()

    paragraphs = re.split(r"\n\s*\n", body)
    current_block = ""

    for para in paragraphs:
        candidate = current_block + "\n\n" + para if current_block else para
        if len(candidate.split()) > 400 and current_block.strip():
            chunks.append(_make_chunk(current_block.strip(), title, rel_path, "transcript", "body"))
            current_block = para
        else:
            current_block = candidate

    if current_block.strip():
        chunks.append(_make_chunk(current_block.strip(), title, rel_path, "transcript", "body"))

    return chunks


def _make_chunk(
    text: str, title: str, source_path: str, source_type: str, section: str, priority: str = "normal"
) -> dict:
    return {
        "text": text,
        "metadata": {
            "source_path": source_path,
            "source_type": source_type,
            "title": title,
            "section": section,
            "priority": priority,
        },
    }


def ingest():
    print("Loading embedding model...")
    model = SentenceTransformer("all-MiniLM-L6-v2")

    client = chromadb.PersistentClient(path=CHROMA_DIR)

    existing = [c.name for c in client.list_collections()]
    if COLLECTION_NAME in existing:
        client.delete_collection(COLLECTION_NAME)

    collection = client.create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )

    all_chunks = []

    md_files = glob.glob(os.path.join(DOCS_DIR, "**", "*.md"), recursive=True)
    print(f"Found {len(md_files)} documentation files")
    for filepath in sorted(md_files):
        chunks = chunk_markdown(filepath, base_dir=DOCS_DIR, source_type="doc")
        all_chunks.extend(chunks)
        print(f"  {os.path.relpath(filepath, DOCS_DIR)}: {len(chunks)} chunks")

    law_files = glob.glob(os.path.join(LAWS_DIR, "**", "*.md"), recursive=True)
    print(f"Found {len(law_files)} law files")
    for filepath in sorted(law_files):
        chunks = chunk_markdown(filepath, base_dir=LAWS_DIR, source_type="doc")
        all_chunks.extend(chunks)
        print(f"  {os.path.relpath(filepath, LAWS_DIR)}: {len(chunks)} chunks")

    const_files = glob.glob(os.path.join(CONSTITUTION_DIR, "**", "*.md"), recursive=True)
    print(f"Found {len(const_files)} constitution files")
    for filepath in sorted(const_files):
        chunks = chunk_markdown(filepath, base_dir=CONSTITUTION_DIR, source_type="doc")
        all_chunks.extend(chunks)
        print(f"  {os.path.relpath(filepath, CONSTITUTION_DIR)}: {len(chunks)} chunks")

    txt_files = glob.glob(os.path.join(TEXT_DIR, "*.txt"))
    print(f"Found {len(txt_files)} transcript files")
    for filepath in sorted(txt_files):
        chunks = chunk_transcript(filepath)
        all_chunks.extend(chunks)
        print(f"  {os.path.basename(filepath)}: {len(chunks)} chunks")

    print(f"\nTotal chunks: {len(all_chunks)}")
    print("Generating embeddings...")

    texts = [c["text"] for c in all_chunks]
    embeddings = model.encode(texts, show_progress_bar=True).tolist()

    batch_size = 500
    for i in range(0, len(all_chunks), batch_size):
        batch = all_chunks[i : i + batch_size]
        batch_embeddings = embeddings[i : i + batch_size]
        ids = [f"chunk_{i + j}" for j in range(len(batch))]

        collection.add(
            ids=ids,
            embeddings=batch_embeddings,
            documents=[c["text"] for c in batch],
            metadatas=[c["metadata"] for c in batch],
        )
        print(f"  Stored batch {i // batch_size + 1} ({len(batch)} chunks)")

    print(f"Ingestion complete. {len(all_chunks)} chunks stored in {CHROMA_DIR}")


if __name__ == "__main__":
    ingest()
