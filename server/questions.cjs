'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const {HttpError} = require('./errors.cjs');
const BOOKS = {target1900: {size: 1900, prefix: 'v1900'}, target1000: {size: 1000, prefix: 'i1000'}, kobun400: {size: 400, prefix: 'k400'}};
const cache = new Map();

function normalize(value) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
}

function kobunMeanings(value) {
  return new Set(value.normalize('NFKC').split(/[。；;]/u).map(part => part.replace(/\s+/gu, ' ').trim()).filter(Boolean));
}

function loadBook(book) {
  if (!Object.hasOwn(BOOKS, book)) throw new HttpError(400, '教材を選んでください。', 'INVALID_BOOK');
  if (cache.has(book)) return cache.get(book);
  const rows = require(path.join('..', 'data', book + '.json'));
  const expected = BOOKS[book];
  if (!Array.isArray(rows) || rows.length !== expected.size || rows.some((row, i) =>
    row.number !== i + 1 || row.id !== expected.prefix + '-' + String(i + 1).padStart(4, '0') ||
    typeof row.english !== 'string' || !row.english.trim() || row.english.length > 2000 ||
    typeof row.japanese !== 'string' || !row.japanese.trim() || row.japanese.length > 2000)) {
    throw new HttpError(503, '教材データを確認できませんでした。', 'MATERIALS_UNAVAILABLE');
  }
  cache.set(book, rows);
  return rows;
}

function shuffle(rows) {
  const copy = rows.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function validateQuizInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !['book', 'direction', 'count', 'from', 'to', 'requestId'].includes(key)) ||
      !Object.hasOwn(BOOKS, body.book) || !['english', 'japanese'].includes(body.direction) ||
      ![10, 20, 50, 100].includes(body.count) || !Number.isInteger(body.from) || !Number.isInteger(body.to) ||
      body.from < 1 || body.to < body.from || body.to > BOOKS[body.book].size ||
      typeof body.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.requestId)) {
    throw new HttpError(400, 'テストの教材・範囲・出題数を確認してください。', 'INVALID_QUIZ');
  }
  return body;
}

function generateQuestions(input, reviewNumbers) {
  const body = validateQuizInput(input);
  const rows = loadBook(body.book);
  let pool = rows.slice(body.from - 1, body.to);
  if (reviewNumbers !== undefined) {
    if (!Array.isArray(reviewNumbers) || reviewNumbers.length > BOOKS[body.book].size ||
        reviewNumbers.some(n => !Number.isSafeInteger(n) || n < body.from || n > body.to) ||
        new Set(reviewNumbers).size !== reviewNumbers.length) {
      throw new HttpError(503, '解き直しの対象を確認できませんでした。', 'REVIEW_UNAVAILABLE');
    }
    const selected = new Set(reviewNumbers);
    pool = pool.filter(row => selected.has(row.number));
  }
  const eligible = shuffle(pool).slice(0, body.count);
  const answerKey = body.direction === 'english' ? 'english' : 'japanese';
  const promptKey = body.direction === 'english' ? 'japanese' : 'english';
  return eligible.map(row => {
    const correctEnglish = normalize(row.english), correctJapanese = normalize(row.japanese);
    const meanings = body.book === 'kobun400' ? kobunMeanings(row.japanese) : null;
    const texts = new Set([normalize(row[answerKey])]);
    const options = [{id: crypto.randomUUID(), text: row[answerKey]}];
    const correctChoiceId = options[0].id;
    for (const other of shuffle(rows)) {
      // Identical translations, or another entry of the same English word,
      // must never turn a second choice into an equally correct answer.
      if (normalize(other.english) === correctEnglish || normalize(other.japanese) === correctJapanese) continue;
      // Classical multi-meaning entries can share one valid translation even
      // when their full glosses differ. Exclude complete shared meanings.
      if (meanings && [...kobunMeanings(other.japanese)].some(meaning => meanings.has(meaning))) continue;
      const normalized = normalize(other[answerKey]);
      if (texts.has(normalized)) continue;
      texts.add(normalized);
      options.push({id: crypto.randomUUID(), text: other[answerKey]});
      if (options.length === 4) break;
    }
    if (options.length !== 4) throw new HttpError(503, '重複しない選択肢を作成できませんでした。', 'CHOICES_UNAVAILABLE');
    return {id: crypto.randomUUID(), prompt: row[promptKey], number: row.number,
      choices: shuffle(options), correctChoiceId, correctText: row[answerKey]};
  });
}

module.exports = {loadBook, normalize, shuffle, validateQuizInput, generateQuestions};
