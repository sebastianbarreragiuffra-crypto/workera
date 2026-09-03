-- pgTAP GESTORA MT-3B: aislamiento tenant del vertical Nómina de Pago.
create extension if not exists pgtap;

begin;
select plan(20);

select has_column('public', 'suppliers', 'company_id', 'suppliers declara tenant');
select has_column('public', 'payroll_batches', 'company_id', 'payroll_batches declara tenant');
select has_column('public', 'payroll_batch_items', 'company_id', 'payroll_batch_items declara tenant');
select has_column('public', 'supplier_master_imports', 'company_id', 'supplier_master_imports declara tenant');

select col_not_null('public', 'suppliers', 'company_id', 'suppliers.company_id es obligatorio');
select col_not_null('public', 'payroll_batches', 'company_id', 'payroll_batches.company_id es obligatorio');
select col_not_null('public', 'payroll_batch_items', 'company_id', 'payroll_batch_items.company_id es obligatorio');
select col_not_null('public', 'supplier_master_imports', 'company_id', 'supplier_master_imports.company_id es obligatorio');

insert into public.companies (
  id, name, legal_name, slug, active, status, workspace_enabled
) values (
  '96000000-0000-0000-0000-000000000002', 'Payroll Tenant B',
  'Payroll Tenant B SpA', 'payroll-tenant-b', true, 'ONBOARDING', false
);

update public.company_modules
set status = 'ENABLED', enabled_at = now()
where company_id in (
  '0a4c0000-0000-0000-0000-000000000001',
  '96000000-0000-0000-0000-000000000002'
) and module_key = 'payroll';

insert into public.profiles (id, display_name, role, active) values
  ('96000000-0000-0000-0000-000000000101', 'Payroll User A', 'ADMIN_RRHH', true),
  ('96000000-0000-0000-0000-000000000102', 'Payroll User B', null, true),
  ('96000000-0000-0000-0000-000000000103', 'Platform Only', null, true);

insert into public.platform_memberships (user_id, role, active)
values ('96000000-0000-0000-0000-000000000103', 'ADMIN', true);

-- El trigger de compatibilidad de profiles ya crea la membresía ARCOTEX de
-- User A. Solo B necesita fixture explícito porque no usa el rol global.
insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('96000000-0000-0000-0000-000000000202', '96000000-0000-0000-0000-000000000102', '96000000-0000-0000-0000-000000000002', 'ADMIN_RRHH', true);

insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id and cr.code = 'HR_ADMIN'
where (cm.user_id = '96000000-0000-0000-0000-000000000101'
       and cm.company_id = '0a4c0000-0000-0000-0000-000000000001')
   or cm.id = '96000000-0000-0000-0000-000000000202';

insert into public.suppliers (
  id, company_id, rut, normalized_rut, name, normalized_name,
  payment_method, bank_code, account_number, created_by
) values (
  '96000000-0000-0000-0000-000000000301', '0a4c0000-0000-0000-0000-000000000001',
  '11-1', '111', 'Proveedor Compartido', 'PROVEEDOR COMPARTIDO',
  'TR', '001', 'A-1', '96000000-0000-0000-0000-000000000101'
);

-- Fixture de aislamiento: simula una fila histórica de B para probar que RLS
-- y FKs no la filtran. El gate real impide crearla mientras B esté bloqueada.
set local session_replication_role = replica;
insert into public.suppliers (
  id, company_id, rut, normalized_rut, name, normalized_name,
  payment_method, bank_code, account_number, created_by
) values (
  '96000000-0000-0000-0000-000000000302', '96000000-0000-0000-0000-000000000002',
  '11-1', '111', 'Proveedor Compartido', 'PROVEEDOR COMPARTIDO',
  'TR', '001', 'B-1', '96000000-0000-0000-0000-000000000102'
);
set local session_replication_role = origin;

