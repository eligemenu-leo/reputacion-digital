/**
 * Prueba end-to-end de la Fase 1 contra el stack local REAL:
 *   supabase start  ·  API (apps/api, puerto 8787)  ·  web (vite, puerto 5173)
 * Crea un superadministrador nuevo por ejecución con el script real de bootstrap
 * (necesita apps/api/.env apuntando al stack local).
 *
 *   MAILPIT_URL=http://127.0.0.1:54324 node e2e/phase1-smoke.mjs
 *
 * Cubre: login, alta MFA TOTP, creación de organización con invitación por email
 * (Mailpit), aceptación de invitación, MFA del administrador, alta de cliente y
 * ubicación, aislamiento entre organizaciones, auditoría y modo oscuro.
 */
import { createRequire } from 'node:module';
// Playwright se resuelve desde la instalación global (CI/entorno con navegadores preinstalados).
const { chromium } = createRequire(import.meta.url)('playwright');
import { execFileSync } from 'node:child_process';
import { totp } from './totp.mjs';

const BASE = process.env.WEB_URL ?? 'http://localhost:5173';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324';
const SHOTS = process.env.SHOTS_DIR ?? './e2e-shots';
const run = Date.now().toString(36);
const SA_EMAIL = `superadmin-${run}@demo.test`;
const SA_PASS = 'Superadmin-Demo-2026';
execFileSync(
  'pnpm',
  ['--filter', '@rep/api', 'bootstrap:superadmin', '--email', SA_EMAIL, '--password', SA_PASS],
  { stdio: 'ignore' },
);
const ADMIN_EMAIL = `admin-${run}@demo.test`;
const ADMIN_PASS = 'Admin-Demo-2026-segura';

const log = (m) => console.log(`✓ ${m}`);
const fail = (m) => {
  throw new Error(m);
};

