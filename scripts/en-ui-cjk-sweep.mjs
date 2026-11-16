#!/usr/bin/env node
/* global CustomEvent, Element, NodeFilter, document, fetch, getComputedStyle, window */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/u;
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'value'];
const MIN_SURFACES = 12;

function parseArgs(argv) {
  const args = { lang: 'en' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!['--base-url', '--lang', '--out'].includes(key)) throw new Error(`Unknown argument: ${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    args[key.slice(2)] = value;
    i += 1;
  }
  if (!args['base-url'] || !args.out) throw new Error('Usage: node scripts/en-ui-cjk-sweep.mjs --base-url URL --lang en|zh --out DIRECTORY');
  if (!['en', 'zh'].includes(args.lang)) throw new Error('--lang must be en or zh');
  return { baseUrl: args['base-url'].replace(/\/$/, ''), lang: args.lang, out: path.resolve(args.out) };
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'surface';
}

async function visible(locator) {
  return await locator.count() > 0 && await locator.first().isVisible();
}

async function clickRequired(locator, description) {
  await locator.first().waitFor({ state: 'visible', timeout: 15000 });
  await locator.first().click();
  console.log(`ACTION ${description}`);
}

async function setLanguage(page, baseUrl, lang) {
  const result = await page.evaluate(async ({ baseUrl, lang }) => {
    const token = window.__CODE_AGENT_TOKEN__;
    const response = await fetch(`${baseUrl}/api/domain/settings/set`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ payload: { ui: { language: lang } } }),
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  }, { baseUrl, lang });
  if (!result.ok) throw new Error(`Failed to set ui.language=${lang}: HTTP ${result.status} ${result.body.slice(0, 300)}`);
}

function collectCjk(page, surface) {
  return page.evaluate(({ surface, cjkSource, attrs }) => {
    const cjk = new RegExp(cjkSource, 'u');
    const allowlistRules = [
      {
        reason: 'user data: session titles and user-entered text are not UI copy',
        matches: (element) => Boolean(element.closest('[data-session-id], [data-user-content], [contenteditable="true"]')),
      },
      {
        reason: 'built-in expert display names are owned by N-FIX-EN-UI-HARDCODED-ZH-SYSTEMIC-FU4',
        matches: (element, text) => {
          const name = element.closest('[data-testid^="expert-card-"]')?.querySelector('.text-sm.font-medium.text-zinc-100');
          return element === name || element.closest('[data-testid="role-basic-summary-name"]') !== null
            || (element.matches('img[alt]') && element.closest('[data-testid="role-detail-page"]') !== null && element.getAttribute('alt') === text);
        },
      },
    ];
    const isVisible = (element) => {
      if (!(element instanceof Element) || element.closest('script,style,noscript,[hidden],[aria-hidden="true"]')) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const describe = (element) => {
      const id = element.id ? `#${element.id}` : '';
      const testId = element.getAttribute('data-testid');
      return `${element.tagName.toLowerCase()}${id}${testId ? `[data-testid="${testId}"]` : ''}`;
    };
    const output = [];
    const add = (element, node, text) => {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (!normalized || !cjk.test(normalized) || !isVisible(element)) return;
      const allowed = allowlistRules.find((rule) => rule.matches(element, normalized));
      output.push({ surface, node, text: normalized.slice(0, 300), allowlisted: Boolean(allowed), reason: allowed?.reason });
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      const element = textNode.parentElement;
      if (element) add(element, `${describe(element)} > text`, textNode.textContent || '');
    }
    for (const element of document.body.querySelectorAll('*')) {
      if (!isVisible(element)) continue;
      for (const attr of attrs) {
        if (attr === 'value' && element.matches('input,textarea,[contenteditable="true"]')) continue;
        const value = element.getAttribute(attr);
        if (value) add(element, `${describe(element)}[${attr}]`, value);
      }
    }
    return output;
  }, { surface, cjkSource: CJK_RE.source, attrs: ATTRS });
}

async function hoverTitles(page) {
  const titles = page.locator('[title]');
  const count = await titles.count();
  let hovered = 0;
  for (let i = 0; i < count; i += 1) {
    const source = titles.nth(i);
    if (!await source.isVisible().catch(() => false)) continue;
    await source.hover({ timeout: 1500 }).catch(() => {});
    hovered += 1;
    await page.waitForTimeout(60);
  }
  return hovered;
}

