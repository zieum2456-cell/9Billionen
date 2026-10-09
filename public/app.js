'use strict';

const STATUS = {
  draft: '초안 작성 중',
  revising: '퇴고 중',
  done: '퇴고 완료',
};

const app = document.getElementById('app');

// ---------- 유틸 ----------

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(iso, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('ko-KR', opts);
}

function relDate(iso) {
  if (!iso) return '퇴고 전';
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (days <= 0) return '오늘';
  if (days === 1) return '어제';
  if (days < 30) return `${days}일 전`;
  return fmtDate(iso);
}

function badge(status) {
  return `<span class="badge badge-${esc(status)}">${esc(STATUS[status] || status)}</span>`;
}

function charCount(text) {
  return [...text].length.toLocaleString('ko-KR');
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

// ---------- 목록(게시판) ----------

const listState = { status: '', tag: '', q: '', sort: 'revised' };

async function renderList() {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(listState)) if (v) params.set(k, v);
  const [posts, tags, stats] = await Promise.all([
    api('GET', `/api/posts?${params}`),
    api('GET', '/api/tags'),
    api('GET', '/api/stats'),
  ]);

  const statCard = (key, label, num) => `
    <button class="stat ${listState.status === key ? 'active' : ''}" data-status="${key}">
      <span class="num">${num}</span><span class="lbl">${label}</span>
    </button>`;

  const rows = posts.length
    ? posts
        .map(
          (p) => `
      <a class="board-row" href="#/post/${esc(p.id)}">
        <div>${badge(p.status)}</div>
        <div>
          <div class="title">${esc(p.title)}</div>
          ${p.tags.length ? `<div class="row-tags">${p.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : ''}
        </div>
        <div class="meta" data-label="최신 퇴고" title="${esc(fmtDate(p.lastRevisedAt, true))}">
          ${esc(relDate(p.lastRevisedAt))}${p.revisionCount ? ` (${p.revisionCount}회)` : ''}
        </div>
        <div class="meta" data-label="퇴고 메모">
          ${p.openCommentCount ? `<span class="memo-open">${p.openCommentCount}</span> / ${p.commentCount}` : p.commentCount ? `0 / ${p.commentCount}` : '—'}
        </div>
        <div class="meta" data-label="글자 수">${p.charCount.toLocaleString('ko-KR')}자</div>
      </a>`,
        )
        .join('')
    : `<div class="empty">${stats.total ? '조건에 맞는 글이 없습니다.' : '아직 글이 없습니다. 오른쪽 위 “새 글 쓰기”로 시작해 보세요.'}</div>`;

  app.innerHTML = `
    <div class="stats">
      ${statCard('', '전체', stats.total)}
      ${Object.entries(STATUS).map(([k, label]) => statCard(k, label, stats.byStatus[k])).join('')}
    </div>
    <div class="filters">
      <input type="search" id="q" placeholder="제목·본문 검색" value="${esc(listState.q)}">
      <select id="sort" aria-label="정렬">
        <option value="revised">최신 퇴고순</option>
        <option value="updated">최근 수정순</option>
        <option value="created">작성일순</option>
      </select>
    </div>
    ${
      tags.length
        ? `<div class="tag-cloud">${tags
            .map(
              (t) =>
                `<button class="tag ${listState.tag.toLowerCase() === t.tag.toLowerCase() ? 'active' : ''}" data-tag="${esc(t.tag)}">#${esc(t.tag)}<span class="cnt">${t.count}</span></button>`,
            )
            .join('')}</div>`
        : ''
    }
    <div class="board">
      <div class="board-head"><div>상태</div><div>제목 · 태그</div><div>최신 퇴고일</div><div>퇴고 메모</div><div>글자 수</div></div>
      ${rows}
    </div>`;

  app.querySelector('#sort').value = listState.sort;
  app.querySelectorAll('.stat').forEach((el) =>
    el.addEventListener('click', () => {
      listState.status = el.dataset.status;
      renderList();
    }),
  );
  app.querySelectorAll('.tag-cloud .tag').forEach((el) =>
    el.addEventListener('click', () => {
      listState.tag = listState.tag.toLowerCase() === el.dataset.tag.toLowerCase() ? '' : el.dataset.tag;
      renderList();
    }),
  );
  app.querySelector('#sort').addEventListener('change', (e) => {
    listState.sort = e.target.value;
    renderList();
  });
  let debounce;
  const q = app.querySelector('#q');
  q.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      listState.q = q.value.trim();
      await renderList();
      const again = app.querySelector('#q');
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    }, 300);
  });
}

// ---------- 글 상세 ----------

