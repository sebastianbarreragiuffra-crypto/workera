-- El snapshot depende de clock_timestamp(), que es VOLATILE. Declararlo STABLE
-- permitía que el optimizador reutilizara un resultado que ya no representa el
-- estado actual del backlog durante consultas prolongadas.

alter function public.get_supporting_document_cleanup_health(integer) volatile;
