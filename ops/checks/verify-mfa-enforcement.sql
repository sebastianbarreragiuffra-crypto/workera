-- Consulta de solo lectura para validar el corte obligatorio de MFA.
select
  (
    select count(*)
    from auth.mfa_factors factor
    where factor.status = 'verified'
      and exists (
        select 1
        from public.platform_memberships membership
        where membership.user_id = factor.user_id
          and membership.active
          and membership.role = 'OWNER'
      )
  ) as verified_owner_factors,
  (
    select count(*)
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = any (array[
        'approve_medical_license',
        'reject_medical_license',
        'platform_create_company',
        'platform_assign_company_role',
        'platform_set_company_module_status',
        'platform_set_onboarding_step_completed',
        'platform_create_company_invitation',
        'platform_create_organization_unit'
      ])
      and procedure.prosrc like '%enforce_mfa_for_privileged()%'
  ) as guarded_sensitive_rpcs,
  pg_get_functiondef(
    'public.enforce_mfa_for_privileged()'::regprocedure
  ) like '%account_requires_mfa(auth.uid())%'
    and pg_get_functiondef(
      'public.enforce_mfa_for_privileged()'::regprocedure
    ) like '%request_is_aal2()%'
    as enforcement_helper_is_secure,
  pg_get_functiondef(
    'public.platform_set_company_module_status(uuid,text,public.company_module_status)'::regprocedure
  ) like '%tenant_isolated%'
    and pg_get_functiondef(
      'public.platform_set_company_module_status(uuid,text,public.company_module_status)'::regprocedure
    ) like '%enforce_mfa_for_privileged()%'
    and pg_get_functiondef(
      'public.platform_set_company_module_status(uuid,text,public.company_module_status)'::regprocedure
    ) not like '%p_module_key <> ''expenses''%'
    as module_control_plane_is_current;
