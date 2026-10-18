import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { waitForConversationViewport } from './conversation-viewport.mjs';

test('readiness waits for the marker inside the clipped conversation viewport', async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="conversation" style="height:100px;overflow:auto"><div style="height:500px"></div><p>Final message</p></div>');
    const marker = page.getByText('Final message', { exact: true });
    assert.equal(await marker.isVisible(), true, 'Playwright visibility alone accepts a clipped marker');
    await assert.rejects(waitForConversationViewport(marker, 100), /viewport/);
    await page.locator('#conversation').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await waitForConversationViewport(marker, 1000);
  } finally {
    await browser.close();
  }
});
