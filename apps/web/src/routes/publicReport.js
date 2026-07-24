const express = require('express');
const { getBugReportPublic } = require('@bugtracker/db');

const router = express.Router();

const PRIORITY_LABELS = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical' };
const STATUS_LABELS = { NEW: 'New', NEEDS_INFO: 'Needs Info', FIXED: 'Fixed', NOT_A_BUG: 'Not a Bug', DUPLICATE: 'Duplicate', WONT_FIX: "Won't Fix" };

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function truncate(str, n) {
  const s = String(str || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Public by design (same trust model as the existing ShareLink feature —
// the id is an unguessable cuid, not a sequential/guessable id). Only
// safe, non-sensitive fields are exposed here (see getBugReportPublic);
// evidence/F9 links and full dashboard access still require login.
//
// This has real Open Graph tags specifically so that when this URL is
// pasted or linked in Discord, Discord's own crawler can build a rich
// preview card right in the chat — no login wall to jump through, no
// leaving the app just to see what a report says.
router.get('/r/:reportId', async (req, res) => {
  const report = await getBugReportPublic(req.params.reportId);
  if (!report) return res.status(404).send('Report not found.');

  const ogTitle = `Bug #${report.bugNumber}: ${report.title}`;
  const ogDescription = `${STATUS_LABELS[report.status] || report.status} · ${PRIORITY_LABELS[report.priority] || report.priority} — ${truncate(report.description, 180)}`;
  const dashboardUrl = `${process.env.WEB_BASE_URL}/dashboard/${report.serverId}?report=${report.id}`;

  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(ogTitle)}</title>
  <meta property="og:title" content="${escapeHtml(ogTitle)}" />
  <meta property="og:description" content="${escapeHtml(ogDescription)}" />
  <meta property="og:site_name" content="Field Log — ${escapeHtml(report.serverName)}" />
  <meta property="og:type" content="website" />
  <meta name="theme-color" content="#e8a33d" />
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <div class="container" style="max-width:600px;">
    <div class="detail-panel">
      <div class="detail-meta">Bug #${report.bugNumber} · ${escapeHtml(report.serverName)}</div>
      <h2>${escapeHtml(report.title)}</h2>
      <div class="detail-tags">
        <div class="tag-row">
          <span class="tag tag-priority-${escapeHtml(report.priority)}"><span class="tag-key">Priority:</span> ${escapeHtml(PRIORITY_LABELS[report.priority] || report.priority)}</span>
          <span class="tag tag-status-${escapeHtml(report.status)}"><span class="tag-key">Status:</span> ${escapeHtml(STATUS_LABELS[report.status] || report.status)}</span>
        </div>
      </div>
      <div class="detail-row"><div class="label">Description</div><div>${escapeHtml(report.description)}</div></div>
      ${report.stepsToReproduce ? `<div class="detail-row"><div class="label">Steps</div><div>${escapeHtml(report.stepsToReproduce)}</div></div>` : ''}
      <div class="detail-row"><div class="label">Device</div><div>${escapeHtml(report.device || 'Not specified')}</div></div>
      <div class="detail-row"><div class="label">Reported by</div><div>${escapeHtml(report.reporterUsername)}</div></div>
      <div class="detail-row"><div class="label">Reported on</div><div>${new Date(report.createdAt).toLocaleDateString()}</div></div>
      <div class="quick-actions" style="border:none;">
        <span class="hint">This is a read-only view. Evidence links and editing require dashboard access.</span>
      </div>
      <div style="margin-top:10px;"><a href="${dashboardUrl}">Open in full dashboard →</a></div>
    </div>
  </div>
</body>
</html>`);
});

module.exports = router;
