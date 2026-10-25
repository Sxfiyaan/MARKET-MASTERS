create policy app_documents_deny_public_access
  on public.app_documents
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);