async function renderPost(id) {
  const post = await api('GET', `/api/posts/${encodeURIComponent(id)}`);
  const open = post.comments.filter((c) => !c.resolved);
  const resolved = post.comments.filter((c) => c.resolved);
  const commentItem = (c) => `
    <li class="comment ${c.resolved ? 'resolved' : ''}">
      <input type="checkbox" data-cid="${esc(c.id)}" ${c.resolved ? 'checked' : ''} title="반영 완료 표시">
      <div class="c-body">
        <div class="c-text">${esc(c.text)}</div>
        <div class="c-date">${esc(fmtDate(c.createdAt, true))}${c.resolved ? ` · 반영 ${esc(fmtDate(c.resolvedAt, true))}` : ''}</div>
      </div>
      <button class="btn-link" data-del-cid="${esc(c.id)}" title="메모 삭제">삭제</button>
    </li>`;

  const revisions = [...post.revisions].reverse();

  app.innerHTML = `
    <div class="post-header">
      <a href="#/">← 목록</a>
      <h1>${esc(post.title)}</h1>
      <div class="post-meta">
        <span>최신 퇴고일 <strong>${esc(fmtDate(post.lastRevisedAt, true))}</strong></span>
        <span>퇴고 ${post.revisions.length}회</span>
        <span>작성 ${esc(fmtDate(post.createdAt))}</span>
        <span>${charCount(post.body)}자</span>
      </div>
      ${post.tags.length ? `<div class="tag-cloud" style="margin:10px 0 0">${post.tags.map((t) => `<a class="tag" href="#/" data-tag="${esc(t)}">#${esc(t)}</a>`).join('')}</div>` : ''}
      <div class="post-actions">
        ${badge(post.status)}
        <select id="status" aria-label="상태 변경">
          ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === post.status ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <span style="flex:1"></span>
        <a class="btn" href="#/post/${esc(post.id)}/edit">퇴고하기</a>
        <button class="btn btn-danger" id="delete">삭제</button>
      </div>
    </div>

    <div class="post-body ${post.body ? '' : 'empty-body'}">${post.body ? esc(post.body) : '아직 본문이 없습니다.'}</div>

    <section class="panel">
      <h2>다음 퇴고를 위한 메모 <small>남은 ${open.length}개 · 반영 ${resolved.length}개</small></h2>
      <ul class="comments">${open.map(commentItem).join('')}${resolved.map(commentItem).join('')}</ul>
      <form class="comment-form" id="comment-form">
        <textarea name="text" rows="2" placeholder="다음 퇴고 때 고칠 점을 적어 두세요 (Ctrl+Enter로 등록)" required></textarea>
        <button class="btn btn-primary" type="submit">등록</button>
      </form>
    </section>

    <section class="panel revisions">
      <h2>퇴고 기록 <small>이전 버전 ${revisions.length}개</small></h2>
      ${
        revisions.length
          ? revisions
              .map(
                (r, i) => `
        <details>
          <summary>${esc(fmtDate(r.savedAt, true))} 퇴고 — ${revisions.length - i}번째 퇴고 이전 원고${r.note ? `<span class="note">“${esc(r.note)}”</span>` : ''}</summary>
          <pre><strong>${esc(r.title)}</strong>\n\n${esc(r.body)}</pre>
        </details>`,
              )
              .join('')
          : '<p class="hint" style="color:var(--muted)">아직 퇴고 기록이 없습니다. 본문이나 제목을 고쳐 저장하면 이전 원고가 여기에 남습니다.</p>'
      }
    </section>`;

  app.querySelectorAll('.post-header .tag').forEach((el) =>
    el.addEventListener('click', () => {
      Object.assign(listState, { tag: el.dataset.tag, status: '', q: '' });
    }),
  );

  app.querySelector('#status').addEventListener('change', async (e) => {
    try {
      await api('PUT', `/api/posts/${encodeURIComponent(id)}`, { status: e.target.value });
      toast(`상태: ${STATUS[e.target.value]}`);
      renderPost(id);
    } catch (err) {
      toast(err.message);
    }
  });

  app.querySelector('#delete').addEventListener('click', async () => {
    if (!confirm(`“${post.title}” 글을 삭제할까요? 퇴고 기록과 메모도 함께 사라집니다.`)) return;
    await api('DELETE', `/api/posts/${encodeURIComponent(id)}`);
    toast('삭제했습니다.');
    location.hash = '#/';
  });

  const form = app.querySelector('#comment-form');
  const submitComment = async () => {
    const text = form.text.value.trim();
    if (!text) return;
    try {
      await api('POST', `/api/posts/${encodeURIComponent(id)}/comments`, { text });
      await renderPost(id);
      app.querySelector('#comment-form textarea').focus();
    } catch (err) {
      toast(err.message);
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitComment();
  });
  form.text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submitComment();
    }
  });

  app.querySelectorAll('.comment input[type=checkbox]').forEach((el) =>
    el.addEventListener('change', async () => {
      await api('PATCH', `/api/posts/${encodeURIComponent(id)}/comments/${el.dataset.cid}`, { resolved: el.checked });
      renderPost(id);
    }),
  );
  app.querySelectorAll('[data-del-cid]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (!confirm('이 메모를 삭제할까요?')) return;
      await api('DELETE', `/api/posts/${encodeURIComponent(id)}/comments/${el.dataset.delCid}`);
      renderPost(id);
    }),
  );
}