select is(
  (select count(*)::integer from public.suppliers where normalized_name = 'PROVEEDOR COMPARTIDO'),
  2,
  'la misma identidad de proveedor puede existir en empresas distintas'
);

select throws_ok(
  $$insert into public.suppliers (
      company_id, rut, normalized_rut, name, normalized_name,
      payment_method, bank_code, account_number, created_by
    ) values (
      '0a4c0000-0000-0000-0000-000000000001', '22-2', '222',
      'Duplicado', 'PROVEEDOR COMPARTIDO', 'TR', '001', 'A-2',
      '96000000-0000-0000-0000-000000000101'
    )$$,
  '23505', null,
  'un nombre normalizado duplicado dentro de la empresa se rechaza'
);

insert into public.payroll_batches (
  id, company_id, source_filename, generated_by, matched_count, unmatched_count, total_amount
) values (
  '96000000-0000-0000-0000-000000000401', '0a4c0000-0000-0000-0000-000000000001',
  'a.xlsx', '96000000-0000-0000-0000-000000000101', 1, 0, 100
);

set local session_replication_role = replica;
insert into public.payroll_batches (
  id, company_id, source_filename, generated_by, matched_count, unmatched_count, total_amount
) values (
  '96000000-0000-0000-0000-000000000402', '96000000-0000-0000-0000-000000000002',
  'b.xlsx', '96000000-0000-0000-0000-000000000102', 1, 0, 200
);
set local session_replication_role = origin;

select throws_ok(
  $$insert into public.payroll_batch_items (
      company_id, batch_id, nro_docto, nombre_cliente, valor_total, supplier_id, status
    ) values (
      '0a4c0000-0000-0000-0000-000000000001',
      '96000000-0000-0000-0000-000000000401', 'X-1', 'Cruce', 100,
      '96000000-0000-0000-0000-000000000302', 'MATCHED'
    )$$,
  '23503', null,
  'una fila de nómina no puede referenciar proveedor de otra empresa'
);

set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000101';
select is((select count(*)::integer from public.suppliers), 1, 'usuario A ve solo proveedores A');
select is((select account_number from public.suppliers), 'A-1', 'usuario A nunca recibe datos bancarios B');
select is((select count(*)::integer from public.payroll_batches), 1, 'usuario A ve solo lotes A');
select throws_ok(
  $$insert into public.payroll_batches (
      company_id, source_filename, generated_by, matched_count, unmatched_count, total_amount
    ) values (
      '96000000-0000-0000-0000-000000000002', 'cross.xlsx',
      '96000000-0000-0000-0000-000000000101', 0, 0, 0
    )$$,
  '23514', 'El workspace de la empresa esta bloqueado para datos laborales.',
  'el gate bloquea insertar lotes en una empresa todavía no operativa'
);
select throws_ok(
  $$update public.suppliers
    set company_id = '96000000-0000-0000-0000-000000000002'
    where id = '96000000-0000-0000-0000-000000000301'$$,
  '23514', 'El workspace de la empresa esta bloqueado para datos laborales.',
  'el gate bloquea trasladar proveedores hacia una empresa no operativa'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000103';
select is((select count(*)::integer from public.suppliers), 0, 'admin de plataforma sin membership no ve datos bancarios');
select is((select count(*)::integer from public.payroll_batches), 0, 'admin de plataforma sin membership no ve lotes');
reset role;

update public.company_memberships
set active = false
where user_id = '96000000-0000-0000-0000-000000000101'
  and company_id = '0a4c0000-0000-0000-0000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000101';
select is((select count(*)::integer from public.suppliers), 0, 'membresía inactiva revoca proveedores inmediatamente');
reset role;

select ok(
  not has_function_privilege(
    'anon',
    'public.apply_supplier_master_import(uuid,uuid,uuid,text,text,integer,integer,integer,integer,integer,integer,jsonb,jsonb)',
    'EXECUTE'
  ),
  'anon no puede ejecutar el RPC de maestro de proveedores'
);

select * from finish();
rollback;
