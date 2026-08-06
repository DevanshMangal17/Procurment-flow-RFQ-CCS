// ProcureFlow - AI-powered procurement assistant (INF533-PPM-022, Group B7).
// Express app exposing the agent pipeline + persistent case tracking.
const path = require('path');
const express = require('express');
const multer = require('multer');

const store = require('./src/store');
const { getAiMode } = require('./src/llm');
const mail = require('./src/mail');
const requirementAgent = require('./src/agents/requirement');
const vendorSearchAgent = require('./src/agents/vendorSearch');
const rfqAgent = require('./src/agents/rfq');
const quotationAgent = require('./src/agents/quotation');
const ccsAgent = require('./src/agents/ccs');

// Safety net: log and keep running instead of letting a stray error (e.g. a
// dropped IMAP/SMTP connection, or a rejected promise nothing awaited) kill
// the whole dev server mid-demo. This is a prototype convenience, not a
// production pattern - a real deployment would still want to fail fast on
// unrecoverable errors, but here the priority is "the app stays up."
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.stack ? err.stack : err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: err.message || String(err) });
});

function vendorMap() {
  return Object.fromEntries(store.loadVendors().map((v) => [v.id, v]));
}

// ---------- status / vendors ----------
app.get('/api/status', (req, res) => {
  res.json({ ai: getAiMode(), statuses: store.STATUSES, mail: mail.mailStatus(), settings: store.loadSettings() });
});

app.put('/api/settings', (req, res) => {
  const s = store.saveSettings({ ...store.loadSettings(), ...req.body });
  res.json(s);
});

app.get('/api/vendors', (req, res) => {
  res.json(store.loadVendors().map((v) => ({ ...v, brochure: store.loadVendorDoc(v) })));
});

// ---------- cases ----------
app.get('/api/cases', (req, res) => {
  res.json(store.listCases().map((c) => ({
    id: c.id, status: c.status, createdAt: c.createdAt, updatedAt: c.updatedAt,
    material: c.requirement ? c.requirement.material : c.rawText.slice(0, 60),
    quoteCount: Object.keys(c.quotes).length,
    vendorCount: c.selectedVendors.length,
  })));
});

app.get('/api/cases/:id', (req, res) => {
  const c = store.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  res.json({ ...c, vendors: vendorMap() });
});

// 1. Requirement Understanding Agent
app.post('/api/cases', wrap(async (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Requirement text is required' });
  const c = store.createCase(text);
  const { result, engine } = await requirementAgent.understand(text);
  c.requirement = result;
  c.requirementEngine = engine;
  store.logEvent(c, 'Requirement Understanding Agent', `Captured requirement (${engine})`);
  store.writeCaseFile(c.id, 'requirement.json', JSON.stringify({ rawText: text, structured: result }, null, 2));
  store.saveCase(c);
  res.json(c);
}));

app.put('/api/cases/:id/requirement', wrap(async (req, res) => {
  const c = store.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  c.requirement = req.body.requirement;
  store.logEvent(c, 'Requester', 'Requirement edited/confirmed');
  store.writeCaseFile(c.id, 'requirement.json', JSON.stringify({ rawText: c.rawText, structured: c.requirement }, null, 2));
  store.saveCase(c);
  res.json(c);
}));

// 2. Vendor Search Agent
app.post('/api/cases/:id/shortlist', wrap(async (req, res) => {
  const c = store.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const { shortlist, engine } = await vendorSearchAgent.search(c.requirement);
  c.shortlist = shortlist.map(({ vendor, ...rest }) => rest); // vendor master joined on read
  c.shortlistEngine = engine;
  c.selectedVendors = shortlist.filter((s) => s.capable).map((s) => s.vendorId);
  store.advanceStatus(c, 'Vendors Shortlisted');
  store.logEvent(c, 'Vendor Search Agent', `Shortlisted ${c.selectedVendors.length} capable vendor(s) from ${shortlist.length} candidates (${engine})`);
  store.saveCase(c);
  res.json({ ...c, vendors: vendorMap() });
}));

app.put('/api/cases/:id/selection', wrap(async (req, res) => {
  const c = store.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  c.selectedVendors = req.body.selectedVendors || [];
  store.logEvent(c, 'Requester', `Vendor selection updated (${c.selectedVendors.length} vendor(s))`);
  store.saveCase(c);
  res.json({ ...c, vendors: vendorMap() });
}));

