-- GESTORA: segundo cliente inicial de la cartera.
--
-- GISBA se incorpora al control plane para poder configurar sus módulos,
-- usuarios y organización de manera independiente. Su workspace permanece
-- cerrado hasta completar el aislamiento multi-tenant operacional.

insert into public.companies (
  id,
  name,
  legal_name,
  slug,
  active,
  status,
  workspace_enabled,
  plan_code,
  country_code,
  timezone
) values (
  '0a4c0000-0000-0000-0000-000000000002',
  'GISBA',
  'GISBA',
  'gisba',
  true,
  'ONBOARDING',
  false,
  'CUSTOM',
  'CL',
  'America/Santiago'
)
on conflict (slug) do nothing;
