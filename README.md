# ProcureFlow — AI-Powered Procurement Assistant

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

A working prototype built for **INF533-PPM-022** — *"AI-Powered Agent for Vendor
Identification, RFQ Generation and Cost Comparison Sheet in Industrial
Procurement"* (Agentic AI course, Academic Group B7).

ProcureFlow takes a procurement engineer from a plain-language requirement to a
ranked L1/L2/L3 Cost Comparison Sheet — with vendor shortlisting, RFQ drafting,
real vendor e-mail, and quotation parsing along the way — while keeping a human
approval checkpoint before anything ever reaches a supplier.

## Why

Industrial procurement today is largely manual: engineers search vendor
brochures by hand, draft RFQs one at a time, e-mail vendors individually, and
re-key every quotation into an Excel comparison sheet. This introduces bias
(the same familiar vendors get approached repeatedly), transcription errors,
and inconsistent RFQ quality. ProcureFlow automates the repetitive front-end
of this process end-to-end, without removing the human from the loop.

## Features

- **Natural-language requirement capture** — type what you need; the app
  structures it into material, spec, quantity, and delivery fields.
- **AI-assisted vendor shortlisting** — retrieves against real vendor brochure
  text (RAG-style) and shows the evidence behind every match, not just a score.
- **RFQ drafting with a hard approval gate** — nothing is sent to any vendor
  until a human reviews and approves the draft.
- **Real vendor e-mail** — sends the approved RFQ via SMTP and reads vendor
  replies back via IMAP, matching them to the right case automatically.
- **Automated quotation parsing** — extracts price, tax, freight, delivery,
  payment terms and warranty from PDF or pasted quotations; every field is
  shown for human confirmation before it's saved.
- **Cost Comparison Sheet generation** — ranks vendors L1/L2/L3 straight into
  your organisation's own Excel template, formulas intact.
- **One audit folder per requirement** — the RFQ, every quotation, all
  correspondence, and the final CCS, together, for later review.
- **Full status pipeline** — every case is trackable end to end: Requirement
  Captured → Vendors Shortlisted → RFQ Drafted → RFQ Approved → RFQ Sent →
  Quotations Received → CCS Generated → Closed.

## Architecture

Five focused agents, each responsible for one step, plus a Communication Agent
that handles real e-mail:

| Agent | Responsibility |
|---|---|
| Requirement Understanding | Parses free-text input into structured fields |
| Vendor Search | Shortlists vendors by retrieving over brochure text, with evidence |
| RFQ Generator | Drafts the enquiry into a standard template |
| Communication | Sends the approved RFQ and reads vendor replies (SMTP/IMAP) |
| Quotation Analysis | Extracts commercial terms from a vendor's reply |
| Cost Comparison | Ranks vendors and writes the CCS Excel file (pure arithmetic, no LLM) |

**AI mode is a three-tier cascade**, tried in order per call, so the app
always produces a result:

1. **Claude** (`claude-opus-4-8`) — if `ANTHROPIC_API_KEY` is set
2. **Gemini** (`gemini-2.5-flash`) — if `GEMINI_API_KEY` is set (free tier, no
   card required — get one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey))
3. **Deterministic heuristics** — regex/pattern extraction, always available,
   zero cost, no external calls

The badge in the app's top bar shows which engine actually produced each
result.

## Tech stack

- **Backend:** Node.js, Express
- **LLM:** `@anthropic-ai/sdk` (Claude), `@google/genai` (Gemini) — no
  orchestration framework; the provider cascade is hand-written
- **PDF processing:** `pdf-parse` (text + table extraction)
- **Excel generation:** `exceljs`, writing directly into the provided CCS
  template so formulas and layout are preserved
- **E-mail:** `nodemailer` (SMTP send), `imapflow` + `mailparser` (IMAP fetch
  + MIME parsing)
- **Frontend:** vanilla HTML/CSS/JavaScript — no framework
- **Persistence:** one JSON-backed folder per case, no database

## Getting started

```bash
git clone <your-repo-url>
cd ProcureFlow
npm install
npm start          # → http://localhost:3111
```

The app runs fully offline on heuristic fallback with zero configuration. To
enable the AI and e-mail features, set these as real environment variables
before starting (see `.env.example` for the full list — note the app reads
them from the environment, not from a `.env` file):

```powershell
# PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-..."     # optional
$env:GEMINI_API_KEY = "AIza..."           # optional, free
$env:GMAIL_USER = "you@gmail.com"         # optional, for real e-mail
$env:GMAIL_APP_PASSWORD = "xxxx xxxx xxxx xxxx"
npm start
```

```bash
# macOS/Linux
export ANTHROPIC_API_KEY="sk-ant-..."
export GEMINI_API_KEY="AIza..."
export GMAIL_USER="you@gmail.com"
export GMAIL_APP_PASSWORD="xxxx xxxx xxxx xxxx"
npm start
```

## Project structure

```
.
├── server.js              # Express app, API routes, pipeline orchestration
├── src/
│   ├── llm.js              # Claude -> Gemini -> heuristic cascade
│   ├── store.js            # Case/vendor/settings persistence
│   ├── mail.js              # SMTP send + IMAP fetch
│   └── agents/
│       ├── requirement.js
│       ├── vendorSearch.js
│       ├── rfq.js
│       ├── quotation.js
│       └── ccs.js
├── public/                 # Frontend (vanilla HTML/CSS/JS)
├── templates/               # The organisation's Cost Comparison Sheet template
└── data/
    ├── vendors.json         # Synthetic vendor master (sample data)
    ├── vendor_docs/         # Matching brochure text (RAG corpus)
    └── cases/                # Created at runtime, git-ignored (see below)
```

## Data & privacy

`data/vendors.json` and `data/vendor_docs/` are **synthetic sample data**
built for this prototype — no real supplier records. `data/cases/` is created
by the app at runtime and holds real requirement/RFQ/quotation history; it is
**git-ignored by design**, since it can contain real vendor and personal
e-mail addresses once you start using the app for real. Do not remove it from
`.gitignore` without checking its contents first.

## Known limitations

- Accuracy has been validated **manually** against real test quotations, not
  benchmarked on a labelled dataset — treat any accuracy claim as
  observed-on-tested-cases, not a statistically powered result.
- The Gemini fallback path has been verified end-to-end on error handling
  (invalid-key round trip to the real API) but not yet on a fully successful
  response — needs a live key to confirm.
- PR/PO creation, ERP integration, and downstream approval workflows are
  explicitly out of scope for this phase.

## Team — Group B7

Devansh Mangal · Harsirjan Kaur · Pulkit Solanki · Sahil Shrikant Talathi ·
Shubhangi Rastogi

Guided by Prof. Deep Prakash and Prof. Abhishek Kumar Jha · TA: Khushbu Gandhi

## License

MIT — see [LICENSE](LICENSE).
