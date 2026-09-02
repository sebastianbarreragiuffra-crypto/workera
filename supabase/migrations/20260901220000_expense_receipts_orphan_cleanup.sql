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
--
-- Esta policy solo se ejerce a través de la Storage API real (el
-- `.remove()` del SDK cliente que usa uploadExpenseReceiptAction), nunca
-- con un DELETE por SQL directo: Supabase instala un trigger
-- storage.protect_delete() que rechaza CUALQUIER DELETE directo sobre
-- storage.objects sin importar RLS, precisamente para que la baja de
-- metadata y el borrado del archivo real en el backend de objetos no se
-- desincronicen. Verificado empíricamente vía pgTAP: ni el propio dueño de
-- un objeto huérfano puede borrarlo con SQL crudo -- por eso la prueba de
-- 044_expenses_receipts_and_approvals.sql valida la policy por su
-- definición y su condición, no ejecutando un DELETE.
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
