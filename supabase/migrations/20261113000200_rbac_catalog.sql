-- =============================================================================
-- Migración 0002 · Catálogo RBAC (permisos y roles de sistema)
-- Los permisos son datos de referencia versionados con el código: añadir uno
-- nuevo = nueva migración + actualizar packages/shared/src/permissions.ts
-- (un test comprueba que ambos coinciden).
-- =============================================================================
insert into public.permissions (key, scope, description) values
  -- Plataforma (solo superadministradores; nunca asignables a roles de organización)
  ('platform.organizations.manage', 'platform', 'Crear, suspender y administrar organizaciones'),
  ('platform.settings.manage', 'platform', 'Configuración global, interruptor de publicación'),
  ('platform.integrations.monitor', 'platform', 'Supervisar integraciones y trabajos de todas las organizaciones'),
  ('platform.ai.configure', 'platform', 'Configuración general de IA (modelos, límites de coste)'),
  -- Organización
  ('organization.read', 'organization', 'Ver datos básicos de la organización'),
  ('organization.manage', 'organization', 'Editar la organización y sus ajustes'),
  ('members.manage', 'organization', 'Invitar, asignar y retirar usuarios'),
  ('roles.manage', 'organization', 'Crear y editar roles personalizados'),
  ('clients.create', 'organization', 'Dar de alta clientes'),
  ('audit.read', 'organization', 'Consultar el registro de auditoría'),
  ('alerts.manage', 'organization', 'Configurar reglas de alerta'),
  -- Cliente
  ('clients.read', 'client', 'Ver la ficha del cliente, ubicaciones y personalidad de marca'),
  ('clients.update', 'client', 'Editar la ficha del cliente y sus ubicaciones'),
  ('brand.write', 'client', 'Editar y versionar la personalidad de marca'),
  ('connections.read', 'client', 'Ver fuentes conectadas y su estado'),
  ('connections.manage', 'client', 'Conectar, desconectar y sincronizar fuentes'),
  ('interactions.read', 'client', 'Ver reseñas, comentarios y menciones'),
  ('interactions.update', 'client', 'Asignar, priorizar y cambiar el estado de interacciones'),
  ('drafts.write', 'client', 'Generar y editar borradores de respuesta'),
  ('approvals.request', 'client', 'Enviar borradores a aprobación'),
  ('responses.approve', 'client', 'Aprobar o rechazar respuestas'),
  ('responses.publish', 'client', 'Lanzar o reintentar la publicación de respuestas aprobadas'),
  ('reports.read', 'client', 'Consultar informes'),
  ('alerts.read', 'client', 'Ver alertas');

insert into public.roles (key, name, description, is_system) values
  ('org_admin', 'Administrador de organización', 'Control total de la organización y todos sus clientes', true),
  ('account_manager', 'Gestor de cuentas', 'Gestiona los clientes asignados; no aprueba salvo permiso adicional', true),
  ('approver', 'Aprobador', 'Rol adicional por cliente: aprobar o rechazar publicaciones', true),
  ('client_viewer', 'Cliente (lectura)', 'Previsto para fases posteriores: solo su información e informes', true);

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key from public.roles r cross join public.permissions p
 where r.key = 'org_admin' and r.is_system and p.scope <> 'platform';

insert into public.role_permissions (role_id, permission_key)
select r.id, k from public.roles r cross join unnest(array[
  'organization.read', 'clients.read', 'clients.update', 'connections.read', 'interactions.read',
  'interactions.update', 'drafts.write', 'approvals.request', 'reports.read', 'alerts.read']) as k
 where r.key = 'account_manager' and r.is_system;

insert into public.role_permissions (role_id, permission_key)
select r.id, k from public.roles r cross join unnest(array[
  'clients.read', 'interactions.read', 'responses.approve']) as k
 where r.key = 'approver' and r.is_system;

insert into public.role_permissions (role_id, permission_key)
select r.id, k from public.roles r cross join unnest(array[
  'organization.read', 'clients.read', 'interactions.read', 'reports.read']) as k
 where r.key = 'client_viewer' and r.is_system;
