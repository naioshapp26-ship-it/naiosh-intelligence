'use strict';
// «اسأل نايوش» trained answers: Arabic-aware matching of a question against the trained questions and their variants.
const STOP = new Set(['ما', 'ماذا', 'هل', 'كيف', 'كم', 'لماذا', 'متى', 'اين', 'أين', 'من', 'في', 'على', 'عن', 'الى', 'إلى', 'او', 'أو', 'و', 'ثم', 'هو', 'هي', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي', 'مع', 'لي', 'لك', 'انا', 'أنا', 'نحن', 'يا', 'اي', 'أي', 'شو', 'ايش', 'قديش', 'بدي', 'ممكن', 'لو', 'ان', 'أن', 'إن', 'قد', 'كان', 'يكون', 'the', 'a', 'is', 'what', 'how', 'to', 'of', 'in']);
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function stem(w) {
  let x = w;
  if (x.length > 4 && x.startsWith('وال')) x = x.slice(3); else if (x.length > 3 && /^(ال|بال|لل|كال|فال)/.test(x)) x = x.replace(/^(بال|كال|فال|ال|لل)/, '');
  if (x.length > 4 && /^[وفب]/.test(x)) x = x.slice(1);
  if (x.length > 4 && /(ات|ون|ين|ها|هم|كم|نا)$/.test(x)) x = x.slice(0, -2);
  else if (x.length > 3 && /[هي]$/.test(x)) x = x.slice(0, -1);
  return x;
}
const toks = (s) => norm(s).split(' ').filter(w => w && !STOP.has(w)).map(stem).filter(w => w.length > 1);
function grams(s) { const t = ' ' + norm(s).replace(/\s/g, '') + ' ', g = new Set(); for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3)); return g; }
function sim(a, b) {
  const A = toks(a), B = toks(b); if (!A.length || !B.length) return 0;
  const sb = new Set(B); let hit = 0; for (const w of new Set(A)) if (sb.has(w)) hit++;
  const tok = hit / Math.max(new Set(A).size, sb.size) * 0.65 + hit / new Set(A).size * 0.35;
  const ga = grams(a), gb = grams(b); let gi = 0; for (const g of ga) if (gb.has(g)) gi++;
  const tri = gi / Math.max(1, ga.size + gb.size - gi);
  return Math.min(1, tok * 0.75 + tri * 0.4);
}
function match(q, entries) {
  const scored = entries.filter(e => e.active).map(e => {
    const forms = [e.question, ...(e.variants || [])];
    let s = Math.max(...forms.map(f => sim(q, f)));
    const kw = (e.keywords || '').split(/[,،]/).map(k => norm(k)).filter(Boolean), nq = norm(q);
    if (kw.length) s = Math.min(1, s + 0.08 * kw.filter(k => nq.includes(k)).length);
    return { e, s };
  }).sort((x, y) => y.s - x.s);
  return { best: scored[0] || null, top: scored.slice(0, 3) };
}
module.exports = { norm, sim, match, THRESHOLD: 0.42, SUGGEST: 0.22 };
