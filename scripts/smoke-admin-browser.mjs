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
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#login-form input[name="password"]', { timeout: 20_000 });
  await page.waitForFunction(() => window.__neurobotLoginBootstrap === true, { timeout: 20_000 });

  const initialState = await page.evaluate(() => ({
    readyState: document.readyState,
    loginHidden: document.querySelector('#login-view')?.classList.contains('hidden') ?? null,
    panelHidden: document.querySelector('#panel-view')?.classList.contains('hidden') ?? null,
    loginBootstrap: window.__neurobotLoginBootstrap === true,
    authenticated: window.__neurobotAuthenticated === true,
    appScript: [...document.scripts].some((script) => script.src.endsWith('/app.js')),
  }));
  record('initial-ui', JSON.stringify(initialState));

  await page.type('#login-form input[name="password"]', password);

  const loginResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST',
    { timeout: 30_000 },
  );
  const verifiedSessionPromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/auth/session' &&
      response.request().method() === 'GET' &&
      response.status() === 200,
    { timeout: 30_000 },
  );
  const reloadPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 });

  await page.click('#login-form button[type="submit"]');
  const loginResponse = await loginResponsePromise;
  record('login-http', String(loginResponse.status()));

  if (loginResponse.status() !== 200) {
    let loginBody = {};
    try {
      loginBody = await loginResponse.json();
    } catch {
      // El estado HTTP basta para el diagnóstico.
    }
    record('login-body', JSON.stringify(loginBody));
    throw new Error(`El navegador recibió HTTP ${loginResponse.status()} en /api/auth/login.`);
  }

  const verifiedSessionResponse = await verifiedSessionPromise;
  record('verified-session-http', String(verifiedSessionResponse.status()));
  await reloadPromise;

  await page.waitForFunction(
    () => window.__neurobotLoginBootstrap === true && window.__neurobotAuthenticated === true,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('#panel-view');
      return panel && !panel.classList.contains('hidden');
    },
    { timeout: 60_000 },
  );
  await page.waitForFunction(() => window.__neurobotPanelRuntimeLoaded === true, {
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => {
      const target = document.querySelector('#bots-list');
      return target && target.childElementCount > 0;
    },
    { timeout: 60_000 },
  );

  const finalState = await page.evaluate(async () => {
    const sessionResponse = await fetch('/api/auth/session', { cache: 'no-store' });
    const botsResponse = await fetch('/api/bots', { cache: 'no-store' });
    const automationForm = document.querySelector('#automatic-messages-form');
    const requiredAutomationFields = [
      'greeting_monday',
      'greeting_weekday',
      'greeting_friday',
      'greeting_weekend',
      'rules_template',
    ];
    const automaticMessagesReady =
      automationForm instanceof HTMLFormElement &&
      requiredAutomationFields.every((name) => automationForm.elements.namedItem(name) !== null);
    // Los controles de encuestas se asocian por form= al formulario propietario, así que se
    // comprueban a través de form.elements y no como descendientes. El botón de guardar no debe
    // pertenecer nunca al formulario general (ese era el bug del formulario anidado).
    const pollForm = document.querySelector('#poll-automation-form');
    const saveButton = document.querySelector('#save-poll-automation');
    const pollFields = [
      'poll_start_time',
      'poll_interval_hours',
      'poll_quiet_hours_enabled',
      'poll_quiet_hours_start',
      'poll_quiet_hours_end',
    ];
    const pollAutomationReady =
      pollForm instanceof HTMLFormElement &&
      !automationForm.contains(pollForm) &&
      pollFields.every((name) => pollForm.elements.namedItem(name) !== null) &&
      saveButton instanceof HTMLButtonElement &&
      saveButton.form === pollForm &&
      saveButton.form !== automationForm &&
      document.querySelectorAll('form form').length === 0;
    return {
      href: window.location.href,
      readyState: document.readyState,
      loginBootstrap: window.__neurobotLoginBootstrap === true,
      authenticated: window.__neurobotAuthenticated === true,
      panelRuntimeLoaded: window.__neurobotPanelRuntimeLoaded === true,
      automaticMessagesReady,
      pollAutomationReady,
      loginHidden: document.querySelector('#login-view')?.classList.contains('hidden') ?? null,
      panelHidden: document.querySelector('#panel-view')?.classList.contains('hidden') ?? null,
      botCards: document.querySelector('#bots-list')?.childElementCount ?? -1,
      sessionStatus: sessionResponse.status,
      botsStatus: botsResponse.status,
    };
  });

  if (finalState.panelRuntimeLoaded !== true) {
    throw new Error('ADMIN_PANEL_RUNTIME_NOT_LOADED');
  }
  if (finalState.automaticMessagesReady !== true) {
    throw new Error('AUTOMATIC_MESSAGES_FORM_NOT_REPAIRED');
  }
  if (finalState.pollAutomationReady !== true) {
    throw new Error('POLL_AUTOMATION_PANEL_NOT_READY');
  }
  if (diagnostics.some((entry) => entry.includes('ADMIN_PANEL_RUNTIME_LOAD_FAILED'))) {
    throw new Error('ADMIN_PANEL_RUNTIME_LOAD_FAILED_RECORDED');
  }

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
