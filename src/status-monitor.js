#!/usr/bin/env node
'use strict';
/**
 * status-monitor.js — Daily automation health report (GitHub Actions API)
 *
 * Queries the GitHub Actions API for every workflow in the primary repo,
 * downloads the latest run's logs to extract what the job actually did,
 * checks any extra repos for pass/fail status, and emails one HTML report.
 *
 * Which repos and workflows are monitored, and how each is labelled, comes
 * from a JSON config file (see monitor.config.example.json).
 *
 * Requires GITHUB_TOKEN with actions:read on the primary repo.
 *
 * Usage:
 *   node src/status-monitor.js              build report + email it
 *   node src/status-monitor.js --no-email   build report, save HTML only
 */

require('dotenv').config();
const fs         = require('fs');
const path       = require('path');
const nodemailer = require('nodemailer');
const { execSync } = require('child_process');
const { countErrors, extractErrors, resolveExtractor } = require('./extractors');

// ── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.resolve(process.env.MONITOR_CONFIG || 'monitor.config.json');
const CONFIG      = loadConfig(CONFIG_PATH);
const NO_EMAIL    = process.argv.includes('--no-email');

const STORE_NAME  = process.env.STORE_NAME || CONFIG.storeName || 'Acme Store';
const EMAIL_TO    = process.env.EMAIL_NOTIFY;
const SMTP_HOST   = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT   = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER   = process.env.SMTP_USER;
const SMTP_PASS   = process.env.SMTP_PASS;
const REPORT_DIR  = path.resolve(process.env.REPORT_DIR || 'reports');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
// Token used for extra repos. In GitHub Actions the default GITHUB_TOKEN is
// scoped to the repository the workflow runs in, so other repos return 404.
// Add a fine-grained PAT (repo access: the extra repos; permissions: Actions
// read + Metadata read) as secret EXTRA_REPOS_TOKEN. Falls back to
// GITHUB_TOKEN so nothing breaks while the secret is missing.
const EXTRA_REPOS_TOKEN = process.env.EXTRA_REPOS_TOKEN || process.env.GITHUB_TOKEN;
// Primary repo: full log parsing. Defaults to the repo the Action runs in.
const REPO        = process.env.MONITOR_REPO || CONFIG.primaryRepo || process.env.GITHUB_REPOSITORY;
// Additional repos whose workflows are also monitored (status only; failures here never break the report)
const EXTRA_REPOS = CONFIG.extraRepos || [];
const WORKFLOW_CONFIG = CONFIG.workflows || {};

// Report sections, in display order. 'discovered' (workflows in the primary
// repo that are not in the config) and 'oneoff' (manual tools) are built in.
const GROUPS = [
  ...(CONFIG.groups || []),
  { id: 'discovered', label: '🔍 OTHER WORKFLOWS' },
  { id: 'oneoff',     label: '🧰 ONE-OFFS TOOLBOX' },
].filter((g, i, arr) => arr.findIndex(x => x.id === g.id) === i);

function loadConfig(file) {
  if (!fs.existsSync(file)) {
    console.error(`❌ Config not found: ${file} (copy monitor.config.example.json to monitor.config.json)`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [filename, wf] of Object.entries(cfg.workflows || {})) {
    if (wf.skip) continue;
    if (!wf.name) throw new Error(`Config: workflow "${filename}" needs a name`);
    if (!['daily', 'weekly', 'monthly'].includes(wf.frequency || 'daily')) {
      throw new Error(`Config: workflow "${filename}" has invalid frequency "${wf.frequency}"`);
    }
  }
  for (const extra of cfg.extraRepos || []) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(extra.repo || '')) throw new Error(`Config: extraRepos entry needs repo "owner/name"`);
    if (!extra.group) throw new Error(`Config: extraRepos "${extra.repo}" needs a group`);
  }
  return cfg;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

function todayLabel() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// ── GitHub Actions API ──────────────────────────────────────────────────────

