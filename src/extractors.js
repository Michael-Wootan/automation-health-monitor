'use strict';
/**
 * Log parsers used by the status monitor.
 *
 * Each extractor takes the captured stdout of a workflow's main script step
 * and returns a one-line human summary for the report. Scripts in the suite
 * print a small, stable summary block at the end of each run (for example
 * "Published: 1 / Processed: 1 / Failed: 0"), and these parsers read it.
 * When nothing matches, they fall back to extractLastMeaningful().
 */

function extractLastMeaningful(log) {
  if (!log) return '';

  // Aggressively filter out ALL infrastructure/boilerplate lines
  const junkPatterns = [
    /^(npm|node_modules|added \d|packages in)/i,
    /git\s+(submodule|config|version|clone|fetch|checkout)/i,
    /\/usr\/bin\//,
    /cache\s+hit|primary\s+key|not\s+saving\s+cache/i,
    /node-cache-linux/i,
    /overriding\s+HOME/i,
    /remote\.origin\.url/i,
    /\[command\]/i,
    /\.tar\.gz|\.zip|\.tgz/,
    /Corepack|Preparing|Resolving|Successfully|Downloading/i,
    /actions\/checkout|actions\/setup/i,
    /GITHUB_|RUNNER_|HOME=/,
    /^Fetching|^From |^Checking out/i,
    /--recursive|--name-only|--get-regexp|--show-origin/,
    /^\s*$/,
  ];

  const lines = log.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 5)
    .filter(l => !junkPatterns.some(p => p.test(l)));

  if (lines.length === 0) return '';

  // Prefer lines with emojis, summary keywords, or meaningful numbers
  const summaryLines = lines.filter(l =>
    /[✅✓📧📊📝🔍🔗💬✉️🎯🔄🔥❌⚠️]|done|complete|sent|found|total|publish|created|processed|synced|revenue|report/i.test(l)
  );

  const best = summaryLines.length > 0 ? summaryLines : lines;
  const last3 = best.slice(-3).map(l => l.slice(0, 150));
  return last3.join(' | ') || '';
}

function countErrors(text) {
  if (!text) return 0;
  // Don't count "Failed: 0" or "0 failed" as errors — those are success messages
  const cleaned = text.replace(/failed:\s*0|0\s+failed/gi, '');
  return (cleaned.match(/\berror\b|❌|\bfailed\b|\bfatal\b|\bexception\b|ECONNREFUSED|ENOTFOUND|✗/gi) || []).length;
}

function extractErrors(text, max = 3) {
  if (!text) return [];
  return text.split('\n')
    .filter(l => {
      // Skip lines where "failed" appears as "Failed: 0" or "0 failed"
      if (/failed:\s*0|0\s+failed/i.test(l)) return false;
      return /\berror\b|❌|\bfailed\b|\bfatal\b|\bexception\b/i.test(l);
    })
    .slice(-max)
    .map(l => l.trim().slice(0, 200));
}

// ── Structured-summary parsers for specific jobs ────────────────────────────

/** Blog publisher: parses the BLOG SUMMARY block. */
function blogSummary(log) {
  // Parse structured BLOG SUMMARY block
  const published = log.match(/^Published:\s*(\d+)/m)?.[1];
  const processed = log.match(/^Processed:\s*(\d+)/m)?.[1];
  const failed    = log.match(/^Failed:\s*(\d+)/m)?.[1];
  const pending   = log.match(/^Pending remaining:\s*(\d+)/m)?.[1];
  if (published !== undefined) {
    let summary = `${published} published | ${processed} processed`;
    if (parseInt(failed) > 0) summary += ` | ${failed} failed`;
    if (pending !== undefined) summary += ` | ${pending} pending`;
    return summary;
  }
  // Fallback: check for skip message
  const skipped = log.match(/Already published \d+ post/)?.[0];
  if (skipped) return skipped;
  return 'Ran successfully';

}

