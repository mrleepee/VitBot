const { chromium } = require('playwright');
const assert = require('assert');

const BASE_URL = 'http://localhost:5173';

async function runTests() {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      await fn(page, errors);
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.message}`);
      failed++;
    } finally {
      await page.close();
    }
  }

  console.log('\nVitBot E2E Tests\n');

  // ── Layout & Structure ──

  console.log('Layout & Structure');

  await test('renders page title', async (page) => {
    const title = await page.title();
    assert.strictEqual(title, 'VitBot — Liberland Knowledge Agent');
  });

  await test('renders header with avatar and title', async (page) => {
    const avatar = await page.locator('.header-avatar img').isVisible();
    assert.ok(avatar, 'Header avatar should be visible');

    const h1 = await page.locator('h1').textContent();
    assert.strictEqual(h1.trim(), 'VitBot');
  });

  await test('renders LIVE badge', async (page) => {
    const badge = await page.locator('text=LIVE').isVisible();
    assert.ok(badge, 'LIVE badge should be visible');
  });

  await test('renders subtitle', async (page) => {
    const subtitle = await page.locator('text=Liberland Intelligence').isVisible();
    assert.ok(subtitle, 'Subtitle should be visible');
  });

  await test('renders textarea input', async (page) => {
    const textarea = await page.locator('#chatInput').isVisible();
    assert.ok(textarea, 'Textarea should be visible');

    const placeholder = await page.locator('#chatInput').getAttribute('placeholder');
    assert.strictEqual(placeholder, 'Ask about Liberland...');
  });

  await test('renders send button', async (page) => {
    const btn = await page.locator('#sendBtn').isVisible();
    assert.ok(btn, 'Send button should be visible');

    // Button should NOT be disabled
    const disabled = await page.locator('#sendBtn').getAttribute('disabled');
    assert.strictEqual(disabled, null, 'Send button should not be disabled');
  });

  await test('renders footer', async (page) => {
    const footer = await page.locator('footer').isVisible();
    assert.ok(footer, 'Footer should be visible');
  });

  await test('no JS errors on page load', async (page, errors) => {
    assert.strictEqual(errors.length, 0, `Page errors: ${errors.join(', ')}`);
  });

  // ── Welcome Message ──

  console.log('\nWelcome Message');

  await test('renders welcome message', async (page) => {
    const content = await page.locator('.bot-message-content').first().textContent();
    assert.ok(content.includes('Welcome to VitBot'), 'Should contain welcome text');
    assert.ok(content.includes('guide to the Free Republic'), 'Should contain guide text');
  });

  await test('renders bot avatar in welcome message', async (page) => {
    const avatar = await page.locator('.avatar-ring img[alt="VitBot"]').isVisible();
    assert.ok(avatar, 'Bot avatar should be visible in message');
  });

  await test('renders 4 suggested question chips', async (page) => {
    const count = await page.locator('#suggestedQuestions button').count();
    assert.strictEqual(count, 4, `Expected 4 chips, got ${count}`);
  });

  await test('suggested chips have correct text', async (page) => {
    const expected = [
      "How does Liberland's meritocracy work?",
      "What is the Liberland blockchain?",
      "How do I become a citizen?",
      "Tell me about the constitution",
    ];

    for (let i = 0; i < expected.length; i++) {
      const text = await page.locator('#suggestedQuestions button').nth(i).textContent();
      assert.ok(text.trim().includes(expected[i]), `Chip ${i} should contain "${expected[i]}"`);
    }
  });

  // ── Input Behavior ──

  console.log('\nInput Behavior');

  await test('textarea accepts input', async (page) => {
    await page.locator('#chatInput').fill('Test message');
    const value = await page.locator('#chatInput').inputValue();
    assert.strictEqual(value, 'Test message');
  });

  await test('textarea auto-resizes on input', async (page) => {
    const initialHeight = await page.locator('#chatInput').evaluate(el => el.offsetHeight);
    await page.locator('#chatInput').fill('Line 1\nLine 2\nLine 3\nLine 4\nLine 5');
    await page.locator('#chatInput').dispatchEvent('input');
    await page.waitForTimeout(100);
    const newHeight = await page.locator('#chatInput').evaluate(el => el.offsetHeight);
    assert.ok(newHeight >= initialHeight, 'Textarea should grow with content');
  });

  await test('empty input does not send', async (page) => {
    const msgCountBefore = await page.locator('.user-bubble').count();
    await page.locator('#sendBtn').click();
    await page.waitForTimeout(200);
    const msgCountAfter = await page.locator('.user-bubble').count();
    assert.strictEqual(msgCountAfter, msgCountBefore, 'Should not add user message on empty send');
  });

  // ── Responsive Design ──

  console.log('\nResponsive Design');

  await test('desktop layout renders correctly', async (page) => {
    await page.screenshot({ path: '/tmp/vitbot-e2e-desktop.png', fullPage: false });
    const header = await page.locator('header').boundingBox();
    assert.ok(header.width > 800, 'Header should span full width on desktop');
  });

  await test('mobile layout renders correctly', async (page) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(300);

    // Everything should still be visible
    const avatar = await page.locator('.header-avatar img').isVisible();
    assert.ok(avatar, 'Avatar visible on mobile');

    const textarea = await page.locator('#chatInput').isVisible();
    assert.ok(textarea, 'Textarea visible on mobile');

    const sendBtn = await page.locator('#sendBtn').isVisible();
    assert.ok(sendBtn, 'Send button visible on mobile');

    const welcome = await page.locator('.bot-message-content').first().isVisible();
    assert.ok(welcome, 'Welcome message visible on mobile');

    await page.screenshot({ path: '/tmp/vitbot-e2e-mobile.png', fullPage: false });
  });

  await test('tablet layout renders correctly', async (page) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(300);

    const textarea = await page.locator('#chatInput').isVisible();
    assert.ok(textarea, 'Textarea visible on tablet');

    const chips = await page.locator('#suggestedQuestions button').count();
    assert.strictEqual(chips, 4, 'All chips visible on tablet');

    await page.screenshot({ path: '/tmp/vitbot-e2e-tablet.png', fullPage: false });
  });

  // ── Visual Design ──

  console.log('\nVisual Design');

  await test('uses correct background color', async (page) => {
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // Should be dark (bg: #07070c)
    assert.ok(bg.includes('7') || bg.includes('12'), `Background should be dark, got: ${bg}`);
  });

  await test('glass-card has backdrop-filter', async (page) => {
    const filter = await page.locator('.glass-card').first().evaluate(
      el => getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter
    );
    assert.ok(filter && filter !== 'none', 'Glass card should have backdrop-filter');
  });

  await test('topo-bg grid is applied', async (page) => {
    const bgImage = await page.locator('.topo-bg').evaluate(el => getComputedStyle(el).backgroundImage);
    assert.ok(bgImage !== 'none', 'Topo background should have a background-image');
  });

  // ── Summary ──

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed\n`);
  await browser.close();

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
