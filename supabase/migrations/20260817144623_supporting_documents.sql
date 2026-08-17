-- Fase 2B — 13: metadata de documentos de respaldo (foto/PDF de licencias, etc.)
--
-- Solo metadata. NUNCA se guarda el binario del archivo en Postgres — vivirá
-- en un bucket PRIVADO de Supabase Storage (no creado en esta fase).

-- ---------------------------------------------------------------------------
-- Diseño: se evaluó una relación polimórfica genérica
-- (related_entity_type text + related_entity_id uuid, sin FK real) y se
-- descartó explícitamente. Motivo: una relación polimórfica sin FK no puede
-- ser validada por Postgres (related_entity_id podría apuntar a una fila
-- inexistente o a la tabla equivocada sin que la base lo detecte nunca), y
-- complica la futura RLS (no se puede expresar "el supervisor de este
-- trabajador puede leer este documento" con un JOIN directo si no se sabe en
-- tiempo de diseño de la política a qué tabla apunta related_entity_id).
--
-- En su lugar: una FK específica y nullable por cada tipo de hecho al que un
-- documento puede respaldar hoy, con un CHECK que permite como máximo una
-- (el documento puede además no estar ligado a ningún hecho puntual, solo al
-- trabajador). Agregar un nuevo tipo de hecho adjuntable en el futuro es una
-- columna nueva + ajustar el CHECK — más columnas con el tiempo, pero cada una
-- con integridad referencial real, lo cual pesa más que el ahorro de espacio
-- de una tabla polimórfica dada la sensibilidad de estos documentos.
create table public.supporting_documents (
  id                          uuid primary key default gen_random_uuid(),
  employee_id                 uuid not null references public.employees(id),

  -- A lo sumo una de estas tres (CHECK más abajo). Ninguna, cero, o una — no
  -- "exactamente una": un documento puede respaldar algo del trabajador en
  -- general sin pertenecer a un registro puntual.
  absence_record_id           uuid references public.absence_records(id),
  late_arrival_decision_id    uuid references public.late_arrival_decisions(id),
  attendance_status_record_id uuid references public.attendance_status_records(id),

  -- Conjunto pequeño y no puramente técnico, pero de bajo riesgo de necesitar
  -- valores nuevos con frecuencia — se prefiere CHECK sobre catálogo aparte
  -- para no multiplicar tablas de una sola columna en esta fase; si el
  -- negocio confirma que este vocabulario crecerá activamente, conviene
  -- revisarlo hacia un catálogo en una fase posterior.
  document_type               text not null check (
    document_type in ('MEDICAL_CERTIFICATE', 'TRANSPORT_PROOF', 'IDENTIFICATION', 'OTHER')
  ),

  -- Apunta a Supabase Storage (bucket privado, a crear en fase futura) — jamás
  -- una URL pública ni el contenido del archivo.
  storage_path                text not null,
  mime_type                   text not null,
  original_filename           text not null,

  uploaded_by                 uuid not null references public.profiles(id),
  uploaded_at                 timestamptz not null default now(),
  created_at                  timestamptz not null default now(),

  constraint supporting_documents_at_most_one_relation_chk
    check (num_nonnulls(absence_record_id, late_arrival_decision_id, attendance_status_record_id) <= 1)
);

comment on table public.supporting_documents is
  'Metadata de documentos de respaldo (foto/PDF de licencia u otra novedad). '
  'SIN contenido de archivo en esta tabla — storage_path referenciará un '
  'bucket PRIVADO de Supabase Storage (Storage real no implementado en esta '
  'fase). Sin diagnóstico ni detalle médico en ninguna columna: la '
  'información sensible, si existe, vive únicamente dentro del archivo '
  'privado, nunca en texto plano en Postgres.';

comment on column public.supporting_documents.storage_path is
  'Ruta en un bucket PRIVADO de Supabase Storage. El acceso futuro debe ser '
  'vía signed URLs de corta duración + políticas de Storage/RLS — nunca URLs '
  'públicas permanentes. No implementado en esta fase.';

create index supporting_documents_employee_id_idx
  on public.supporting_documents (employee_id);
create index supporting_documents_absence_record_id_idx
  on public.supporting_documents (absence_record_id) where absence_record_id is not null;
create index supporting_documents_late_arrival_decision_id_idx
  on public.supporting_documents (late_arrival_decision_id) where late_arrival_decision_id is not null;
create index supporting_documents_attendance_status_record_id_idx
  on public.supporting_documents (attendance_status_record_id) where attendance_status_record_id is not null;

-- Metadata inmutable tras subir (igual criterio de auditabilidad que el resto
-- del esquema): si un documento se reemplaza, se sube uno nuevo, el anterior
-- permanece como historial en vez de editarse.
create trigger supporting_documents_immutable
  before update on public.supporting_documents
  for each row
  execute function public.enforce_immutable_columns();