/** Search Console not-indexed monitor: parses the INSPECTION RESULTS block. */
function gscNotIndexed(log) {
  // Parse the INSPECTION RESULTS block from the new monitor output
  const inspectedMatch = log.match(/Inspected:\s*(\d+)\s*URLs/i);
  const indexedMatch = log.match(/✅ Indexed:\s*(\d+)/i);
  const notIndexedMatch = log.match(/❌ Not indexed:\s*(\d+)/i);
  const totalTracked = log.match(/Total tracked not-indexed \(actionable\):\s*(\d+)/i);

  const parts = [];
  if (inspectedMatch) parts.push(`${inspectedMatch[1]} inspected`);
  if (indexedMatch) parts.push(`${indexedMatch[1]} indexed`);
  if (notIndexedMatch) parts.push(`${notIndexedMatch[1]} not-indexed`);
  if (totalTracked) parts.push(`${totalTracked[1]} total actionable`);

  if (parts.length > 0) return parts.join(' | ');

  // Fallback
  const lines = log.split('\n').filter(l => /✅|inspected|indexed|not.indexed|actionable/i.test(l));
  return lines.slice(-2).join(' | ') || 'Ran successfully';

}

/** Search Console indexing submitter: parses the INDEXING STATUS block. */
function gscIndexing(log) {
  // Parse the INDEXING STATUS summary block from the output
  const totalMatch = log.match(/Total sitemap URLs:\s*(\d+)/i);
  const indexedMatch = log.match(/Confirmed indexed:\s*(\d+)/i);
  const notIndexedMatch = log.match(/Not indexed:\s*(\d+)/i);
  const submittedMatch = log.match(/Submitted to Google:\s*(\d+)/i);
  const pendingMatch = log.match(/Still pending submit:\s*(\d+)/i);
  const nowIndexedMatch = log.match(/Now indexed:\s*(\d+)/i);
  const submittedTodayMatch = log.match(/Submitted\s+(\d+)\s+URLs/i);
  const importedMatch = log.match(/Imported\s+(\d+)\s+new not-indexed/i);

  const parts = [];
  if (indexedMatch && totalMatch) parts.push(`${indexedMatch[1]}/${totalMatch[1]} indexed`);
  if (notIndexedMatch) parts.push(`${notIndexedMatch[1]} not-indexed`);
  if (submittedTodayMatch) parts.push(`${submittedTodayMatch[1]} submitted today`);
  else if (submittedMatch) parts.push(`${submittedMatch[1]} total submitted`);
  if (pendingMatch && pendingMatch[1] !== '0') parts.push(`${pendingMatch[1]} pending`);
  if (nowIndexedMatch) parts.push(`${nowIndexedMatch[1]} newly indexed`);
  if (importedMatch) parts.push(`${importedMatch[1]} from monitor`);

  if (parts.length > 0) return parts.join(' | ');

  // Fallback
  const lines = log.split('\n').filter(l => /✅|submitted|indexed|scan|quota|pending/i.test(l));
  return lines.slice(-3).join(' | ') || extractLastMeaningful(log);

}

/**
 * Contact sync (see the companion ecommerce-contact-sync repo): parses the
 * "Collected: ..." line from --collect and the "Done: ..." line from --upload.
 */
function contactSync(log) {
  const done = log.match(/Done: \+(\d+) retail, \+(\d+) wholesale, \+(\d+) international/i);
  if (done) return `${done[1]} retail, ${done[2]} wholesale, ${done[3]} international uploaded`;
  const collected = log.match(/Collected: (\d+) retail \+ (\d+) wholesale \+ (\d+) international = (\d+)/i);
  if (collected) return `${collected[4]} new contacts collected for approval`;
  if (/HOLD reply detected/i.test(log)) return 'Upload held (HOLD reply received)';
  return extractLastMeaningful(log);
}

const EXTRACTORS = {
  lastMeaningful: extractLastMeaningful,
  blogSummary,
  gscNotIndexed,
  gscIndexing,
  contactSync,
};

/** Resolve a workflow config's `extract` (a preset name or a function). */
function resolveExtractor(extract) {
  if (typeof extract === 'function') return extract;
  if (extract && EXTRACTORS[extract]) return EXTRACTORS[extract];
  if (extract) console.warn(`  Unknown extractor "${extract}", using lastMeaningful`);
  return extractLastMeaningful;
}

module.exports = { extractLastMeaningful, countErrors, extractErrors, resolveExtractor, EXTRACTORS };
