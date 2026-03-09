# RAG Pipeline — Ihsan Labs
## docs/rag-pipeline.md
<!-- VIBE-CODER: Update [RAG_VERSION], [EMBEDDING_MODEL], and [CHUNK_SIZE] if ingestion strategy changes. The "Deduplication" and "Failure modes" sections must be kept current with the pipeline implementation in packages/rag-pipeline/. -->
<!-- [RAG_VERSION]: 1.0.0 -->
<!-- [EMBEDDING_MODEL]: text-embedding-3-small (OpenAI) -->
<!-- [EMBEDDING_DIMS]: 1536 -->
<!-- [CHUNK_SIZE_TOKENS]: 512 -->
<!-- [CHUNK_OVERLAP_TOKENS]: 50 -->
<!-- [LAST_REVIEWED]: 2025 -->

---

## Purpose

The RAG (Retrieval-Augmented Generation) pipeline is the evidence backbone of Ihsan Labs. It is responsible for converting raw documentary evidence — partner annual reports, GlobalGiving project updates, field inspection PDFs, audit statements — into a searchable vector corpus that the edge functions can retrieve at query time.

No LLM call in the system is made without retrieved chunks from this corpus. The quality of every allocation plan and due-diligence report is a direct function of how well this pipeline runs.

---

## What Gets Ingested

The pipeline has three document sources.

**GlobalGiving project pages** are fetched via the GlobalGiving REST API. Each project page is treated as a document: title, description, updates feed, and any attached PDF reports are each chunked separately. Project pages are re-ingested whenever the project's `updated_at` timestamp changes.

**Partner field report PDFs** are submitted by field partners via a simple admin endpoint (`POST /api/admin/ingest-pdf` with `{ source_url, project_id, doc_type }`). The pipeline fetches the PDF from the URL, computes its SHA-256 hash, and checks whether the hash already exists in `document_chunks.pdf_hash` before proceeding. New reports are ingested within the next nightly run or immediately if submitted via the admin endpoint with `priority: true`.

**Charity Navigator narrative content** — taglines, cause descriptions, and advisory text — is ingested as lightweight chunks and associated with the `organization_id` rather than a `project_id`. These chunks provide context for the due-diligence summarizer when it is assessing an organization with few project-level documents.

---

## Ingestion Steps

The pipeline executes the following steps for each document, in order.

**1. Fetch.** The raw document is retrieved from its source URL. For PDFs, the pipeline uses `pdfjs-dist` to extract text page by page. For HTML (GlobalGiving pages), it uses `cheerio` to extract the relevant text nodes and strip navigation, footer, and advertisement content.

**2. Hash.** A SHA-256 hash is computed over the raw document bytes (for PDFs) or the extracted text (for HTML). This hash is the deduplication key. If a chunk with this `pdf_hash` already exists in the database, the document is skipped and the pipeline moves on.

**3. Chunk.** The extracted text is split into chunks of 512 tokens with a 50-token overlap using the `@anthropic-ai/tokenizer` package. Chunk boundaries are adjusted to respect sentence endings — the pipeline will not split in the middle of a sentence if doing so can be avoided within a 10-token tolerance. Each chunk is assigned a sequential `chunk_index` within its document.

**4. Embed.** Each chunk is sent to the OpenAI Embeddings API (`text-embedding-3-small`, 1536 dimensions) in batches of 100 to respect rate limits. The resulting vectors are stored alongside the chunk text.

**5. Upsert.** Chunks are upserted into `document_chunks` with an `on conflict (project_id, pdf_hash, chunk_index) do update` strategy. This means re-ingesting a document that has not changed is a no-op after the hash check, and re-ingesting a document that has changed will overwrite only the rows for that document.

**6. Trigger due-diligence refresh.** After ingesting new chunks for a project, the pipeline calls `POST /functions/v1/due-diligence` with `{ project_id, force_refresh: true }` to invalidate the cached report and regenerate it with the new evidence.

---

## Retrieval

At query time, the `match_chunks` Postgres function performs a cosine similarity search using pgvector's `<=>` operator against the `embedding` column. The IVFFlat index with `lists = 100` supports this search at under 50ms for a corpus of up to 1 million chunks.

The default retrieval parameters used by the edge functions are a similarity threshold of 0.72 and a maximum result count of 5 chunks. These values represent a conservative balance: high enough to exclude noise, low enough to return something useful even for projects with limited documentation. Callers may override these parameters, but should not exceed a count of 8 chunks per LLM call — beyond that, the additional context provides diminishing returns and increases latency.

The query embedding must be generated from the same model (`text-embedding-3-small`) that was used during ingestion. Using a different model for queries will produce meaningless similarity scores.

---

## Running the Pipeline

```bash
# Nightly batch (top-100 projects by final_score, GlobalGiving sync + partner PDFs)
bash scripts/ingest-pdfs.sh

# Single project ingest
pnpm --filter rag-pipeline start \
  --source partner-pdf \
  --url https://partner.org/report-2025.pdf \
  --project-id <uuid> \
  --doc-type field_report

# GlobalGiving full sync
pnpm --filter rag-pipeline start \
  --source globalgiving \
  --limit 200

# Force re-ingest of all documents for a project (ignores hash dedup)
pnpm --filter rag-pipeline start \
  --project-id <uuid> \
  --force
```

---

## Failure Modes

**OpenAI rate limit (429).** The pipeline uses exponential backoff with a maximum of five retries per batch. If a batch fails after five retries, the affected chunks are written to a `failed_chunks` table with the error message and retried during the next nightly run.

**PDF extraction failure.** If `pdfjs-dist` cannot extract text from a PDF (encrypted, scanned-only, or corrupted), the document is skipped and an alert is written to `audit_log` with `action: 'ingest_skipped'` and the reason. Scanned PDFs may be processed via an OCR step in a future phase.

**Source URL unavailable.** If the source URL returns a non-200 response, the document is skipped and queued for retry with a 24-hour delay.

**Schema mismatch.** If the `embedding` column dimension does not match the model output (e.g., because the embedding model was changed without a schema migration), the upsert will fail at the database level. This is intentional: a dimension mismatch must be resolved deliberately, not silently accepted.

---
<!-- VIBE-CODER SECTION — UPDATE ON CHANGE -->
<!-- [EMBEDDING_BATCH_SIZE]: 100 -->
<!-- [MAX_RETRY_ATTEMPTS]: 5 -->
<!-- [SIMILARITY_DEFAULT]: 0.72 -->
<!-- [MAX_CHUNKS_PER_LLM_CALL]: 8 (recommended), 5 (default) -->
<!-- [DEDUP_STRATEGY]: pdf_hash on (project_id, pdf_hash, chunk_index) -->
<!-- [FAILED_CHUNK_RETRY_DELAY_HOURS]: 24 -->
