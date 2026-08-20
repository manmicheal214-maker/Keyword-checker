(() => {
  'use strict';

  const DATA_URL = './data/rankings.json';
  const state = { rankings: null, rows: [], search: '', filter: 'all' };

  const $ = id => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function flatten(data) {
    const rows = [];
    for (const [domainKey, domainData] of Object.entries(data.domains || {})) {
      for (const item of Array.isArray(domainData?.keywords) ? domainData.keywords : []) {
        rows.push({
          domain: domainData.domain || domainKey,
          keyword: item.keyword || '',
          position: Number.isFinite(item.position) ? item.position : null,
          previous: Number.isFinite(item.previous_position) ? item.previous_position : null,
          change: Number.isFinite(item.change) ? item.change : null,
          url: item.url || null,
          checkedAt: item.checked_at || data.last_updated || null,
          error: item.error || null
        });
      }
    }
    return rows;
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return escapeHtml(value);
    return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function positionBadge(position) {
    if (position === null) return '<span class="position-badge position-none">—</span>';
    const cls = position <= 3 ? 'position-top' : 'position-badge';
    return `<span class="position-badge ${cls}">${position}</span>`;
  }

  function changeBadge(change) {
    if (change === null || change === 0) return '<span class="change-badge change-flat">—</span>';
    if (change > 0) return `<span class="change-badge change-up">↑ ${change}</span>`;
    return `<span class="change-badge change-down">↓ ${Math.abs(change)}</span>`;
  }

  function updateStats() {
    const rows = state.rows;
    const ranked = rows.filter(r => r.position !== null);
    const positions = ranked.map(r => r.position);
    $('totalKeywords').textContent = rows.length;
    $('averagePosition').textContent = positions.length ? (positions.reduce((a, b) => a + b, 0) / positions.length).toFixed(1) : '—';
    $('top3').textContent = rows.filter(r => r.position !== null && r.position <= 3).length;
    $('top10').textContent = rows.filter(r => r.position !== null && r.position <= 10).length;
    $('top20').textContent = rows.filter(r => r.position !== null && r.position <= 20).length;
    $('top50').textContent = rows.filter(r => r.position !== null && r.position <= 50).length;
    $('notRanking').textContent = rows.filter(r => r.position === null).length;
    $('lastUpdated').textContent = formatDate(state.rankings?.last_updated);
    const domains = [...new Set(rows.map(r => r.domain).filter(Boolean))];
    $('domain').textContent = domains.length === 1 ? domains[0] : `${domains.length} domains`;
  }

  function filteredRows() {
    const query = state.search.trim().toLowerCase();
    return state.rows.filter(row => {
      const matchesSearch = !query || row.keyword.toLowerCase().includes(query) || row.domain.toLowerCase().includes(query);
      const p = row.position;
      const matchesFilter = state.filter === 'all' ||
        (state.filter === 'not-ranking' && p === null) ||
        (state.filter === 'top3' && p !== null && p <= 3) ||
        (state.filter === 'top10' && p !== null && p <= 10) ||
        (state.filter === 'top20' && p !== null && p <= 20) ||
        (state.filter === 'top50' && p !== null && p <= 50);
      return matchesSearch && matchesFilter;
    });
  }

  function renderTable() {
    const rows = filteredRows();
    const table = $('rankingsTable');
    if (!rows.length) {
      table.innerHTML = '<tr><td colspan="7"><div class="empty">No keywords match your current filters.</div></td></tr>';
      return;
    }

    table.innerHTML = rows.map((row, index) => `
      <tr>
        <td class="rank-number">${index + 1}</td>
        <td><div class="keyword">${escapeHtml(row.keyword)}</div><div class="muted">${escapeHtml(row.domain)}</div></td>
        <td>${positionBadge(row.position)}</td>
        <td>${row.previous === null ? '<span class="muted">—</span>' : row.previous}</td>
        <td>${changeBadge(row.change)}</td>
        <td>${row.url ? `<a class="rank-link" href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.url)}</a>` : '<span class="muted">Not found</span>'}</td>
        <td class="muted">${formatDate(row.checkedAt)}</td>
      </tr>`).join('');
  }

  async function loadRankings(showSpinner = true) {
    const button = $('refreshButton');
    const table = $('rankingsTable');
    $('errorContainer').innerHTML = '';
    if (showSpinner) {
      button.disabled = true;
      table.innerHTML = '<tr><td colspan="7"><div class="loading">Loading latest rankings...</div></td></tr>';
    }

    try {
      // Cache-buster is important on GitHub Pages after Actions commits new JSON.
      const response = await fetch(`${DATA_URL}?v=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Could not load rankings.json (HTTP ${response.status}).`);
      const data = await response.json();
      if (!data || typeof data !== 'object' || !data.domains) throw new Error('rankings.json has an unexpected format.');
      state.rankings = data;
      state.rows = flatten(data);
      updateStats();
      renderTable();
    } catch (error) {
      table.innerHTML = '<tr><td colspan="7"><div class="empty">Unable to load ranking data.</div></td></tr>';
      $('errorContainer').innerHTML = `<div class="error"><strong>Data loading error:</strong> ${escapeHtml(error.message)}<br><small>Try Refresh, or wait for the GitHub Pages deployment to finish.</small></div>`;
    } finally {
      button.disabled = false;
    }
  }

  function exportCsv() {
    const rows = filteredRows();
    const headers = ['Domain', 'Keyword', 'Position', 'Previous Position', 'Change', 'Ranking URL', 'Checked'];
    const csv = [headers, ...rows.map(r => [r.domain, r.keyword, r.position ?? '', r.previous ?? '', r.change ?? '', r.url || '', r.checkedAt || ''])]
      .map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `seo-rankings-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  $('search').addEventListener('input', event => { state.search = event.target.value; renderTable(); });
  $('positionFilter').addEventListener('change', event => { state.filter = event.target.value; renderTable(); });
  $('refreshButton').addEventListener('click', () => loadRankings(true));
  $('exportButton').addEventListener('click', exportCsv);

  loadRankings(true);
})();
