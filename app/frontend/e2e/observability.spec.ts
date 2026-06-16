import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('fixture runtime renders structured receipts and approval decisions', async ({ page }) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-gui-e2e-'))
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Vivary\nA fixture workspace.\n', 'utf8')
  fs.writeFileSync(path.join(workspace, 'STATE.md'), '# Current\nFixture workspace for observability testing.\n', 'utf8')
  fs.writeFileSync(path.join(workspace, 'tropo.toml'), [
    'version = 1',
    '',
    '[base]',
    'derive = ["id", "title", "created", "updated"]',
    'allow_untyped = true',
    'strict = false',
    '',
  ].join('\n'), 'utf8')

  await page.goto('/')
  await page.getByPlaceholder(/workspace path/).fill(workspace)
  await page.getByRole('button', { name: '+ Add workspace' }).click()

  await expect(page.getByRole('button', { name: new RegExp(path.basename(workspace)) })).toBeVisible()
  await expect(page.getByText(/no tropo\.toml/i)).not.toBeVisible()
  await expect(page.locator('select')).toContainText('Fixture (test)')
  await page.locator('select').first().selectOption('fixture')

  await page.getByPlaceholder(/Reply, or ask Vivary/).fill('approval proof')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByText(/Structured fixture answer for: approval proof/)).toBeVisible()
  await expect(page.getByText('# Vivary')).not.toBeVisible()
  await page.getByRole('button', { name: /Read README.md/ }).click()
  await expect(page.getByText('# Vivary')).toBeVisible()

  await expect(page.getByText('Approval needed')).toBeVisible()
  await page.getByRole('button', { name: 'Allow once' }).click()
  await expect(page.getByText('Approval approved')).toBeVisible()

  await page.getByRole('button', { name: 'Compact' }).click()
  await expect(page.getByRole('button', { name: 'Compact' })).toHaveAttribute('aria-pressed', 'true')
})
