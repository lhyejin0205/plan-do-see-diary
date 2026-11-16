(() => {
  'use strict';

  const TZ = 'Asia/Seoul';
  const SCHEMA = 'pds-schema-v2';
  const cfg = window.PDS_CONFIG || {};
  const $ = (sel) => document.querySelector(sel);

  let db = null;
  const today0 = todaySeoul();
  const state = {
    date: today0,            // 선택한 날
    month: today0.slice(0, 7), // 달력에 보이는 달 'YYYY-MM'
    plans: [], dos: [], see: null,
    marks: {},               // { 'YYYY-MM-DD': { plan, do, see } }
    busy: false,
  };

  // ───────── 날짜 도우미 (모든 날짜는 Asia/Seoul 달력 날짜 'YYYY-MM-DD') ─────────
  function todaySeoul() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }
  function isIsoDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  function shiftMonth(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
  }
  function daysInMonth(ym) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  function fmtDay(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const wd = '일월화수목금토'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    return `${y}년 ${m}월 ${d}일 ${wd}요일`;
  }
  function fmtTime(ts) {
    if (!ts) return '';
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(ts));
  }

  // ───────── 일반 도우미 ─────────
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function toNum(v) {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  function fmtNum(n) {
    return n == null ? '' : Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 2 });
  }
  function clean(v) {
    const t = String(v ?? '').trim();
    return t === '' ? null : t;
  }

  function setStatus(text, kind) {
    const el = $('#status');
    el.textContent = text;
    el.dataset.kind = kind || '';
  }
  function showError(msg) {
    $('#error-text').textContent = msg;
    $('#error').hidden = false;
  }
  function clearError() { $('#error').hidden = true; }

  function explain(err) {
    const msg = (err && (err.message || String(err))) || '알 수 없는 오류';
    if (/does not exist|Could not find the table|schema cache/i.test(msg)) {
      return `Supabase에 표가 없습니다. supabase/schema.sql을 SQL Editor에서 실행했는지 확인하세요. (${msg})`;
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      return '서버에 연결하지 못했습니다. 인터넷 연결과 config.js의 Project URL을 확인하세요.';
    }
    if (/row-level security|permission denied/i.test(msg)) {
      return `권한 때문에 거절됐습니다. schema.sql의 권한 부분까지 실행됐는지 확인하세요. (${msg})`;
    }
    if (/Invalid API key|JWT/i.test(msg)) {
      return 'API 키가 맞지 않습니다. config.js의 공개용 키를 다시 복사해 넣으세요.';
    }
    if (/must not be earlier than plan_date/i.test(msg)) {
      return '실제로 한 날짜가 계획한 날보다 앞설 수 없습니다.';
    }
    return msg;
  }

  async function check(res) {
    const r = await res;
    if (r.error) throw r.error;
    return r.data;
  }

  // ───────── 서버 읽기 ─────────
  async function loadDay() {
    const [plans, see] = await Promise.all([
      check(db.from('pds_plans').select('*').eq('plan_date', state.date).order('created_at', { ascending: true })),
      check(db.from('pds_sees').select('*').eq('see_date', state.date).maybeSingle()),
    ]);
    const ids = plans.map((x) => x.id);
    const dos = ids.length
      ? await check(db.from('pds_dos').select('*').in('plan_id', ids).order('created_at', { ascending: true }))
      : [];
    return { plans, dos, see };
  }

  // 달력 점: 그 달에 계획·실행 기록·돌아보기가 있는 날
  async function loadMonth() {
    const from = `${state.month}-01`;
    const to = `${state.month}-${String(daysInMonth(state.month)).padStart(2, '0')}`;
    const [plans, sees] = await Promise.all([
      check(db.from('pds_plans').select('id, plan_date').gte('plan_date', from).lte('plan_date', to)),
      check(db.from('pds_sees').select('see_date').gte('see_date', from).lte('see_date', to)),
    ]);
    const ids = plans.map((p) => p.id);
    const dos = ids.length ? await check(db.from('pds_dos').select('plan_id').in('plan_id', ids)) : [];
    const done = new Set(dos.map((d) => d.plan_id));
    const marks = {};
    const mark = (date) => (marks[date] = marks[date] || { plan: false, do: false, see: false });
    for (const p of plans) { const m = mark(p.plan_date); m.plan = true; if (done.has(p.id)) m.do = true; }
    for (const s of sees) mark(s.see_date).see = true;
    return marks;
  }

  async function load() {
    setStatus('불러오는 중…', 'busy');
    const [day, marks] = await Promise.all([loadDay(), loadMonth()]);
    Object.assign(state, day, { marks });
    render();
    clearError();
    setStatus('서버에 저장된 내용', 'ok');
  }

  async function run(label, fn) {
    if (state.busy) return false;
    state.busy = true;
    setStatus(`${label}…`, 'busy');
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      console.error(e);
      setStatus('저장 실패', 'error');
      showError(explain(e));
      return false;
    } finally {
      state.busy = false;
    }
  }

  // ───────── 화면 그리기 ─────────
  function planStats(p) {
    const ds = state.dos.filter((d) => d.plan_id === p.id);
    const hasValue = ds.some((d) => d.actual_value != null);
    const total = ds.reduce((a, d) => a + (d.actual_value == null ? 0 : Number(d.actual_value)), 0);
    const target = p.target_value == null ? null : Number(p.target_value);
    const pct = target && target > 0 && hasValue ? Math.round((total / target) * 100) : null;
    return { ds, total, target, pct };
  }

  function planCard(p) {
    const { ds, total, target, pct } = planStats(p);
    const unit = esc(p.unit || '');

    const meta = (p.metric || target != null)
      ? `<p class="meta">${esc(p.metric || '목표')}${target != null ? ` · 목표 ${fmtNum(target)} ${unit}` : ''}</p>`
      : '';

    const progress = pct != null
      ? `<div class="bar" aria-hidden="true"><span style="width:${Math.min(pct, 100)}%"></span></div>
         <p class="pct">실제 ${fmtNum(total)} ${unit} / 목표 ${fmtNum(target)} ${unit} · <b>${pct}%</b></p>`
      : (ds.length ? '' : '<p class="pct">아직 실행 기록이 없습니다.</p>');

    const doItems = ds.map((d) => `
      <li>
        <span class="do-date">${esc(d.done_date.slice(5).replace('-', '/'))}</span>
        ${d.actual_value != null ? `<b>${fmtNum(d.actual_value)} ${unit}</b>` : ''}
        <span class="do-note">${esc(d.note || '')}</span>
        <button type="button" class="link danger" data-action="del-do" data-id="${esc(d.id)}">삭제</button>
      </li>`).join('');

    return `
      <article class="plan-card" data-id="${esc(p.id)}">
        <div class="plan-head">
          <div>
            <h3>${esc(p.title)}</h3>
            ${meta}
          </div>
          <button type="button" class="link danger" data-action="del-plan" data-id="${esc(p.id)}">계획 삭제</button>
        </div>
        ${progress}
        ${ds.length ? `<ul class="dos" aria-label="실행 기록">${doItems}</ul>` : ''}
        <form class="do-form" data-plan="${esc(p.id)}" autocomplete="off">
          <span class="tag do">Do</span>
          <label>실제로 한 양
            <input name="actual_value" type="number" min="0" step="any" inputmode="decimal" placeholder="${unit || '숫자'}">
          </label>
          <label class="grow">무엇을 했나요
            <input name="note" maxlength="500" placeholder="실제로 한 일">
          </label>
          <label>한 날짜
            <input name="done_date" type="date" value="${esc(state.date)}" min="${esc(p.plan_date)}">
          </label>
          <button type="submit" class="primary">Do 기록</button>
        </form>
      </article>`;
  }

  function renderCalendar() {
    const [y, m] = state.month.split('-').map(Number);
    $('#cal-title').textContent = `${y}년 ${m}월`;
    const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const total = daysInMonth(state.month);
    const today = todaySeoul();
    let html = '';
    for (let i = 0; i < lead; i++) html += '<span class="day blank" aria-hidden="true"></span>';
    for (let d = 1; d <= total; d++) {
      const iso = `${state.month}-${String(d).padStart(2, '0')}`;
      const mk = state.marks[iso] || {};
      const has = [mk.plan && '계획', mk.do && '실행 기록', mk.see && '돌아보기'].filter(Boolean);
      const cls = ['day', iso === state.date && 'selected', iso === today && 'today'].filter(Boolean).join(' ');
      const label = `${m}월 ${d}일${iso === today ? ', 오늘' : ''}${has.length ? ', ' + has.join('·') + ' 있음' : ''}`;
      html += `<button type="button" class="${cls}" data-date="${iso}" aria-pressed="${iso === state.date}" aria-label="${label}">
        <span class="num">${d}</span>
        <span class="dots">${mk.plan ? '<i class="dot plan"></i>' : ''}${mk.do ? '<i class="dot do"></i>' : ''}${mk.see ? '<i class="dot see"></i>' : ''}</span>
      </button>`;
    }
    $('#cal-grid').innerHTML = html;

    // 사이드바: 보이는 달에 계획을 적은 날 수
    const planDays = Object.values(state.marks).filter((x) => x.plan).length;
    $('#streak-over').textContent = `${y}년 ${m}월`;
    $('#streak-title').textContent = planDays ? `${planDays}일 계획을 세웠어요` : '아직 계획이 없어요';
    $('#streak-bar').style.width = `${Math.round((planDays / total) * 100)}%`;
    const seeDays = Object.values(state.marks).filter((x) => x.see).length;
    $('#streak-caption').textContent = `${total}일 중 ${planDays}일 · 돌아보기 ${seeDays}일`;
  }

  function renderSummary() {
    const n = state.plans.length;
    const stats = state.plans.map(planStats);
    const done = stats.filter((s) => s.ds.length).length;
    const pcts = stats.map((s) => s.pct).filter((p) => p != null);
    const avg = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;
    $('#sum-plans').textContent = `${n}개`;
    $('#sum-done').textContent = `${done}개`;
    $('#sum-rate').textContent = avg == null ? '–' : `${avg}%`;
    let text;
    if (!n) text = '이 날에는 아직 계획이 없어요. 계획을 하나 적으면 여기에 요약이 나타나요.';
    else if (!done) text = `계획 ${n}개를 세웠고, 아직 실행 기록은 없어요.`;
    else if (avg == null) text = `계획 ${n}개 중 ${done}개에 실행 기록이 있어요. 목표 수치를 적으면 달성률도 계산돼요.`;
    else text = `계획 ${n}개 중 ${done}개를 실행했고, 목표가 있는 계획의 평균 달성률은 ${avg}%예요.`;
    if (n && !state.see) text += ' 돌아보기는 아직 남기지 않았어요.';
    $('#sum-text').textContent = text;
  }

  function render() {
    const isToday = state.date === todaySeoul();
    $('#date-over').textContent = isToday ? '오늘' : '선택한 날';
    $('#date-title').textContent = fmtDay(state.date);
    $('#date-input').value = state.date;

    renderCalendar();

    $('#plan-list').innerHTML = state.plans.length
      ? state.plans.map(planCard).join('')
      : '<p class="empty">이 날의 계획이 아직 없습니다. 위 칸에 실제로 할 일을 하나 적어 보세요.</p>';

    const f = $('#see-form');
    f.went_well.value = state.see?.went_well || '';
    f.to_improve.value = state.see?.to_improve || '';
    f.next_action.value = state.see?.next_action || '';
    const [, mm, dd] = state.date.split('-').map(Number);
    $('#see-over').textContent = `${mm}월 ${dd}일 · 돌아보기`;
    $('#see-saved').textContent = state.see
      ? `저장됨 · ${fmtTime(state.see.updated_at || state.see.created_at)}`
      : '아직 저장 안 됨';

    renderSummary();
  }

  // ───────── 동작 ─────────
  async function addPlan(form) {
    const title = clean(form.title.value);
    const target = toNum(form.target_value.value);
    if (!title) { showError('계획 내용을 적어 주세요.'); form.title.focus(); return; }
    if (Number.isNaN(target) || (target != null && target < 0)) {
      showError('목표는 0 이상의 숫자로 적어 주세요.'); form.target_value.focus(); return;
    }
    const ok = await run('계획 저장 중', () => check(db.from('pds_plans').insert({
      plan_date: state.date,
      title,
      metric: clean(form.metric.value),
      target_value: target,
      unit: clean(form.unit.value),
    })));
    if (ok) { form.reset(); $('#plan-form').title.focus(); }
  }

  async function addDo(form) {
    const planId = form.dataset.plan;
    const plan = state.plans.find((p) => p.id === planId);
    if (!plan) return;
    const actual = toNum(form.actual_value.value);
    const note = clean(form.note.value);
    const doneDate = form.done_date.value;
    if (Number.isNaN(actual) || (actual != null && actual < 0)) {
      showError('실제로 한 양은 0 이상의 숫자로 적어 주세요.'); return;
    }
    if (actual == null && !note) { showError('실제로 한 양이나 한 일 중 하나는 적어 주세요.'); return; }
    if (!isIsoDate(doneDate)) { showError('한 날짜를 골라 주세요.'); return; }
    if (doneDate < plan.plan_date) { showError('실제로 한 날짜가 계획한 날보다 앞설 수 없습니다.'); return; }
    await run('실행 기록 저장 중', () => check(db.from('pds_dos').insert({
      plan_id: planId, done_date: doneDate, actual_value: actual, note,
    })));
  }

  async function saveSee(form) {
    const row = {
      see_date: state.date,
      went_well: clean(form.went_well.value),
      to_improve: clean(form.to_improve.value),
      next_action: clean(form.next_action.value),
    };
    if (!row.went_well && !row.to_improve && !row.next_action) {
      showError('돌아보기 칸 중 하나 이상 적어 주세요.'); return;
    }
    await run('돌아보기 저장 중', () => check(
      db.from('pds_sees').upsert(row, { onConflict: 'see_date' }),
    ));
  }

  async function delPlan(id) {
    const plan = state.plans.find((p) => p.id === id);
    if (!plan) return;
    if (!confirm(`"${plan.title}" 계획과 그 실행 기록을 모두 삭제할까요? 되돌릴 수 없습니다.`)) return;
    await run('삭제 중', () => check(db.from('pds_plans').delete().eq('id', id)));
  }

  async function delDo(id) {
    if (!confirm('이 실행 기록을 삭제할까요? 되돌릴 수 없습니다.')) return;
    await run('삭제 중', () => check(db.from('pds_dos').delete().eq('id', id)));
  }

  async function fetchAll(table) {
    const out = [];
    const size = 1000;
    for (let from = 0; ; from += size) {
      const { data, error } = await db.from(table).select('*')
        .order('created_at', { ascending: true }).range(from, from + size - 1);
      if (error) throw error;
      out.push(...data);
      if (data.length < size) break;
    }
    return out;
  }

  async function exportAll() {
    if (state.busy) return;
    state.busy = true;
    setStatus('내보낼 자료 모으는 중…', 'busy');
    try {
      const [plans, dos, sees] = await Promise.all([
        fetchAll('pds_plans'), fetchAll('pds_dos'), fetchAll('pds_sees'),
      ]);
      const payload = {
        schema: SCHEMA,
        exported_at: new Date().toISOString(),
        timezone: TZ,
        counts: { plans: plans.length, dos: dos.length, sees: sees.length },
        plans, dos, sees,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pds-diary-export-${todaySeoul()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(`내보내기 완료 · 계획 ${plans.length} · 실행 ${dos.length} · 돌아보기 ${sees.length}`, 'ok');
    } catch (e) {
      console.error(e);
      setStatus('내보내기 실패', 'error');
      showError(explain(e));
    } finally {
      state.busy = false;
    }
  }

  function reload() {
    load().catch((e) => { console.error(e); setStatus('불러오기 실패', 'error'); showError(explain(e)); });
  }
  function goTo(date) {
    if (!isIsoDate(date) || state.busy) return;
    state.date = date;
    state.month = date.slice(0, 7);
    reload();
  }
  function goMonth(n) {
    if (state.busy) return;
    state.month = shiftMonth(state.month, n);
    reload();
  }

  // ───────── 연결 ─────────
  function configured() {
    return Boolean(
      window.supabase && cfg.supabaseUrl && cfg.supabaseAnonKey
      && !/YOUR_/.test(cfg.supabaseUrl + cfg.supabaseAnonKey),
    );
  }

  function wire() {
    $('#error-close').addEventListener('click', clearError);
    $('#export-btn').addEventListener('click', exportAll);
    $('#today-btn').addEventListener('click', () => goTo(todaySeoul()));
    $('#date-input').addEventListener('change', (e) => goTo(e.target.value));

    document.querySelector('.cal-controls').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-month]');
      if (btn) goMonth(Number(btn.dataset.month));
    });
    $('#cal-grid').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-date]');
      if (btn) goTo(btn.dataset.date);
    });

    $('#plan-form').addEventListener('submit', (e) => { e.preventDefault(); addPlan(e.target); });
    $('#see-form').addEventListener('submit', (e) => { e.preventDefault(); saveSee(e.target); });

    const list = $('#plan-list');
    list.addEventListener('submit', (e) => {
      if (!e.target.matches('.do-form')) return;
      e.preventDefault();
      addDo(e.target);
    });
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'del-plan') delPlan(btn.dataset.id);
      if (btn.dataset.action === 'del-do') delDo(btn.dataset.id);
    });
  }

  function init() {
    wire();
    if (!configured()) {
      $('#setup').hidden = false;
      $('#export-btn').disabled = true;
      $('#today-btn').disabled = true;
      setStatus('Supabase 연결 필요', 'error');
      return;
    }
    db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    $('#app').hidden = false;
    reload();
  }

  init();
})();
