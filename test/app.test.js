'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Store, ValidationError, normalizeTags } = require('../lib/store');
const { createApp } = require('../server');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writing-log-'));
  return path.join(dir, 'db.json');
}

test('태그 정규화: 공백·#·중복 제거', () => {
  assert.deepEqual(normalizeTags(' 단편, #겨울,단편 , ,Winter,winter'), ['단편', '겨울', 'Winter']);
});

test('새 글은 초안 상태이고 퇴고일이 없다', () => {
  const store = new Store(tmpFile());
  const post = store.createPost({ title: '첫 글', body: '본문' });
  assert.equal(post.status, 'draft');
  assert.equal(post.lastRevisedAt, null);
  assert.equal(post.revisions.length, 0);
});

test('본문 수정 시 이전 원고가 기록되고 최신 퇴고일이 갱신된다', () => {
  const store = new Store(tmpFile());
  const post = store.createPost({ title: '글', body: 'v1' });
  store.updatePost(post.id, { body: 'v2', revisionNote: '문장 다듬음' });
  const updated = store.getPost(post.id);
  assert.equal(updated.body, 'v2');
  assert.ok(updated.lastRevisedAt);
  assert.equal(updated.revisions.length, 1);
  assert.equal(updated.revisions[0].body, 'v1');
  assert.equal(updated.revisions[0].note, '문장 다듬음');
});

test('상태나 태그만 바꾸면 퇴고로 기록되지 않는다', () => {
  const store = new Store(tmpFile());
  const post = store.createPost({ title: '글', body: 'v1' });
  store.updatePost(post.id, { status: 'revising', tags: '단편' });
  const updated = store.getPost(post.id);
  assert.equal(updated.status, 'revising');
  assert.deepEqual(updated.tags, ['단편']);
  assert.equal(updated.lastRevisedAt, null);
  assert.equal(updated.revisions.length, 0);
});

test('잘못된 상태와 빈 제목은 거부된다', () => {
  const store = new Store(tmpFile());
  assert.throws(() => store.createPost({ title: '' }), ValidationError);
  assert.throws(() => store.createPost({ title: 'x', status: 'published' }), ValidationError);
});

test('메모 추가·반영 표시·삭제와 목록 집계', () => {
  const store = new Store(tmpFile());
  const post = store.createPost({ title: '글' });
  const c1 = store.addComment(post.id, { text: '2장 전개가 느림' });
  store.addComment(post.id, { text: '결말 다시 생각' });
  store.updateComment(post.id, c1.id, { resolved: true });
  let [row] = store.listPosts();
  assert.equal(row.commentCount, 2);
  assert.equal(row.openCommentCount, 1);
  store.deleteComment(post.id, c1.id);
  [row] = store.listPosts();
  assert.equal(row.commentCount, 1);
});

test('상태·태그·검색어로 필터링', () => {
  const store = new Store(tmpFile());
  store.createPost({ title: '겨울 이야기', tags: ['단편'], status: 'done' });
  store.createPost({ title: '여름', body: '바다가 보이는', tags: ['장편'] });
  assert.equal(store.listPosts({ status: 'done' }).length, 1);
  assert.equal(store.listPosts({ tag: '장편' }).length, 1);
  assert.equal(store.listPosts({ q: '바다' })[0].title, '여름');
  assert.deepEqual(store.stats().byStatus, { draft: 1, revising: 0, done: 1 });
});

test('데이터는 파일에 저장되어 다시 불러올 수 있다', () => {
  const file = tmpFile();
  const post = new Store(file).createPost({ title: '보존' });
  assert.equal(new Store(file).getPost(post.id).title, '보존');
});

test('HTTP API 왕복', async (t) => {
  const server = http.createServer(createApp(new Store(tmpFile())));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, data: res.status === 204 ? null : await res.json() };
  };

  const created = await call('POST', '/api/posts', { title: 'API 글', tags: '시, 연작' });
  assert.equal(created.status, 201);
  const id = created.data.id;

  assert.equal((await call('PUT', `/api/posts/${id}`, { body: '새 본문' })).data.revisions.length, 1);
  assert.equal((await call('POST', `/api/posts/${id}/comments`, { text: '메모' })).status, 201);
  assert.equal((await call('GET', '/api/tags')).data.length, 2);
  assert.equal((await call('PUT', `/api/posts/${id}`, { status: 'nope' })).status, 400);
  assert.equal((await call('GET', '/api/posts/없는-글')).status, 404);
  assert.equal((await call('DELETE', `/api/posts/${id}`)).status, 204);
  assert.equal((await call('GET', '/api/posts')).data.length, 0);

  const page = await fetch(base + '/');
  assert.match(await page.text(), /집필 기록/);
  assert.equal((await fetch(base + '/..%2Fserver.js')).status, 403);
});