async function ghFetch(endpoint, token) {
  const url = endpoint.startsWith('http')
    ? endpoint
    : `https://api.github.com/repos/${REPO}${endpoint}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token || GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Get all workflow files in the repo
 */
async function listWorkflows() {
  const data = await ghFetch('/actions/workflows?per_page=50');
  return data.workflows || [];
}

/**
 * Get recent runs for a specific workflow
 */
async function getWorkflowRuns(workflowId, maxRuns = 5) {
  const data = await ghFetch(`/actions/workflows/${workflowId}/runs?per_page=${maxRuns}&status=completed`);
  return data.workflow_runs || [];
}

/**
 * Get structured step info and extract the main script's output from a run.
 *
 * Strategy:
 * 1. Use Jobs API to get step names, durations, conclusions (structured, reliable)
 * 2. Download the RUN LOGS ZIP — contains 0_run.txt (all steps combined) + system.txt
 * 3. Parse 0_run.txt using ##[group]StepName / ##[endgroup] markers to find the
 *    main script step's output section
 * 4. If ZIP download fails, fall back to clean step-based summary
 */
async function getRunOutput(runId) {
  try {
    const data = await ghFetch(`/actions/runs/${runId}/jobs?per_page=5`);
    const jobs = data.jobs || [];
    if (jobs.length === 0) return { stepSummary: '', scriptOutput: '' };

    const mainJob = jobs[0];
    const steps = mainJob.steps || [];

    // ── Identify the main script step ──────────────────────────
    const infraPatterns = /^(Set up job|Run actions\/|Post Run|Complete job|Write service|Run npm)/i;
    const scriptSteps = steps.filter(s => !infraPatterns.test(s.name));
    const scriptStep = scriptSteps.length > 0 ? scriptSteps[0] : null;

    // Build a clean step summary (always reliable fallback)
    const stepSummary = scriptSteps
      .map(s => {
        const icon = s.conclusion === 'success' ? '✅' : s.conclusion === 'failure' ? '❌' : '⏳';
        const dur = s.started_at && s.completed_at
          ? formatDuration(new Date(s.completed_at) - new Date(s.started_at))
          : '';
        return `${icon} ${s.name}${dur ? ` (${dur})` : ''} — ${s.conclusion || s.status}`;
      })
      .join('\n');

    // ── Download the run logs ZIP ──────────────────────────────
    // The ZIP contains: 0_run.txt (ALL steps combined) + system.txt
    // Inside 0_run.txt, steps are delimited by:
    //   ##[group]Step Name
    //   ... step output ...
    //   ##[endgroup]
    let scriptOutput = '';
    if (scriptStep) {
      try {
        const logsUrl = `https://api.github.com/repos/${REPO}/actions/runs/${runId}/logs`;
        // IMPORTANT: Use redirect: 'manual' because the API returns a 302 to Azure Blob Storage.
        // If we follow automatically, the Authorization header gets forwarded to Azure which rejects it.
        const logsRes = await fetch(logsUrl, {
          headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          redirect: 'manual',
        });

        // Get the redirect URL and fetch WITHOUT auth headers
        let zipBuffer;
        if (logsRes.status === 302) {
          const redirectUrl = logsRes.headers.get('location');
          console.log(`    📥 Following redirect to download logs...`);
          const zipRes = await fetch(redirectUrl);
          if (!zipRes.ok) {
            console.log(`    ⚠️ ZIP download failed: ${zipRes.status}`);
            throw new Error('ZIP download failed');
          }
          zipBuffer = Buffer.from(await zipRes.arrayBuffer());
        } else if (logsRes.ok) {
          zipBuffer = Buffer.from(await logsRes.arrayBuffer());
        } else {
          console.log(`    ⚠️ Logs API returned ${logsRes.status}`);
          throw new Error(`Logs API returned ${logsRes.status}`);
        }

        if (zipBuffer && zipBuffer.length > 0) {
          console.log(`    📦 Downloaded ${(zipBuffer.length / 1024).toFixed(1)}KB log archive`);
          const zipDir = `/tmp/run-logs-${runId}`;
          const zipPath = `${zipDir}.zip`;

          // Write zip and extract
          fs.writeFileSync(zipPath, zipBuffer);
          fs.mkdirSync(zipDir, { recursive: true });
          execSync(`unzip -o -q "${zipPath}" -d "${zipDir}" 2>/dev/null || true`);

          // Find 0_run.txt (the combined log file)
          const allFiles = [];
          function findFiles(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              if (entry.isDirectory()) findFiles(path.join(dir, entry.name));
              else allFiles.push(path.join(dir, entry.name));
            }
          }
          findFiles(zipDir);

          // The main log file is named like "0_run.txt" or "0_build.txt" etc.
          // It's always the file starting with "0_" that isn't "system.txt"
          const runLogFile = allFiles.find(f => {
            const base = path.basename(f);
            return base.startsWith('0_') && base.endsWith('.txt');
          });

          if (runLogFile) {
            const rawLog = fs.readFileSync(runLogFile, 'utf8');
            console.log(`    🔍 Parsing ${path.basename(runLogFile)} (${rawLog.length} chars)`);

            // GitHub Actions log structure (from raw logs):
            //   ##[group]Run node order-sync.js      ← uses COMMAND, not YAML step name
            //   [36;1mnode order-sync.js[0m           ← ANSI command echo
            //   shell: /usr/bin/bash -e {0}           ← shell info
            //   env:                                  ← env vars
            //   ##[endgroup]                          ← end of step header
            //   [actual script stdout here]           ← THIS is what we want
            //   Post job cleanup.                     ← end of script output
            //
            // Key: ##[group] uses the raw command ("Run node X.js"), NOT the
            // YAML step name ("Run order sync"). So we find the LAST
            // ##[group]Run node... section and capture after its ##[endgroup].
            const lines = rawLog.split('\n');

            // Find all ##[group] positions to identify the main script step
            // The main script is the last "Run node" or "Run " before "Post job"
            let scriptGroupIdx = -1;
            let scriptEndgroupIdx = -1;
            let nextGroupIdx = -1;

            for (let i = 0; i < lines.length; i++) {
              const stripped = lines[i].replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, '');
              if (stripped.startsWith('##[group]Run node ') || stripped.startsWith('##[group]Run ./')) {
                scriptGroupIdx = i;
                console.log(`    ✅ Found script group at line ${i}: ${stripped.slice(0, 80)}`);
              }
            }

            // Now find the ##[endgroup] after our script group, and the next ##[group] after that
            if (scriptGroupIdx >= 0) {
              for (let i = scriptGroupIdx + 1; i < lines.length; i++) {
                const stripped = lines[i].replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, '');
                if (stripped.startsWith('##[endgroup]') && scriptEndgroupIdx < 0) {
                  scriptEndgroupIdx = i;
                  continue;
                }
                if (scriptEndgroupIdx >= 0 && (stripped.startsWith('##[group]') || stripped.includes('Post job cleanup'))) {
                  nextGroupIdx = i;
                  break;
                }
              }
            }

            // Extract lines between endgroup and next group/post-cleanup
            const capturedLines = [];
            if (scriptEndgroupIdx >= 0) {
              const endIdx = nextGroupIdx >= 0 ? nextGroupIdx : lines.length;
              for (let i = scriptEndgroupIdx + 1; i < endIdx; i++) {
                const clean = lines[i]
                  .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, '')
                  .replace(/\x1b\[[0-9;]*m/g, '') // strip ANSI codes
                  .trim();
                if (!clean) continue;
                if (/^##\[/.test(clean)) continue;
                if (/^::/.test(clean)) continue;
                if (/^\[dotenv/.test(clean)) continue;
                capturedLines.push(clean);
              }
            }

            if (capturedLines.length > 0) {
              scriptOutput = capturedLines.slice(-30).join('\n');
              console.log(`    📄 Extracted ${capturedLines.length} lines of script output`);
            } else {
              console.log(`    ⚠️ No script output found (groupIdx=${scriptGroupIdx}, endgroupIdx=${scriptEndgroupIdx})`);
            }
          } else {
            console.log(`    ⚠️ No 0_*.txt log file found in ZIP`);
            console.log(`    📁 Available files: ${allFiles.map(f => path.basename(f)).join(', ')}`);
          }

          // Cleanup
          try {
            execSync(`rm -rf "${zipDir}" "${zipPath}" 2>/dev/null`);
          } catch {}
        }
      } catch (err) {
        console.log(`    ⚠️ Log download failed: ${err.message}`);
      }
    }

    return { stepSummary, scriptOutput };
  } catch {
    return { stepSummary: '', scriptOutput: '' };
  }
}