// ---------- 작성 / 퇴고 ----------

let dirty = false;

async function renderEditor(id) {
  const post = id
    ? await api('GET', `/api/posts/${encodeURIComponent(id)}`)
    : { title: '', body: '', status: 'draft', tags: [], comments: [] };
  const openMemos = (post.comments || []).filter((c) => !c.resolved);

  app.innerHTML = `
    <div class="post-header">
      <a href="${id ? `#/post/${esc(id)}` : '#/'}">← ${id ? '글로 돌아가기' : '목록'}</a>
      <h1>${id ? '퇴고하기' : '새 글 쓰기'}</h1>
    </div>
    ${
      openMemos.length
        ? `<section class="panel" style="margin-top:0;margin-bottom:16px">
            <h2>반영할 메모 <small>${openMemos.length}개</small></h2>
            <ul class="comments">${openMemos.map((c) => `<li class="comment"><div class="c-body"><div class="c-text">${esc(c.text)}</div></div></li>`).join('')}</ul>
          </section>`
        : ''
    }
    <form class="form" id="editor">
      <label>제목<input name="title" value="${esc(post.title)}" maxlength="200" required></label>
      <div class="row">
        <label>상태
          <select name="status">
            ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === post.status ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </label>
        <label>키워드 태그 <span class="hint">쉼표로 구분 (예: 단편, 1인칭, 겨울)</span>
          <input name="tags" value="${esc(post.tags.join(', '))}" placeholder="태그1, 태그2">
        </label>
      </div>
      <label>본문<textarea name="body" class="body-input">${esc(post.body)}</textarea></label>
      ${id ? '<label>퇴고 메모 <span class="hint">이번 퇴고에서 무엇을 고쳤는지 (선택)</span><input name="revisionNote" maxlength="200"></label>' : ''}
      <div class="error" id="err"></div>
      <div class="form-actions">
        <span class="count" id="count"></span>
        <a class="btn" href="${id ? `#/post/${esc(id)}` : '#/'}">취소</a>
        <button class="btn btn-primary" type="submit">저장</button>
      </div>
    </form>`;

  const form = app.querySelector('#editor');
  const count = app.querySelector('#count');
  const updateCount = () => {
    count.textContent = `${charCount(form.body.value)}자 (공백 제외 ${charCount(form.body.value.replace(/\s/g, ''))}자)`;
  };
  updateCount();
  dirty = false;
  form.addEventListener('input', () => {
    dirty = true;
    updateCount();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      title: form.title.value,
      body: form.body.value,
      status: form.status.value,
      tags: form.tags.value,
    };
    if (id) payload.revisionNote = form.revisionNote.value;
    try {
      const saved = id
        ? await api('PUT', `/api/posts/${encodeURIComponent(id)}`, payload)
        : await api('POST', '/api/posts', payload);
      dirty = false;
      toast('저장했습니다.');
      location.hash = `#/post/${saved.id}`;
    } catch (err) {
      app.querySelector('#err').textContent = err.message;
    }
  });

  (id ? form.body : form.title).focus();
}

// ---------- 라우터 ----------

let currentHash = location.hash;

async function route() {
  const hash = location.hash || '#/';
  if (dirty && hash !== currentHash) {
    if (!confirm('저장하지 않은 내용이 있습니다. 나갈까요?')) {
      history.replaceState(null, '', currentHash);
      return;
    }
    dirty = false;
  }
  currentHash = hash;
  window.scrollTo(0, 0);
  let m;
  try {
    if (hash === '#/new') await renderEditor(null);
    else if ((m = hash.match(/^#\/post\/([\w-]+)\/edit$/))) await renderEditor(m[1]);
    else if ((m = hash.match(/^#\/post\/([\w-]+)$/))) await renderPost(m[1]);
    else await renderList();
  } catch (err) {
    app.innerHTML = `<div class="empty">${esc(err.message)}<br><br><a href="#/">목록으로</a></div>`;
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});
route();
