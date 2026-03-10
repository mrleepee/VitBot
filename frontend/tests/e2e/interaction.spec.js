const { chromium } = require('playwright');
const http = require('http');
const assert = require('assert');

const BASE_URL = 'http://localhost:5173';
const MOCK_PORT = 8111;

// ── Mock SSE Server ──
// Simulates the backend streaming response with tokens, sources, and done events

const MOCK_RESPONSES = {
  'What is Liberland?': {
    tokens: [
      'Liberland, ', 'officially the ', '**Free Republic of Liberland**, ',
      'is a sovereign state ', 'proclaimed on ', '13 April 2015. ',
      'It is situated on the ', 'western bank of the Danube, ',
      'between Croatia and Serbia.\n\n',
      'The country was founded by ', '**Vít Jedlička** ',
      'on a parcel of land that was ', 'unclaimed by either nation.',
    ],
    sources: [
      { title: 'About Liberland', source_type: 'doc', section: 'Overview', source_path: 'about.md' },
      { title: 'Constitutional Framework', source_type: 'doc', section: 'Preamble', source_path: 'constitution.md' },
    ],
  },
  'How does the blockchain work?': {
    tokens: [
      'Liberland uses a ', '**substrate-based blockchain** ',
      'for its governance system.\n\n',
      'Key features include:\n',
      '- **On-chain governance** — citizens vote on legislation directly\n',
      '- **LLM token** — the native merit token used for voting weight\n',
      '- **Decentralised identity** — citizen credentials stored on-chain\n\n',
      'The blockchain serves as the ', 'backbone of the e-governance system, ',
      'enabling transparent and ', 'tamper-proof record keeping.',
    ],
    sources: [
      { title: 'Blockchain Governance', source_type: 'doc', section: 'Architecture', source_path: 'blockchain.md' },
      { title: 'Montevideo Speech 2023', source_type: 'transcript', section: 'Technology', source_path: 'montevideo.txt' },
      { title: 'LLM Token Economics', source_type: 'doc', section: 'Tokenomics', source_path: 'token.md' },
    ],
  },
  'Tell me about citizenship': {
    tokens: [
      'Citizenship in Liberland ', 'is merit-based. ',
      'To become a citizen, you must:\n\n',
      '1. **Register** on the official portal\n',
      '2. **Stake LLM tokens** as a commitment to the nation\n',
      '3. **Pass a citizenship test** on constitutional knowledge\n',
      '4. **Receive approval** from the citizenship committee\n\n',
      'Citizens gain voting rights ', 'proportional to their ', 'staked merit (LLM tokens).',
    ],
    sources: [
      { title: 'Citizenship Guide', source_type: 'doc', section: 'Requirements', source_path: 'citizenship.md' },
    ],
  },
};

const DEFAULT_RESPONSE = {
  tokens: [
    'I can help with questions about ', 'Liberland\'s governance, ',
    'blockchain, constitution, ', 'and citizenship. ',
    'Could you be more specific?',
  ],
  sources: [
    { title: 'General FAQ', source_type: 'doc', section: 'Overview', source_path: 'faq.md' },
  ],
};