// 3. RFQ Generator Agent
app.post('/api/cases/:id/rfq', wrap(async (req, res) => {
  const c = store.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const { result, engine } = await rfqAgent.draft(c.requirement, c.id);
  c.rfq = result;
  c.rfqEngine = engine;
  c.rfqApprovedAt = null;
  store.advanceStatus(c, 'RFQ Drafted');
  store.logEvent(c, 'RFQ Generator Agent', `RFQ drafted (${engine}) - pending requester approval`);
  store.saveCase(c);
  res.json({ ...c, vendors: vendorMap() });
}));

app.put('/api/cases/:id/rfq', wrap(async (req, res) => {
  const c = store.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  c.rfq = req.body.rfq;
  c.rfqApprovedAt = null; // edits invalidate a prior approval
  store.logEvent(c, 'Requester', 'RFQ draft edited');
  store.saveCase(c);
  res.json({ ...c, vendors: vendorMap() });
}));

// 4. Approval Agent (human checkpoint - nothing is sent before this)
app.post('/api/cases/:id/rfq/approve', wrap(async (req, res) => {
  const c = store.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  if (!c.rfq) return res.status(400).json({ error: 'No RFQ draft to approve' });
  c.rfqApprovedAt = new Date().toISOString();
  store.advanceStatus(c, 'RFQ Approved');
  store.logEvent(c, 'Approval Agent', 'RFQ approved by requester');
  store.writeCaseFile(c.id, `RFQ_${c.id}.txt`, rfqAgent.renderText(c.rfq, c.id, null));
  store.saveCase(c);
  res.json({ ...c, vendors: vendorMap() });
}));

// 5. Communication Agent - real e-mail when SMTP is configured, else simulated.
// Body may carry { emails: { vendorId: overrideAddress } } confirmed in the UI.
app.post('/api/cases/:id/send', wrap(async (req, res) => {
  const c = store.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  if (!c.rfqApprovedAt) return res.status(400).json({ error: 'RFQ must be approved before sending' });
  if (!c.selectedVendors.length) return res.status(400).json({ error: 'No vendors selected' });
  const vendors = vendorMap();
  const overrides = (req.body && req.body.emails) || {};
  c.vendorEmails = { ...(c.vendorEmails || {}), ...overrides };
  const canSend = mail.mailStatus().outbound;
  const sent = [];
  const failures = [];
  for (const vid of c.selectedVendors) {
    const v = vendors[vid];
    if (!v) continue;
    const to = c.vendorEmails[vid] || v.email;
    const bodyText = rfqAgent.renderText(c.rfq, c.id, v.name);
    // Subject carries the case ID so vendor replies can be matched back automatically.
    const subject = c.rfq.subject.includes(c.id) ? c.rfq.subject : `${c.rfq.subject} [${c.id}]`;
    let mode = 'SIMULATED - e-mail not configured';
    if (canSend) {
      try {
        await mail.sendMail({ to, subject, text: bodyText });
        mode = `SENT via ${mail.mailStatus().from}`;
      } catch (err) {
        mode = `SEND FAILED: ${err.message}`;
        failures.push(`${v.name}: ${err.message}`);
      }
    }
    const record = [
      `From   : ${mail.mailStatus().from || 'procurement@company.example.com'}`,
      `To     : ${to}`,
      `Date   : ${new Date().toISOString()}`,
      `Subject: ${subject}`,
      `[${mode}]`,
      '',
      bodyText,
    ].join('\n');
    store.writeCaseFile(c.id, `correspondence/RFQ_email_${vid}.txt`, record);
    if (!mode.startsWith('SEND FAILED')) sent.push(`${v.name} <${to}>`);
  }
  if (failures.length && !sent.length) {
    store.logEvent(c, 'Communication Agent', `RFQ send failed: ${failures.join('; ')}`);
    store.saveCase(c);
    return res.status(502).json({ error: `Sending failed - ${failures.join('; ')}` });
  }
  c.rfqSentAt = new Date().toISOString();
  store.advanceStatus(c, 'RFQ Sent');
  store.logEvent(c, 'Communication Agent',
    `RFQ ${canSend ? 'e-mailed' : 'e-mailed (simulated)'} to: ${sent.join(', ')}${failures.length ? ` | failures: ${failures.join('; ')}` : ''}`);
  store.saveCase(c);
  res.json({ ...c, vendors });
}));

