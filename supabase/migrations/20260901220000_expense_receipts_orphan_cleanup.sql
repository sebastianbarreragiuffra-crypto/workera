-- GESTORA Rendiciones: limpieza de comprobantes huérfanos en Storage
-- (hallazgo de la auditoría, P1). Si el archivo se sube al bucket privado
-- pero register_expense_receipt() falla después (constraint, RLS, red),
-- el objeto queda en Storage sin ninguna fila de expense_receipts que lo
-- referencie. Deliberadamente NO se concede DELETE general sobre
-- storage.objects a `authenticated` -- la policy solo permite borrar un
-- objeto cuando (a) la ruta ya pasa exactamente el mismo chequeo de
-- pertenencia que exige subirlo, y (b) ninguna fila de expense_receipts lo
-- referencia todavía. En cuanto register_expense_receipt() inserta esa
-- fila, el objeto deja de calificar para el borrado -- un comprobante ya
-- registrado nunca puede borrarse por esta vía.
create policy "expense_receipts_storage_delete_orphan"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'expense-receipts'
    and public.can_upload_expense_receipt_path(name)
    and not exists (
      select 1 from public.expense_receipts r where r.storage_path = name
    )
  );

comment on policy "expense_receipts_storage_delete_orphan" on storage.objects is
  'Borra únicamente comprobantes huérfanos (subidos pero nunca registrados en '
  'expense_receipts) del propio dueño de la ruta -- nunca un DELETE general, '
  'y nunca alcanza a un comprobante ya registrado.';
