import * as cheerio from 'cheerio';
import { config } from '../config.js';

const WS = /\s+/g;
const clean = (s) => String(s || '').replace(WS, ' ').trim();
const safeUrl = (href, base) => { try { return new URL(href, base).href; } catch { return null; } };

export function parseWebsite({ html, finalUrl }) {
  const $ = cheerio.load(html);
  $('script, style, noscript, template, svg, iframe').remove();

  const title = clean($('title').first().text()).slice(0, 300);
  const metaDescription = clean(
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content')
  ).slice(0, 500);

  const buttons = [];
  $('button, [role="button"], input[type="submit"], input[type="button"]').each((_, el) => {
    const t = clean($(el).attr('aria-label') || $(el).attr('value') || $(el).text());
    if (t) buttons.push(t.slice(0, 160));
  });

  const links = [];
  const seen = new Set();
  $('a[href]').each((_, el) => {
    const href = safeUrl($(el).attr('href'), finalUrl);
    if (!href || !/^https?:/i.test(href)) return;
    if (seen.has(href)) return;
    seen.add(href);
    links.push({
      href,
      text: clean($(el).text()).slice(0, 160),
      ariaLabel: clean($(el).attr('aria-label')).slice(0, 160),
      title: clean($(el).attr('title')).slice(0, 160),
    });
    if (links.length >= 500) return false;
  });

  const bodyText = clean($('body').text() || $.root().text()).slice(0, config.scrape.maxTextChars);

  return { title, metaDescription, buttons: [...new Set(buttons)].slice(0, 100), links, bodyText };
}