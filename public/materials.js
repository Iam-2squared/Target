'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TargetStudyMaterials = factory();
})(globalThis, function () {
  const standard = total => Array.from({length: Math.ceil(total / 100)}, (_, index) =>
    ({section: index + 1, from: index * 100 + 1, to: Math.min((index + 1) * 100, total)}));
  const define = (title, kind, total, prefix, sectionLabel, sections, wordLabel = '英語', meaningLabel = '訳') =>
    Object.freeze({title, kind, total, prefix, sectionLabel, wordLabel, meaningLabel,
      sections: Object.freeze(sections.map(section => Object.freeze(section)))});
  const books = Object.freeze({
    target1900: define('Target 1900', '英単語', 1900, 'v1900', 'Section', standard(1900)),
    target1000: define('英熟語Target 1000', '英熟語', 1000, 'i1000', 'Section', standard(1000)),
    kobun400: define('古文単語', '古文単語', 400, 'k400', 'Section', standard(400), '古語', '現代語訳'),
    crown: define('Crown', '英単語・表現', 32, 'crown', 'Lesson',
      [{section: 6, from: 1, to: 17}, {section: 7, from: 18, to: 32}]),
    improve: define('Improve', '英単語・表現', 42, 'improve', 'Section',
      [{section: 8, from: 1, to: 10}, {section: 9, from: 11, to: 20},
       {section: 10, from: 21, to: 30}, {section: 11, from: 31, to: 42}]),
    cnn: define('CNN', '英単語・表現', 24, 'cnn', 'Section', [{section: 1, from: 1, to: 24}])
  });
  const empty = Object.freeze([]);
  function sectionsFor(book) {
    return Object.hasOwn(books, book) ? books[book].sections : empty;
  }
  function sectionForWord(book, number) {
    if (!Number.isSafeInteger(number)) return null;
    return sectionsFor(book).find(section => number >= section.from && number <= section.to) ?? null;
  }
  function wordRange(book, fromSection, toSection) {
    if (!Number.isSafeInteger(fromSection) || !Number.isSafeInteger(toSection) || fromSection > toSection) return null;
    const sections = sectionsFor(book);
    const first = sections.find(section => section.section === fromSection);
    const last = sections.find(section => section.section === toSection);
    return first && last ? {from: first.from, to: last.to} : null;
  }
  return Object.freeze({books, sectionsFor, sectionForWord, wordRange});
});
