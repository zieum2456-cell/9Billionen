'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATUSES = ['draft', 'revising', 'done'];
const STATUS_LABELS = {
  draft: '초안 작성 중',
  revising: '퇴고 중',
  done: '퇴고 완료',
};

class ValidationError extends Error {}
class NotFoundError extends Error {}

function now() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID();
}

function normalizeTags(tags) {
  if (tags == null) return [];
  const list = Array.isArray(tags) ? tags : String(tags).split(',');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = String(raw).trim().replace(/^#/, '').trim();
    if (!tag) continue;
    if (tag.length > 30) throw new ValidationError(`태그는 30자 이하여야 합니다: ${tag}`);
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  if (out.length > 20) throw new ValidationError('태그는 최대 20개까지 붙일 수 있습니다.');
  return out;
}

function validateStatus(status) {
  if (!STATUSES.includes(status)) {
    throw new ValidationError(`알 수 없는 상태입니다: ${status}`);
  }
  return status;
}

function validateTitle(title) {
  const t = String(title ?? '').trim();
  if (!t) throw new ValidationError('제목을 입력해 주세요.');
  if (t.length > 200) throw new ValidationError('제목은 200자 이하여야 합니다.');
  return t;
}

/**
 * JSON 파일 하나에 모든 데이터를 저장하는 단순한 저장소.
 * 쓰기는 임시 파일에 기록한 뒤 rename 하여 중간에 꺼져도 파일이 깨지지 않게 한다.
 */
class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this._load();
  }

  _load() {
    if (!fs.existsSync(this.filePath)) {
      return { posts: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.posts)) {
      throw new Error(`데이터 파일 형식이 올바르지 않습니다: ${this.filePath}`);
    }
    return parsed;
  }

  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  _find(id) {
    const post = this.data.posts.find((p) => p.id === id);
    if (!post) throw new NotFoundError('글을 찾을 수 없습니다.');
    return post;
  }

  listPosts({ status, tag, q, sort } = {}) {
    let posts = this.data.posts;
    if (status) posts = posts.filter((p) => p.status === status);
    if (tag) {
      const key = tag.toLowerCase();
      posts = posts.filter((p) => p.tags.some((t) => t.toLowerCase() === key));
    }
    if (q) {
      const needle = q.toLowerCase();
      posts = posts.filter(
        (p) => p.title.toLowerCase().includes(needle) || p.body.toLowerCase().includes(needle),
      );
    }
    const sortKey = sort === 'created' ? 'createdAt' : sort === 'updated' ? 'updatedAt' : 'lastRevisedAt';
    posts = [...posts].sort((a, b) => {
      const av = a[sortKey] || a.createdAt;
      const bv = b[sortKey] || b.createdAt;
      return bv.localeCompare(av);
    });
    return posts.map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      tags: p.tags,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      lastRevisedAt: p.lastRevisedAt,
      revisionCount: p.revisions.length,
      charCount: [...p.body].length,
      commentCount: p.comments.length,
      openCommentCount: p.comments.filter((c) => !c.resolved).length,
    }));
  }

  getPost(id) {
    return this._find(id);
  }

  createPost({ title, body = '', status = 'draft', tags = [] } = {}) {
    const ts = now();
    const post = {
      id: newId(),
      title: validateTitle(title),
      body: String(body ?? ''),
      status: validateStatus(status),
      tags: normalizeTags(tags),
      createdAt: ts,
      updatedAt: ts,
      lastRevisedAt: null,
      revisions: [],
      comments: [],
    };
    this.data.posts.push(post);
    this._save();
    return post;
  }

  /**
   * 글 수정. 제목이나 본문이 바뀌면 '퇴고'로 간주해 이전 버전을 기록하고 최신 퇴고일을 갱신한다.
   * 상태나 태그만 바꾸는 것은 퇴고로 치지 않는다.
   */
  updatePost(id, changes = {}) {
    const post = this._find(id);
    const next = {
      title: changes.title !== undefined ? validateTitle(changes.title) : post.title,
      body: changes.body !== undefined ? String(changes.body ?? '') : post.body,
      status: changes.status !== undefined ? validateStatus(changes.status) : post.status,
      tags: changes.tags !== undefined ? normalizeTags(changes.tags) : post.tags,
    };
    const ts = now();
    const contentChanged = next.title !== post.title || next.body !== post.body;
    if (contentChanged) {
      post.revisions.push({
        id: newId(),
        savedAt: ts,
        title: post.title,
        body: post.body,
        note: changes.revisionNote ? String(changes.revisionNote).trim() : '',
      });
      post.lastRevisedAt = ts;
    }
    Object.assign(post, next, { updatedAt: ts });
    this._save();
    return post;
  }

  deletePost(id) {
    this._find(id);
    this.data.posts = this.data.posts.filter((p) => p.id !== id);
    this._save();
  }

  addComment(postId, { text } = {}) {
    const post = this._find(postId);
    const body = String(text ?? '').trim();
    if (!body) throw new ValidationError('메모 내용을 입력해 주세요.');
    if (body.length > 5000) throw new ValidationError('메모는 5000자 이하여야 합니다.');
    const comment = { id: newId(), text: body, createdAt: now(), resolved: false, resolvedAt: null };
    post.comments.push(comment);
    this._save();
    return comment;
  }

  updateComment(postId, commentId, { resolved } = {}) {
    const post = this._find(postId);
    const comment = post.comments.find((c) => c.id === commentId);
    if (!comment) throw new NotFoundError('메모를 찾을 수 없습니다.');
    if (resolved !== undefined) {
      comment.resolved = Boolean(resolved);
      comment.resolvedAt = comment.resolved ? now() : null;
    }
    this._save();
    return comment;
  }

  deleteComment(postId, commentId) {
    const post = this._find(postId);
    const before = post.comments.length;
    post.comments = post.comments.filter((c) => c.id !== commentId);
    if (post.comments.length === before) throw new NotFoundError('메모를 찾을 수 없습니다.');
    this._save();
  }

  listTags() {
    const counts = new Map();
    for (const post of this.data.posts) {
      for (const tag of post.tags) {
        const key = tag.toLowerCase();
        const entry = counts.get(key) || { tag, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  stats() {
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const post of this.data.posts) byStatus[post.status] += 1;
    return { total: this.data.posts.length, byStatus };
  }
}

module.exports = { Store, STATUSES, STATUS_LABELS, ValidationError, NotFoundError, normalizeTags };