// ── Check a workflow via GitHub Actions API ────────────────────────────────


// ── Extra repos (e.g. a support bot) ───────────────────────────────

const TIMING_BY_FREQUENCY = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' };

/**
 * Normalise a config entry once: resolve its log extractor and fill the
 * display defaults (category follows group; manual tools go to 'oneoff').
 */
function withExtractor(config) {
  if (!config.extractResults) config.extractResults = resolveExtractor(config.extract);
  config.frequency ||= 'daily';
  if (config.oneoff) { config.group = 'oneoff'; config.category = 'oneoff'; config.timing ||= 'MANUAL'; }
  config.group    ||= 'discovered';
  config.category ||= config.group;
  config.timing   ||= TIMING_BY_FREQUENCY[config.frequency] || 'SCHEDULED';
  config.schedule ||= 'See workflow file';
  return config;
}
async function checkExtraRepos(processGroups) {
  for (const extra of EXTRA_REPOS) {
    try {
      const wfData = await ghFetch(`https://api.github.com/repos/${extra.repo}/actions/workflows?per_page=50`, EXTRA_REPOS_TOKEN);
      for (const wf of (wfData.workflows || [])) {
        try {
          const filename = wf.path.split('/').pop();
          const meta = (extra.workflows || {})[filename] || {
            name: `${extra.icon} ${wf.name}`, frequency: 'daily',
            description: 'Workflow in ' + extra.repo, schedule: 'See workflow file',
          };
          if (meta.skip) continue;
          const runsData = await ghFetch(`https://api.github.com/repos/${extra.repo}/actions/workflows/${wf.id}/runs?per_page=3&status=completed`, EXTRA_REPOS_TOKEN);
          const runs = runsData.workflow_runs || [];
          const base = {
            name: meta.name, schedule: meta.schedule, category: extra.group, oneoff: meta.oneoff,
            description: meta.description, file: filename, workflowUrl: wf.html_url,
            group: extra.group, timing: meta.oneoff ? 'MANUAL' : 'SCHEDULED', repo: extra.repo,
            results: '', errors: [], errorCount: 0,
          };
          if (runs.length === 0) {
            processGroups[extra.group].push({ ...base, ranToday: false, status: meta.oneoff ? 'ok' : 'not_run', detail: 'Never run' });
          } else {
            const latest = runs[0];
            const hoursAgo = (Date.now() - new Date(latest.created_at).getTime()) / 3600000;
            const windowH = meta.frequency === 'daily' ? 30 : meta.frequency === 'weekly' ? 192 : 768;
            const isRecent = hoursAgo < windowH;
            let status = 'not_run';
            if (latest.conclusion === 'failure') status = 'error';
            else if (isRecent && latest.conclusion === 'success') status = 'ok';
            else if (isRecent && latest.conclusion === 'cancelled') status = 'warning';
            else if (meta.oneoff) status = 'ok';
            const ago = hoursAgo < 1 ? `${Math.round(hoursAgo * 60)}m ago` : hoursAgo < 48 ? `${Math.round(hoursAgo)}h ago` : `${Math.round(hoursAgo / 24)}d ago`;
            processGroups[extra.group].push({
              ...base,
              ranToday: latest.created_at?.slice(0, 10) === today(),
              status,
              detail: `Last run ${latest.conclusion} · ${ago}`,
              lastRunAt: latest.created_at,
              errors: latest.conclusion === 'failure' ? [`${meta.name}: latest run failed — check logs in ${extra.repo}`] : [],
              errorCount: latest.conclusion === 'failure' ? 1 : 0,
            });
          }
          await new Promise(r => setTimeout(r, 150));
        } catch (err) {
          console.error(`  Extra-repo workflow check failed (${extra.repo}): ${err.message.slice(0, 120)}`);
        }
      }
    } catch (err) {
      console.error(`  Extra repo unreachable (${extra.repo}): ${err.message.slice(0, 120)}`);
      processGroups[extra.group].push({
        name: `${extra.icon} ${extra.repo}`, schedule: '', category: extra.group, group: extra.group,
        description: 'Could not reach this repo from the monitor.', file: '', workflowUrl: `https://github.com/${extra.repo}/actions`,
        timing: 'SCHEDULED', repo: extra.repo, ranToday: false, status: 'warning',
        detail: `Monitor could not reach repo: ${err.message.slice(0, 80)}`, results: '', errors: [], errorCount: 1,
      });
    }
  }
}

