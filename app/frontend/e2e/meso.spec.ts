import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('Meso Canvas builds selected context and hands it to chat', async ({ page }) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-meso-e2e-'))
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Meso Proof\nSelectable context.\n', 'utf8')
  fs.writeFileSync(path.join(workspace, 'STATE.md'), '# STATE\nFocus: prove Meso.\n', 'utf8')

  await page.goto('/')
  await page.getByPlaceholder(/workspace path/).fill(workspace)
  await page.getByRole('button', { name: '+ Add workspace' }).click()

  await expect(page.getByRole('button', { name: path.basename(workspace) })).toBeVisible()
  await page.getByRole('button', { name: 'meso', exact: true }).click()
  await expect(page.getByText('Meso Canvas')).toBeVisible()
  await expect(page.locator('.react-flow__node').filter({ hasText: 'README.md' }).first()).toBeVisible()

  await page.getByTestId('meso-select-doc:README.md').click()
  await expect(page.getByText('1 selected')).toBeVisible()
  await page.getByRole('button', { name: 'Build context' }).click()
  await expect(page.getByText(/1 node\(s\) selected/)).toBeVisible()
  await page.getByRole('button', { name: 'Ask about selected' }).click()

  await page.getByRole('button', { name: 'Meso context ready' }).click()
  await expect(page.getByPlaceholder(/Reply, or ask Vivary/)).toHaveValue(/Use this Meso Canvas selection/)
})
