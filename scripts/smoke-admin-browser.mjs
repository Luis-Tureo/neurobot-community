/* eslint-disable no-undef */
import process from 'node:process';
import puppeteer from 'puppeteer';

const baseUrl = process.env.NEUROBOT_SMOKE_URL;
const password = process.env.NEUROBOT_SMOKE_PASSWORD;

if (!baseUrl || !password) {
  throw new Error('Faltan NEUROBOT_SMOKE_URL o NEUROBOT_SMOKE_PASSWORD.');
}

const diagnostics = [];
let browser;

function record(type, detail) {
  const safe = String(detail)
    .replaceAll(password, '[REDACTED]')
    .slice(0, 2000);
  diagnostics.push(`${type}: ${safe}`);
}

try {
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setCacheEnabled(false);

  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      record(`console.${message.type()}`, message.text());
    }
  });
  page.on('pageerror', (error) => record('pageerror', error.stack || error.message));
  page.on('requestfailed', (request) => {
    record('requestfailed', `${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      record('http', `${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  const target = new URL('/#assistants', baseUrl).href;
  await page.goto(target, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.waitForSelector('#login-form input[name="password"]', { timeout: 15_000 });

  const initialState = await page.evaluate(() => ({
    loginHidden: document.querySelector('#login-view')?.classList.contains('hidden') ?? null,
    panelHidden: document.querySelector('#panel-view')?.classList.contains('hidden') ?? null,
    appScript: [...document.scripts].some((script) => script.src.endsWith('/app.js')),
    moduleScripts: [...document.scripts]
      .filter((script) => script.type === 'module')
      .map((script) => new URL(script.src).pathname),
  }));
  record('initial-ui', JSON.stringify(initialState));

  await page.type('#login-form input[name="password"]', password);

  const loginResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST',
    { timeout: 20_000 },
  );

  await page.click('#login-form button[type="submit"]');
  const loginResponse = await loginResponsePromise;
  record('login-http', String(loginResponse.status()));

  let loginBody = {};
  try {
    loginBody = await loginResponse.json();
  } catch {
    // El estado HTTP basta para el diagnóstico.
  }
  if (loginResponse.status() !== 200) {
    record('login-body', JSON.stringify(loginBody));
    throw new Error(`El navegador recibió HTTP ${loginResponse.status()} en /api/auth/login.`);
  }

  await page.waitForFunction(
    () => {
      const panel = document.querySelector('#panel-view');
      return panel && !panel.classList.contains('hidden');
    },
    { timeout: 20_000 },
  );

  await page.waitForFunction(
    () => {
      const target = document.querySelector('#bots-list');
      return target && target.childElementCount > 0;
    },
    { timeout: 20_000 },
  );

  const finalState = await page.evaluate(async () => {
    const sessionResponse = await fetch('/api/auth/session', { cache: 'no-store' });
    const botsResponse = await fetch('/api/bots', { cache: 'no-store' });
    return {
      href: window.location.href,
      loginHidden: document.querySelector('#login-view')?.classList.contains('hidden') ?? null,
      panelHidden: document.querySelector('#panel-view')?.classList.contains('hidden') ?? null,
      botCards: document.querySelector('#bots-list')?.childElementCount ?? -1,
      sessionStatus: sessionResponse.status,
      botsStatus: botsResponse.status,
    };
  });

  console.log(`BROWSER_AUTH_DIAGNOSTIC=OK ${JSON.stringify(finalState)}`);
  if (diagnostics.length > 0) {
    console.log('BROWSER_AUTH_NON_FATAL_DIAGNOSTICS_START');
    diagnostics.forEach((entry) => console.log(entry));
    console.log('BROWSER_AUTH_NON_FATAL_DIAGNOSTICS_END');
  }
} catch (error) {
  console.error(`BROWSER_AUTH_DIAGNOSTIC=FAILED ${error instanceof Error ? error.message : String(error)}`);
  diagnostics.forEach((entry) => console.error(entry));
  process.exitCode = 1;
} finally {
  await browser?.close();
}