async function checkWorkflow(workflow, config) {
  const runs = await getWorkflowRuns(workflow.id, 3);

  if (runs.length === 0) {
    return {
      name: config.name,
      schedule: config.schedule,
      category: config.category,
      oneoff: config.oneoff, description: config.description, file: config.file, workflowUrl: config.workflowUrl, group: config.group, timing: config.timing,
      ranToday: false,
      status: 'not_run',
      detail: 'Never run',
      results: '',
      errors: [],
      errorCount: 0,
    };
  }

  const latestRun = runs[0];
  const runDate = latestRun.created_at?.slice(0, 10);
  const ranToday = runDate === today();

  // Determine frequency window for status
  const isRecent = (() => {
    const runTime = new Date(latestRun.created_at).getTime();
    const hoursAgo = (Date.now() - runTime) / 3600000;
    if (config.frequency === 'daily') return hoursAgo < 30;
    if (config.frequency === 'weekly') return hoursAgo < 192; // 8 days
    if (config.frequency === 'monthly') return hoursAgo < 768; // 32 days
    return hoursAgo < 30;
  })();

  const conclusion = latestRun.conclusion; // success, failure, cancelled, etc.
  let status = 'not_run';
  if (isRecent && conclusion === 'success') status = 'ok';
  else if (isRecent && conclusion === 'failure') status = 'error';
  else if (isRecent && conclusion === 'cancelled') status = 'warning';
  else if (!isRecent) status = 'not_run';

  // Fetch actual run output for results
  let results = '';
  let errors = [];
  let errorCount = 0;

  if (runs.length > 0) {
    try {
      const { stepSummary, scriptOutput } = await getRunOutput(latestRun.id);

      // Try script output first (actual console output from the node script)
      if (scriptOutput) {
        results = config.extractResults(scriptOutput);
        errorCount = countErrors(scriptOutput);
        errors = extractErrors(scriptOutput, 3);
      }

      // If script output parsing gave nothing useful or contains infrastructure garbage, use step summary
      const isGarbage = (r) => !r || r.includes('git submodule') || r.includes('Cache hit') || r.includes('/usr/bin/') || r.includes('node-cache') || r.includes('remote.origin');
      if (isGarbage(results)) {
        if (stepSummary) {
          results = stepSummary.split('\n').map(l => l.slice(0, 100)).join(' | ');
        }
      }
    } catch {}
  }

  // Final fallback: just report status and timing
  if (!results) {
    const ago = timeAgo(latestRun.created_at);
    results = conclusion === 'success' ? `Completed successfully ${ago}` : `${conclusion || 'unknown'} ${ago}`;
  }

  // Build detail with run timing
  const duration = latestRun.run_started_at && latestRun.updated_at
    ? formatDuration(new Date(latestRun.updated_at) - new Date(latestRun.run_started_at))
    : '';

  const detail = ranToday
    ? `${results}${duration ? ` (${duration})` : ''}`
    : `Last: ${timeAgo(latestRun.created_at)} — ${results}`;

  return {
    name: config.name,
    schedule: config.schedule,
    category: config.category,
    oneoff: config.oneoff, description: config.description, file: config.file, workflowUrl: config.workflowUrl, group: config.group, timing: config.timing,
    ranToday,
    status,
    detail,
    results,
    errors,
    errorCount,
    runUrl: latestRun.html_url,
    conclusion,
    lastRunAt: latestRun.created_at,
  };
}