// 5b. Communication Agent (inbound): scan the inbox for vendor replies on this
// RFQ's thread, pull PDF/TXT attachments and run the Quotation Analysis Agent
// on each - results come back for the engineer to review and confirm.
app.post('/api/cases/:id/quotes/fetch-inbox', wrap(async (req, res) => {
  const c = store.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  if (!c.rfqSentAt) return res.status(400).json({ error: 'Send the RFQ first' });
  const vendors = vendorMap();
  const emailByVendor = {};
  for (const vid of c.selectedVendors) {
    emailByVendor[(c.vendorEmails && c.vendorEmails[vid]) || (vendors[vid] || {}).email] = vid;
  }
  const replies = await mail.fetchReplies({
    caseId: c.id,
    vendorEmails: Object.keys(emailByVendor),
    sinceDate: c.rfqSentAt,
  });
  const results = [];
  for (const r of replies) {
    const vendorId = emailByVendor[(r.from || '').toLowerCase()] || null;
    let text = r.bodyText || '';
    let tables = [];
    let savedFile = null;
    const att = (r.attachments || [])[0];
    if (att && /pdf/i.test(att.contentType || att.filename)) {
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: att.content });
      const parsed = await parser.getText();
      text += '\n\n' + parsed.text;
      try {
        const tr = await parser.getTable();
        tables = (tr.pages || []).flatMap((p) => p.tables || []);
      } catch { /* table detection is best-effort */ }
      savedFile = `quotations/inbox_${vendorId || 'unmatched'}_${Date.now()}.pdf`;
      store.writeCaseFile(c.id, savedFile, att.content);
    } else if (att) {
      text += '\n\n' + att.content.toString('utf8');
      savedFile = `quotations/inbox_${vendorId || 'unmatched'}_${Date.now()}.txt`;
      store.writeCaseFile(c.id, savedFile, att.content);
    }
    const { result, engine } = await quotationAgent.extract(text, c.requirement, tables);
    results.push({
      vendorId, from: r.from, subject: r.subject, date: r.date, matchedBy: r.matchedBy,
      attachment: att ? att.filename : null, savedFile, extracted: result, engine,
    });
  }
  store.logEvent(c, 'Communication Agent', `Inbox scanned: ${replies.length} reply(ies) found for ${c.id}`);
  store.saveCase(c);
  res.json({ replies: results });
}));

// 6. Quotation Analysis Agent - extract from pasted text or uploaded PDF
app.post('/api/cases/:id/quotes/extract', upload.single('file'), wrap(async (req, res) => {
  const c = store.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  let text = req.body.text || '';
  let tables = [];
  let sourceFile = null;
  if (req.file) {
    const vid = req.body.vendorId || 'unknown';
    if (req.file.mimetype === 'application/pdf' || req.file.originalname.toLowerCase().endsWith('.pdf')) {
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: req.file.buffer });
      const parsed = await parser.getText();
      text = parsed.text;
      try {
        const tr = await parser.getTable();
        tables = (tr.pages || []).flatMap((p) => p.tables || []);
      } catch { /* table detection is best-effort */ }
      sourceFile = `quotations/original_${vid}.pdf`;
    } else {
      text = req.file.buffer.toString('utf8');
      sourceFile = `quotations/original_${vid}.txt`;
    }
    store.writeCaseFile(c.id, sourceFile, req.file.buffer);
  }
  if (!text.trim()) return res.status(400).json({ error: 'No quotation text found' });
  const { result, engine } = await quotationAgent.extract(text, c.requirement, tables);
  res.json({ extracted: result, engine, sourceFile, rawText: text.slice(0, 5000), tablesDetected: tables.length });
}));

// Save a confirmed quotation for a vendor
app.post('/api/cases/:id/quotes', wrap(async (req, res) => {
  const c = store.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const { vendorId, quote } = req.body;
  if (!vendorId || !quote) return res.status(400).json({ error: 'vendorId and quote are required' });
  c.quotes[vendorId] = quote;
  store.writeCaseFile(c.id, `quotations/quote_${vendorId}.json`, JSON.stringify(quote, null, 2));
  store.advanceStatus(c, 'Quotations Received');
  store.logEvent(c, 'Quotation Analysis Agent', `Quotation recorded for ${vendorId} (${Object.keys(c.quotes).length}/${c.selectedVendors.length})`);
  store.saveCase(c);
  res.json({ ...c, vendors: vendorMap() });
}));

app.delete('/api/cases/:id/quotes/:vendorId', wrap(async (req, res) => {
  const c = store.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  delete c.quotes[req.params.vendorId];
  store.logEvent(c, 'Requester', `Quotation removed for ${req.params.vendorId}`);
  store.saveCase(c);
  res.json({ ...c, vendors: vendorMap() });
}));

