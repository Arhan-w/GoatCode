import { expect, test } from 'bun:test';
import { fetch } from 'bun';

test('web server health check', async () => {
  const response = await fetch('http://localhost:3000/health');
  const data = await response.json();
  expect(data.status).toBe('ok');
  expect(data.version).toBeTruthy();
});

test('web server root page', async () => {
  const response = await fetch('http://localhost:3000/');
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('<title>Goated AI</title>');
});