function timeAgo(isoDate) {
  if (!isoDate) return 'never';
  const hours = Math.round((Date.now() - new Date(isoDate).getTime()) / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  return `${mins}m`;
}

// ── Build HTML email ────────────────────────────────────────────────────────

function statusBadge(status) {
  const map = {
    ok:      { bg: '#1a4a1a', color: '#4caf50', label: '✅ OK' },
    error:   { bg: '#4a1a1a', color: '#f44336', label: '❌ ERROR' },
    warning: { bg: '#4a3a1a', color: '#ff9800', label: '⚠️ WARNING' },
    not_run: { bg: '#2a2a2a', color: '#888888', label: '⏳ NOT RUN' },
    info:    { bg: '#1a2a4a', color: '#2196F3', label: 'ℹ️ INFO' },
  };
  const s = map[status] || map.info;
  return `<span style="background:${s.bg};color:${s.color};padding:2px 8px;border-radius:4px;font-size:12px;font-weight:bold;">${s.label}</span>`;
}

function timingBadge(timing) {
  if (!timing) return '';
  const tmap = {
    'DAILY':     { bg: '#1a2a3a', color: '#64b5f6' },
    'WEEKDAYS':  { bg: '#16303a', color: '#4dd0e1' },
    'WEEKLY':    { bg: '#241a3a', color: '#b39ddb' },
    'MONTHLY':   { bg: '#2a1a2e', color: '#f48fb1' },
    'MANUAL':    { bg: '#2a2618', color: '#d4a72c' },
    'SCHEDULED': { bg: '#2a2a2a', color: '#aaaaaa' },
  };
  const s = tmap[timing] || tmap['SCHEDULED'];
  return `<span style="background:${s.bg};color:${s.color};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;margin-right:6px;">${timing}</span>`;
}

function categoryLabel(cat) {
  const g = GROUPS.find(x => x.id === cat);
  return g ? g.label : cat.toUpperCase();
}

function oneoffCard(proc) {
  const last = proc.lastRunAt ? `Last run ${timeAgo(proc.lastRunAt)}` : 'Never run yet';
  const runLink = `<a href="https://github.com/${proc.repo || REPO}/actions/workflows/${proc.file}" style="color:#d4a72c;font-size:11px;text-decoration:none;">▶ Run manually</a>`;
  const fileLink = proc.workflowUrl ? ` · <a href="${proc.workflowUrl}" style="color:#6699cc;font-size:11px;text-decoration:none;">See workflow file →</a>` : '';
  return `
  <div style="background:#1b1b1b;border:1px dashed #4a442a;border-radius:8px;padding:12px 16px;margin-bottom:8px;">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div style="color:#d8c48a;font-weight:bold;font-size:13px;">${proc.name}</div>
      <span style="background:#2a2618;color:#d4a72c;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;">🧰 TOOL</span>
    </div>
    ${proc.description ? `<div style="color:#999;font-size:12px;margin-top:4px;">${proc.description}</div>` : ''}
    <div style="color:#666;font-size:11px;margin-top:6px;">${last} · ${runLink}${fileLink}</div>
  </div>`;
}

function processCard(proc) {
  const errHtml = proc.errors.length
    ? `<div style="background:#2a1a1a;border-left:3px solid #f44336;padding:8px 12px;margin-top:8px;border-radius:0 4px 4px 0;">
        <div style="color:#f44336;font-size:11px;font-weight:bold;margin-bottom:4px;">RECENT ERRORS</div>
        ${proc.errors.map(e => `<div style="color:#ffb3b3;font-size:11px;font-family:monospace;word-break:break-all;">${escapeHtml(e)}</div>`).join('')}
       </div>`
    : '';

  const resultsHtml = proc.results && proc.results !== proc.detail
    ? `<div style="background:#1a2a1a;border-left:3px solid #4caf50;padding:8px 12px;margin-top:8px;border-radius:0 4px 4px 0;">
        <div style="color:#4caf50;font-size:11px;font-weight:bold;margin-bottom:4px;">TODAY'S OUTPUT</div>
        <div style="color:#b0d0b0;font-size:11px;font-family:monospace;word-break:break-all;">${escapeHtml(proc.results.slice(0, 500)).replace(/\n/g, '<br>')}</div>
       </div>`
    : '';

  const linkHtml = proc.runUrl
    ? `<div style="margin-top:6px;"><a href="${proc.runUrl}" style="color:#6699cc;font-size:11px;text-decoration:none;">View run →</a></div>`
    : '';

  return `
  <div style="background:#1e1e1e;border:1px solid #333;border-radius:8px;padding:16px;margin-bottom:10px;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
      <div>
        <div style="color:#e0e0e0;font-weight:bold;font-size:14px;">${proc.name}</div>
        ${proc.description ? `<div style="color:#8a8a8a;font-size:11px;font-style:italic;margin-top:3px;">${proc.description}</div>` : ''}
          <div style="color:#666;font-size:11px;margin-top:2px;">🕐 ${proc.schedule}</div>
      </div>
      <div style="text-align:right;white-space:nowrap;">${timingBadge(proc.timing)}${statusBadge(proc.status)}</div>
    </div>
    <div style="color:#aaa;font-size:12px;margin-top:6px;">${escapeHtml(proc.detail)}</div>
    ${proc.ranToday && proc.status === 'ok' ? resultsHtml : ''}
    ${errHtml}
    ${linkHtml}
  </div>`;
}

function buildEmail(processGroups, totalWorkflows) {
  const oneoffs = processGroups.oneoff || [];
  const allProcesses = Object.values(processGroups).flat().filter(p => p.category !== 'oneoff');
  const totalErrors  = allProcesses.reduce((s, p) => s + p.errorCount, 0);
  const totalOk      = allProcesses.filter(p => p.status === 'ok').length;
  const totalWarning = allProcesses.filter(p => p.status === 'warning' || p.status === 'error').length;
  const totalNotRun  = allProcesses.filter(p => p.status === 'not_run').length;

  const overallStatus = totalWarning === 0
    ? `<span style="color:#4caf50">✅ All systems normal</span>`
    : `<span style="color:#f44336">⚠️ ${totalWarning} process(es) need attention</span>`;

  let sectionsHtml = '';
  const categoryOrder = GROUPS.map(g => g.id).filter(id => id !== 'oneoff');
  for (const cat of categoryOrder) {
    const procs = processGroups[cat];
    if (!procs || procs.length === 0) continue;
    sectionsHtml += `
    <div style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:16px 0 8px;border-bottom:1px solid #2a2a2a;padding-bottom:4px;">${categoryLabel(cat)}</div>
    ${procs.map(processCard).join('')}`;
  }

  if (oneoffs.length > 0) {
    sectionsHtml += `
    <div style="color:#d4a72c;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:22px 0 4px;border-bottom:1px solid #2a2a2a;padding-bottom:4px;">${categoryLabel('oneoff')}</div>
    <div style="color:#666;font-size:11px;margin:0 0 10px;">Manual, run-when-needed tools you have built — kept here so they are not forgotten. These do not run on a schedule.</div>
    ${oneoffs.map(oneoffCard).join('')}`;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="background:#121212;color:#e0e0e0;font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px;">
  <div style="background:#181818;border:1px solid #333;border-radius:10px;padding:28px;">

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <h2 style="color:#d4a72c;margin:0;font-size:20px;">${escapeHtml(STORE_NAME)} — Daily Status Report</h2>
    </div>
    <div style="color:#666;font-size:12px;margin-bottom:20px;">${todayLabel()} — <em>Powered by GitHub Actions API</em></div>

    <div style="background:#1e1e1e;border:1px solid #333;border-radius:8px;padding:14px;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;text-align:center;">
        <div style="flex:1">
          <div style="font-size:24px;font-weight:bold;color:#4caf50">${totalOk}</div>
          <div style="color:#666;font-size:11px;">OK</div>
        </div>
        <div style="flex:1">
          <div style="font-size:24px;font-weight:bold;color:#ff9800">${totalWarning}</div>
          <div style="color:#666;font-size:11px;">Issues</div>
        </div>
        <div style="flex:1">
          <div style="font-size:24px;font-weight:bold;color:#888">${totalNotRun}</div>
          <div style="color:#666;font-size:11px;">Pending</div>
        </div>
        <div style="flex:1">
          <div style="font-size:24px;font-weight:bold;color:#e0e0e0">${allProcesses.length}</div>
          <div style="color:#666;font-size:11px;">Total</div>
        </div>
        <div style="flex:2;border-left:1px solid #333;padding-left:12px;display:flex;align-items:center;justify-content:center;">
          <div style="font-size:13px;">${overallStatus}</div>
        </div>
      </div>
    </div>

    ${sectionsHtml}

    <hr style="border:none;border-top:1px solid #2a2a2a;margin:20px 0;">
    <div style="color:#444;font-size:11px;text-align:center;">
      ${escapeHtml(STORE_NAME)} — Automation Health Monitor<br>
      ${totalWorkflows} workflows tracked • Source: GitHub Actions API<br>
      <a href="https://github.com/${REPO}/actions" style="color:#6699cc;text-decoration:none;">View all workflows →</a>
    </div>
  </div>
</body>
</html>`;
}

// ── Send email ──────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function sendReport(html, hasErrors) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const subject = hasErrors
    ? `⚠️ ${STORE_NAME} Status — Issues Detected — ${todayLabel()}`
    : `✅ ${STORE_NAME} Status — All Clear — ${todayLabel()}`;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || SMTP_USER,
    to:   EMAIL_TO,
    subject,
    html,
  });

  console.log(`📧 Status report sent to ${EMAIL_TO}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n📊 ${STORE_NAME} Automation Health Monitor — ${todayLabel()}`);
  console.log('='.repeat(55));

  if (!NO_EMAIL && (!SMTP_USER || !SMTP_PASS || !EMAIL_TO)) {
    console.error('❌ SMTP_USER, SMTP_PASS and EMAIL_NOTIFY must be set (or pass --no-email)');
    process.exit(1);
  }

  if (!REPO) {
    console.error('❌ No primary repo: set MONITOR_REPO or primaryRepo in the config');
    process.exit(1);
  }

  if (!GITHUB_TOKEN) {
    console.error('❌ GITHUB_TOKEN not set — needed to query workflow runs');
    process.exit(1);
  }

  // ── Fetch all workflows from GitHub ──────────────────────────
  console.log('🔄 Fetching workflows from GitHub Actions API...');
  const workflows = await listWorkflows();
  console.log(`   Found ${workflows.length} workflows\n`);

  const processGroups = Object.fromEntries(GROUPS.map(g => [g.id, []]));
  for (const extra of EXTRA_REPOS) processGroups[extra.group] ||= [];
  for (const wf of Object.values(WORKFLOW_CONFIG)) if (wf.group) processGroups[wf.group] ||= [];

  // ── Check each workflow ──────────────────────────────────────
  for (const wf of workflows) {
    const filename = wf.path.split('/').pop(); // e.g., 'blog-publish.yml'
    const config = WORKFLOW_CONFIG[filename] && withExtractor(WORKFLOW_CONFIG[filename]);
    if (config) { config.file = filename; config.workflowUrl = wf.html_url; }

    if (config?.skip) continue; // skip self

    if (config) {
      console.log(`  Checking: ${config.name}...`);
      try {
        const result = await checkWorkflow(wf, config);
        processGroups[config.group || 'discovered'].push(result);

        const icon = result.status === 'ok' ? '✅' : result.status === 'error' ? '❌' : result.status === 'warning' ? '⚠️' : '⏳';
        console.log(`    ${icon} ${result.status.toUpperCase()} — ${result.detail.slice(0, 100)}`);
      } catch (err) {
        console.error(`    ❌ Error checking ${config.name}: ${err.message}`);
        processGroups[config.group || 'discovered'].push({
          name: config.name,
          schedule: config.schedule,
          category: config.category,
          oneoff: config.oneoff, description: config.description, file: config.file, workflowUrl: config.workflowUrl, group: config.group, timing: config.timing,
          ranToday: false,
          status: 'error',
          detail: `Failed to check: ${err.message.slice(0, 100)}`,
          results: '',
          errors: [err.message.slice(0, 200)],
          errorCount: 1,
        });
      }
    } else {
      // Discovered workflow not in our config — auto-add
      console.log(`  Discovered: ${wf.name} (${filename})`);
      try {
        const autoConfig = {
          name: `🔧 ${wf.name}`,
          schedule: 'See workflow file',
          group: 'discovered',
          timing: 'SCHEDULED',
          category: 'discovered',
          frequency: 'daily',
        };
        withExtractor(autoConfig);
        const result = await checkWorkflow(wf, autoConfig);
        processGroups.discovered.push(result);
      } catch {}
    }

    // Small delay to respect rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  // Check extra repos — additive, never fatal
  console.log('\nChecking extra repos...');
  await checkExtraRepos(processGroups);

  // ── Print summary to terminal ────────────────────────────────
  const categoryOrder = GROUPS.map(g => g.id).filter(id => id !== 'oneoff');
  console.log('\n' + '='.repeat(55));
  for (const cat of categoryOrder) {
    const procs = processGroups[cat];
    if (!procs || procs.length === 0) continue;
    console.log(`\n${categoryLabel(cat)}:`);
    for (const p of procs) {
      const icon = p.status === 'ok' ? '✅' : p.status === 'error' ? '❌' : p.status === 'warning' ? '⚠️' : '⏳';
      console.log(`  ${icon}  ${p.name.padEnd(35)} ${p.detail.slice(0, 80)}`);
    }
  }

  const allProcesses = Object.values(processGroups).flat();
  const totalErrors = allProcesses.filter(p => p.status === 'error' || p.status === 'warning').length;
  console.log(`\n${totalErrors === 0 ? '✅ All clear' : `⚠️ ${totalErrors} workflow(s) need attention`}`);
  console.log(`📊 Tracking ${allProcesses.length} workflows\n`);

  // ── Build and send email ─────────────────────────────────────
  const html = buildEmail(processGroups, allProcesses.length);

  // Save local copy
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `status-report-${today()}.html`);
  fs.writeFileSync(reportPath, html);
  console.log(`📄 Report saved: ${reportPath}`);

  if (NO_EMAIL) {
    console.log('✉️  --no-email: skipping send');
    return;
  }
  await sendReport(html, totalErrors > 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

