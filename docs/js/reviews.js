/* FullVolume - the reviews section on the home page.
 *
 * Reviews are written in the Discord server with /review. The bot serves the
 * posted ones as JSON (FullVolumeDiscord src/publicreviews.js), reached here
 * through the site's /api/reviews proxy. The section stays hidden until there
 * is at least one review, and everything a reviewer wrote goes on the page as
 * text, never as HTML.
 */
(() => {
  'use strict';

  const section = document.getElementById('reviews');
  if (!section) return;
  const grid = document.getElementById('rvGrid');
  const score = document.getElementById('rvScore');

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);

  // Discord formatting would show up as stray symbols in plain text.
  const plain = (text) => String(text || '')
    .replace(/\*\*|__|~~|\|\|/g, '')
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .trim();

  const date = (ms) => ms
    ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '';

  const avatar = (r) => {
    if (r.avatar) {
      const img = el('img', 'rv-avatar');
      img.src = r.avatar; img.alt = ''; img.width = 42; img.height = 42;
      img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.replaceWith(blank(r)), { once: true });
      return img;
    }
    return blank(r);
  };
  const blank = (r) => el('span', 'rv-avatar rv-avatar--blank', (r.name || '?').trim().charAt(0).toUpperCase());

  const card = (r, i) => {
    const article = el('article', 'rv-card');
    article.style.setProperty('--i', i);

    const who = el('div', 'rv-who');
    const id = el('div');
    id.append(el('p', 'rv-name', r.name));
    const meta = el('p', 'rv-meta');
    const s = el('span', 'rv-stars', stars(r.rating));
    s.setAttribute('aria-label', `${r.rating} out of 5 stars`);
    meta.append(s, date(r.createdAt));
    id.append(meta);
    who.append(avatar(r), id);
    article.append(who);

    if (r.title) article.append(el('h3', 'rv-title', plain(r.title)));

    const body = el('p', 'rv-body', plain(r.body));
    article.append(body);

    if (r.improve) {
      const better = el('p', 'rv-better');
      better.append(el('b', null, 'What would make it better'), plain(r.improve));
      article.append(better);
    }

    if (r.images?.length) {
      const shots = el('div', 'rv-shots');
      r.images.slice(0, 4).forEach((url, n) => {
        const a = el('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.setAttribute('aria-label', `Screenshot ${n + 1} from ${r.name}'s review`);
        const img = el('img');
        img.src = url; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => a.remove(), { once: true });
        a.append(img);
        shots.append(a);
      });
      article.append(shots);
    }

    // Long reviews fold to six lines with a Read more.
    requestAnimationFrame(() => {
      body.classList.add('is-clamped');
      if (body.scrollHeight - body.clientHeight < 4) { body.classList.remove('is-clamped'); return; }
      const more = el('button', 'rv-more', 'Read more');
      more.type = 'button';
      more.setAttribute('aria-expanded', 'false');
      more.addEventListener('click', () => {
        const open = body.classList.toggle('is-clamped') === false;
        more.textContent = open ? 'Show less' : 'Read more';
        more.setAttribute('aria-expanded', String(open));
      });
      body.after(more);
    });

    return article;
  };

  const load = async () => {
    try {
      const res = await fetch('/api/reviews', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const list = Array.isArray(data.reviews) ? data.reviews : [];
      if (list.length === 0) return;

      const avg = Number(data.average) || 0;
      score.querySelector('b').textContent = avg.toFixed(1);
      score.querySelector('.rv-score__stars').textContent = stars(Math.round(avg));
      score.querySelector('.rv-score__count').textContent =
        `from ${list.length} ${list.length === 1 ? 'review' : 'reviews'} in our Discord`;

      grid.replaceChildren(...list.map(card));
      section.hidden = false;
    } catch {
      // The section simply stays hidden; the rest of the page does not depend on it.
    }
  };

  load();
})();