// 7. Cost Comparison Agent - CCS in the organisation's template format
app.post('/api/cases/:id/ccs', wrap(async (req, res) => {
  const c = store.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  if (!Object.keys(c.quotes).length) return res.status(400).json({ error: 'No quotations recorded yet' });
  const fileRel = `CCS_${c.id}.xlsx`;
  const outFile = path.join(store.caseDir(c.id), fileRel);
  const summary = await ccsAgent.generate({ caseData: c, vendorById: vendorMap(), outFile });
  c.ccs = { ...summary, file: fileRel, generatedAt: new Date().toISOString() };
  store.advanceStatus(c, 'CCS Generated');
  const l1 = summary.ranking[0];
  store.logEvent(c, 'Cost Comparison Agent', `CCS generated - L1: ${l1.vendorName} at INR ${l1.landedCost.toFixed(2)} landed`);
  // When every selected vendor has quoted, mail the finished CCS to the
  // engineer's personal address (if e-mail + address are configured).
  const settings = store.loadSettings();
  const allQuoted = c.selectedVendors.length > 0 && c.selectedVendors.every((vid) => c.quotes[vid]);
  if (allQuoted && settings.personalEmail && mail.mailStatus().outbound) {
    try {
      await mail.sendMail({
        to: settings.personalEmail,
        subject: `CCS ready - ${c.id}: ${c.requirement.material} (L1: ${l1.vendorName})`,
        text: `All ${c.selectedVendors.length} vendor quotation(s) are in for ${c.id}.\n\n` +
          summary.ranking.map((r) => `${r.label}  ${r.vendorName}  landed INR ${r.landedCost.toFixed(2)}`).join('\n') +
          `\n\nThe Cost Comparison Sheet is attached.`,
        attachments: [{ filename: fileRel, path: outFile }],
      });
      c.ccsEmailedTo = settings.personalEmail;
      store.logEvent(c, 'Communication Agent', `CCS e-mailed to ${settings.personalEmail}`);
    } catch (err) {
      store.logEvent(c, 'Communication Agent', `CCS e-mail failed: ${err.message}`);
    }
  }
  store.saveCase(c);
  res.json({ ...c, vendors: vendorMap() });
}));

// E-mail the CCS to the engineer's personal address on demand.
app.post('/api/cases/:id/ccs/email', wrap(async (req, res) => {
  const c = store.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  if (!c.ccs) return res.status(400).json({ error: 'Generate the CCS first' });
  const to = (req.body && req.body.to) || store.loadSettings().personalEmail;
  if (!to) return res.status(400).json({ error: 'No personal e-mail configured' });
  const outFile = path.join(store.caseDir(c.id), c.ccs.file);
  await mail.sendMail({
    to,
    subject: `CCS - ${c.id}: ${c.requirement.material} (L1: ${c.ccs.ranking[0].vendorName})`,
    text: `Cost Comparison Sheet for ${c.id} attached.\n\n` +
      c.ccs.ranking.map((r) => `${r.label}  ${r.vendorName}  landed INR ${r.landedCost.toFixed(2)}`).join('\n'),
    attachments: [{ filename: c.ccs.file, path: outFile }],
  });
  c.ccsEmailedTo = to;
  store.logEvent(c, 'Communication Agent', `CCS e-mailed to ${to}`);
  store.saveCase(c);
  res.json({ ...c, vendors: vendorMap() });
}));

app.post('/api/cases/:id/close', wrap(async (req, res) => {
  const c = store.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  store.advanceStatus(c, 'Closed');
  store.logEvent(c, 'System', 'Case closed - procurement folder finalised for audit');
  store.saveCase(c);
  res.json({ ...c, vendors: vendorMap() });
}));

// ---------- procurement folder ----------
app.get('/api/cases/:id/files', (req, res) => {
  res.json(store.listCaseFiles(req.params.id));
});

app.get('/api/cases/:id/files/download', (req, res) => {
  const full = store.resolveCaseFile(req.params.id, req.query.path || '');
  if (!full) return res.status(404).json({ error: 'File not found' });
  res.download(full);
});

const PORT = process.env.PORT || 3111;
app.listen(PORT, () => {
  console.log(`ProcureFlow running at http://localhost:${PORT}`);
  console.log(`AI mode: ${process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY found - Claude API' : 'no ANTHROPIC_API_KEY - will try SDK credential chain, else heuristic fallback'}`);
});
