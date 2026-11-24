/* Pocket Ledger
   Local-first personal finance tracker. Optional Supabase sync is protected by Supabase Auth + RLS.
*/
(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const STORAGE_KEY = 'pocket-ledger-state-v1';
  const CLOUD_KEY = 'pocket-ledger-cloud-v1';
  const EXPENSE_CATEGORIES = [
    'Debt & Loans', 'Housing & Utilities', 'Food & Groceries', 'Transportation',
    'Family & Personal', 'Giving & Donations', 'Shopping', 'Subscriptions & Digital',
    'Health', 'Savings & Investments', 'Other Expense'
  ];
  const INCOME_CATEGORIES = ['Salary', 'Bonus', 'Business', 'Interest / Lending', 'Other Income'];
  const DEFAULT_BUDGETS = {
    'Debt & Loans': 20000, 'Housing & Utilities': 5000, 'Food & Groceries': 8000,
    'Transportation': 12000, 'Family & Personal': 20000, 'Giving & Donations': 5000,
    'Shopping': 5000, 'Subscriptions & Digital': 1000, 'Health': 3000,
    'Savings & Investments': 5000, 'Other Expense': 3000
  };
  const DEFAULT_ACCOUNTS = [
    { name: 'Cash', kind: 'cash' }, { name: 'BDO', kind: 'bank' }, { name: 'Maya', kind: 'ewallet' },
    { name: 'UnionBank', kind: 'bank' }, { name: 'Pag-IBIG', kind: 'bank' },
    { name: 'Credit Card - BDO', kind: 'credit' }, { name: 'Credit Card - UB', kind: 'credit' },
    { name: 'Credit Card - Other', kind: 'credit' }, { name: 'Other', kind: 'other' }
  ];
  const TYPE_LABELS = {
    expense: 'Expense', income: 'Income', transfer: 'Transfer', lent: 'Lent money',
    borrowed: 'Borrowed money', collect: 'Collected lent money', repay: 'Debt repayment',
    collect_plan: 'Installment received'
  };
  const TYPE_SYMBOLS = { expense: '−', income: '+', transfer: '⇄', lent: '↗', borrowed: '↙', collect: '↘', repay: '−', collect_plan: '↘' };
  let state;
  let currentView = 'dashboard';
  let activitySearch = '';
  let activityMonth = new Date().toISOString().slice(0, 7);
  let idb = null;
  let toastTimer = null;
  let cloudSyncTimer = null;
  let cloudBusy = false;

  function makeId() {
    return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function monthISO(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }
  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function peso(value, showSign = false) {
    const n = Number(value || 0);
    const abs = Math.abs(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const sign = showSign ? (n < 0 ? '−' : '+') : (n < 0 ? '−' : '');
    return `${sign}₱${abs}`;
  }
  function dateLabel(value, options = { month: 'short', day: 'numeric', year: 'numeric' }) {
    if (!value) return 'No date set';
    const d = new Date(`${value}T12:00:00`);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString('en-PH', options);
  }
  function addMonths(dateString, months = 1) {
    const d = new Date(`${dateString || todayISO()}T12:00:00`);
    const day = d.getDate();
    d.setMonth(d.getMonth() + months);
    if (d.getDate() < day) d.setDate(0);
    return d.toISOString().slice(0, 10);
  }
  function defaultState() {
    return {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      settings: { currency: 'PHP', buffer: 0 },
      categories: [...EXPENSE_CATEGORIES],
      accounts: DEFAULT_ACCOUNTS.map(a => ({ id: makeId(), name: a.name, kind: a.kind, openingBalance: 0 })),
      budgets: { ...DEFAULT_BUDGETS },
      transactions: [],
      obligations: []
    };
  }
  function normalizeState(input) {
    const base = defaultState();
    if (!input || typeof input !== 'object') return base;
    const merged = { ...base, ...input };
    merged.settings = { ...base.settings, ...(input.settings || {}) };
    merged.categories = Array.isArray(input.categories) && input.categories.length ? input.categories : base.categories;
    merged.accounts = Array.isArray(input.accounts) ? input.accounts : base.accounts;
    merged.transactions = Array.isArray(input.transactions) ? input.transactions : [];
    merged.obligations = Array.isArray(input.obligations) ? input.obligations : [];
    merged.budgets = { ...base.budgets, ...(input.budgets || {}) };
    merged.accounts = merged.accounts.map(a => ({ id: a.id || makeId(), name: a.name || 'Account', kind: a.kind || 'other', openingBalance: Number(a.openingBalance || 0) }));
    merged.transactions = merged.transactions.map(t => ({ ...t, id: t.id || makeId(), amount: Number(t.amount || 0), review: !!t.review }));
    merged.obligations = merged.obligations.map(o => ({ ...o, id: o.id || makeId(), remaining: Number(o.remaining || 0), monthlyAmount: Number(o.monthlyAmount || 0) }));
    return merged;
  }
  function openDatabase() {
    return new Promise(resolve => {
      if (!('indexedDB' in window)) return resolve(null);
      const request = indexedDB.open('PocketLedgerDB', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  }
  async function loadSavedState() {
    idb = await openDatabase();
    if (idb) {
      try {
        const value = await new Promise((resolve, reject) => {
          const tx = idb.transaction('state', 'readonly');
          const req = tx.objectStore('state').get('main');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        if (value) return normalizeState(value);
      } catch (_) { /* use localStorage fallback */ }
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? normalizeState(JSON.parse(raw)) : defaultState();
    } catch (_) { return defaultState(); }
  }
  async function persist({ silent = false, sync = true } = {}) {
    state.updatedAt = new Date().toISOString();
    try {
      if (idb) {
        await new Promise((resolve, reject) => {
          const tx = idb.transaction('state', 'readwrite');
          tx.objectStore('state').put(state, 'main');
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      }
    } catch (err) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
      catch (_) { showToast('Storage is full. Export a backup and remove old records.'); }
    }
    render();
    if (!silent) showToast('Saved on this device');
    if (sync) scheduleCloudSync();
  }
  function showToast(message) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 2400);
  }
  function currentMonthTransactions(month = monthISO()) {
    return state.transactions.filter(t => String(t.date || '').slice(0, 7) === month);
  }
  function getAccount(id) { return state.accounts.find(a => a.id === id); }
  function accountKindLabel(kind) {
    return ({ cash: 'Cash', bank: 'Bank account', ewallet: 'E-wallet', credit: 'Credit card', other: 'Other' })[kind] || 'Other';
  }
  function accountBalance(account) {
    let balance = Number(account.openingBalance || 0);
    for (const t of state.transactions) {
      const amount = Number(t.amount || 0);
      if (t.type === 'income' && t.accountId === account.id) balance += account.kind === 'credit' ? -amount : amount;
      if (t.type === 'expense' && t.accountId === account.id) balance += account.kind === 'credit' ? amount : -amount;
      if (t.type === 'repay' && t.accountId === account.id) balance -= amount;
      if (t.type === 'lent' && t.accountId === account.id) balance -= amount;
      if (t.type === 'borrowed' && t.accountId === account.id) balance += amount;
      if (t.type === 'collect' && t.accountId === account.id) balance += amount;
      if (t.type === 'collect_plan' && t.accountId === account.id) balance += amount;
      if (t.type === 'transfer') {
        if (t.accountId === account.id) balance += account.kind === 'credit' ? amount : -amount;
        if (t.toAccountId === account.id) balance += account.kind === 'credit' ? -amount : amount;
      }
    }
    return balance;
  }
  function liquidTotal() {
    return state.accounts.filter(a => a.kind !== 'credit').reduce((sum, a) => sum + accountBalance(a), 0);
  }
  function creditOutstanding() {
    return state.accounts.filter(a => a.kind === 'credit').reduce((sum, a) => sum + Math.max(0, accountBalance(a)), 0);
  }
  function lendingOutstanding() {
    return state.transactions.reduce((sum, t) => {
      if (t.type === 'lent') return sum + Number(t.amount || 0);
      if (t.type === 'collect') return sum - Number(t.amount || 0);
      return sum;
    }, 0);
  }
  function borrowedOutstanding() {
    return state.transactions.reduce((sum, t) => {
      if (t.type === 'borrowed') return sum + Number(t.amount || 0);
      if (t.type === 'repay') return sum - Number(t.amount || 0);
      return sum;
    }, 0);
  }
  function monthTotals(month = monthISO()) {
    const txs = currentMonthTransactions(month);
    const income = txs.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const expense = txs.filter(t => t.type === 'expense' || t.type === 'repay').reduce((s, t) => s + t.amount, 0);
    return { income, expense, net: income - expense, count: txs.length };
  }
  function budgetActual(category, month = monthISO()) {
    return currentMonthTransactions(month).filter(t => (t.type === 'expense' || t.type === 'repay') && t.category === category).reduce((s, t) => s + t.amount, 0);
  }
  function safeSpend() {
    const now = new Date();
    const daysLeft = Math.max(1, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate() + 1);
    const dueSoon = state.obligations.filter(o => o.direction === 'payable' && o.remaining > 0 && !o.includedInCardDebt && o.dueDate && new Date(`${o.dueDate}T23:59:59`) <= new Date(now.getTime() + 30 * 86400000)).reduce((sum, o) => sum + Math.min(o.remaining, o.monthlyAmount > 0 ? o.monthlyAmount : o.remaining), 0);
    const planned = liquidTotal() - creditOutstanding() - Math.max(0, borrowedOutstanding()) - dueSoon - Number(state.settings.buffer || 0);
    return { available: planned, daily: Math.max(0, planned) / daysLeft, daysLeft, dueSoon };
  }
  function sortedTransactions(txs = state.transactions) {
    return [...txs].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
  }
  function accountSelectOptions(selected = '', { includeCredit = true, exclude = '' } = {}) {
    return state.accounts.filter(a => a.id !== exclude && (includeCredit || a.kind !== 'credit')).map(a => `<option value="${escapeHTML(a.id)}" ${a.id === selected ? 'selected' : ''}>${escapeHTML(a.name)}${a.kind === 'credit' ? ' · Card' : ''}</option>`).join('');
  }
  function categoryOptions(type = 'expense', selected = '') {
    const list = type === 'income' ? INCOME_CATEGORIES : state.categories;
    return list.map(name => `<option value="${escapeHTML(name)}" ${name === selected ? 'selected' : ''}>${escapeHTML(name)}</option>`).join('');
  }
  function viewTitle(view) {
    return ({ dashboard: 'Overview', activity: 'Transactions', budgets: 'Budgets', accounts: 'Accounts', plans: 'Installments & loans', settings: 'Settings & sync' })[view] || 'Overview';
  }
  function setView(view) {
    currentView = view;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function render() {
    const content = $('#page-content');
    if (!content) return;
    $$('.nav-item[data-view], .mobile-nav-item[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === currentView));
    $('#today-label').textContent = new Date().toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' });
    const renderers = { dashboard: renderDashboard, activity: renderActivity, budgets: renderBudgets, accounts: renderAccounts, plans: renderPlans, settings: renderSettings };
    content.innerHTML = (renderers[currentView] || renderDashboard)();
  }
  function pageHeading(eyebrow, title, subtitle, action = '') {
    return `<div class="page-heading"><div><div class="eyebrow">${escapeHTML(eyebrow)}</div><h1>${escapeHTML(title)}</h1><p>${subtitle}</p></div>${action ? `<div class="heading-actions">${action}</div>` : ''}</div>`;
  }
  function sixMonthSeries() {
    const now = new Date();
    return Array.from({ length: 6 }, (_, index) => {
      const date = new Date(now.getFullYear(), now.getMonth() - 5 + index, 1);
      const month = monthISO(date);
      return {
        month,
        label: date.toLocaleDateString('en-PH', { month: 'short' }),
        ...monthTotals(month)
      };
    });
  }
  function compactPeso(value) {
    const amount = Math.abs(Number(value || 0));
    if (amount >= 1000000) return `₱${(amount / 1000000).toFixed(1)}m`;
    if (amount >= 1000) return `₱${(amount / 1000).toFixed(amount >= 10000 ? 0 : 1)}k`;
    return `₱${Math.round(amount).toLocaleString('en-PH')}`;
  }
  function renderCashFlowChart() {
    const series = sixMonthSeries();
    if (!series.some(item => item.income > 0 || item.expense > 0)) {
      return `<div class="chart-empty"><span class="chart-empty-icon">▥</span><strong>Your cash-flow graph will appear here</strong><p>Log income and expenses to compare your monthly money coming in and going out.</p></div>`;
    }
    const width = 680, height = 238, left = 66, right = 14, top = 16, bottom = 38;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const maximum = Math.max(1, ...series.flatMap(item => [item.income, item.expense])) * 1.12;
    const groupWidth = plotWidth / series.length;
    const barWidth = Math.min(23, groupWidth * 0.25);
    const grid = [0, 0.25, 0.5, 0.75, 1].map(fraction => {
      const y = top + plotHeight * (1 - fraction);
      return `<line class="chart-gridline" x1="${left}" y1="${y.toFixed(1)}" x2="${(width - right).toFixed(1)}" y2="${y.toFixed(1)}"></line><text class="chart-axis-label" x="${left - 9}" y="${(y + 3).toFixed(1)}" text-anchor="end">${compactPeso(maximum * fraction)}</text>`;
    }).join('');
    const bars = series.map((item, index) => {
      const center = left + groupWidth * (index + 0.5);
      const incomeHeight = item.income / maximum * plotHeight;
      const expenseHeight = item.expense / maximum * plotHeight;
      const incomeX = center - barWidth - 2;
      const expenseX = center + 2;
      const incomeY = top + plotHeight - incomeHeight;
      const expenseY = top + plotHeight - expenseHeight;
      return `<rect class="chart-bar income-bar" x="${incomeX.toFixed(1)}" y="${incomeY.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0, incomeHeight).toFixed(1)}" rx="4"><title>${item.label}: income ${peso(item.income)}</title></rect><rect class="chart-bar expense-bar" x="${expenseX.toFixed(1)}" y="${expenseY.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0, expenseHeight).toFixed(1)}" rx="4"><title>${item.label}: expenses ${peso(item.expense)}</title></rect><text class="chart-month-label" x="${center.toFixed(1)}" y="${height - 11}" text-anchor="middle">${item.label}</text>`;
    }).join('');
    return `<svg class="cashflow-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Six-month income and expense comparison. Values use recorded transactions only."><title>Monthly income compared with expenses over the last six months</title>${grid}${bars}</svg>`;
  }
  function renderSpendingDonut() {
    const rows = state.categories.map((category, index) => ({
      category,
      value: budgetActual(category),
      color: ['#28634f', '#79a88d', '#d6a45d', '#7891ad', '#bd8178', '#9584b5', '#61a7a2', '#b7a66d'][index % 8]
    })).filter(item => item.value > 0).sort((a, b) => b.value - a.value);
    const total = rows.reduce((sum, item) => sum + item.value, 0);
    if (!total) {
      return `<div class="chart-empty"><span class="chart-empty-icon">◌</span><strong>No spending recorded this month</strong><p>Once you log expenses, this chart will show which categories make up your spending.</p></div>`;
    }
    const visible = rows.slice(0, 5);
    const remainder = rows.slice(5).reduce((sum, item) => sum + item.value, 0);
    if (remainder > 0) visible.push({ category: 'Other categories', value: remainder, color: '#aab5ae' });
    let cursor = 0;
    const stops = visible.map(item => {
      const start = cursor;
      cursor += item.value / total * 100;
      return `${item.color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
    }).join(', ');
    return `<div class="donut-layout"><div class="donut-chart" style="--donut-stops:${stops}" role="img" aria-label="Spending breakdown by category. Total ${peso(total)}"><div class="donut-hole"><strong>${compactPeso(total)}</strong><span>spent this month</span></div></div><div class="donut-legend">${visible.map(item => `<div class="donut-legend-row"><span class="legend-dot" style="background:${item.color}"></span><span class="legend-name">${escapeHTML(item.category)}</span><strong>${Math.round(item.value / total * 100)}%</strong><small>${peso(item.value)}</small></div>`).join('')}</div></div>`;
  }
  function renderFinancialPulse({ totals, budgetTotal, spent, safe, reviewCount }) {
    const budgetPct = budgetTotal > 0 ? spent / budgetTotal * 100 : 0;
    const budgetStatus = budgetTotal <= 0
      ? { label: 'Set your budgets', tone: 'watch', detail: 'Add category limits to track your monthly plan.' }
      : spent > budgetTotal
        ? { label: 'Over budget', tone: 'over', detail: `${peso(spent - budgetTotal)} above your combined monthly limits.` }
        : budgetPct >= 80
          ? { label: 'Watch spending', tone: 'watch', detail: `${budgetPct.toFixed(0)}% of your combined budget has been used.` }
          : { label: 'Within budget', tone: 'good', detail: `${Math.max(0, 100 - budgetPct).toFixed(0)}% of your combined budget remains.` };
    const flowStatus = totals.income === 0 && totals.expense === 0
      ? { label: 'Waiting for activity', tone: 'neutral', detail: 'Log income and expenses to see your cash-flow position.' }
      : totals.net < 0
        ? { label: 'Negative cash flow', tone: 'over', detail: `${peso(Math.abs(totals.net))} more expenses than income this month.` }
        : totals.net === 0
          ? { label: 'Break-even', tone: 'watch', detail: 'Recorded income and expenses are currently equal.' }
          : { label: 'Positive cash flow', tone: 'good', detail: `${peso(totals.net)} more income than expenses this month.` };
    const commitmentStatus = safe.dueSoon > 0
      ? { label: 'Upcoming payments', tone: 'watch', detail: `${peso(safe.dueSoon)} in recorded payable installments due within 30 days.` }
      : { label: 'No near-term payables', tone: 'good', detail: 'No payable installment is recorded as due within 30 days.' };
    const reviewStatus = reviewCount
      ? { label: `${reviewCount} records to review`, tone: 'watch', detail: 'Check flagged imported transactions before relying on totals.' }
      : { label: 'No flagged records', tone: 'good', detail: 'No imported transactions are currently marked for review.' };
    const items = [
      { title: 'Monthly cash flow', data: flowStatus },
      { title: 'Budget usage', data: budgetStatus },
      { title: 'Upcoming commitments', data: commitmentStatus },
      { title: 'Record review', data: reviewStatus }
    ];
    return `<div class="panel pulse-panel"><div class="panel-head"><div><h3>Financial status</h3><p>A quick reading of your recorded activity and commitments</p></div><span class="pulse-caption">This month</span></div><div class="pulse-grid">${items.map(item => `<div class="pulse-item"><div class="pulse-item-top"><strong>${item.title}</strong><span class="status-chip ${item.data.tone === 'over' ? 'over' : item.data.tone === 'watch' ? 'watch' : ''} ${item.data.tone === 'neutral' ? 'neutral' : ''}">${item.data.label}</span></div><p>${item.data.detail}</p></div>`).join('')}</div></div>`;
  }
  function renderDashboard() {
    const totals = monthTotals();
    const safe = safeSpend();
    const budgetTotal = Object.values(state.budgets).reduce((sum, x) => sum + Number(x || 0), 0);
    const spent = state.categories.reduce((sum, category) => sum + budgetActual(category), 0);
    const remaining = budgetTotal - spent;
    const txs = sortedTransactions().slice(0, 7);
    const accounts = state.accounts.filter(a => a.kind !== 'credit').slice(0, 5);
    const debtCards = state.accounts.filter(a => a.kind === 'credit');
    const reviewCount = state.transactions.filter(t => t.review).length;
    const budgetRows = state.categories.map(category => {
      const budget = Number(state.budgets[category] || 0), actual = budgetActual(category), left = budget - actual;
      const pct = budget > 0 ? Math.min(100, actual / budget * 100) : actual > 0 ? 100 : 0;
      const status = actual > budget ? 'Over budget' : pct >= 80 ? 'Watch' : 'On track';
      return `<div class="budget-item"><div class="budget-topline"><span class="budget-name">${escapeHTML(category)}</span><span class="budget-numbers">${peso(actual)} / ${peso(budget)}</span></div><div class="progress"><span class="${actual > budget ? 'over' : ''}" style="width:${pct}%"></span></div><div class="budget-foot"><span>${status}</span><span>${left >= 0 ? `${peso(left)} left` : `${peso(Math.abs(left))} over`}</span></div></div>`;
    }).sort((a, b) => 0).slice(0, 6).join('');
    const safeStatus = safe.available < 0 ? 'Commitments exceed available funds' : 'Based on the entries recorded';
    return `${pageHeading('YOUR MONEY, IN ONE PLACE', 'Good day.', 'A clear view of what came in, what went out, and what is already committed.', `<button class="button button-primary" data-action="open-add">＋ Add transaction</button>`)}
      <div class="grid dashboard-top">
        <div class="safe-card"><div class="safe-head"><span>SAFE TO SPEND PER DAY</span><span class="safe-pill">${safe.daysLeft} days left this month</span></div><div class="safe-amount">${peso(safe.daily)}</div><div class="safe-sub">${safeStatus}</div><div class="safe-foot">Estimated available funds: <strong>${peso(safe.available)}</strong> · after card debt, borrowed money, upcoming installments and your buffer.</div></div>
        <div class="side-stack"><div class="mini-stat"><span class="mini-stat-label">Liquid account balances</span><div><div class="mini-stat-value">${peso(liquidTotal())}</div><div class="mini-stat-note">Cash, banks and e-wallets</div></div></div><div class="mini-stat"><span class="mini-stat-label">Outstanding credit cards</span><div><div class="mini-stat-value ${creditOutstanding() > 0 ? 'negative' : ''}">${peso(creditOutstanding())}</div><div class="mini-stat-note">${debtCards.length} card account${debtCards.length === 1 ? '' : 's'}</div></div></div></div>
      </div>
      <div class="grid stat-grid">
        <div class="stat-card"><div class="stat-label">Income this month</div><div class="stat-value positive">${peso(totals.income)}</div><div class="stat-caption">${totals.count} logged transactions this month</div></div>
        <div class="stat-card"><div class="stat-label">Expenses this month</div><div class="stat-value">${peso(totals.expense)}</div><div class="stat-caption">Includes debt repayments recorded as expenses</div></div>
        <div class="stat-card"><div class="stat-label">Net cash flow</div><div class="stat-value ${totals.net < 0 ? 'negative' : 'positive'}">${peso(totals.net, true)}</div><div class="stat-caption">Income less logged expenses</div></div>
      </div>
      <div class="grid insight-grid">
        <section class="panel chart-panel"><div class="panel-head"><div><h3>Cash flow trend</h3><p>Income vs. expenses · last 6 months</p></div><span class="chart-status">Monthly</span></div><div class="panel-body chart-body">${renderCashFlowChart()}<div class="chart-legend"><span><i class="legend-dot income-dot"></i>Income</span><span><i class="legend-dot expense-dot"></i>Expenses</span></div><p class="chart-footnote">Uses recorded income, expenses and debt repayments. Transfers are excluded to avoid double counting.</p></div></section>
        <section class="panel chart-panel"><div class="panel-head"><div><h3>Spending breakdown</h3><p>Where this month's expenses went</p></div><span class="chart-status">By category</span></div><div class="panel-body chart-body">${renderSpendingDonut()}</div></section>
      </div>
      ${renderFinancialPulse({ totals, budgetTotal, spent, safe, reviewCount })}
      ${state.settings.migrationNote ? `<div class="inline-note warning" style="margin-top:16px"><strong>Workbook migration reminder:</strong> Your source workbook had one combined opening cash/bank balance, so it was not assigned to individual accounts. Set account opening balances as of the day before your first imported transaction (or clear history and start with today's balances). Review flagged entries before relying on balances. <button class="button-text" data-action="dismiss-migration-note">Dismiss</button></div>` : ''}
      ${reviewCount ? `<div class="inline-note warning" style="margin-top:16px"><strong>${reviewCount} transaction${reviewCount === 1 ? '' : 's'} need review.</strong> Imported records with review notes are flagged in Transactions. Confirm their category, payment account and type before relying on balances.</div>` : ''}
      ${!state.transactions.length && state.accounts.every(a => Number(a.openingBalance || 0) === 0) ? `<div class="inline-note" style="margin-top:16px"><strong>First setup:</strong> Open Accounts and enter each wallet, bank and credit-card opening balance. Then use Quick add to log new transactions. You can also import your existing Excel tracker in Settings.</div>` : ''}
      <div class="section-row"><h2>Account balances</h2><a class="muted-link" href="#accounts" data-view="accounts">View all accounts →</a></div>
      <div class="panel"><div class="panel-body"><div class="account-list">${accounts.length ? accounts.map(a => `<div class="account-row"><div class="account-left"><div class="account-symbol">${a.kind === 'cash' ? '₱' : a.kind === 'ewallet' ? '◈' : '▤'}</div><div><div class="account-name">${escapeHTML(a.name)}</div><div class="account-kind">${accountKindLabel(a.kind)}</div></div></div><div class="account-balance ${accountBalance(a) < 0 ? 'negative' : ''}">${peso(accountBalance(a))}</div></div>`).join('') : `<div class="empty-state">No accounts yet.</div>`}</div></div></div>
      <div class="grid content-grid"><div><div class="section-row"><h2>Recent transactions</h2><a class="muted-link" href="#activity" data-view="activity">View all →</a></div><div class="panel">${txs.length ? `<div class="transaction-list">${txs.map(transactionRow).join('')}</div>` : emptyState('No transactions yet','Start with your current account balances, then log your first income or expense.','open-add','＋ Log first transaction')}</div></div>
      <div><div class="section-row"><h2>Budget progress</h2><a class="muted-link" href="#budgets" data-view="budgets">Manage →</a></div><div class="panel"><div class="panel-body"><div class="budget-list">${budgetRows}</div><div class="budget-foot" style="margin-top:17px;padding-top:12px;border-top:1px solid var(--line)"><span>Total budget ${peso(budgetTotal)}</span><span class="${remaining < 0 ? 'negative' : ''}">${remaining < 0 ? `${peso(Math.abs(remaining))} over` : `${peso(remaining)} remaining`}</span></div></div></div><div class="section-row"><h2>Money owed</h2></div><div class="panel"><div class="panel-body"><div class="account-row"><div><div class="account-name">Others owe you</div><div class="account-kind">Lent money less collections</div></div><div class="account-balance positive">${peso(lendingOutstanding())}</div></div><div class="account-row" style="margin-top:14px"><div><div class="account-name">You owe others</div><div class="account-kind">Borrowed money less repayments</div></div><div class="account-balance negative">${peso(borrowedOutstanding())}</div></div></div></div></div></div>
    `;
  }
  function transactionRow(t) {
    const account = getAccount(t.accountId);
    const label = t.description || t.category || TYPE_LABELS[t.type] || 'Transaction';
    let sign = '';
    let amountClass = '';
    if (['income', 'borrowed', 'collect', 'collect_plan'].includes(t.type)) { sign = '+'; amountClass = 'positive'; }
    else if (['expense', 'lent', 'repay'].includes(t.type)) { sign = '−'; amountClass = t.type === 'lent' ? '' : ''; }
    const meta = [TYPE_LABELS[t.type] || t.type, t.category, account?.name, dateLabel(t.date, { month: 'short', day: 'numeric' })].filter(Boolean).join(' · ');
    return `<div class="transaction-row"><div class="transaction-symbol">${TYPE_SYMBOLS[t.type] || '•'}</div><div class="transaction-main"><div class="transaction-title">${escapeHTML(label)}</div><div class="transaction-meta">${escapeHTML(meta)}${t.review ? ' · Review' : ''}</div></div><div class="transaction-amount ${amountClass}">${sign}${peso(t.amount)}${t.review ? '<small class="negative">Needs review</small>' : ''}</div></div>`;
  }
  function emptyState(title, description, action = '', buttonText = '') {
    return `<div class="empty-state"><div class="empty-icon">◎</div><strong>${escapeHTML(title)}</strong><p>${escapeHTML(description)}</p>${action ? `<button class="button button-primary button-small" data-action="${escapeHTML(action)}">${escapeHTML(buttonText)}</button>` : ''}</div>`;
  }
  function renderActivity() {
    let txs = sortedTransactions().filter(t => !activityMonth || String(t.date || '').slice(0, 7) === activityMonth);
    if (activitySearch.trim()) {
      const q = activitySearch.toLowerCase();
      txs = txs.filter(t => [t.description, t.category, t.note, TYPE_LABELS[t.type], getAccount(t.accountId)?.name, getAccount(t.toAccountId)?.name].join(' ').toLowerCase().includes(q));
    }
    const options = ['<option value="">All months</option>'];
    const months = [...new Set(state.transactions.map(t => String(t.date || '').slice(0, 7)).filter(Boolean))].sort().reverse();
    months.forEach(m => options.push(`<option value="${m}" ${m === activityMonth ? 'selected' : ''}>${dateLabel(`${m}-01`, { month: 'long', year: 'numeric' })}</option>`));
    return `${pageHeading('YOUR LEDGER', 'Transactions', 'Every transaction in one searchable record. Use transfers for moving money between your own accounts.', `<button class="button button-primary" data-action="open-add">＋ Add transaction</button>`)}
      <div class="toolbar"><input class="field-control search-control" id="activity-search" placeholder="Search description, category or account…" value="${escapeHTML(activitySearch)}"><select class="field-control month-select" id="activity-month">${options.join('')}</select><button class="button" data-action="export-csv">Export CSV</button></div>
      <div class="page-panel table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Description</th><th>Type</th><th>Account</th><th>Amount</th><th></th></tr></thead><tbody>${txs.length ? txs.map(t => {
        const acct = getAccount(t.accountId);
        const dest = getAccount(t.toAccountId);
        const signed = ['income', 'borrowed', 'collect', 'collect_plan'].includes(t.type) ? '+' : ['expense', 'lent', 'repay'].includes(t.type) ? '−' : '';
        return `<tr><td>${dateLabel(t.date, { month: 'short', day: 'numeric', year: 'numeric' })}</td><td><div class="table-primary">${escapeHTML(t.description || t.category || TYPE_LABELS[t.type])}</div><div class="table-secondary">${escapeHTML(t.category || '')}${t.note ? ` · ${escapeHTML(t.note)}` : ''}${t.review ? '<div class="review-flag">Needs review</div>' : ''}</div></td><td><span class="type-tag ${escapeHTML(t.type)}">${escapeHTML(TYPE_LABELS[t.type] || t.type)}</span></td><td>${escapeHTML(acct?.name || '—')}${dest ? `<div class="table-secondary">to ${escapeHTML(dest.name)}</div>` : ''}</td><td class="table-primary">${signed}${peso(t.amount)}</td><td><button class="button button-quiet" data-action="edit-transaction" data-id="${escapeHTML(t.id)}">Edit</button></td></tr>`;
      }).join('') : `<tr><td colspan="6">${emptyState('No matching transactions','Try a different month or search, or add a new transaction.','open-add','＋ Add transaction')}</td></tr>`}</tbody></table></div>
      <div class="inline-note" style="margin-top:14px">Credit-card purchases are logged as <strong>Expenses paid from the card account</strong>. Paying the card bill is a <strong>Transfer</strong> from your bank to the credit-card account, so the purchase is not counted twice.</div>`;
  }
  function renderBudgets() {
    const total = Object.values(state.budgets).reduce((sum, amount) => sum + Number(amount || 0), 0);
    const actual = state.categories.reduce((sum, c) => sum + budgetActual(c), 0);
    return `${pageHeading('MONTHLY PLAN', 'Budgets', 'Set a spending limit for each category. Categories stay flat—no subcategories.', `<button class="button button-primary" data-action="edit-budgets">Edit budgets</button>`)}
      <div class="grid stat-grid"><div class="stat-card"><div class="stat-label">Total monthly budget</div><div class="stat-value">${peso(total)}</div><div class="stat-caption">Across ${state.categories.length} categories</div></div><div class="stat-card"><div class="stat-label">Actual spending</div><div class="stat-value">${peso(actual)}</div><div class="stat-caption">Expenses and debt repayments this month</div></div><div class="stat-card"><div class="stat-label">Budget remaining</div><div class="stat-value ${total - actual < 0 ? 'negative' : 'positive'}">${peso(total - actual)}</div><div class="stat-caption">Can be negative when over budget</div></div></div>
      <div class="section-row"><h2>Category breakdown</h2><span class="muted-link">${new Date().toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })}</span></div>
      <div class="panel"><div class="panel-body"><div class="budget-list">${state.categories.map(category => {
        const budget = Number(state.budgets[category] || 0), spent = budgetActual(category), left = budget - spent;
        const pct = budget > 0 ? Math.min(100, spent / budget * 100) : spent > 0 ? 100 : 0;
        const status = spent > budget ? 'Over budget' : pct >= 80 ? 'Watch' : 'On track';
        return `<div class="budget-item"><div class="budget-topline"><span class="budget-name">${escapeHTML(category)}</span><span class="budget-numbers">${peso(spent)} of ${peso(budget)} <span class="status-chip ${spent > budget ? 'over' : pct >= 80 ? 'watch' : ''}">${status}</span></span></div><div class="progress"><span class="${spent > budget ? 'over' : ''}" style="width:${pct}%"></span></div><div class="budget-foot"><span>${pct.toFixed(0)}% used</span><span>${left >= 0 ? `${peso(left)} remaining` : `${peso(Math.abs(left))} over budget`}</span></div></div>`;
      }).join('')}</div></div></div>
      <div class="inline-note" style="margin-top:14px">A credit-card purchase is counted when the purchase is logged. A later card bill payment is a transfer, not a second expense. Debt repayments can be recorded under <strong>Debt & Loans</strong>.</div>`;
  }
  function renderAccounts() {
    return `${pageHeading('WHERE YOUR MONEY LIVES', 'Accounts', 'Track cash, bank accounts, e-wallets and credit-card balances separately.', `<button class="button button-primary" data-action="add-account">＋ Add account</button>`)}
      <div class="inline-note warning"><strong>Before relying on balances:</strong> enter the actual opening balance for each account as of your tracking start date. For a credit card, enter the current amount owed as its opening balance. Do not enter a combined bank-and-cash figure into several accounts.</div>
      <div class="grid account-cards">${state.accounts.map(a => {
        const balance = accountBalance(a), credit = a.kind === 'credit';
        return `<div class="account-card"><div class="account-card-top"><div class="account-symbol">${a.kind === 'cash' ? '₱' : a.kind === 'ewallet' ? '◈' : credit ? '▣' : '▤'}</div><span class="status-chip">${accountKindLabel(a.kind)}</span></div><h3>${escapeHTML(a.name)}</h3><div class="account-type">${credit ? 'Outstanding balance' : 'Available balance'}</div><div class="balance-big ${credit && balance > 0 ? 'negative' : balance < 0 ? 'negative' : 'positive'}">${peso(balance)}</div><div class="balance-note">Opening balance: ${peso(a.openingBalance)}</div><div class="card-actions"><button class="button-text" data-action="edit-account" data-id="${escapeHTML(a.id)}">Edit account</button><button class="button-text" data-action="account-history" data-id="${escapeHTML(a.id)}">View activity</button></div></div>`;
      }).join('')}</div>`;
  }
  function renderPlans() {
    const open = state.obligations.filter(o => o.remaining > 0);
    const payable = open.filter(o => o.direction === 'payable').reduce((s, o) => s + o.remaining, 0);
    const receivable = open.filter(o => o.direction === 'receivable').reduce((s, o) => s + o.remaining, 0);
    return `${pageHeading('FUTURE COMMITMENTS', 'Installments & loans', 'Keep track of what you still owe and what others still owe you. Record actual payments when they happen.', `<button class="button button-primary" data-action="add-plan">＋ Add commitment</button>`)}
      <div class="grid stat-grid"><div class="stat-card"><div class="stat-label">You still owe</div><div class="stat-value negative">${peso(payable)}</div><div class="stat-caption">Open payables and installments</div></div><div class="stat-card"><div class="stat-label">Owed to you</div><div class="stat-value positive">${peso(receivable)}</div><div class="stat-caption">Open receivables</div></div><div class="stat-card"><div class="stat-label">Due in next 30 days</div><div class="stat-value">${peso(safeSpend().dueSoon)}</div><div class="stat-caption">Payables not already included in card debt</div></div></div>
      <div class="section-row"><h2>Open commitments</h2><span class="muted-link">${open.length} open</span></div>
      <div class="grid obligation-grid">${open.length ? open.map(o => {
        const isPayable = o.direction === 'payable';
        return `<div class="panel obligation-card"><div class="account-row"><div><h3>${escapeHTML(o.name)}</h3><p>${isPayable ? 'You owe' : 'Owed to you'}${o.counterparty ? ` · ${escapeHTML(o.counterparty)}` : ''}</p></div><span class="status-chip ${isPayable ? 'watch' : ''}">${isPayable ? 'Payable' : 'Receivable'}</span></div><div class="obligation-amount ${isPayable ? '' : 'positive'}">${peso(o.remaining)}</div><div class="obligation-meta"><span>Monthly: ${peso(o.monthlyAmount || o.remaining)}</span><span>Next due: ${dateLabel(o.dueDate, { month: 'short', day: 'numeric', year: 'numeric' })}</span></div><div class="obligation-meta" style="margin-top:7px">${o.includedInCardDebt ? 'Already included in credit-card balance' : 'Separate from credit-card balance'}</div><div class="obligation-actions"><button class="button button-quiet" data-action="edit-plan" data-id="${escapeHTML(o.id)}">Edit</button><button class="button button-primary button-small" data-action="pay-plan" data-id="${escapeHTML(o.id)}">${isPayable ? 'Record payment' : 'Record collection'}</button></div></div>`;
      }).join('') : `<div class="panel" style="grid-column:1/-1">${emptyState('No commitments added','Add an installment, loan, or amount someone owes you so it is not forgotten.','add-plan','＋ Add commitment')}</div>`}</div>
      <div class="section-row"><h2>Completed</h2></div><div class="panel"><div class="panel-body">${state.obligations.some(o => o.remaining <= 0) ? state.obligations.filter(o => o.remaining <= 0).map(o => `<div class="account-row" style="padding:8px 0"><div><div class="account-name">${escapeHTML(o.name)}</div><div class="account-kind">Completed · ${o.direction === 'payable' ? 'Payable' : 'Receivable'}</div></div><span class="status-chip">Settled</span></div>`).join('') : '<div class="account-kind">No completed commitments yet.</div>'}</div></div>
      <div class="inline-note" style="margin-top:14px">A commitment only affects your “safe to spend” estimate when it is a payable due within 30 days and is not already included in your credit-card balance. Use <strong>Record payment</strong> or <strong>Record collection</strong> to log the actual cash movement and update the remaining amount.</div>`;
  }
  function getCloud() {
    try { return JSON.parse(localStorage.getItem(CLOUD_KEY) || '{}'); } catch (_) { return {}; }
  }
  function saveCloud(obj) { localStorage.setItem(CLOUD_KEY, JSON.stringify(obj)); }
  function renderSettings() {
    const cloud = getCloud();
    const signed = !!(cloud.accessToken && cloud.userId);
    return `${pageHeading('PREFERENCES & BACKUP', 'Settings & sync', 'Keep your records private, make backups, and optionally sync your iPhone and computer through your own Supabase project.')}
      <div class="grid settings-grid">
        <div class="panel settings-card"><h3>Safe-to-spend buffer</h3><p>An amount you choose not to spend. It is subtracted from liquid balances when calculating your daily estimate.</p><form data-form="buffer"><div class="form-field"><label for="buffer">Safety buffer (PHP)</label><input id="buffer" name="buffer" type="number" min="0" step="0.01" value="${Number(state.settings.buffer || 0)}"></div><button class="button button-primary" type="submit">Save buffer</button></form>
          <div style="height:19px"></div><h3>Backup & restore</h3><p>Download a complete JSON backup, or restore a backup on another device. Keep backups somewhere private.</p><div class="toolbar"><button class="button" data-action="export-json">Download backup</button><button class="button" data-action="import-json">Restore backup</button><input class="hidden" id="json-file" type="file" accept=".json,application/json"></div><div class="form-field"><label>Import your existing Excel tracker</label><input id="excel-file" type="file" accept=".xlsx,.xlsm,.xls"><small>Reads the Transactions, Budgets and Lists & Setup sheets. Opening balances are not automatically allocated because your workbook has one combined opening cash/bank figure.</small></div><div class="inline-note warning">Imported transactions with “Review” notes are flagged for checking. Verify the original transaction type and account before using the calculated balances.</div></div>
        <div class="panel settings-card"><h3>Optional cloud sync</h3><p>Use your own Supabase project to sync the same ledger between iPhone and Windows. Local saving works without this setup.</p>
          <div class="inline-note ${signed ? 'success' : ''}">${signed ? `Signed in as <strong>${escapeHTML(cloud.email || 'your account')}</strong>. Your local data can sync to your private cloud row.` : '<strong>Not connected.</strong> Create a free Supabase project, run the SQL in the included supabase.sql file, then enter your project URL and anon key.'}</div>
          <form data-form="cloud-config"><div class="form-field"><label for="supabase-url">Supabase project URL</label><input id="supabase-url" name="url" type="url" placeholder="https://your-project.supabase.co" value="${escapeHTML(state.settings.supabaseUrl || '')}"></div><div class="form-field"><label for="supabase-key">Supabase anon / publishable key</label><input id="supabase-key" name="key" type="password" autocomplete="off" placeholder="Paste your public anon key" value="${escapeHTML(state.settings.supabaseKey || '')}"></div><div class="form-row"><div class="form-field"><label for="cloud-email">Email</label><input id="cloud-email" name="email" type="email" autocomplete="username" value="${escapeHTML(cloud.email || '')}" placeholder="you@example.com"></div><div class="form-field"><label for="cloud-password">Password</label><input id="cloud-password" name="password" type="password" autocomplete="current-password" placeholder="Cloud account password"></div></div><div class="toolbar"><button class="button button-primary" type="button" data-action="cloud-signup">Create cloud account</button><button class="button" type="button" data-action="cloud-login">Sign in</button></div></form>
          <div class="toolbar">${signed ? '<button class="button button-primary" data-action="cloud-sync">Sync now</button><button class="button button-danger" data-action="cloud-logout">Sign out</button>' : '<button class="button" data-action="save-cloud-config">Save project settings</button>'}</div>
          <div class="form-field"><small>Sync uses Supabase email/password authentication and row-level security. The app stores the session token on this device. Do not share your password or project secrets. Use the public anon key only.</small></div>
        </div>
      </div>
      <div class="section-row"><h2>How your daily safe-to-spend estimate works</h2></div><div class="panel"><div class="panel-body"><p style="font-size:11px;line-height:1.7;color:#65736b;margin:0"> <strong>Liquid cash + bank + e-wallet balances − credit-card outstanding − borrowed money still owed − upcoming payable installments due in 30 days − your safety buffer.</strong> The remaining amount is divided by the number of days left in the current month. This is a conservative estimate, not a bank balance or a guarantee. Do not record the same amount both as an open commitment and as an outstanding card balance unless you mark the commitment as already included in card debt.</p></div></div>
      <div class="section-row"><h2>Privacy & data</h2></div><div class="panel"><div class="panel-body"><p style="font-size:11px;line-height:1.7;color:#65736b;margin:0">Your ledger is stored on this device by default. It is not sent anywhere unless you configure cloud sync. Use <strong>Download backup</strong> regularly. For iPhone and Windows synchronization, configure cloud sync and sign in with the same account on both devices.</p></div></div>`;
  }
  function openModal(title, subtitle, body, wide = false) {
    $('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="backdrop-close"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true"><div class="modal-head"><div><h2>${title}</h2><p>${subtitle || ''}</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button></div><div class="modal-body">${body}</div></div></div>`;
    const focusTarget = $('.modal input:not([type=hidden]), .modal select');
    if (focusTarget) setTimeout(() => focusTarget.focus(), 70);
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }
  function openTransactionModal(type = 'expense', existing = null, prefill = {}) {
    const t = existing || {};
    const chosenType = t.type || type;
    const firstAsset = state.accounts.find(a => a.kind !== 'credit')?.id || state.accounts[0]?.id || '';
    const sourceDefault = t.accountId || firstAsset;
    const destDefault = t.toAccountId || state.accounts.find(a => a.kind === 'credit')?.id || state.accounts.find(a => a.id !== sourceDefault)?.id || '';
    const cat = t.category || (chosenType === 'income' ? 'Salary' : chosenType === 'repay' ? 'Debt & Loans' : state.categories[0]);
    const body = `<form data-form="transaction" data-edit-id="${escapeHTML(t.id || '')}">
      <div class="form-field"><label for="txn-amount">Amount (PHP)</label><input class="amount-input" id="txn-amount" name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" required placeholder="0.00" value="${t.amount ?? prefill.amount ?? ''}"></div>
      <div class="form-field"><label for="txn-type">Transaction type</label><select id="txn-type" name="type">${Object.entries(TYPE_LABELS).filter(([key]) => key !== 'collect_plan').map(([key, label]) => `<option value="${key}" ${key === chosenType ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
      <div class="form-row" id="txn-category-account"><div class="form-field" id="txn-category-wrap"><label for="txn-category">Category</label><select id="txn-category" name="category">${categoryOptions(chosenType === 'income' ? 'income' : 'expense', cat)}</select></div><div class="form-field" id="txn-account-wrap"><label id="txn-account-label" for="txn-account">Account</label><select id="txn-account" name="accountId">${accountSelectOptions(sourceDefault)}</select></div></div>
      <div class="form-field hidden" id="txn-to-wrap"><label for="txn-to">Transfer to / card</label><select id="txn-to" name="toAccountId">${accountSelectOptions(destDefault, { exclude: sourceDefault })}</select></div>
      <div class="form-row"><div class="form-field"><label for="txn-date">Date</label><input id="txn-date" name="date" type="date" required value="${escapeHTML(t.date || todayISO())}"></div><div class="form-field"><label for="txn-description">Description / payee</label><input id="txn-description" name="description" type="text" maxlength="90" placeholder="e.g. Lunch, Salary, Fuel" value="${escapeHTML(t.description || prefill.description || '')}"></div></div>
      <div class="form-field"><label for="txn-note">Notes (optional)</label><textarea id="txn-note" name="note" placeholder="Extra details or person involved">${escapeHTML(t.note || '')}</textarea></div>
      <div class="modal-actions"><button class="button" type="button" data-action="close-modal">Cancel</button>${existing ? '<button class="button button-danger" type="button" data-action="delete-transaction" data-id="'+escapeHTML(t.id)+'">Delete</button>' : ''}<button class="button button-primary" type="submit">${existing ? 'Save changes' : 'Save transaction'}</button></div>
    </form>`;
    openModal(existing ? 'Edit transaction' : 'Quick add transaction', 'Enter the amount first. Transfers between your own accounts are not income or expenses.', body);
    updateTransactionFields();
  }
  function updateTransactionFields() {
    const type = $('#txn-type')?.value || 'expense';
    const catWrap = $('#txn-category-wrap');
    const toWrap = $('#txn-to-wrap');
    const accountLabel = $('#txn-account-label');
    const category = $('#txn-category');
    const previous = category?.value;
    const showCategory = ['expense', 'income', 'repay'].includes(type);
    if (catWrap) catWrap.classList.toggle('hidden', !showCategory);
    if (toWrap) toWrap.classList.toggle('hidden', type !== 'transfer');
    if (accountLabel) accountLabel.textContent = type === 'income' || type === 'borrowed' || type === 'collect' ? 'Deposit to' : type === 'transfer' ? 'From account' : 'Paid from';
    if (category && showCategory) {
      const selected = type === 'repay' ? 'Debt & Loans' : previous;
      category.innerHTML = categoryOptions(type === 'income' ? 'income' : 'expense', selected);
      category.disabled = type === 'repay';
    }
    const from = $('#txn-account');
    const to = $('#txn-to');
    if (from && to && from.value === to.value) {
      const option = Array.from(to.options).find(o => o.value !== from.value);
      if (option) to.value = option.value;
    }
  }
  function addTransactionFromForm(form) {
    const fd = new FormData(form);
    const amount = Number(fd.get('amount'));
    if (!Number.isFinite(amount) || amount <= 0) { showToast('Enter an amount greater than zero.'); return; }
    const type = String(fd.get('type'));
    const accountId = String(fd.get('accountId') || '');
    const toAccountId = String(fd.get('toAccountId') || '');
    if (!getAccount(accountId)) { showToast('Choose an account first.'); return; }
    if (type === 'transfer' && (!getAccount(toAccountId) || toAccountId === accountId)) { showToast('Choose a different destination account.'); return; }
    const editId = form.dataset.editId;
    const tx = {
      id: editId || makeId(), date: String(fd.get('date') || todayISO()), type,
      category: ['expense', 'income', 'repay'].includes(type) ? String(fd.get('category') || (type === 'repay' ? 'Debt & Loans' : '')) : '',
      accountId, toAccountId: type === 'transfer' ? toAccountId : '', amount,
      description: String(fd.get('description') || '').trim(), note: String(fd.get('note') || '').trim(),
      createdAt: new Date().toISOString(), review: false
    };
    if (editId) {
      const index = state.transactions.findIndex(x => x.id === editId);
      if (index >= 0) state.transactions[index] = { ...state.transactions[index], ...tx };
    } else state.transactions.push(tx);
    closeModal();
    persist({ silent: true });
    showToast(editId ? 'Transaction updated' : 'Transaction saved');
  }
  function openAccountModal(existing = null) {
    const a = existing || {};
    const body = `<form data-form="account" data-edit-id="${escapeHTML(a.id || '')}"><div class="form-field"><label for="account-name">Account name</label><input id="account-name" name="name" maxlength="45" required value="${escapeHTML(a.name || '')}" placeholder="e.g. BPI, GCash, Wallet"></div><div class="form-row"><div class="form-field"><label for="account-kind">Account type</label><select id="account-kind" name="kind">${[['cash','Cash'],['bank','Bank account'],['ewallet','E-wallet'],['credit','Credit card'],['other','Other']].map(([v,l]) => `<option value="${v}" ${v === (a.kind || 'bank') ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div class="form-field"><label for="account-opening">Opening balance (PHP)</label><input id="account-opening" name="openingBalance" type="number" step="0.01" value="${Number(a.openingBalance || 0)}"></div></div><div class="inline-note">For cash, banks and e-wallets, enter the money available on your start date. For a credit card, enter the amount you already owe as a positive number.</div><div class="modal-actions"><button class="button" type="button" data-action="close-modal">Cancel</button>${existing ? `<button class="button button-danger" type="button" data-action="delete-account" data-id="${escapeHTML(a.id)}">Delete</button>` : ''}<button class="button button-primary" type="submit">Save account</button></div></form>`;
    openModal(existing ? 'Edit account' : 'Add account', 'Separate balances make the daily spending estimate more useful.', body);
  }
  function openBudgetModal() {
    const body = `<form data-form="budgets"><div class="inline-note">Set your monthly limits. Enter 0 for categories you do not use. These amounts are editable and can be changed later.</div>${state.categories.map(c => `<div class="form-row"><div class="form-field"><label>${escapeHTML(c)}</label></div><div class="form-field"><input type="number" min="0" step="0.01" name="budget:${escapeHTML(c)}" value="${Number(state.budgets[c] || 0)}" aria-label="Budget for ${escapeHTML(c)}"></div></div>`).join('')}<div class="modal-actions"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Save budgets</button></div></form>`;
    openModal('Edit monthly budgets', 'Set the maximum amount you plan to spend by category.', body, true);
  }
  function openPlanModal(existing = null) {
    const o = existing || {};
    const body = `<form data-form="plan" data-edit-id="${escapeHTML(o.id || '')}"><div class="form-field"><label for="plan-name">Commitment name</label><input id="plan-name" name="name" maxlength="60" required placeholder="e.g. Phone installment, Car loan, Money lent" value="${escapeHTML(o.name || '')}"></div><div class="form-row"><div class="form-field"><label for="plan-direction">Direction</label><select id="plan-direction" name="direction"><option value="payable" ${o.direction !== 'receivable' ? 'selected' : ''}>I owe / payable</option><option value="receivable" ${o.direction === 'receivable' ? 'selected' : ''}>Owed to me / receivable</option></select></div><div class="form-field"><label for="plan-counterparty">Person / provider</label><input id="plan-counterparty" name="counterparty" value="${escapeHTML(o.counterparty || '')}" placeholder="Optional"></div></div><div class="form-row"><div class="form-field"><label for="plan-remaining">Remaining amount (PHP)</label><input id="plan-remaining" name="remaining" type="number" min="0" step="0.01" required value="${Number(o.remaining || '')}"></div><div class="form-field"><label for="plan-monthly">Monthly amount (PHP)</label><input id="plan-monthly" name="monthlyAmount" type="number" min="0" step="0.01" value="${Number(o.monthlyAmount || '')}"></div></div><div class="form-row"><div class="form-field"><label for="plan-due">Next due date</label><input id="plan-due" name="dueDate" type="date" value="${escapeHTML(o.dueDate || '')}"></div><div class="form-field"><label for="plan-account">Payment / collection account</label><select id="plan-account" name="accountId">${accountSelectOptions(o.accountId || state.accounts.find(a => a.kind !== 'credit')?.id || '', { includeCredit: false })}</select></div></div><div class="form-field"><label for="plan-card">Credit card (if applicable)</label><select id="plan-card" name="cardAccountId"><option value="">Not linked to a card</option>${state.accounts.filter(a => a.kind === 'credit').map(a => `<option value="${escapeHTML(a.id)}" ${a.id === o.cardAccountId ? 'selected' : ''}>${escapeHTML(a.name)}</option>`).join('')}</select></div><label class="form-check"><input type="checkbox" name="includedInCardDebt" ${o.includedInCardDebt ? 'checked' : ''}> This installment is already included in the credit-card outstanding balance (do not deduct it twice from safe-to-spend).</label><div class="form-field"><label for="plan-note">Notes</label><textarea id="plan-note" name="note">${escapeHTML(o.note || '')}</textarea></div><div class="modal-actions"><button class="button" type="button" data-action="close-modal">Cancel</button>${existing ? `<button class="button button-danger" type="button" data-action="delete-plan" data-id="${escapeHTML(o.id)}">Delete</button>` : ''}<button class="button button-primary" type="submit">Save commitment</button></div></form>`;
    openModal(existing ? 'Edit commitment' : 'Add commitment', 'Track remaining amounts and upcoming installment dates.', body, true);
  }
  function recordPlanPayment(id) {
    const plan = state.obligations.find(o => o.id === id);
    if (!plan || plan.remaining <= 0) return;
    const amountDue = Math.min(plan.remaining, plan.monthlyAmount > 0 ? plan.monthlyAmount : plan.remaining);
    const isPayable = plan.direction === 'payable';
    const accountId = plan.accountId || state.accounts.find(a => a.kind !== 'credit')?.id || '';
    const creditId = plan.cardAccountId || '';
    if (!getAccount(accountId)) { showToast('Choose a valid payment or collection account in the commitment first.'); openPlanModal(plan); return; }
    if (isPayable && plan.includedInCardDebt && (!creditId || !getAccount(creditId))) { showToast('Choose the linked credit-card account first.'); openPlanModal(plan); return; }
    let tx;
    if (isPayable && plan.includedInCardDebt) {
      tx = { id: makeId(), date: todayISO(), type: 'transfer', category: '', accountId, toAccountId: creditId, amount: amountDue, description: `Card installment: ${plan.name}`, note: plan.note || '', createdAt: new Date().toISOString(), review: false };
    } else if (isPayable) {
      tx = { id: makeId(), date: todayISO(), type: 'expense', category: 'Debt & Loans', accountId, toAccountId: '', amount: amountDue, description: `Installment: ${plan.name}`, note: plan.note || '', createdAt: new Date().toISOString(), review: false };
    } else {
      tx = { id: makeId(), date: todayISO(), type: 'collect_plan', category: '', accountId, toAccountId: '', amount: amountDue, description: `Collection: ${plan.name}`, note: plan.note || '', createdAt: new Date().toISOString(), review: false };
    }
    state.transactions.push(tx);
    plan.remaining = Math.max(0, Number((plan.remaining - amountDue).toFixed(2)));
    if (plan.remaining > 0 && plan.dueDate) plan.dueDate = addMonths(plan.dueDate, 1);
    closeModal();
    persist({ silent: true });
    showToast(`${isPayable ? 'Payment' : 'Collection'} recorded: ${peso(amountDue)}`);
  }
  function handleFormSubmit(event) {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    const kind = form.dataset.form;
    if (kind === 'transaction') return addTransactionFromForm(form);
    const fd = new FormData(form);
    if (kind === 'account') {
      const name = String(fd.get('name') || '').trim();
      const editId = form.dataset.editId;
      const duplicate = state.accounts.find(a => a.name.toLowerCase() === name.toLowerCase() && a.id !== editId);
      if (!name || duplicate) { showToast(duplicate ? 'An account with that name already exists.' : 'Enter an account name.'); return; }
      const item = { id: editId || makeId(), name, kind: String(fd.get('kind')), openingBalance: Number(fd.get('openingBalance') || 0) };
      if (editId) state.accounts = state.accounts.map(a => a.id === editId ? item : a); else state.accounts.push(item);
      closeModal(); persist({ silent: true }); showToast('Account saved'); return;
    }
    if (kind === 'budgets') {
      state.categories.forEach(c => { state.budgets[c] = Math.max(0, Number(fd.get(`budget:${c}`) || 0)); });
      closeModal(); persist({ silent: true }); showToast('Budgets updated'); return;
    }
    if (kind === 'plan') {
      const name = String(fd.get('name') || '').trim();
      const editId = form.dataset.editId;
      const item = { id: editId || makeId(), name, direction: String(fd.get('direction')), counterparty: String(fd.get('counterparty') || '').trim(), remaining: Math.max(0, Number(fd.get('remaining') || 0)), monthlyAmount: Math.max(0, Number(fd.get('monthlyAmount') || 0)), dueDate: String(fd.get('dueDate') || ''), accountId: String(fd.get('accountId') || ''), cardAccountId: String(fd.get('cardAccountId') || ''), includedInCardDebt: fd.get('includedInCardDebt') === 'on', note: String(fd.get('note') || '').trim() };
      if (!name) { showToast('Enter a commitment name.'); return; }
      if (editId) state.obligations = state.obligations.map(o => o.id === editId ? item : o); else state.obligations.push(item);
      closeModal(); persist({ silent: true }); showToast('Commitment saved'); return;
    }
    if (kind === 'buffer') {
      state.settings.buffer = Math.max(0, Number(fd.get('buffer') || 0));
      persist({ silent: true }); showToast('Safety buffer saved'); return;
    }
    if (kind === 'cloud-config') {
      state.settings.supabaseUrl = String(fd.get('url') || '').trim().replace(/\/$/, '');
      state.settings.supabaseKey = String(fd.get('key') || '').trim();
      persist({ silent: true, sync: false }); showToast('Cloud project settings saved');
    }
  }
  function downloadFile(name, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportJSON() {
    downloadFile(`pocket-ledger-backup-${todayISO()}.json`, JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2), 'application/json');
    showToast('Backup downloaded');
  }
  function exportCSV() {
    const rows = [['Date','Type','Category','Description','Account','Destination account','Amount PHP','Notes','Needs review']];
    sortedTransactions().forEach(t => rows.push([t.date, TYPE_LABELS[t.type] || t.type, t.category || '', t.description || '', getAccount(t.accountId)?.name || '', getAccount(t.toAccountId)?.name || '', t.amount, t.note || '', t.review ? 'Yes' : 'No']));
    const csv = rows.map(row => row.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    downloadFile(`pocket-ledger-transactions-${todayISO()}.csv`, '\ufeff' + csv, 'text/csv;charset=utf-8');
    showToast('CSV exported');
  }
  function openImportJSON() { $('#json-file')?.click(); }
  async function importJSONFile(file) {
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.transactions)) throw new Error('This file does not look like a Pocket Ledger backup.');
      if (!confirm(`Restore backup with ${parsed.transactions.length} transactions and ${parsed.accounts.length} accounts? This replaces the data currently on this device.`)) return;
      state = normalizeState(parsed);
      await persist({ silent: true });
      showToast('Backup restored');
    } catch (err) { showToast(err.message || 'Could not read this backup.'); }
    finally { $('#json-file').value = ''; }
  }
  function excelDate(value) {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? todayISO() : d.toISOString().slice(0, 10);
  }
  function accountTypeFromName(name) {
    const n = String(name || '').toLowerCase();
    if (n.includes('credit card') || n.includes('credit-card')) return 'credit';
    if (n === 'cash' || n.includes('wallet')) return 'cash';
    if (n.includes('maya') || n.includes('gcash')) return 'ewallet';
    if (['bdo', 'unionbank', 'pag-ibig', 'bpi', 'bank'].some(x => n.includes(x))) return 'bank';
    return 'other';
  }
  function findOrCreateAccount(name) {
    const clean = String(name || 'Other').trim() || 'Other';
    let account = state.accounts.find(a => a.name.toLowerCase() === clean.toLowerCase());
    if (!account) { account = { id: makeId(), name: clean, kind: accountTypeFromName(clean), openingBalance: 0 }; state.accounts.push(account); }
    return account;
  }
  async function loadXlsxLibrary() {
    if (window.XLSX) return true;
    if (window.__pocketLedgerXlsxPromise) return window.__pocketLedgerXlsxPromise;
    window.__pocketLedgerXlsxPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      script.onload = () => resolve(!!window.XLSX);
      script.onerror = () => reject(new Error('Excel import needs an internet connection to load its parser.'));
      document.head.appendChild(script);
    });
    return window.__pocketLedgerXlsxPromise;
  }
  async function importWorkbook(file) {
    try {
      await loadXlsxLibrary();
      if (!window.XLSX) throw new Error('The Excel import library could not be loaded.');
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
      const txSheet = wb.Sheets['Transactions'];
      if (!txSheet) throw new Error('The workbook does not contain a Transactions sheet.');
      const rows = XLSX.utils.sheet_to_json(txSheet, { header: 1, raw: true, defval: '' });
      const imported = [];
      for (let i = 3; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r[0] || !r[1] || !Number(r[7])) continue;
        const sourceType = String(r[1]).trim().toLowerCase();
        const typeMap = { income: 'income', expense: 'expense', transfer: 'transfer' };
        const type = typeMap[sourceType] || 'expense';
        let accountName = String(r[5] || 'Cash').trim();
        if (String(r[6] || '').toLowerCase().includes('credit card') && !accountName.toLowerCase().includes('credit card')) {
          const card = String(r[9] || 'Other').trim();
          accountName = `Credit Card - ${card}`;
        }
        const account = findOrCreateAccount(accountName);
        const originalNote = String(r[11] || '').trim();
        const missingTransferDestination = type === 'transfer' && !r[12];
        const review = /review|confirm|unlabelled|unclassified|change type|provision/i.test(`${originalNote} ${String(r[4] || '')}`) || missingTransferDestination;
        const notes = [originalNote, missingTransferDestination ? 'Transfer destination was not present in the source workbook; review this transaction.' : ''].filter(Boolean).join(' ');
        imported.push({ id: makeId(), date: excelDate(r[0]), type, category: String(r[2] || ''), accountId: account.id, toAccountId: '', amount: Math.abs(Number(r[7])), description: String(r[4] || ''), note: notes, createdAt: new Date().toISOString(), review });
      }
      let importedBudgets = 0;
      const budgetSheet = wb.Sheets['Budgets'];
      if (budgetSheet) {
        const br = XLSX.utils.sheet_to_json(budgetSheet, { header: 1, raw: true, defval: '' });
        for (let i = 3; i < br.length; i++) {
          const name = String(br[i]?.[0] || '').trim();
          if (name && br[i][1] !== '') { if (!state.categories.includes(name)) state.categories.push(name); state.budgets[name] = Number(br[i][1]) || 0; importedBudgets++; }
        }
      }
      const listSheet = wb.Sheets['Lists & Setup'];
      if (listSheet) {
        const lr = XLSX.utils.sheet_to_json(listSheet, { header: 1, raw: true, defval: '' });
        for (let i = 3; i < lr.length; i++) if (lr[i]?.[3]) findOrCreateAccount(String(lr[i][3]));
      }
      const existingCount = state.transactions.length;
      if (!imported.length) throw new Error('No transaction rows were found under the Transactions headers.');
      const replace = confirm(`Found ${imported.length} transactions and ${importedBudgets} budget categories.\n\nOK = replace the current transaction history with these imported rows.\nCancel = add them to the current history.`);
      if (replace) state.transactions = imported; else state.transactions.push(...imported);
      state.settings.migrationNote = 'Imported from Personal_Finance_Budget_Tracker.xlsm. Opening balance is intentionally not allocated; set each account opening balance manually.';
      await persist({ silent: true });
      showToast(`${imported.length} transactions imported${existingCount ? ' (history updated)' : ''}`);
      setView('activity');
    } catch (err) { showToast(err.message || 'Could not import the workbook.'); }
    finally { $('#excel-file').value = ''; }
  }
  async function cloudFetch(path, options = {}) {
    const cloud = getCloud();
    const url = String(state.settings.supabaseUrl || '').replace(/\/$/, '');
    const key = state.settings.supabaseKey || '';
    if (!url || !key) throw new Error('Save your Supabase project URL and anon key first.');
    const token = options.noAuth ? key : (cloud.accessToken || key);
    const response = await fetch(`${url}${path}`, { ...options, headers: { apikey: key, Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
    const textBody = await response.text();
    let data = null;
    try { data = textBody ? JSON.parse(textBody) : null; } catch (_) { data = textBody; }
    if (!response.ok) throw new Error(data?.message || data?.msg || data?.error_description || data?.details || `Cloud request failed (${response.status}).`);
    return data;
  }
  async function cloudAuth(mode) {
    const email = ($('#cloud-email')?.value || '').trim();
    const password = $('#cloud-password')?.value || '';
    const url = String(state.settings.supabaseUrl || $('#supabase-url')?.value || '').trim().replace(/\/$/, '');
    const key = String(state.settings.supabaseKey || $('#supabase-key')?.value || '').trim();
    if (!url || !key) { showToast('Enter and save your Supabase URL and anon key first.'); return; }
    if (!email || !password) { showToast('Enter your email and password.'); return; }
    state.settings.supabaseUrl = url; state.settings.supabaseKey = key;
    await persist({ silent: true, sync: false });
    const endpoint = mode === 'signup' ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password';
    try {
      const result = await cloudFetch(endpoint, { method: 'POST', noAuth: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      if (!result?.access_token) {
        showToast(mode === 'signup' ? 'Account created. Check your email to confirm, then sign in.' : 'Cloud account response did not include a session.');
        return;
      }
      saveCloud({ accessToken: result.access_token, refreshToken: result.refresh_token, userId: result.user?.id, email: result.user?.email || email, expiresAt: Date.now() + (result.expires_in || 3600) * 1000 });
      render();
      await syncCloud();
      showToast('Signed in and synced');
    } catch (err) { showToast(err.message || 'Could not connect to Supabase.'); }
  }
  async function refreshCloudToken() {
    const cloud = getCloud();
    if (!cloud.refreshToken) return false;
    try {
      const result = await cloudFetch('/auth/v1/token?grant_type=refresh_token', { method: 'POST', noAuth: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: cloud.refreshToken }) });
      if (!result?.access_token) return false;
      saveCloud({ ...cloud, accessToken: result.access_token, refreshToken: result.refresh_token, userId: result.user?.id || cloud.userId, expiresAt: Date.now() + (result.expires_in || 3600) * 1000 });
      return true;
    } catch (_) { return false; }
  }
  async function ensureCloudToken() {
    const cloud = getCloud();
    if (!cloud.accessToken) return false;
    if (cloud.expiresAt && Date.now() > cloud.expiresAt - 60000) return refreshCloudToken();
    return true;
  }
  async function syncCloud() {
    if (cloudBusy) return;
    const cloud = getCloud();
    if (!cloud.userId || !cloud.accessToken) { showToast('Sign in to your cloud account first.'); return; }
    cloudBusy = true;
    try {
      if (!(await ensureCloudToken())) throw new Error('Your cloud session expired. Sign in again.');
      const userId = getCloud().userId;
      const rows = await cloudFetch(`/rest/v1/finance_snapshots?select=payload,updated_at&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
      if (Array.isArray(rows) && rows.length && rows[0].payload) {
        const remote = normalizeState(rows[0].payload);
        const remoteTime = new Date(remote.updatedAt || rows[0].updated_at || 0).getTime();
        const localTime = new Date(state.updatedAt || 0).getTime();
        if (remoteTime > localTime) {
          if (confirm('A newer copy exists in your cloud account. Replace this device with the cloud copy?')) {
            state = remote;
            await persist({ silent: true, sync: false });
          } else {
            showToast('Cloud copy left unchanged.');
            return;
          }
        } else {
          await pushCloudSnapshot(userId);
        }
      } else {
        await pushCloudSnapshot(userId);
      }
      render();
    } catch (err) { showToast(err.message || 'Cloud sync failed.'); }
    finally { cloudBusy = false; }
  }
  async function pushCloudSnapshot(userId) {
    const cloud = getCloud();
    const url = String(state.settings.supabaseUrl || '').replace(/\/$/, '');
    const key = state.settings.supabaseKey || '';
    const response = await fetch(`${url}/rest/v1/finance_snapshots?on_conflict=user_id`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${cloud.accessToken}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: userId, payload: state, updated_at: new Date().toISOString() })
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(body || `Cloud save failed (${response.status}).`);
    }
  }
  function scheduleCloudSync() {
    const cloud = getCloud();
    if (!cloud.userId || !cloud.accessToken || !state.settings.supabaseUrl || !state.settings.supabaseKey) return;
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(async () => {
      if (cloudBusy) return;
      try { await ensureCloudToken(); await pushCloudSnapshot(getCloud().userId); }
      catch (err) { console.warn('Pocket Ledger background sync:', err.message); }
    }, 1800);
  }
  async function cloudLogout() {
    const cloud = getCloud();
    try { if (cloud.accessToken) await cloudFetch('/auth/v1/logout', { method: 'POST' }); } catch (_) { /* local sign-out should still proceed */ }
    localStorage.removeItem(CLOUD_KEY);
    render(); showToast('Signed out. Local records remain on this device.');
  }
  function handleClick(event) {
    const button = event.target.closest('[data-action], [data-view]');
    if (!button) return;
    const action = button.dataset.action;
    const view = button.dataset.view;
    if (view) { event.preventDefault(); if ($('#modal-root').innerHTML) closeModal(); setView(view); return; }
    if (!action) return;
    if (action === 'open-add') return openTransactionModal('expense');
    if (action === 'dismiss-migration-note') { delete state.settings.migrationNote; persist({ silent: true }); return; }
    if (action === 'open-more') return openModal('More', 'Manage the rest of your ledger.', `<div class="grid" style="gap:9px"><button class="button" data-view="accounts">▤ &nbsp; Accounts</button><button class="button" data-view="plans">◷ &nbsp; Installments & loans</button><button class="button" data-view="settings">⚙ &nbsp; Settings & sync</button></div>`);
    if (action === 'close-modal') return closeModal();
    if (action === 'backdrop-close') { if (event.target.classList.contains('modal-backdrop')) closeModal(); return; }
    if (action === 'add-account') return openAccountModal();
    if (action === 'edit-account') return openAccountModal(getAccount(button.dataset.id));
    if (action === 'account-history') { const account = getAccount(button.dataset.id); activitySearch = account?.name || ''; activityMonth = ''; setView('activity'); return; }
    if (action === 'edit-budgets') return openBudgetModal();
    if (action === 'add-plan') return openPlanModal();
    if (action === 'edit-plan') return openPlanModal(state.obligations.find(o => o.id === button.dataset.id));
    if (action === 'pay-plan') return recordPlanPayment(button.dataset.id);
    if (action === 'edit-transaction') return openTransactionModal('expense', state.transactions.find(t => t.id === button.dataset.id));
    if (action === 'delete-transaction') {
      if (confirm('Delete this transaction? This will change account balances and budget totals.')) {
        state.transactions = state.transactions.filter(t => t.id !== button.dataset.id); closeModal(); persist({ silent: true }); showToast('Transaction deleted');
      } return;
    }
    if (action === 'delete-account') {
      const id = button.dataset.id;
      if (state.transactions.some(t => t.accountId === id || t.toAccountId === id)) { showToast('This account has transactions. Edit its name or keep it to preserve your history.'); return; }
      if (confirm('Delete this account?')) { state.accounts = state.accounts.filter(a => a.id !== id); closeModal(); persist({ silent: true }); }
      return;
    }
    if (action === 'delete-plan') {
      if (confirm('Delete this commitment?')) { state.obligations = state.obligations.filter(o => o.id !== button.dataset.id); closeModal(); persist({ silent: true }); }
      return;
    }
    if (action === 'export-json') return exportJSON();
    if (action === 'export-csv') return exportCSV();
    if (action === 'import-json') return openImportJSON();
    if (action === 'save-cloud-config') {
      const form = $('form[data-form="cloud-config"]'); if (form) { const fd = new FormData(form); state.settings.supabaseUrl = String(fd.get('url') || '').trim().replace(/\/$/, ''); state.settings.supabaseKey = String(fd.get('key') || '').trim(); persist({ silent: true, sync: false }); showToast('Cloud project settings saved'); } return;
    }
    if (action === 'cloud-signup') return cloudAuth('signup');
    if (action === 'cloud-login') return cloudAuth('login');
    if (action === 'cloud-sync') return syncCloud();
    if (action === 'cloud-logout') return cloudLogout();
  }
  function handleChange(event) {
    const target = event.target;
    if (target.id === 'txn-type') return updateTransactionFields();
    if (target.id === 'txn-account') {
      const to = $('#txn-to');
      if (to && to.value === target.value) { const opt = Array.from(to.options).find(o => o.value !== target.value); if (opt) to.value = opt.value; }
      return;
    }
    if (target.id === 'activity-month') { activityMonth = target.value; render(); return; }
    if (target.id === 'json-file' && target.files?.[0]) return importJSONFile(target.files[0]);
    if (target.id === 'excel-file' && target.files?.[0]) return importWorkbook(target.files[0]);
  }
  function handleInput(event) {
    if (event.target.id === 'activity-search') {
      const pos = event.target.selectionStart;
      activitySearch = event.target.value;
      const tbody = $('.data-table tbody');
      if (tbody) {
        const txs = sortedTransactions().filter(t => (!activityMonth || String(t.date || '').slice(0, 7) === activityMonth) && [t.description, t.category, t.note, TYPE_LABELS[t.type], getAccount(t.accountId)?.name, getAccount(t.toAccountId)?.name].join(' ').toLowerCase().includes(activitySearch.toLowerCase()));
        tbody.innerHTML = txs.length ? txs.map(t => {
          const acct = getAccount(t.accountId), dest = getAccount(t.toAccountId);
          const sign = ['income', 'borrowed', 'collect', 'collect_plan'].includes(t.type) ? '+' : ['expense', 'lent', 'repay'].includes(t.type) ? '−' : '';
          return `<tr><td>${dateLabel(t.date, { month: 'short', day: 'numeric', year: 'numeric' })}</td><td><div class="table-primary">${escapeHTML(t.description || t.category || TYPE_LABELS[t.type])}</div><div class="table-secondary">${escapeHTML(t.category || '')}${t.note ? ` · ${escapeHTML(t.note)}` : ''}${t.review ? '<div class="review-flag">Needs review</div>' : ''}</div></td><td><span class="type-tag ${escapeHTML(t.type)}">${escapeHTML(TYPE_LABELS[t.type] || t.type)}</span></td><td>${escapeHTML(acct?.name || '—')}${dest ? `<div class="table-secondary">to ${escapeHTML(dest.name)}</div>` : ''}</td><td class="table-primary">${sign}${peso(t.amount)}</td><td><button class="button button-quiet" data-action="edit-transaction" data-id="${escapeHTML(t.id)}">Edit</button></td></tr>`;
        }).join('') : `<tr><td colspan="6"><div class="empty-state"><strong>No matching transactions</strong><p>Try a different search.</p></div></td></tr>`;
      }
    }
  }
  function handleSubmit(event) { handleFormSubmit(event); }
  function registerPWA() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('./sw.js').catch(err => console.warn('Service worker registration failed:', err));
    }
  }
  async function init() {
    state = await loadSavedState();
    render();
    document.addEventListener('click', handleClick);
    document.addEventListener('change', handleChange);
    document.addEventListener('input', handleInput);
    document.addEventListener('submit', handleSubmit);
    registerPWA();
    const params = new URLSearchParams(location.search);
    const quick = params.get('quick');
    if (quick && ['expense', 'income', 'transfer', 'lent', 'borrowed', 'collect', 'repay'].includes(quick)) {
      const amount = params.get('amount') || '';
      const description = params.get('note') || params.get('description') || '';
      setTimeout(() => openTransactionModal(quick, null, { amount, description }), 250);
      history.replaceState({}, '', `${location.pathname}${location.hash || '#dashboard'}`);
    }
  }
  init().catch(err => { console.error(err); showToast('The app could not load your saved data.'); });
})();
