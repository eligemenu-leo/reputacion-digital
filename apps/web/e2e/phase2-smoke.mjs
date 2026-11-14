/**
 * Prueba end-to-end de la Fase 2 contra el stack local REAL:
 *   supabase start · API (dist/server.js, :8787) · worker (dist/worker.js, pg-boss) · web (vite, :5173)
 *
 *   node e2e/phase2-smoke.mjs
 *
 * Prepara una organización ficticia con tres personas (administradora, gestor y
 * aprobadora) creando usuarios reales en Supabase Auth, y recorre:
 * fuente simulada → sincronización por el worker → bandeja (filtros, lotes) →
 * borrador → aprobación desde móvil → publicación y verificación por el worker →
 * invalidación de la aprobación al editar → panel con datos reales.
 * Todos los datos son ficticios y se muestran como «Simulado».
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const { chromium } = createRequire(import.meta.url)('playwright');
const postgres = createRequire(new URL('../../api/package.json', import.meta.url))('postgres');

const BASE = process.env.WEB_URL ?? 'http://localhost:5173';
const SHOTS = process.env.SHOTS_DIR ?? './e2e-shots';
const env = Object.fromEntries(
  readFileSync(new URL('../../api/.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const run = Date.now().toString(36);
const PASS = 'Demo-Fase2-2026-segura';
const log = (m) => console.log(`✓ ${m}`);
const fail = (m) => {
  throw new Error(m);
};

// ---------------------------------------------------------------------------
// Preparación de datos (usuarios reales de Supabase Auth, organización ficticia)
// ---------------------------------------------------------------------------
const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
async function createUser(name) {
  const email = `${name}-${run}@demo.test`;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password: PASS,
      email_confirm: true,
      user_metadata: { full_name: `${name[0].toUpperCase()}${name.slice(1)} (ficticio)` },
    }),
  });
  if (!res.ok) fail(`No se pudo crear ${email}: ${await res.text()}`);
  const { id } = await res.json();
  await sql`update public.profiles set full_name = ${`${name[0].toUpperCase()}${name.slice(1)} (ficticio)`} where id = ${id}`;
  return { id, email };
}
const admin = await createUser('admin');
const manager = await createUser('gestor');
const approver = await createUser('aprobadora');
const role = async (k) =>
  (await sql`select id from public.roles where key = ${k} and is_system`)[0].id;
const [org] = await sql`
  insert into public.organizations (name, slug) values (${`Agencia Fase 2 ${run}`}, ${`fase2-${run}`}) returning id`;
await sql`insert into public.organization_members (organization_id, user_id, role_id, all_clients_access, status) values
  (${org.id}, ${admin.id}, ${await role('org_admin')}, true, 'active'),
  (${org.id}, ${manager.id}, ${await role('account_manager')}, false, 'active'),
  (${org.id}, ${approver.id}, ${await role('account_manager')}, false, 'active')`;
const [client] = await sql`
  insert into public.clients (organization_id, name, sector, status)
  values (${org.id}, 'Restaurante La Brasa (ficticio)', 'Hostelería', 'active') returning id`;
await sql`insert into public.client_locations (organization_id, client_id, name, city, is_primary)
  values (${org.id}, ${client.id}, 'Local Centro', 'Oviedo', true)`;
await sql`insert into public.client_members (organization_id, client_id, user_id, role_id) values
  (${org.id}, ${client.id}, ${manager.id}, null),
  (${org.id}, ${client.id}, ${approver.id}, ${await role('approver')})`;

const browser = await chromium.launch();
const errors = [];
async function login(user, viewport = { width: 1360, height: 860 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/login`);
  await page.getByLabel(/Email/).fill(user.email);
  await page.getByLabel(/Contraseña/).fill(PASS);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByRole('heading', { name: 'Panel' }).waitFor();
  return page;
}
const base = `/o/${org.id}`;

try {
  // 1. Fuente simulada + sincronización real por el worker
  const pa = await login(admin);
  await pa.getByRole('link', { name: 'Fuentes conectadas' }).click();
  await pa.getByText('Google Business Profile').waitFor();
  await pa.getByRole('button', { name: /Fuente simulada/ }).click();
  await pa.getByLabel(/^Cliente/).selectOption(client.id);
  await pa.getByRole('button', { name: 'Crear y sincronizar' }).click();
  await pa.getByText(/12 nuevas/).waitFor({ timeout: 30000 });
  await pa.screenshot({ path: `${SHOTS}/f2-01-fuentes.png` });
  log('Fuente simulada creada y sincronizada por el worker (12 reseñas ficticias)');

  // 2. Bandeja: listado, filtros, búsqueda y lotes
  await pa.getByRole('link', { name: 'Bandeja', exact: true }).click();
  await pa.getByRole('heading', { name: 'Bandeja' }).waitFor();
  await pa.getByText(/12 resultados/).waitFor();
  const count = await pa.locator('li a[href*="/bandeja/"]').count();
  if (count !== 12) fail(`La bandeja muestra ${count} interacciones, se esperaban 12`);
  await pa.screenshot({ path: `${SHOTS}/f2-02-bandeja.png` });
  await pa.getByLabel('Prioridad', { exact: true }).selectOption('4');
  await pa.getByText(/2 resultados/).waitFor();
  await pa.getByText('Legal').first().waitFor();
  await pa.getByLabel('Prioridad', { exact: true }).selectOption({ label: 'Cualquier prioridad' });
  await pa.getByText(/12 resultados/).waitFor();
  await pa.getByLabel('Buscar en la bandeja').fill('gluten');
  await pa.getByText(/1 resultados/).waitFor();
  await pa.getByLabel('Buscar en la bandeja').fill('');
  await pa.getByText(/12 resultados/).waitFor();
  log('Filtro por prioridad y búsqueda de texto');

  await pa.getByLabel(/Seleccionar reseña de Raúl/).check();
  await pa.getByLabel(/Seleccionar reseña de Javier/).check();
  await pa.getByRole('button', { name: 'Asignarme' }).click();
  await pa.getByText('2 actualizadas').waitFor();
  await pa.getByRole('button', { name: /Asignadas a mí/ }).click();
  await pa.getByText(/2 resultados/).waitFor();
  await pa.getByRole('button', { name: /Asignadas a mí/ }).click();
  log('Acción por lotes (asignación) y filtro «asignadas a mí»');

  // 3. Gestor: borrador y envío a aprobación
  const pm = await login(manager);
  await pm.getByRole('link', { name: 'Bandeja', exact: true }).click();
  await pm.getByText(/sin gluten/).click();
  await pm.getByRole('button', { name: /Generar con IA · Fase 3/ }).waitFor();
  await pm
    .getByLabel(/^Borrador/)
    .fill('¡Hola, Carmen! Sí: tenemos carta sin gluten. Pídela al llegar y te asesoramos.');
  await pm.getByRole('button', { name: 'Guardar borrador' }).click();
  await pm.getByRole('status').filter({ hasText: 'Borrador guardado' }).last().waitFor();
  await pm.getByRole('button', { name: /Enviar a aprobación/ }).click();
  await pm.getByText('Pendiente de aprobación').first().waitFor();
  await pm.screenshot({ path: `${SHOTS}/f2-03-detalle-gestor.png`, fullPage: true });
  // El gestor no puede aprobar: no ve el panel de aprobación.
  if (await pm.getByRole('button', { name: 'Aprobar y publicar' }).count())
    fail('El gestor ve el botón de aprobar');
  log('Gestor redacta y envía a aprobación (sin poder aprobar)');

  // 4. Segundo borrador que se editará después de enviarlo a aprobación
  await pm.goBack();
  await pm.getByText(/terraza es preciosa/).click();
  await pm.getByLabel(/^Borrador/).fill('Gracias, Elena. Tomamos nota sobre los precios.');
  await pm.getByRole('button', { name: 'Guardar borrador' }).click();
  await pm.getByRole('status').filter({ hasText: 'Borrador guardado' }).last().waitFor();
  await pm.getByRole('button', { name: /Enviar a aprobación/ }).click();
  await pm.getByText('Pendiente de aprobación').first().waitFor();

  // 5. Aprobadora desde el móvil
  const pp = await login(approver, { width: 390, height: 844 });
  await pp.goto(`${BASE}${base}/aprobaciones`);
  await pp.getByText(/tenemos carta sin gluten/).waitFor();
  await pp.getByText(/Tomamos nota sobre los precios/).waitFor();
  await pp.screenshot({ path: `${SHOTS}/f2-04-aprobaciones-movil.png`, fullPage: true });
  log('La aprobadora ve las dos solicitudes en el móvil');

  // 6. El gestor edita el segundo texto: la solicitud queda anulada
  await pm.getByLabel(/^Borrador/).fill('Gracias, Elena. Revisaremos los precios de la carta.');
  await pm.getByText(/invalidará la solicitud de aprobación/).waitFor();
  await pm.getByRole('button', { name: 'Guardar borrador' }).click();
  await pm.getByRole('status').filter({ hasText: 'Borrador guardado' }).last().waitFor();
  await pm.getByText('Borrador generado').first().waitFor();
  await pp.reload();
  await pp.getByText(/tenemos carta sin gluten/).waitFor();
  if (await pp.getByText(/Tomamos nota sobre los precios/).count())
    fail('Sigue pendiente un texto editado');
  log('Editar tras enviar a aprobación anula la solicitud');

  // 7. Aprobar y publicar; el worker publica y verifica
  await pp.getByRole('button', { name: 'Aprobar y publicar' }).first().click();
  await pp
    .getByRole('alertdialog')
    .or(pp.getByRole('dialog'))
    .getByRole('button', { name: 'Aprobar y publicar' })
    .click();
  await pp.getByText(/Se publicará y verificará/).waitFor();
  await pp.getByText('No hay respuestas pendientes').waitFor();
  log('Aprobada desde el móvil');

  await pm.goto(`${BASE}${base}/bandeja?q=gluten&view=all`);
  await pm.getByText(/sin gluten/).click();
  await pm.getByText(/Publicada y verificada en/).waitFor({ timeout: 30000 });
  await pm.getByText('Publicada y verificada', { exact: true }).waitFor();
  await pm.screenshot({ path: `${SHOTS}/f2-05-publicada.png`, fullPage: true });
  const [job] = await sql`
    select j.status, (select count(*)::int from public.publication_attempts a where a.job_id = j.id and a.operation = 'publish') as publishes,
           (select count(*)::int from public.publication_receipts r where r.job_id = j.id) as receipts
      from public.publication_jobs j join public.external_interactions i on i.id = j.interaction_id
     where i.client_id = ${client.id} and i.content like '%gluten%'`;
  if (job.status !== 'published' || job.publishes !== 1 || job.receipts !== 1)
    fail(`Publicación inesperada: ${JSON.stringify(job)}`);
  log('El worker publicó una sola vez y verificó la respuesta (recibo guardado)');

  // 8. Panel con métricas reales, modo oscuro
  await pa.getByRole('link', { name: 'Panel', exact: true }).click();
  await pa.getByText('Interacciones abiertas').waitFor();
  await pa.getByText(/ficticias del proveedor simulado/).waitFor();
  await pa.screenshot({ path: `${SHOTS}/f2-06-panel.png` });
  await pa.getByRole('button', { name: /modo oscuro/ }).click();
  await pa.getByRole('link', { name: 'Bandeja', exact: true }).click();
  await pa.getByText('Simulado').first().waitFor();
  await pa.screenshot({ path: `${SHOTS}/f2-07-bandeja-oscuro.png` });
  log('Panel con datos reales y modo oscuro');

  if (errors.length) fail(`Errores de JavaScript en página: ${errors.join(' | ')}`);
  console.log('\nE2E Fase 2: OK');
} catch (e) {
  for (const c of browser.contexts())
    for (const p of c.pages())
      await p
        .screenshot({
          path: `${SHOTS}/zz-f2-failure-${Math.random().toString(36).slice(2, 6)}.png`,
        })
        .catch(() => {});
  console.error('✗', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  await sql.end();
}
