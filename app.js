// 플랜두씨 다이어리 2 (T07)
// [개발 · 인증] Supabase Auth(이메일+비밀번호)로 로그인한 사람만 자기 기록을 본다.
// [개발 · DB구축] 모든 표는 pds7_* 이고, 서버의 행 수준 보안(RLS)이 owner_id = auth.uid() 인 행만 허용한다.
//   화면에서 숨기는 것은 편의일 뿐이고, 실제 차단은 서버 정책이 한다(supabase/schema-t07.sql).
(() => {
  'use strict';

  const TZ = 'Asia/Seoul';
  const SCHEMA = 'pds-schema-v3';
  const T = {
    plans: 'pds7_plans', dos: 'pds7_dos', sees: 'pds7_sees',
    moods: 'pds7_moods', books: 'pds7_books', rules: 'pds7_rules',
  };
  const cfg = window.PDS_CONFIG || {};
  const $ = (sel) => document.querySelector(sel);

  let db = null;
  let authMode = 'login';
  const today0 = todaySeoul();
  const state = {
    user: null,
    date: today0,
    month: today0.slice(0, 7),
    plans: [], dos: [], see: null,
    marks: {},
    mood: null,
    books: [],
    rules: [],              // 관찰 규칙 전체 버전 (version 오름차순)
    busy: false,
  };

  const MOODS = [
    ['great', '아주 좋음', '<path d="M8 14s1.5 2.5 4 2.5 4-2.5 4-2.5"/>'],
    ['calm', '평온함', '<path d="M8.5 14.5s1.3 1.5 3.5 1.5 3.5-1.5 3.5-1.5"/>'],
    ['okay', '보통', '<path d="M8.5 15h7"/>'],
    ['tired', '피곤함', '<path d="M8.5 16s1.3-1.5 3.5-1.5 3.5 1.5 3.5 1.5"/>'],
    ['sad', '우울함', '<path d="M8 16.5s1.5-2.5 4-2.5 4 2.5 4 2.5"/>'],
  ];
  const moodLabel = (v) => (MOODS.find((m) => m[0] === v) || [])[1] || '';

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
  function fmtShort(iso) {
    const [, m, d] = iso.split('-').map(Number);
    return `${m}/${d}`;
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
      return `Supabase에 T07 표가 없습니다. supabase/schema-t07.sql을 SQL Editor에서 실행했는지 확인하세요. (${msg})`;
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      return '서버에 연결하지 못했습니다. 인터넷 연결과 config.js의 Project URL을 확인하세요.';
    }
    if (/row-level security|permission denied/i.test(msg)) {
      return `서버가 이 요청을 거절했습니다. 로그인이 풀렸다면 다시 로그인하세요. (${msg})`;
    }
    if (/JWT expired|invalid JWT|refresh token/i.test(msg)) {
      return '로그인이 만료됐습니다. 다시 로그인하세요.';
    }
    if (/Invalid API key/i.test(msg)) {
      return 'API 키가 맞지 않습니다. config.js의 공개용 키를 다시 복사해 넣으세요.';
    }
    if (/must not be earlier than plan_date/i.test(msg)) {
      return '실제로 한 날짜가 계획한 날보다 앞설 수 없습니다.';
    }
    if (/pds7_rules_version_unique|duplicate key/i.test(msg)) {
      return '다른 창에서 규칙이 먼저 바뀌었습니다. 새로고침한 뒤 다시 시도하세요.';
    }
    return msg;
  }

  function explainAuth(err) {
    const msg = (err && (err.message || String(err))) || '알 수 없는 오류';
    if (/Invalid login credentials/i.test(msg)) return '이메일 또는 비밀번호가 맞지 않습니다.';
    if (/Email not confirmed/i.test(msg)) return '이메일 확인이 아직 끝나지 않았습니다. 받은 메일의 확인 링크를 누른 뒤 로그인하세요.';
    if (/already registered|already been registered/i.test(msg)) return '이미 가입된 이메일입니다. 로그인 탭에서 로그인하세요.';
    if (/rate limit|too many/i.test(msg)) return '요청이 너무 많습니다. 잠시 뒤에 다시 시도하세요.';
    if (/Password should be|weak/i.test(msg)) return '비밀번호가 너무 약합니다. 8자 이상으로, 쉽게 짐작할 수 없게 정하세요.';
    if (/invalid.*email|email.*invalid/i.test(msg)) return '이메일 주소 형식이 맞지 않습니다.';
    if (/signups not allowed|Signups not allowed/i.test(msg)) return '지금은 회원가입이 꺼져 있습니다.';
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return '서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.';
    return msg;
  }

  async function check(res) {
    const r = await res;
    if (r.error) throw r.error;
    return r.data;
  }
  const uid = () => state.user && state.user.id;

  // ───────── 서버 읽기 (RLS 때문에 내 행만 돌아온다) ─────────
  async function loadDay() {
    const [plans, see, mood] = await Promise.all([
      check(db.from(T.plans).select('*').eq('plan_date', state.date).order('created_at', { ascending: true })),
      check(db.from(T.sees).select('*').eq('see_date', state.date).maybeSingle()),
      check(db.from(T.moods).select('*').eq('mood_date', state.date).maybeSingle()),
    ]);
    const ids = plans.map((x) => x.id);
    const dos = ids.length
      ? await check(db.from(T.dos).select('*').in('plan_id', ids).order('created_at', { ascending: true }))
      : [];
    return { plans, dos, see, mood };
  }

  async function loadMonth() {
    const from = `${state.month}-01`;
    const to = `${state.month}-${String(daysInMonth(state.month)).padStart(2, '0')}`;
    const [plans, sees, moods] = await Promise.all([
      check(db.from(T.plans).select('id, plan_date').gte('plan_date', from).lte('plan_date', to)),
      check(db.from(T.sees).select('see_date').gte('see_date', from).lte('see_date', to)),
      check(db.from(T.moods).select('mood_date, mood').gte('mood_date', from).lte('mood_date', to)),
    ]);
    const ids = plans.map((p) => p.id);
    const dos = ids.length ? await check(db.from(T.dos).select('plan_id').in('plan_id', ids)) : [];
    const done = new Set(dos.map((d) => d.plan_id));
    const marks = {};
    const mark = (date) => (marks[date] = marks[date] || { plan: false, do: false, see: false });
    for (const p of plans) { const m = mark(p.plan_date); m.plan = true; if (done.has(p.id)) m.do = true; }
    for (const s of sees) mark(s.see_date).see = true;
    for (const r of moods) mark(r.mood_date).mood = r.mood;
    return marks;
  }

  async function loadShared() {
    const [books, rules] = await Promise.all([
      check(db.from(T.books).select('*').order('updated_at', { ascending: false }).limit(50)),
      check(db.from(T.rules).select('*').order('version', { ascending: true })),
    ]);
    return { books, rules };
  }

  async function load() {
    if (!state.user) return;
    setStatus('불러오는 중…', 'busy');
    const [day, marks, shared] = await Promise.all([loadDay(), loadMonth(), loadShared()]);
    Object.assign(state, day, shared, { marks });
    render();
    clearError();
    setStatus('서버에 저장된 내 기록', 'ok');
  }

  async function run(label, fn) {
    if (state.busy || !state.user) return false;
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
      const has = [mk.plan && '계획', mk.do && '실행 기록', mk.see && '돌아보기', mk.mood && `기분 ${moodLabel(mk.mood)}`].filter(Boolean);
      const cls = ['day', iso === state.date && 'selected', iso === today && 'today'].filter(Boolean).join(' ');
      const label = `${m}월 ${d}일${iso === today ? ', 오늘' : ''}${has.length ? ', ' + has.join('·') + ' 있음' : ''}`;
      html += `<button type="button" class="${cls}" data-date="${iso}" aria-pressed="${iso === state.date}" aria-label="${label}">
        <span class="num">${d}</span>
        <span class="dots">${mk.plan ? '<i class="dot plan"></i>' : ''}${mk.do ? '<i class="dot do"></i>' : ''}${mk.see ? '<i class="dot see"></i>' : ''}${mk.mood ? `<i class="dot mood m-${esc(mk.mood)}"></i>` : ''}</span>
      </button>`;
    }
    $('#cal-grid').innerHTML = html;

    const planDays = Object.values(state.marks).filter((x) => x.plan).length;
    $('#streak-over').textContent = `${y}년 ${m}월`;
    $('#streak-title').textContent = planDays ? `${planDays}일 계획을 세웠어요` : '아직 계획이 없어요';
    $('#streak-bar').style.width = `${Math.round((planDays / total) * 100)}%`;
    const seeDays = Object.values(state.marks).filter((x) => x.see).length;
    $('#streak-caption').textContent = `${total}일 중 ${planDays}일 · 돌아보기 ${seeDays}일`;
  }

  function currentRule() {
    // 선택한 날에 적용되던 규칙: effective_from <= 선택한 날 인 것 중 가장 최신 버전
    const applicable = state.rules.filter((r) => r.effective_from <= state.date);
    return applicable.length ? applicable[applicable.length - 1] : null;
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
    if (state.mood) text += ` 이 날의 기분은 '${moodLabel(state.mood.mood)}'이에요.`;
    const rule = currentRule();
    if (rule) text += ` 이 날에는 관찰 규칙 v${rule.version}이 적용돼요.`;
    $('#sum-text').textContent = text;
  }

  function renderMood() {
    const cur = state.mood && state.mood.mood;
    $('#mood-options').innerHTML = MOODS.map(([value, label, mouth]) => `
      <button type="button" class="mood-btn${cur === value ? ' selected' : ''}" data-mood="${value}" aria-pressed="${cur === value}">
        <span class="bubble m-${value}">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1" fill="currentColor" stroke="none"/>${mouth}</svg>
        </span>
        <span>${label}</span>
      </button>`).join('');
    $('#mood-saved').textContent = state.mood
      ? `저장됨 · ${fmtTime(state.mood.updated_at || state.mood.created_at)}`
      : '하루 한 번 기록';
  }

  function bookAddForm() {
    return `
      <form class="book-add" data-form="book-add" autocomplete="off">
        <label>책 제목
          <input name="title" required maxlength="200" placeholder="예: 월든">
        </label>
        <div class="pair">
          <label>저자
            <input name="author" maxlength="100" placeholder="예: 헨리 데이비드 소로">
          </label>
          <label>전체 쪽수
            <input name="total_pages" type="number" min="1" step="1" inputmode="numeric" required placeholder="예: 320">
          </label>
        </div>
        <button type="submit" class="primary">책 추가</button>
      </form>`;
  }

  function renderBook() {
    const el = $('#book-body');
    $('#book-pct').textContent = '';
    const cur = state.books.find((b) => b.current_page < b.total_pages);
    const finished = state.books.filter((b) => b.current_page >= b.total_pages).length;
    if (!cur) {
      el.innerHTML = `<p class="empty" style="margin-bottom:12px">${finished ? `다 읽은 책 ${finished}권. ` : ''}지금 읽고 있는 책을 추가해 보세요.</p>${bookAddForm()}`;
      return;
    }
    const pct = Math.round((cur.current_page / cur.total_pages) * 100);
    $('#book-pct').textContent = `${pct}%`;
    el.innerHTML = `
      <div class="book-now">
        <div class="cover" aria-hidden="true"><span>${esc(cur.title.slice(0, 14))}</span><i></i></div>
        <div class="book-info">
          <h3>${esc(cur.title)}</h3>
          <p class="meta">${cur.author ? esc(cur.author) + ' · ' : ''}${fmtNum(cur.current_page)} / ${fmtNum(cur.total_pages)}쪽</p>
          <div class="bar" aria-hidden="true"><span style="width:${pct}%"></span></div>
          ${cur.reflection ? `<p class="book-quote">“${esc(cur.reflection)}”</p>` : ''}
        </div>
      </div>
      <form class="book-save" data-form="book-save" data-id="${esc(cur.id)}" data-total="${cur.total_pages}" autocomplete="off">
        <label>지금까지 읽은 쪽
          <input name="current_page" type="number" min="0" max="${cur.total_pages}" step="1" inputmode="numeric" value="${cur.current_page}">
        </label>
        <label>감상 메모
          <textarea name="reflection" rows="2" maxlength="2000" placeholder="읽으며 든 생각">${esc(cur.reflection || '')}</textarea>
        </label>
        <div class="book-actions">
          <button type="submit" class="primary">독서 기록 저장</button>
          <button type="button" class="link danger" data-action="del-book" data-id="${esc(cur.id)}">책 삭제</button>
        </div>
      </form>
      <details class="book-new">
        <summary>다른 책 시작하기${finished ? ` · 다 읽은 책 ${finished}권` : ''}</summary>
        ${bookAddForm()}
      </details>`;
  }

  function ruleFields(r, firstTime) {
    return `
      <label>관찰 질문
        <input name="question" required maxlength="300" value="${esc(r ? r.question : '')}" placeholder="예: 계획한 공부 시간을 실제로 얼마나 지켰나?">
      </label>
      <div class="pair">
        <label>지표
          <input name="metric" required maxlength="100" value="${esc(r ? r.metric : '')}" placeholder="예: 공부 시간">
        </label>
        <label>단위
          <input name="unit" required maxlength="30" value="${esc(r ? r.unit : '')}" placeholder="예: 분">
        </label>
      </div>
      <label>계산 규칙
        <textarea name="calc_rule" required rows="2" maxlength="500" placeholder="예: 그날 Do 기록의 실제 양 합계 ÷ 계획 목표 × 100">${esc(r ? r.calc_rule : '')}</textarea>
      </label>
      <label>${firstTime ? '적용 시작일' : '바뀐 규칙 적용 시작일'}
        <input name="effective_from" type="date" required value="${esc(firstTime ? state.date : todaySeoul())}"${r ? ` min="${esc(r.effective_from)}"` : ''}>
      </label>`;
  }

  function renderRules() {
    const el = $('#rule-body');
    const latest = state.rules[state.rules.length - 1];
    $('#rule-version').textContent = latest ? `v${latest.version} · ${state.rules.length}개 버전` : '아직 없음';
    if (!latest) {
      el.innerHTML = `
        <p class="sum-text">5일 관찰에 쓸 질문·지표·단위·계산 규칙을 정해 두세요. 한 번 저장한 규칙은 고치지 않고, 바꿀 때는 새 버전으로 남습니다.</p>
        <form class="rule-form" data-form="rule" autocomplete="off">
          ${ruleFields(null, true)}
          <button type="submit" class="primary">관찰 규칙 저장</button>
        </form>`;
      return;
    }
    const history = state.rules.slice().reverse().map((r) => `
      <li>
        <b>v${r.version}</b> · ${esc(fmtShort(r.effective_from))}부터 · ${esc(r.metric)}(${esc(r.unit)})<br>
        ${esc(r.calc_rule)}
        ${r.change_reason ? `<br><b>바꾼 이유</b> ${esc(r.change_reason)}` : ''}
        ${r.learned ? `<br><b>배운 점</b> ${esc(r.learned)}` : ''}
      </li>`).join('');
    el.innerHTML = `
      <dl class="rule-now">
        <dt>질문</dt><dd>${esc(latest.question)}</dd>
        <dt>지표</dt><dd>${esc(latest.metric)} (${esc(latest.unit)})</dd>
        <dt>계산</dt><dd>${esc(latest.calc_rule)}</dd>
        <dt>시작</dt><dd>${esc(fmtDay(latest.effective_from))}</dd>
      </dl>
      ${state.rules.length > 1 ? `<ul class="rule-history" aria-label="규칙 변경 이력">${history}</ul>` : ''}
      <details class="rule-change">
        <summary>규칙 바꾸기 (새 버전 v${latest.version + 1})</summary>
        <form class="rule-form" data-form="rule" autocomplete="off">
          ${ruleFields(latest, false)}
          <label>바꾸는 이유
            <textarea name="change_reason" required rows="2" maxlength="1000" placeholder="이전 규칙으로 기록하며 어떤 문제가 있었나요?"></textarea>
          </label>
          <label>배운 점
            <textarea name="learned" rows="2" maxlength="2000" placeholder="바꾸기 전 기록에서 알게 된 것"></textarea>
          </label>
          <button type="submit" class="primary">새 규칙으로 저장</button>
        </form>
      </details>`;
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

    renderMood();
    renderRules();
    renderBook();
    renderSummary();
  }

  // ───────── 기록 동작 (모든 쓰기에 owner_id = 내 id) ─────────
  async function addPlan(form) {
    const title = clean(form.title.value);
    const target = toNum(form.target_value.value);
    if (!title) { showError('계획 내용을 적어 주세요.'); form.title.focus(); return; }
    if (Number.isNaN(target) || (target != null && target < 0)) {
      showError('목표는 0 이상의 숫자로 적어 주세요.'); form.target_value.focus(); return;
    }
    const ok = await run('계획 저장 중', () => check(db.from(T.plans).insert({
      owner_id: uid(),
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
    await run('실행 기록 저장 중', () => check(db.from(T.dos).insert({
      owner_id: uid(), plan_id: planId, done_date: doneDate, actual_value: actual, note,
    })));
  }

  async function saveSee(form) {
    const row = {
      owner_id: uid(),
      see_date: state.date,
      went_well: clean(form.went_well.value),
      to_improve: clean(form.to_improve.value),
      next_action: clean(form.next_action.value),
    };
    if (!row.went_well && !row.to_improve && !row.next_action) {
      showError('돌아보기 칸 중 하나 이상 적어 주세요.'); return;
    }
    await run('돌아보기 저장 중', () => check(
      db.from(T.sees).upsert(row, { onConflict: 'owner_id,see_date' }),
    ));
  }

  async function delPlan(id) {
    const plan = state.plans.find((p) => p.id === id);
    if (!plan) return;
    if (!confirm(`"${plan.title}" 계획과 그 실행 기록을 모두 삭제할까요? 되돌릴 수 없습니다.`)) return;
    await run('삭제 중', () => check(db.from(T.plans).delete().eq('id', id)));
  }

  async function delDo(id) {
    if (!confirm('이 실행 기록을 삭제할까요? 되돌릴 수 없습니다.')) return;
    await run('삭제 중', () => check(db.from(T.dos).delete().eq('id', id)));
  }

  async function setMood(value) {
    if (!MOODS.some((m) => m[0] === value)) return;
    if (state.mood && state.mood.mood === value) return;
    await run('기분 저장 중', () => check(
      db.from(T.moods).upsert({ owner_id: uid(), mood_date: state.date, mood: value }, { onConflict: 'owner_id,mood_date' }),
    ));
  }

  async function addBook(form) {
    const title = clean(form.title.value);
    const total = toNum(form.total_pages.value);
    if (!title) { showError('책 제목을 적어 주세요.'); form.title.focus(); return; }
    if (total == null || !Number.isInteger(total) || total < 1) {
      showError('전체 쪽수는 1 이상의 정수로 적어 주세요.'); form.total_pages.focus(); return;
    }
    await run('책 추가 중', () => check(db.from(T.books).insert({
      owner_id: uid(), title, author: clean(form.author.value), total_pages: total, current_page: 0,
    })));
  }

  async function saveBook(form) {
    const total = Number(form.dataset.total);
    const page = toNum(form.current_page.value);
    if (page == null || !Number.isInteger(page) || page < 0 || page > total) {
      showError(`읽은 쪽은 0부터 ${total} 사이의 정수로 적어 주세요.`); form.current_page.focus(); return;
    }
    await run('독서 기록 저장 중', () => check(db.from(T.books).update({
      current_page: page, reflection: clean(form.reflection.value),
    }).eq('id', form.dataset.id)));
  }

  async function delBook(id) {
    const book = state.books.find((b) => b.id === id);
    if (!book) return;
    if (!confirm(`"${book.title}" 책과 독서 기록을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    await run('삭제 중', () => check(db.from(T.books).delete().eq('id', id)));
  }

  async function saveRule(form) {
    const latest = state.rules[state.rules.length - 1];
    const row = {
      owner_id: uid(),
      version: latest ? latest.version + 1 : 1,
      effective_from: form.effective_from.value,
      question: clean(form.question.value),
      metric: clean(form.metric.value),
      unit: clean(form.unit.value),
      calc_rule: clean(form.calc_rule.value),
      change_reason: form.change_reason ? clean(form.change_reason.value) : null,
      learned: form.learned ? clean(form.learned.value) : null,
    };
    if (!row.question || !row.metric || !row.unit || !row.calc_rule) {
      showError('질문·지표·단위·계산 규칙을 모두 적어 주세요.'); return;
    }
    if (!isIsoDate(row.effective_from)) { showError('적용 시작일을 골라 주세요.'); return; }
    if (latest) {
      if (row.effective_from < latest.effective_from) {
        showError('새 규칙의 시작일은 이전 규칙의 시작일보다 앞설 수 없습니다.'); return;
      }
      if (!row.change_reason) { showError('규칙을 바꾸는 이유를 적어 주세요.'); return; }
      const same = ['question', 'metric', 'unit', 'calc_rule'].every((k) => row[k] === latest[k]);
      if (same) { showError('바뀐 내용이 없습니다. 질문·지표·단위·계산 규칙 중 하나 이상을 바꿔 주세요.'); return; }
    }
    await run('관찰 규칙 저장 중', () => check(db.from(T.rules).insert(row)));
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
    if (state.busy || !state.user) return;
    state.busy = true;
    setStatus('내보낼 자료 모으는 중…', 'busy');
    try {
      const [plans, dos, sees, moods, books, rules] = await Promise.all(
        [T.plans, T.dos, T.sees, T.moods, T.books, T.rules].map(fetchAll),
      );
      const payload = {
        schema: SCHEMA,
        exported_at: new Date().toISOString(),
        timezone: TZ,
        owner_id: uid(),
        counts: { plans: plans.length, dos: dos.length, sees: sees.length, moods: moods.length, books: books.length, rules: rules.length },
        plans, dos, sees, moods, books, rules,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pds-diary2-export-${todaySeoul()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(`내보내기 완료 · 계획 ${plans.length} · 실행 ${dos.length} · 돌아보기 ${sees.length} · 규칙 ${rules.length}`, 'ok');
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

  // ───────── [개발 · 인증] 로그인 · 회원가입 · 로그아웃 ─────────
  function setAuthMode(mode) {
    authMode = mode;
    const signup = mode === 'signup';
    for (const tab of document.querySelectorAll('.auth-tab')) {
      const on = tab.dataset.mode === mode;
      tab.classList.toggle('selected', on);
      tab.setAttribute('aria-selected', String(on));
    }
    $('#auth-title').textContent = signup ? '회원가입' : '로그인';
    $('#auth-submit').textContent = signup ? '가입하기' : '로그인';
    $('#auth-form').password.autocomplete = signup ? 'new-password' : 'current-password';
    $('#auth-hint').textContent = signup
      ? '비밀번호는 8자 이상으로 정하세요. 다른 사이트에서 쓰는 비밀번호는 쓰지 않습니다.'
      : '가입한 이메일과 비밀번호를 입력하세요.';
    $('#auth-error').hidden = true;
    $('#auth-msg').textContent = '';
  }

  function authFail(msg) {
    $('#auth-error').textContent = msg;
    $('#auth-error').hidden = false;
  }

  async function submitAuth(form) {
    const email = clean(form.email.value);
    const password = form.password.value;
    $('#auth-error').hidden = true;
    $('#auth-msg').textContent = '';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { authFail('이메일 주소를 정확히 입력하세요.'); form.email.focus(); return; }
    if (!password || password.length < 8) { authFail('비밀번호는 8자 이상이어야 합니다.'); form.password.focus(); return; }
    if (password.length > 72) { authFail('비밀번호는 72자 이하로 정하세요.'); form.password.focus(); return; }

    const btn = $('#auth-submit');
    btn.disabled = true;
    try {
      if (authMode === 'signup') {
        const { data, error } = await db.auth.signUp({
          email, password,
          options: { emailRedirectTo: location.origin + location.pathname },
        });
        if (error) throw error;
        // 이미 가입된 이메일이면 Supabase는 identities가 빈 사용자를 돌려준다
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          authFail('이미 가입된 이메일입니다. 로그인 탭에서 로그인하세요.');
          return;
        }
        if (!data.session) {
          // 이메일 확인이 켜져 있으면 세션 없이 돌아온다. 로그인 탭으로 옮겨 안내한다.
          setAuthMode('login');
          form.email.value = email;
          $('#auth-msg').textContent = `${email}로 확인 메일을 보냈어요. 메일의 링크를 누른 뒤 여기서 로그인하세요.`;
        }
      } else {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      form.password.value = '';
    } catch (e) {
      console.error(e);
      authFail(explainAuth(e));
    } finally {
      btn.disabled = false;
    }
  }

  function clearData() {
    // 로그아웃하면 화면에 남은 이전 사용자의 기록을 모두 지운다
    Object.assign(state, { plans: [], dos: [], see: null, marks: {}, mood: null, books: [], rules: [], busy: false });
    for (const sel of ['#plan-list', '#cal-grid', '#mood-options', '#book-body', '#rule-body']) $(sel).innerHTML = '';
    $('#see-form').reset();
  }

  function showSignedOut() {
    state.user = null;
    clearData();
    $('#shell').hidden = true;
    $('#auth-view').hidden = false;
    document.title = '로그인 · 플랜두씨 다이어리';
  }

  function showSignedIn(user) {
    const changed = !state.user || state.user.id !== user.id;
    state.user = user;
    $('#account-email').textContent = user.email || '';
    $('#auth-view').hidden = true;
    $('#shell').hidden = false;
    $('#app').hidden = false;
    document.title = '플랜두씨 다이어리';
    if (changed) { clearData(); reload(); }
  }

  async function logout() {
    try {
      const { error } = await db.auth.signOut();
      if (error) throw error;
    } catch (e) {
      console.error(e);
      // 서버 로그아웃이 실패해도 이 기기의 세션은 지운다
      await db.auth.signOut({ scope: 'local' }).catch(() => {});
    }
    showSignedOut();
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
    $('#logout-btn').addEventListener('click', logout);
    $('#date-input').addEventListener('change', (e) => goTo(e.target.value));

    document.querySelector('.auth-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('[data-mode]');
      if (tab) setAuthMode(tab.dataset.mode);
    });
    $('#auth-form').addEventListener('submit', (e) => { e.preventDefault(); submitAuth(e.target); });

    document.querySelector('.cal-controls').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-month]');
      if (btn) goMonth(Number(btn.dataset.month));
    });
    $('#cal-grid').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-date]');
      if (btn) goTo(btn.dataset.date);
    });

    $('#mood-options').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mood]');
      if (btn) setMood(btn.dataset.mood);
    });
    const bookBody = $('#book-body');
    bookBody.addEventListener('submit', (e) => {
      const kind = e.target.dataset.form;
      if (!kind) return;
      e.preventDefault();
      if (kind === 'book-add') addBook(e.target);
      if (kind === 'book-save') saveBook(e.target);
    });
    bookBody.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="del-book"]');
      if (btn) delBook(btn.dataset.id);
    });
    $('#rule-body').addEventListener('submit', (e) => {
      if (e.target.dataset.form !== 'rule') return;
      e.preventDefault();
      saveRule(e.target);
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

  async function init() {
    wire();
    if (!configured()) {
      $('#shell').hidden = false;
      $('#setup').hidden = false;
      $('#export-btn').disabled = true;
      $('#today-btn').disabled = true;
      $('#logout-btn').disabled = true;
      setStatus('Supabase 연결 필요', 'error');
      return;
    }
    db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });

    db.auth.onAuthStateChange((event, session) => {
      // 콜백 안에서 다른 Supabase 호출을 기다리지 않도록 다음 틱으로 넘긴다
      setTimeout(() => {
        if (session && session.user) showSignedIn(session.user);
        else showSignedOut();
      }, 0);
    });

    try {
      const { data, error } = await db.auth.getSession();
      if (error) throw error;
      if (data.session && data.session.user) showSignedIn(data.session.user);
      else showSignedOut();
    } catch (e) {
      console.error(e);
      showSignedOut();
      authFail(explainAuth(e));
    }
  }

  init();
})();