function createVisitor(page, out, report) {
  const seen = new Set();
  return async function visit(surface, assertion) {
    if (!seen.add(surface)) throw new Error(`Duplicate surface: ${surface}`);
    if (assertion) {
      await assertion.first().waitFor({ state: 'visible', timeout: 15000 });
      if (!await assertion.first().isVisible()) throw new Error(`Screenshot assertion failed: ${surface}`);
    }
    await page.waitForTimeout(250);
    const hovered = await hoverTitles(page);
    const findings = await collectCjk(page, surface);
    const hits = findings.filter((finding) => !finding.allowlisted);
    const allowed = findings.filter((finding) => finding.allowlisted);
    const screenshot = path.join(out, `${String(report.surfaces.length + 1).padStart(2, '0')}-${slug(surface)}.png`);
    await page.screenshot({ path: screenshot, fullPage: false });
    const record = { surface, hits, allowlisted: allowed, titleHovers: hovered, screenshot };
    report.surfaces.push(record);
    for (const finding of findings) {
      console.log(`${finding.allowlisted ? 'ALLOWLIST' : 'HIT'} surface=${surface} node=${finding.node} text=${JSON.stringify(finding.text)}${finding.reason ? ` reason=${finding.reason}` : ''}`);
    }
    console.log(`SURFACE ${surface} CJK strings=${hits.length} allowlisted=${allowed.length} titleHovers=${hovered} screenshot=${screenshot}`);
  };
}

async function closeOnboarding(page, lang) {
  const skip = page.getByRole('button', {
    name: lang === 'en' ? 'Skip for now, set up later in Settings' : '跳过，稍后在设置里配置',
    exact: true,
  });
  if (await visible(skip)) await skip.click();
  await page.waitForTimeout(1000);
}

async function sweepOnboarding(page, visit, lang) {
  const subscription = page.getByTestId('onboarding-route-subscription');
  if (!await visible(subscription)) return;
  await visit('onboarding-subscription', page.getByTestId('onboarding-subscription-sources'));
  await clickRequired(page.getByTestId('onboarding-route-api'), 'onboarding API Key route');
  await visit('onboarding-api-key', page.getByTestId('onboarding-api-source'));
  await clickRequired(subscription, 'return to subscription route');
  const selectable = page.locator('[data-onboarding-engine]');
  if (await selectable.count() > 0) {
    await clickRequired(selectable, 'subscription source to default-model step');
    await visit('onboarding-default-model', page.getByTestId('onboarding-model-step'));
    await clickRequired(page.getByTestId('onboarding-continue-to-chat'), 'onboarding connectors step');
    await visit('onboarding-connectors', page.getByTestId('onboarding-connectors-next'));
    await clickRequired(page.getByTestId('onboarding-connectors-skip'), 'onboarding voice-hotkey step');
    await visit('onboarding-voice-hotkey', page.getByTestId('onboarding-voice-hotkey-skip'));
    return;
  }
  console.log('ONBOARDING no selectable subscription client; model/connectors/voice steps are unreachable without credentials');
  await closeOnboarding(page, lang);
}

async function closeSettings(page) {
  if (await visible(page.getByTestId('settings-panel'))) await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

async function sweepSettings(page, visit) {
  await page.keyboard.press('Meta+,');
  await page.getByTestId('settings-panel').waitFor({ state: 'visible', timeout: 15000 });
  const nav = page.getByTestId('settings-panel').locator('aside nav');
  for (let pass = 0; pass < 10; pass += 1) {
    const collapsed = nav.locator('button[aria-expanded="false"]');
    if (await collapsed.count() === 0) break;
    await collapsed.first().click();
  }
  const tabs = nav.locator('button:not([aria-expanded])');
  const labels = await tabs.allInnerTexts();
  if (labels.length < 5) throw new Error(`Settings navigation discovery failed: only ${labels.length} tabs`);
  console.log(`SETTINGS discovered tabs=${labels.length}: ${labels.map((label) => label.trim()).join(' | ')}`);
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index].trim();
    await tabs.nth(index).click();
    await page.waitForTimeout(350);
    const heading = page.locator('#settings-page-title');
    await visit(`settings-${label}`, heading);
    if (/privacy|隐私/i.test(label)) {
      await page.getByTestId('settings-panel').locator('main').evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await visit(`settings-${label}-bottom`, heading);
    }
    if (/advanced|高级/i.test(label)) {
      const titles = await page.locator('[data-testid^="engine-switch-button-"]').evaluateAll((elements) => elements.map((element) => element.getAttribute('title') || ''));
      console.log(`ENGINE_SWITCH_TITLE_COUNT=${titles.length}`);
      titles.forEach((title, i) => console.log(`ENGINE_SWITCH_TITLE_${i + 1}=${JSON.stringify(title)}`));
    }
  }
  await closeSettings(page);
}