function createMockServer() {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/chat') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { message } = JSON.parse(body);

      const response = MOCK_RESPONSES[message] || DEFAULT_RESPONSE;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      // Stream tokens with realistic delay
      for (const token of response.tokens) {
        res.write(`data: ${JSON.stringify({ type: 'token', content: token })}\n\n`);
        await new Promise(r => setTimeout(r, 20));
      }

      res.write(`data: ${JSON.stringify({ type: 'sources', sources: response.sources })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      return;
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });
}

// ── Test Runner ──

async function runTests() {
  // Start mock server
  const mockServer = createMockServer();
  await new Promise(resolve => mockServer.listen(MOCK_PORT, resolve));
  console.log(`Mock SSE server on port ${MOCK_PORT}`);

  const browser = await chromium.launch({ headless: true });
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    try {
      // Route /api/* to mock server instead of real backend
      await page.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        const mockUrl = `http://localhost:${MOCK_PORT}${url.pathname}`;

        const headers = {};
        const reqHeaders = route.request().headers();
        if (reqHeaders['content-type']) headers['Content-Type'] = reqHeaders['content-type'];

        const response = await fetch(mockUrl, {
          method: route.request().method(),
          headers,
          body: route.request().method() === 'POST' ? route.request().postData() : undefined,
        });

        const body = await response.text();
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
        });
      });

      await page.goto(BASE_URL, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      await fn(page, errors);
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      passed++;
    } catch (err) {
      console.log(`  \x1b[31m✗\x1b[0m ${name}`);
      console.log(`    \x1b[31m${err.message}\x1b[0m`);
      failed++;
    } finally {
      await context.close();
    }
  }

  // Helper: send a message and wait for full response
  async function sendAndWait(page, message) {
    await page.locator('#chatInput').fill(message);
    await page.locator('#sendBtn').click();

    // Wait for typing indicator to appear
    await page.locator('#typingIndicator').waitFor({ state: 'visible', timeout: 3000 });

    // Wait for response to complete (typing indicator gone, new bot message present)
    await page.waitForFunction(() => {
      return document.getElementById('typingIndicator') === null;
    }, { timeout: 15000 });

    // Small settle time for DOM updates
    await page.waitForTimeout(200);
  }

  console.log('\n\x1b[1mVitBot Interaction Tests (with Mock SSE Server)\x1b[0m\n');

  // ═══════════════════════════════════════════════
  // Single message round-trip
  // ═══════════════════════════════════════════════

  console.log('\x1b[36mSingle Message Round-Trip\x1b[0m');

  await test('sends message and receives streamed bot response', async (page) => {
    await sendAndWait(page, 'What is Liberland?');

    // Should have welcome + response = 2 bot messages
    const botMsgs = await page.locator('.bot-message-content').count();
    assert.strictEqual(botMsgs, 2, `Expected 2 bot messages, got ${botMsgs}`);

    // Response should contain streamed content
    const responseText = await page.locator('.bot-message-content').nth(1).textContent();
    assert.ok(responseText.includes('Free Republic of Liberland'), `Response missing key text. Got: ${responseText.slice(0, 80)}`);
    assert.ok(responseText.includes('Vít Jedlička'), 'Response should mention the founder');
  });

  await test('response renders markdown correctly', async (page) => {
    await sendAndWait(page, 'What is Liberland?');

    const responseEl = page.locator('.bot-message-content').nth(1);

    // Bold text should render as <strong>
    const strongCount = await responseEl.locator('strong').count();
    assert.ok(strongCount >= 1, `Expected bold text, found ${strongCount} <strong> elements`);

    const strongText = await responseEl.locator('strong').first().textContent();
    assert.ok(strongText.includes('Free Republic of Liberland'), `Bold text should be "Free Republic of Liberland", got "${strongText}"`);
  });

  await test('sources section appears with correct data', async (page) => {
    await sendAndWait(page, 'What is Liberland?');

    // Sources toggle should appear
    const sourcesToggle = page.locator('.sources-toggle');
    await sourcesToggle.waitFor({ state: 'visible', timeout: 3000 });

    const toggleText = await sourcesToggle.textContent();
    assert.ok(toggleText.includes('2'), `Should show 2 sources, got: "${toggleText.trim()}"`);

    // Click to expand sources
    await sourcesToggle.click();
    await page.waitForTimeout(400);

    // Check source cards
    const sourceCards = page.locator('.source-card');
    const cardCount = await sourceCards.count();
    assert.strictEqual(cardCount, 2, `Expected 2 source cards, got ${cardCount}`);

    // Verify source titles
    const firstTitle = await sourceCards.first().textContent();
    assert.ok(firstTitle.includes('About Liberland'), `First source should be "About Liberland", got: "${firstTitle.trim()}"`);
  });

  await test('sources section collapses and expands', async (page) => {
    await sendAndWait(page, 'What is Liberland?');

    const sourcesContent = page.locator('.sources-content');
    const sourcesToggle = page.locator('.sources-toggle');

    // Initially collapsed
    const initiallyExpanded = await sourcesContent.evaluate(el => el.classList.contains('expanded'));
    assert.strictEqual(initiallyExpanded, false, 'Sources should start collapsed');

    // Click to expand
    await sourcesToggle.click();
    await page.waitForTimeout(400);
    const afterExpand = await sourcesContent.evaluate(el => el.classList.contains('expanded'));
    assert.strictEqual(afterExpand, true, 'Sources should be expanded after click');

    // Click to collapse
    await sourcesToggle.click();
    await page.waitForTimeout(400);
    const afterCollapse = await sourcesContent.evaluate(el => el.classList.contains('expanded'));
    assert.strictEqual(afterCollapse, false, 'Sources should collapse on second click');
  });

  await test('user message appears in gold bubble', async (page) => {
    await sendAndWait(page, 'What is Liberland?');

    const userBubble = page.locator('.user-bubble');
    const count = await userBubble.count();
    assert.strictEqual(count, 1, 'Should have 1 user bubble');

    const text = await userBubble.textContent();
    assert.ok(text.includes('What is Liberland?'), 'User bubble should show sent text');

    // User bubble should be right-aligned (parent has justify-end)
    const parentClass = await userBubble.locator('..').locator('..').getAttribute('class');
    assert.ok(parentClass.includes('justify-end'), 'User message should be right-aligned');
  });

  await test('input clears and re-enables after response', async (page) => {
    await sendAndWait(page, 'What is Liberland?');

    const inputValue = await page.locator('#chatInput').inputValue();
    assert.strictEqual(inputValue, '', 'Input should be empty');

    const disabled = await page.locator('#chatInput').getAttribute('disabled');
    assert.strictEqual(disabled, null, 'Input should not be disabled');

    const focused = await page.locator('#chatInput').evaluate(el => document.activeElement === el);
    assert.strictEqual(focused, true, 'Input should be focused');
  });

  // ═══════════════════════════════════════════════
  // Multi-turn conversation
  // ═══════════════════════════════════════════════

  console.log('\n\x1b[36mMulti-Turn Conversation\x1b[0m');

  await test('three-turn conversation maintains message order', async (page) => {
    // Turn 1
    await sendAndWait(page, 'What is Liberland?');
    // Turn 2
    await sendAndWait(page, 'How does the blockchain work?');
    // Turn 3
    await sendAndWait(page, 'Tell me about citizenship');

    // Should have: welcome + 3 user + 3 bot = 7 items (welcome, user1, bot1, user2, bot2, user3, bot3)
    const userBubbles = await page.locator('.user-bubble').count();
    assert.strictEqual(userBubbles, 3, `Expected 3 user messages, got ${userBubbles}`);

    const botMessages = await page.locator('.bot-message-content').count();
    assert.strictEqual(botMessages, 4, `Expected 4 bot messages (welcome + 3 responses), got ${botMessages}`);

    // Verify messages are in correct order
    const allItems = page.locator('#messages > div');
    const itemCount = await allItems.count();

    // First item: welcome message (bot)
    const first = await allItems.nth(0).locator('.bot-message-content').count();
    assert.ok(first > 0, 'First item should be welcome message');

    // Verify each user message text
    const userTexts = await page.locator('.user-bubble').allTextContents();
    assert.ok(userTexts[0].includes('What is Liberland?'), 'First user message correct');
    assert.ok(userTexts[1].includes('How does the blockchain work?'), 'Second user message correct');
    assert.ok(userTexts[2].includes('Tell me about citizenship'), 'Third user message correct');

    await page.screenshot({ path: '/tmp/vitbot-e2e-multiturn.png', fullPage: true });
  });

  await test('each response has distinct content', async (page) => {
    await sendAndWait(page, 'What is Liberland?');
    await sendAndWait(page, 'How does the blockchain work?');
    await sendAndWait(page, 'Tell me about citizenship');

    // Grab all bot response texts (skip welcome at index 0)
    const botTexts = await page.locator('.bot-message-content').allTextContents();
    const response1 = botTexts[1];
    const response2 = botTexts[2];
    const response3 = botTexts[3];

    // Each should have unique content
    assert.ok(response1.includes('Danube'), 'Response 1 should mention the Danube');
    assert.ok(response2.includes('substrate'), 'Response 2 should mention substrate blockchain');
    assert.ok(response3.includes('merit-based'), 'Response 3 should mention merit-based citizenship');

    // Verify they're actually different
    assert.notStrictEqual(response1, response2, 'Responses should be different');
    assert.notStrictEqual(response2, response3, 'Responses should be different');
  });

  await test('each turn has its own sources section', async (page) => {
    await sendAndWait(page, 'What is Liberland?');
    await sendAndWait(page, 'How does the blockchain work?');

    const sourceToggles = await page.locator('.sources-toggle').allTextContents();
    assert.strictEqual(sourceToggles.length, 2, `Expected 2 source toggles, got ${sourceToggles.length}`);

    // First response: 2 sources, second: 3 sources
    assert.ok(sourceToggles[0].includes('2'), `First should have 2 sources: "${sourceToggles[0].trim()}"`);
    assert.ok(sourceToggles[1].includes('3'), `Second should have 3 sources: "${sourceToggles[1].trim()}"`);
  });

  await test('multi-turn shows mixed source types (doc + transcript)', async (page) => {
    await sendAndWait(page, 'How does the blockchain work?');

    // Expand sources
    await page.locator('.sources-toggle').click();
    await page.waitForTimeout(400);

    const html = await page.locator('.sources-content').innerHTML();
    assert.ok(html.includes('Doc'), 'Should have Doc badge');
    assert.ok(html.includes('Speech'), 'Should have Speech badge for transcript source');
  });

  await test('chat scrolls to bottom on each new message', async (page) => {
    await sendAndWait(page, 'What is Liberland?');
    await sendAndWait(page, 'How does the blockchain work?');
    await sendAndWait(page, 'Tell me about citizenship');

    // The last message should be visible
    const lastBot = page.locator('.bot-message-content').last();
    const isVisible = await lastBot.isVisible();
    assert.ok(isVisible, 'Last bot message should be visible (scrolled into view)');

    // Check scroll position is near bottom
    const scrollInfo = await page.evaluate(() => {
      const el = document.getElementById('chatArea');
      return {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
    });
    const distFromBottom = scrollInfo.scrollHeight - scrollInfo.scrollTop - scrollInfo.clientHeight;
    assert.ok(distFromBottom < 50, `Should be scrolled to bottom, but ${distFromBottom}px away`);
  });

  // ═══════════════════════════════════════════════
  // Suggested question chip interaction
  // ═══════════════════════════════════════════════

  console.log('\n\x1b[36mSuggested Question Chips\x1b[0m');

  await test('clicking chip sends message and gets response', async (page) => {
    // Click first chip
    const chipText = await page.locator('#suggestedQuestions button').first().textContent();
    await page.locator('#suggestedQuestions button').first().click();

    // Wait for response
    await page.waitForFunction(() => {
      return document.getElementById('typingIndicator') === null &&
             document.querySelectorAll('.bot-message-content').length >= 2;
    }, { timeout: 15000 });
    await page.waitForTimeout(200);

    // Chips should be gone
    const chipsAfter = await page.locator('#suggestedQuestions').count();
    assert.strictEqual(chipsAfter, 0, 'Chips should disappear after click');

    // User message + bot response should appear
    const userBubbles = await page.locator('.user-bubble').count();
    assert.strictEqual(userBubbles, 1, 'Should show user message from chip');

    const botMsgs = await page.locator('.bot-message-content').count();
    assert.strictEqual(botMsgs, 2, 'Should have welcome + response');
  });

  await test('chips disappear and do not return after any message', async (page) => {
    await sendAndWait(page, 'What is Liberland?');

    const chips = await page.locator('#suggestedQuestions').count();
    assert.strictEqual(chips, 0, 'Chips gone after first message');

    // Send another — chips should not reappear
    await sendAndWait(page, 'How does the blockchain work?');
    const chipsStill = await page.locator('#suggestedQuestions').count();
    assert.strictEqual(chipsStill, 0, 'Chips should not reappear');
  });

  // ═══════════════════════════════════════════════
  // Markdown rendering in responses
  // ═══════════════════════════════════════════════

  console.log('\n\x1b[36mMarkdown Rendering\x1b[0m');

  await test('renders bullet lists from response', async (page) => {
    await sendAndWait(page, 'How does the blockchain work?');

    const responseEl = page.locator('.bot-message-content').nth(1);
    const listItems = await responseEl.locator('li').count();
    assert.ok(listItems >= 3, `Expected at least 3 list items, got ${listItems}`);
  });

  await test('renders numbered lists from response', async (page) => {
    await sendAndWait(page, 'Tell me about citizenship');

    const responseEl = page.locator('.bot-message-content').nth(1);
    const olItems = await responseEl.locator('ol li').count();
    assert.ok(olItems >= 4, `Expected at least 4 numbered items, got ${olItems}`);
  });

  await test('renders bold text within lists', async (page) => {
    await sendAndWait(page, 'How does the blockchain work?');

    const responseEl = page.locator('.bot-message-content').nth(1);
    const boldInList = await responseEl.locator('li strong').count();
    assert.ok(boldInList >= 1, `Expected bold text in list items, got ${boldInList}`);
  });

  await test('renders paragraphs with line breaks', async (page) => {
    await sendAndWait(page, 'What is Liberland?');

    const responseEl = page.locator('.bot-message-content').nth(1);
    const paragraphs = await responseEl.locator('p').count();
    assert.ok(paragraphs >= 2, `Expected multiple paragraphs, got ${paragraphs}`);
  });

  // ═══════════════════════════════════════════════
  // Edge cases & resilience
  // ═══════════════════════════════════════════════

  console.log('\n\x1b[36mEdge Cases & Resilience\x1b[0m');

  await test('rapid successive clicks are blocked while streaming', async (page) => {
    await page.locator('#chatInput').fill('What is Liberland?');
    await page.locator('#sendBtn').click();

    // Wait for streaming to start
    await page.waitForTimeout(50);

    // Verify the guard state: isStreaming should be true, input should be disabled
    const isDisabled = await page.locator('#chatInput').evaluate(el => el.disabled);
    assert.ok(isDisabled, 'Input should be disabled while streaming');

    // Try clicking send again — even with text, it should not work
    const canSend = await page.evaluate(() => {
      const app = document.querySelector('#app');
      // Check internal state via DOM: isStreaming blocks handleSend
      const input = document.getElementById('chatInput');
      return !input.disabled;
    });
    assert.strictEqual(canSend, false, 'Input should remain disabled during streaming');

    // Wait for response to complete
    await page.waitForFunction(() => {
      return document.getElementById('typingIndicator') === null;
    }, { timeout: 15000 });
    await page.waitForTimeout(200);

    // Only 1 user message should exist
    const userBubbles = await page.locator('.user-bubble').count();
    assert.strictEqual(userBubbles, 1, `Should only have 1 user message, got ${userBubbles}`);

    // Input should now be re-enabled
    const isEnabledAfter = await page.locator('#chatInput').evaluate(el => !el.disabled);
    assert.ok(isEnabledAfter, 'Input should be re-enabled after streaming completes');
  });

  await test('XSS in user input is sanitised', async (page) => {
    await sendAndWait(page, '<img src=x onerror=alert(1)>');

    const userBubble = page.locator('.user-bubble').last();
    const html = await userBubble.innerHTML();
    assert.ok(!html.includes('<img'), 'Should not contain raw img tag');
    assert.ok(html.includes('&lt;img'), 'Should contain escaped img tag');
  });

  await test('very long message does not break layout', async (page) => {
    const longMsg = 'What is Liberland? '.repeat(50);
    await sendAndWait(page, longMsg);

    // Layout should still be intact
    const header = await page.locator('header').isVisible();
    assert.ok(header, 'Header should still be visible');

    const chatArea = await page.locator('#chatArea').isVisible();
    assert.ok(chatArea, 'Chat area should still be visible');

    // User bubble should not overflow
    const bubbleBox = await page.locator('.user-bubble').boundingBox();
    const chatBox = await page.locator('#chatArea').boundingBox();
    assert.ok(bubbleBox.width <= chatBox.width, 'User bubble should not exceed chat width');
  });

  // ═══════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════

  const total = passed + failed;
  const color = failed === 0 ? '\x1b[32m' : '\x1b[31m';
  console.log(`\n${color}${total} tests, ${passed} passed, ${failed} failed\x1b[0m\n`);

  await browser.close();
  mockServer.close();

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
