import { test, expect } from '@playwright/test';

test('source blocks and separate node conversations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'createServer()' })).toBeVisible();
  await page.getByRole('tab', { name: 'Source', exact: true }).click();
  await page.getByRole('button', { name: 'Select line 17', exact: true }).click();
  await page.getByRole('button', { name: 'Select line 19', exact: true }).click();
  await page.getByRole('button', { name: 'Ask about this', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ask about this node' }).fill('Explain this source block.');
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect(page.getByText('Selected block:', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Expand src/pricing.ts', exact: true }).click();
  await page.getByRole('button', { name: 'ƒ calculateTotal', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A question worth asking.' })).toBeVisible();
  await page.getByRole('button', { name: 'ƒ createServer', exact: true }).click();
  await expect(page.getByText('Explain this source block.', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: /^Ask/ }).click();
  await expect(page.getByText('Explain this source block.', { exact: true })).toBeVisible();
});

test('model administration and responsive map controls', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose AI model', exact: true }).click();
  await page.getByRole('button', { name: 'Manage models', exact: true }).click();
  await expect(page.getByText('Local structural analysis · no LLM')).toBeVisible();
  await page.getByRole('button', { name: 'Add model', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Provider model ID', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: '2D', exact: true }).click();
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'See how it all connects.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open settings', exact: true })).toBeVisible();
});
