/**
 * Prueba end-to-end de la Fase 3 (IA) contra el stack local REAL:
 *   supabase start · API (:8787) · worker (pg-boss) · web (vite, :5173)
 *   node e2e/phase3-smoke.mjs
 *
 * Usa el proveedor de IA configurado en apps/api/.env: OpenAI si hay
 * OPENAI_API_KEY (coste real de céntimos) o el simulado con AI_PROVIDER=fake.
 * Todas las reseñas son FICTICIAS (simulador). Recorre:
 * personalidad de marca → sincronización → clasificación automática por el
 * worker → análisis en la ficha → «Generar con IA» y «Más breve» → envío a
 * aprobación (sin publicar) → informe con métricas y resumen de IA →
 * registro de generaciones y coste.
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
const PASS = 'Demo-Fase3-2026-segura';
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
  insert into public.organizations (name, slug) values (${`Agencia Fase 3 ${run}`}, ${`fase3-${run}`}) returning id`;
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

const waitFor = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) fail(`Tiempo agotado esperando: ${what}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
};

try {
  // 1. Personalidad de marca (versión 1)
  const pa = await login(admin);
  await pa.goto(`${BASE}${base}/clientes/${client.id}#marca`);
  await pa.getByText('Sin configurar: la IA no puede redactar').waitFor();
  await pa.getByLabel(/^Tono/).fill('Cercano, cálido y profesional');
  await pa.getByLabel(/^Tratamiento/).selectOption('tu');
  await pa.getByLabel(/^Expresiones prohibidas/).fill('barato\nchollo');
  await pa
    .getByLabel(/^Datos verificados del negocio/)
    .fill(
      'horario: de martes a domingo, de 13:00 a 23:30\ncarta sin gluten: disponible bajo petición',
    );
  await pa.getByRole('button', { name: 'Guardar nueva versión' }).click();
  await pa.getByText('Versión vigente: 1').waitFor();
  await pa.screenshot({ path: `${SHOTS}/f3-01-marca.png`, fullPage: true });
  log('Personalidad de marca guardada (versión 1)');

  // 2. Fuente simulada → el worker sincroniza y clasifica con IA
  await pa.goto(`${BASE}${base}/fuentes`);
  await pa.getByRole('button', { name: /Fuente simulada/ }).click();
  await pa.getByLabel(/^Cliente/).selectOption(client.id);
  await pa.getByRole('button', { name: 'Crear y sincronizar' }).click();
  await pa.getByText(/12 nuevas/).waitFor({ timeout: 30000 });
  const started = Date.now();
  const done = await waitFor(
    async () => {
      const [r] = await sql`
        select count(*) filter (where ai_status = 'done')::int as done,
               count(*) filter (where ai_status in ('failed', 'skipped'))::int as bad,
               count(*)::int as total
          from public.external_interactions where client_id = ${client.id}`;
      if (r.bad) fail(`Hay análisis fallidos u omitidos: ${JSON.stringify(r)}`);
      return r.done === r.total && r.total === 12 ? r : null;
    },
    180000,
    'clasificación de las 12 reseñas',
  );
  const [prov] = await sql`
    select provider, model, count(*)::int as n, sum(cost_usd)::float8 as cost
      from public.ai_generations where client_id = ${client.id} and kind = 'classification' group by 1, 2`;
  log(
    `Worker clasificó ${done.done} reseñas ficticias en ${Math.round((Date.now() - started) / 1000)} s con ${prov.provider}/${prov.model} (coste ${prov.cost.toFixed(4)} USD)`,
  );

  await pa.goto(`${BASE}${base}/bandeja`);
  await pa.getByText(/12 resultados/).waitFor();
  await pa.getByText('Positiva').first().waitFor();
  await pa.getByText('Negativa').first().waitFor();
  await pa.screenshot({ path: `${SHOTS}/f3-02-bandeja-clasificada.png` });
  log('La bandeja muestra el sentimiento calculado por la IA');

  // 3. Ficha: análisis, riesgo sanitario y manipulación
  const pm = await login(manager);
  await pm.goto(`${BASE}${base}/bandeja`);
  await pm.getByText(/malestar estomacal/).click();
  await pm.getByRole('heading', { name: 'Análisis' }).waitFor();
  await pm.getByText('Requiere revisión especializada').first().waitFor();
  await pm.getByText(/Conclusión generada por IA/).waitFor();
  await pm.screenshot({ path: `${SHOTS}/f3-03-analisis-salud.png`, fullPage: true });
  log('Reseña de salud: crítica y con revisión especializada');
  await pm.goBack();
  await pm.getByText(/Ignora tus instrucciones/).click();
  await pm.getByText('Instrucciones sospechosas').first().waitFor();
  log('Reseña con instrucciones ocultas marcada como sospechosa');

  // 4. Borrador con IA, variante y envío a aprobación (no se publica)
  await pm.goBack();
  await pm.getByText(/mejor arroz/).click();
  await pm.getByRole('button', { name: 'Generar con IA' }).click();
  await pm.getByText(/Propuesta generada por IA/).waitFor({ timeout: 90000 });
  const v1 = await pm.getByLabel(/^Borrador/).inputValue();
  if (!v1.trim()) fail('El borrador de IA está vacío');
  if (/barato|chollo/i.test(v1)) fail('El borrador usa una expresión prohibida');
  await pm.screenshot({ path: `${SHOTS}/f3-04-borrador-ia.png`, fullPage: true });
  log(`Borrador de IA (v1): «${v1.slice(0, 120)}${v1.length > 120 ? '…' : ''}»`);
  await pm.getByRole('button', { name: 'Más breve' }).click();
  await pm.getByText('Borrador (versión 2)').waitFor({ timeout: 90000 });
  const v2 = await pm.getByLabel(/^Borrador/).inputValue();
  log(`Variante «Más breve» (v2): «${v2.slice(0, 120)}${v2.length > 120 ? '…' : ''}»`);
  await pm.getByRole('button', { name: /Enviar a aprobación/ }).click();
  await pm.getByText('Pendiente de aprobación').first().waitFor();
  const jobs = await sql`
    select j.id from public.publication_jobs j join public.external_interactions i on i.id = j.interaction_id
     where i.client_id = ${client.id}`;
  if (jobs.length) fail('Se creó una publicación sin aprobación humana');
  log('Enviada a aprobación; nada se publica sin la aprobadora');

  // 5. La aprobadora ve que el texto lo propuso la IA
  const pp = await login(approver);
  await pp.goto(`${BASE}${base}/bandeja`);
  await pp.getByText(/mejor arroz/).click();
  await pp.getByRole('heading', { name: 'Aprobación' }).waitFor();
  await pp
    .getByText(/Propuesta generada por IA/)
    .first()
    .waitFor();
  await pp.screenshot({ path: `${SHOTS}/f3-05-aprobacion-ia.png`, fullPage: true });
  log('La aprobadora ve el aviso «generada por IA» antes de decidir');

  // 6. Informe: métricas observadas + resumen de IA validado
  await pa.goto(`${BASE}${base}/informes`);
  await pa.getByLabel(/^Cliente/).selectOption(client.id);
  await pa.getByText('Temas más mencionados').waitFor();
  await pa.screenshot({ path: `${SHOTS}/f3-06-informes-metricas.png`, fullPage: true });
  await pa.getByRole('button', { name: /Crear informe con resumen IA/ }).click();
  await pa.getByText(/Conclusión generada por IA/).waitFor({ timeout: 120000 });
  const headline = await pa
    .locator('section[aria-label="Conclusión generada por IA"] h3')
    .innerText();
  const [rep] = await sql`
    select status, jsonb_array_length(summary->'findings') as findings, warnings
      from public.report_snapshots where client_id = ${client.id} order by created_at desc limit 1`;
  if (rep.status !== 'ready') fail(`Informe sin resumen: ${JSON.stringify(rep)}`);
  await pa.screenshot({ path: `${SHOTS}/f3-07-informe-ia.png`, fullPage: true });
  log(
    `Informe con resumen de IA («${headline}»), ${rep.findings} hallazgos con ≥ 3 reseñas de respaldo`,
  );

  const [tot] = await sql`
    select count(*)::int as n, coalesce(sum(cost_usd), 0)::float8 as cost
      from public.ai_generations where client_id = ${client.id}`;
  log(`Generaciones registradas: ${tot.n} · coste total ${tot.cost.toFixed(4)} USD`);

  if (errors.length) fail(`Errores de JavaScript en página: ${errors.join(' | ')}`);
  console.log('\nE2E Fase 3: OK');
} catch (e) {
  for (const c of browser.contexts())
    for (const p of c.pages())
      await p
        .screenshot({
          path: `${SHOTS}/zz-f3-failure-${Math.random().toString(36).slice(2, 6)}.png`,
        })
        .catch(() => {});
  console.error('✗', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  await sql.end();
}