async function sweepAutomations(page, visit, lang) {
  await clickRequired(page.getByTestId('sidebar-capability-automation'), 'open Automations');
  await visit('automations-jobs', page.getByTestId('cron-center-panel'));
  await clickRequired(page.getByTestId('cron-center-tab-runs'), 'Automation runs tab');
  await visit('automations-runs', page.getByTestId('cron-center-panel'));
  await clickRequired(page.getByTestId('cron-center-tab-jobs'), 'Automation jobs tab');
  const create = page.getByTestId('cron-center-panel').locator('button').filter({ has: page.locator('svg.lucide-plus') }).first();
  await clickRequired(create, 'open cron editor');
  await visit('automations-cron-editor', page.locator('[role="dialog"]').last());
  await page.keyboard.press('Escape');
  const quit = page.getByRole('dialog').filter({ hasText: lang === 'en' ? /discard|unsaved|leave/i : /放弃|未保存|离开/ });
  if (await visible(quit)) await visit('automations-cron-editor-quit', quit);
}

async function sweepCapabilityHub(page, visit) {
  await page.keyboard.press('Escape');
  await clickRequired(page.getByTestId('sidebar-capability-hub'), 'open Capability Hub');
  const tabs = page.locator('[data-testid^="capability-hub-tab-"]');
  const ids = await tabs.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid').replace('capability-hub-tab-', '')));
  if (ids.length < 5) throw new Error(`Capability Hub discovery failed: ${ids.length} tabs`);
  for (const id of ids) {
    await clickRequired(page.getByTestId(`capability-hub-tab-${id}`), `Capability Hub ${id}`);
    await visit(`capability-hub-${id}`, page.getByTestId('capability-hub-page'));
    if (id === 'experts') {
      const detail = page.locator('[data-testid^="expert-detail-"]');
      if (await detail.count() > 0) {
        await clickRequired(detail, 'open one expert detail');
        await visit('expert-detail', page.locator('[data-testid="role-basic-summary-name"], [data-testid^="role-detail-"]').first());
        await clickRequired(page.getByTestId('sidebar-capability-hub'), 'return to Experts list');
      }
    }
  }
}

async function sweepProjectTasks(page, visit) {
  await clickRequired(page.getByTestId('sidebar-capability-projects'), 'open collaboration spaces');
  await visit('space-list', page.getByTestId('project-space-page'));
  const existing = page.locator('[data-testid^="project-space-list-item-"]');
  if (await existing.count() > 0) {
    await clickRequired(existing, 'open a collaboration space');
    await clickRequired(page.getByTestId('project-space-tab-tasks'), 'space Tasks tab');
    await visit('space-tasks', page.getByTestId('project-space-tab-tasks'));
  } else {
    console.log('SPACE no existing collaboration space; Tasks tab requires a user-owned space and was not fabricated');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.out, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const report = { baseUrl: args.baseUrl, lang: args.lang, surfaces: [] };
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(args.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await setLanguage(page, args.baseUrl, args.lang);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const visit = createVisitor(page, args.out, report);
    await sweepOnboarding(page, visit, args.lang);
    await closeOnboarding(page, args.lang);
    const webClose = page.getByRole('button', { name: /^(关闭|Close)$/ });
    if (await visible(webClose)) await webClose.first().click();
    await visit('main-screen', page.locator('body'));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('code-agent:open-model-switcher')));
    await page.waitForTimeout(400);
    await visit('model-switcher-popover', page.locator('[data-model-search-input], [data-engine-panel]').first());
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('app:openCommandPalette')));
    await visit('command-palette', page.getByRole('dialog', { name: /command|命令/i }));
    await page.keyboard.press('Escape');
    await sweepSettings(page, visit);
    await sweepAutomations(page, visit, args.lang);
    await sweepCapabilityHub(page, visit);
    await sweepProjectTasks(page, visit);
    report.totalHits = report.surfaces.reduce((sum, surface) => sum + surface.hits.length, 0);
    report.totalAllowlisted = report.surfaces.reduce((sum, surface) => sum + surface.allowlisted.length, 0);
    fs.writeFileSync(path.join(args.out, `report-${args.lang}.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`SUMMARY lang=${args.lang} surfaces=${report.surfaces.length} hits=${report.totalHits} allowlisted=${report.totalAllowlisted}`);
    if (report.surfaces.length < MIN_SURFACES) throw new Error(`Only ${report.surfaces.length} surfaces visited; required >= ${MIN_SURFACES}`);
    if (args.lang === 'zh' && report.totalHits === 0) throw new Error('Non-vacuous check failed: zh sweep reported zero CJK hits');
    if (args.lang === 'en' && report.totalHits > 0) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`SWEEP FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