async function waitForInviteLink(email) {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    ).then((x) => x.json());
    const msg = r.messages?.[0];
    if (msg) {
      const full = await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`).then((x) => x.json());
      const link =
        (full.HTML ?? full.Text).match(/href="([^"]+)"/)?.[1] ??
        full.Text.match(/https?:\/\/\S+/)?.[0];
      return link.replace(/&amp;/g, '&');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`No llegó el email de invitación a ${email}`);
}

async function enrollMfa(page) {
  await page.getByRole('button', { name: 'Activar', exact: true }).click();
  const secret = (await page.locator('code').first().textContent()).trim();
  await page.getByLabel('Código de 6 dígitos').fill(totp(secret));
  await page.getByRole('button', { name: 'Verificar y activar' }).click();
  await page.getByText('Activada', { exact: true }).waitFor();
  return secret;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  // 1. Login superadmin
  await page.goto(`${BASE}/login`);
  await page.screenshot({ path: `${SHOTS}/01-login.png` });
  await page.getByLabel(/Email/).fill(SA_EMAIL);
  await page.getByLabel(/Contraseña/).fill(SA_PASS);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByRole('heading', { name: 'Administración de plataforma' }).waitFor();
  log('Login de superadministrador');

  // 2. Crear organización sin MFA → debe exigir MFA
  await page.getByRole('button', { name: /Nueva organización/ }).click();
  await page.getByLabel(/^Nombre/).fill(`Agencia Demo ${run}`);
  await page.getByLabel(/Email del administrador/).fill(ADMIN_EMAIL);
  await page.getByRole('button', { name: 'Crear' }).click();
  await page.getByText(/verificación en dos pasos/).waitFor();
  log('Crear organización sin MFA se bloquea (MFA_REQUIRED)');
  await page.keyboard.press('Escape');

  // 3. Activar MFA del superadmin
  await page.goto(`${BASE}/cuenta`);
  await enrollMfa(page);
  log('MFA TOTP activado (sesión elevada a aal2)');

  // 4. Crear organización → invitación real por email
  await page.goto(`${BASE}/admin`);
  await page.getByRole('button', { name: /Nueva organización/ }).click();
  await page.getByLabel(/^Nombre/).fill(`Agencia Demo ${run}`);
  await page.getByLabel(/Email del administrador/).fill(ADMIN_EMAIL);
  await page.getByRole('button', { name: 'Crear' }).click();
  await page.getByText('Organización creada').waitFor();
  await page.screenshot({ path: `${SHOTS}/02-admin-orgs.png` });
  log('Organización creada e invitación enviada');

  // 5. Aceptar invitación en un contexto limpio
  const link = await waitForInviteLink(ADMIN_EMAIL);
  const ctx2 = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(link);
  await p2.getByRole('heading', { name: 'Nueva contraseña' }).waitFor({ timeout: 15000 });
  await p2.getByLabel('Contraseña', { exact: false }).first().fill(ADMIN_PASS);
  await p2.getByLabel('Repite la contraseña').fill(ADMIN_PASS);
  await p2.getByRole('button', { name: 'Guardar y entrar' }).click();
  await p2.getByRole('heading', { name: 'Panel' }).waitFor();
  await p2.screenshot({ path: `${SHOTS}/03-dashboard-empty.png` });
  log('Invitación aceptada; el administrador entra en el panel de su organización');

  // 6. MFA del administrador y alta de cliente
  await p2.getByRole('link', { name: 'Configuración' }).click();
  await enrollMfa(p2);
  await p2.getByRole('link', { name: 'Clientes', exact: true }).click();
  await p2
    .getByRole('button', { name: /Nuevo cliente/ })
    .first()
    .click();
  await p2.getByLabel(/Nombre comercial/).fill('Restaurante La Brasa (ficticio)');
  await p2.getByLabel(/Sector/).fill('Hostelería');
  await p2.getByLabel(/^Web/).fill('https://labrasa.example');
  await p2
    .getByLabel(/Información verificada/)
    .fill('Abierto de martes a domingo, 13:00–16:00 y 20:00–23:30. Terraza climatizada.');
  await p2.screenshot({ path: `${SHOTS}/04-client-form.png` });
  await p2.getByRole('button', { name: 'Crear cliente' }).click();
  await p2.getByRole('heading', { name: 'Restaurante La Brasa (ficticio)' }).waitFor();
  log('Cliente creado');

  await p2.getByRole('tab', { name: 'Ubicaciones' }).click();
  await p2.getByRole('button', { name: 'Añadir' }).click();
  await p2.getByLabel(/^Nombre/).fill('Local Centro');
  await p2.getByLabel(/Ciudad/).fill('Oviedo');
  await p2.getByRole('switch', { name: 'Ubicación principal' }).click();
  await p2.getByRole('button', { name: 'Guardar' }).click();
  await p2.getByText('Ubicación añadida').waitFor();
  await p2.screenshot({ path: `${SHOTS}/05-client-locations.png` });
  log('Ubicación añadida');

  // 7. Auditoría y panel con datos reales
  await p2.getByRole('link', { name: 'Auditoría' }).click();
  await p2
    .getByText(/creó cliente/)
    .first()
    .waitFor();
  await p2.screenshot({ path: `${SHOTS}/06-audit.png` });
  await p2.getByRole('link', { name: 'Panel', exact: true }).click();
  await p2.getByText('Restaurante La Brasa (ficticio)').waitFor();
  await p2.screenshot({ path: `${SHOTS}/07-dashboard.png` });
  log('Auditoría y panel reflejan los cambios');

  // 8. Aislamiento: el admin de la nueva organización no accede a otra organización
  const token = await p2.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.includes('auth-token'));
    return JSON.parse(localStorage.getItem(k)).access_token;
  });
  const orgs = await fetch('http://localhost:8787/v1/organizations', {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  if (orgs.length !== 1) fail(`El administrador ve ${orgs.length} organizaciones`);
  log('El administrador solo ve su organización');

  // 9. Modo oscuro y móvil
  await p2.getByRole('button', { name: /modo oscuro/ }).click();
  await p2.getByRole('link', { name: 'Clientes', exact: true }).click();
  await p2.getByRole('table').waitFor();
  await p2.screenshot({ path: `${SHOTS}/08-clients-dark.png` });
  await p2.setViewportSize({ width: 390, height: 844 });
  await p2.screenshot({ path: `${SHOTS}/09-clients-mobile.png` });
  log('Modo oscuro y vista móvil');

  if (errors.length) fail(`Errores de JavaScript en página: ${errors.join(' | ')}`);
  console.log('\nE2E Fase 1: OK');
} catch (e) {
  await page.screenshot({ path: `${SHOTS}/zz-failure-sa.png` }).catch(() => {});
  for (const c of browser.contexts())
    for (const p of c.pages())
      await p
        .screenshot({ path: `${SHOTS}/zz-failure-${Math.random().toString(36).slice(2, 6)}.png` })
        .catch(() => {});
  console.error('✗', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
